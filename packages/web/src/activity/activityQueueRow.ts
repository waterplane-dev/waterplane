import {
  type BlockReason,
  type Lifecycle,
  type SendBlockReason,
  intentReasonText,
} from "@waterplane/shared";
import { CONFIRMING_WHY, hostStillConfirming } from "../sendConfirm.ts";
import { serialTextFor } from "../core/queue/serialStates.ts";
import type { OutboxEntry } from "../outbox";
import {
  act,
  clip,
  entryProse,
  queueRowKey,
  recordedFailure,
} from "./activityPieces.ts";
import {
  bucketOf,
} from "./activityBucket.ts";
import type { ActivityAction, ActivityDeps, ActivityInput, ActivityKind, ActivityRow, DeliveryTruth } from "./activityTypes.ts";

// ── Queue rows: the phone's own send queue ──────────────────────────────────

/**
 * The queue's nine block reasons onto the shared ten.
 *
 * Four of them line up exactly (`gate`, `budget`, `sessionGone`, `serial`). The
 * rest are all one shape — "the lane in front of you is occupied" — which the
 * shared set expresses as `sessionBusy`, and the queue's own more specific
 * sentence rides along as the `detail` that `intentReasonText` prefers. That is
 * the documented contract there: `detail` IS the answer when present, and the
 * generic line is what a row says when nobody knew better.
 *
 * `backoff` maps to nothing, on purpose. A send waiting out its retry delay is
 * not blocked on the account, the session or a switch — it is a clock this
 * client owns, and it clears itself in seconds. Naming it as the nearest
 * neighbour would put it in the ordering ahead of things that genuinely need a
 * person.
 */
const QUEUE_BLOCK: Record<SendBlockReason, BlockReason | null> = {
  gate: "gate",
  budget: "budget",
  sessionBudget: "sessionBudget",
  sessionGone: "sessionGone",
  serial: "serial",
  held: "sessionBusy",
  lane: "sessionBusy",
  inflight: "sessionBusy",
  pendingCreate: "sessionBusy",
  backoff: null,
};

/** The queue's own sentence for each, kept as the per-row `detail` so the four
 *  lane-shaped reasons do not all collapse into "the session is working". */
const QUEUE_DETAIL: Partial<Record<SendBlockReason, string>> = {
  held: "held until the agent finishes this turn",
  lane: "another message for that session is going out first",
  inflight: "a delivery for that session is already in flight",
  pendingCreate: "waiting for its session to open",
};

function deliveryOf(failState: OutboxEntry["failState"]): DeliveryTruth {
  switch (failState) {
    case "unconfirmed": return "unconfirmed";
    case "unsubmitted": return "unsubmitted";
    // The host answered and said no: the fingerprint the answer carried no
    // longer names the box on screen, so nothing was written. That is a
    // REFUSAL, and it is the one failure here that is provably harmless.
    case "stale": return "refused";
    // The same fact on the durable-OP path — `op.ack` came back `ok:false`, so
    // the action was never started. Without this it fell to the default and the
    // row said "nobody recorded whether it ran" over a verdict the desktop had
    // spelled out.
    case "refused": return "refused";
    // Deliberately not "unreachable". Nothing recorded which it was, and
    // guessing the kinder of the two is how a real refusal reads as a bad link.
    default: return "unknown";
  }
}

function queueKind(e: OutboxEntry, deps: ActivityDeps): ActivityKind {
  if (e.answer) return "answer";
  if (e.mode === "upload") return "upload";
  if (e.mode === "op") return deps.isCreateOp(e) ? "prompt" : "action";
  return "prompt";
}

export function queueRow(e: OutboxEntry, input: ActivityInput): ActivityRow {
  const { deps, now, online } = input;
  const kind = queueKind(e, deps);
  const blocked = input.queueBlocked?.get(e.ackId);
  const gone = (e.mode ?? "input") === "input" && !!input.goneLanes?.has(e.sessionId);

  // What the row is DOING right now, in the shared lifecycle. `pending` is
  // `starting` and not `running`: the bytes are on the wire, the turn has not
  // begun, and the difference is exactly the window a delivery goes missing in.
  let state: Lifecycle = e.status === "pending" ? "starting" : e.status === "failed" ? "failed" : "queued";
  let reason: BlockReason | null = null;
  let detail: string | undefined;

  // A verdict the DESKTOP is still working on is not a failure on this screen
  // either (`sendConfirm.ts`). `unconfirmed` arrives seven seconds after Send
  // and the host has four re-sends and a doubling sweep still to spend, so a
  // row that read `failed` — in the failure count, offering "try again" — was
  // asking for a decision nobody had the facts for, about the one action that
  // can run a prompt twice. It is `running` because something IS happening to
  // it, and it carries its own sentence.
  const confirming = hostStillConfirming(e, now);
  if (confirming) {
    state = "running";
    detail = "the desktop is confirming whether it ran — it types it again itself if it never did";
  }

  if (e.status === "queued") {
    if (!online) {
      // The one reason produced ONLY by the phone, and the one the user asked
      // for by name: this has not reached the desktop at all. It is not a
      // failure and it does not expire — `intentReasonText` says so at length.
      reason = "offline";
    } else if (gone) {
      reason = "sessionGone";
    } else if (blocked) {
      reason = QUEUE_BLOCK[blocked];
      detail = QUEUE_DETAIL[blocked];
      // Name WHO holds the repo — "the session before it" sent a person
      // looking for a session they could not find.
      if (blocked === "serial" && input.sessions) detail = serialTextFor(e.serial, input.sessions);
      if (blocked === "backoff") {
        const ms = e.retryAt && e.retryAt > now ? e.retryAt - now : null;
        // Minutes past the minute: a round wait (`roundDelay`) is 5 to 30 of
        // them, and "trying again in 1140s" is a number nobody converts.
        const inWords = ms == null ? null : ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`;
        // `waitReason` is the round's own sentence — "nobody answered", which is
        // not the same claim as "a send failed" and is the one this row is
        // usually making after a minute of trying.
        const lead = e.waitReason ?? "a send just failed";
        detail = inWords ? `${lead} — trying again in ${inWords}` : `${lead} — trying again in a moment`;
      }
      if (blocked === "held") {
        // `held` COLLAPSES three different situations, because `laneBusy()`
        // deliberately answers one question ("can this lane take text?") with
        // one boolean: mid-turn, parked on a question, or blocked on a usage
        // limit. Naming which of the three it is here is not a second decision
        // — the ladder's verdict stands, and these are the same three facts it
        // read. It matters because two of them will never clear on their own:
        // "held until the agent finishes this turn" printed over a session
        // that is sitting on an unanswered question box is a sentence that
        // sends a person away to wait for something that is waiting for them.
        const s = input.sessions?.find((x) => x.id === e.sessionId);
        if (s?.limit?.blocked) {
          reason = "limit";
          detail = undefined;
        } else if (s?.awaitingInput || (s?.prompt && s.prompt.kind !== "trust")) {
          reason = "awaitingAnswer";
          detail = s.prompt
            ? `the session is waiting on a question — “${(s.prompt.ask || s.prompt.question).slice(0, 80)}”`
            : "the session is showing a dialog it wants an answer to";
        }
      }
    }
    // `detail` without `reason` is the backoff case: genuinely blocked, and
    // genuinely none of the ten. The state is what the row DOES; the reason is
    // which shared word it is, and a wait can exist without one.
    if (reason || detail) state = "blocked";
  }

  // The instant this row last had something happen to it — read here rather
  // than at the bottom of the object, because whether the recorded reason is
  // still advice is a question about that instant.
  const at = e.failedAt ?? e.sentAt ?? e.ts;
  const verdict = state === "failed"
    ? recordedFailure(e.reason, at, now,
      "it never went — nothing here says why, so treat it as unrun only if the session shows nothing")
    : state === "starting"
      ? "on its way to the desktop"
      : reason
        ? intentReasonText(reason, detail)
        : detail ?? "next in line";

  // `isEditableEntry` is about editing a queued row IN PLACE, which is what the
  // queue screen does; a FAILED row fails it. But rewriting is precisely the way
  // out of a verdict the desktop remembers — it retires this row and queues a
  // fresh ackId (`retireSendSource`) — and without this every red prompt row
  // offered "rewrite it" refused with "this one is an action, not text", which
  // is both wrong and the sentence a person reads when they are already stuck.
  const editable = deps.isEditableEntry(e) || (e.status === "failed" && kind === "prompt");
  const parked = e.mode === "upload" || e.mode === "op" || !!e.answer;
  const locked = e.status === "pending";
  const prose = entryProse(e);
  // An upload's words are a LABEL (`file · 1000074690-…jpg`), not a path — the
  // path is on the entry's `upload`. Everything else that is words is asked
  // about its words; an answer is keystrokes and has none.
  const attachText = kind === "upload" ? (e.upload?.relPath ?? null)
    : kind === "answer" ? null
    : prose || null;

  // The lane is parked on a question box. Nothing in this queue moves until
  // somebody answers it, so that — and not "send now" — is what the row leads
  // with; sending into an open box answers the box with your prompt.
  const needsAnswer = reason === "awaitingAnswer";

  // What "try again" would actually DO on this row — which for three of the
  // five failure verdicts is nothing at all.
  //
  // A retry re-sends the SAME ackId, which is what makes it safe; the host's
  // ledger answers a known ackId with the verdict it recorded and types
  // nothing (`routes/session.ts`). So a row whose verdict the host REMEMBERED
  // is offered a button whose only possible outcome is that same refusal
  // replayed — measured on a phone, the button vanished for the frame the
  // entry spent `pending` and came straight back red, with no toast, which
  // reads exactly like a dead control.
  //
  // And the two that are not merely futile are dangerous: `unconfirmed` and
  // `unsubmitted` are the verdicts that say the text MAY be in that session
  // already, which is why the bulk revive has always excluded them. Re-sending
  // is how a prompt runs twice, so this says what is known and sends the
  // person to the session instead.
  const stuckSend = e.status !== "failed" ? undefined
    // While the host is still asking, the reason "try again" is not the move is
    // simpler than the settled one — and it does not end with a decision.
    : confirming ? CONFIRMING_WHY
    : e.failState === "unconfirmed"
      ? "it was typed into the session and the desktop could not read the screen back — it may have run. Sending it again could run it twice: open the session and look, or rewrite it to send a fresh copy."
    : e.failState === "unsubmitted"
      ? "the words are already sitting in that session's composer — open it and press Return. Sending again would leave two copies."
    : e.failState === "stale"
      ? "the desktop refused this one because the question it answers is gone, and it remembers refusing it — a re-send is answered with the same no. Answer the question that is up now."
    : e.failState === "refused"
      ? "the desktop answered no and remembers it, so this exact message can only be refused again — rewrite it to send it as a new one."
    : undefined;
  const actions: ActivityAction[] = [
    ...(needsAnswer ? [act("answer", "answer the question", { primary: true })] : []),
    act("sendNow", e.status === "failed" ? "try again" : "send now", {
      primary: !needsAnswer,
      // A failed row is the one thing here worth tapping with the link DOWN:
      // reviving it writes nothing to a socket, it puts the entry back in the
      // queue with its budget reset. Gating it on `online` left a row of red
      // text whose only enabled control was DELETE.
      disabledReason: locked ? "already on its way"
        : stuckSend
        ?? ((!online && e.status !== "failed") ? "no connection yet — it goes out when the link is back"
        : undefined),
    }),
    act("hold", e.holdUntilIdle ? "send without waiting" : "wait for the agent", {
      disabledReason: locked ? "already on its way"
        : parked ? "this one is an action or a file, not text — there is no turn to wait for"
        : undefined,
    }),
    act("retarget", "aim it elsewhere", {
      disabledReason: locked ? "already on its way"
        : e.answer ? "an answer names one question box in one session — it cannot go anywhere else"
        : e.mode === "upload" ? "a file goes to the repo inbox its path names"
        : e.mode === "op" ? "this one is an action — its payload already names its own subject"
        : undefined,
    }),
    act("edit", "rewrite it", {
      // The way out when a retry can only be refused: rewriting retires this
      // row and queues a FRESH ackId (`retireSendSource`), which is a message
      // the ledger has never seen. Marked primary there so the row leads with
      // the one action that can still move it.
      primary: !!stuckSend,
      disabledReason: editable ? undefined
        : locked ? "already on its way"
        : e.answer ? "an answer is the option you tapped, not text"
        : e.mode === "upload" ? "a file has no words to rewrite"
        : "this one is an action, not text",
    }),
    act("fix", "fix its files & send", {
      disabledReason: e.answer || e.mode === "upload" ? "there are no words on this row to rewrite" : undefined,
    }),
    // Only the one verdict this is honestly an answer to: the desktop typed it
    // in and could not read the screen back to say whether it landed. The
    // other failure verdicts (`refused`, `unsubmitted`, a stale fingerprint)
    // already know what happened — this button would be asserting something
    // the row's own words already contradict.
    ...(e.failState === "unconfirmed" ? [act("confirmDone", "save as done", {
      disabledReason: confirming ? CONFIRMING_WHY : locked ? "already on its way" : undefined,
    })] : []),
    act("discard", "discard", { danger: true, alwaysShown: true, disabledReason: locked ? "already on its way" : undefined }),
  ];
  if (e.sessionId && !e.sessionId.startsWith("create:")) {
    actions.push(act("open", "open the session", {
      alwaysShown: true,
      disabledReason: gone ? "that session is gone" : undefined,
    }));
  }

  const head = clip(kind === "answer" && e.answer ? `${e.answer.label} — ${e.answer.question}` : prose);
  return {
    key: queueRowKey(e.ackId),
    id: e.ackId,
    source: "queue",
    kind,
    state,
    bucket: bucketOf(state, reason),
    blockReason: reason,
    verdict,
    ...head,
    fullText: kind === "upload" || kind === "answer" ? null : prose,
    attachText,
    where: deps.laneLabel(e),
    cwd: e.cwd || null,
    sessionId: e.sessionId.startsWith("create:") ? null : e.sessionId,
    delivery: e.status === "failed" ? deliveryOf(e.failState) : null,
    at,
    createdAt: e.ts,
    dueAt: null,
    // Never stale: this row IS the phone's own copy, not a cache of the host's.
    asOf: null,
    progress: null,
    targets: [],
    lastRun: null,
    attempts: e.attempts ?? 0,
    actions,
    subject: { source: "queue", entry: e },
  };
}
