/**
 * The send queue's pure half: the timing constants, the pending-session id
 * scheme, and the handful of derivations the queue core and its bars share.
 * No React, no socket, no storage — `logic.test.mjs` runs it under `node --test`.
 */
import { retryDelay, sessionBudgetHeld, withFirstSentAt } from "@waterplane/shared";
import type { ClientMessage, SessionInfo } from "@waterplane/shared";
import type { OutboxEntry } from "../../outbox";
import { entryProse } from "../../activityRows.ts";

/** How long one delivery attempt may go unacknowledged before it goes back in
 *  the queue. Short: the host acks as soon as it has written to the PTY, so a
 *  silent window this long means the socket, not the host, is the problem. */
export const ACK_TIMEOUT_MS = 6000;
/** An OP's receipt window. The host answers `op.ack` as soon as it has ACCEPTED
 *  the action (a create is synchronous there), so this is pure round-trip
 *  budget — and a phone reaching the host through a DERP relay on a bad radio
 *  regularly needs more than the 6 s a keystroke gets. Too short here does not
 *  merely delay the op: every expired window burns one of MAX_SEND_ATTEMPTS,
 *  and eight of them go in under a minute, so "open a session here" ended up
 *  permanently failed ("delivery kept failing · 8 attempts") while the link was
 *  still coming back. */
export const OP_ACK_TIMEOUT_MS = 20000;
/**
 * A VERIFIED compose send's receipt window — the `submit` path, where the host
 * runs the same `deliverPrompt()` the backlog and the fan-out use: wait for the
 * TUI to reach its prompt (up to 45 s on a loaded machine), type, confirm the
 * echo on the rendered screen, press Return and prove the turn started.
 *
 * So this is not round-trip budget like the two above — the receipt is not even
 * ATTEMPTED until all of that has finished, and sizing it like a keystroke's
 * would requeue a delivery that is working perfectly, over and over, until the
 * entry burned its eight attempts and failed while the prompt was in fact
 * running. Generous on purpose; a socket that actually dies is caught by the
 * disconnect requeue below, not by this deadline.
 */
export const SUBMIT_ACK_TIMEOUT_MS = 90000;
/** How long the queue bar stays up after the last entry settles. Long enough to
 *  swallow the gap between two sends (and to show "sent"), short enough that it
 *  is out of the way before the next glance. */
export const QUEUE_BAR_LINGER_MS = 1500;
/** Same, for the upload row inside the composer. Shorter: it carries no verdict
 *  worth reading, it is only there to keep the composer from resizing between
 *  one file and the next. */
export const UPLOAD_ROW_LINGER_MS = 900;

/** Backstop sweep for the send queue — the reconnect flush is the main trigger,
 *  this catches an entry queued while the socket was mid-handshake. */
export const FLUSH_SWEEP_MS = 5000;
/**
 * No upload progress for this long ⇒ the transfer is wedged, abort it and put it
 * back in the queue.
 *
 * An upload is the one queue mode with no ack timeout (it settles itself), and
 * the disconnect requeue deliberately skips it — so a POST that neither resolves
 * nor rejects held its lane forever, with the prompt naming the file stuck
 * behind it, and only a page reload (the mount sweep) ever recovered it. XHR's
 * own `timeout` is the wrong tool: it bounds the WHOLE request, so a legitimate
 * 60 MB upload on a slow link would be killed halfway. This bounds SILENCE
 * instead — the progress callback resets it, so a slow-but-moving transfer runs
 * as long as it needs.
 */
export const UPLOAD_STALL_MS = 45000;
/** Gap before the next queued message for the SAME session goes out. The host
 *  submits the prompt itself now (and only answers once it has), so by the time
 *  a receipt lands the Return is already consumed — this is the TUI's breathing
 *  room, so the next prompt lands in an empty composer rather than glued to the
 *  last line. */
export const LANE_GAP_MS = 450;

/** How many undelivered rows the bar names before it stops and offers the
 *  list. Three fits a phone without the bar eating the terminal above it; a
 *  fourth line is what the sheet is for. */
export const WHICH_MAX = 3;

// ── The pending session (`pending:<createAck>`) ────────────────────────────

export const PENDING_PREFIX = "pending:";
export const isPendingId = (id: string | null | undefined): boolean => !!id?.startsWith(PENDING_PREFIX);
export const pendingLaneId = (ackId: string) => `${PENDING_PREFIX}${ackId}`;
/**
 * **The later screen** (`pending:later:<cwd>`) — the repo header's `+ later`.
 * The same session screen as `+ now`, for words whose session starts only when
 * the backlog item they become runs: nothing is queued until Send, so there is
 * no create behind it, and the terminal area says so instead of drawing one.
 * A `pending:` id on purpose — every guard that keeps a synthetic id off the
 * host (attach, resize, kill, star, the key pipe) already reads that prefix.
 * Per REPO, not per tap: the draft is keyed by session id, so reopening
 * `+ later` finds the words left there.
 */
export const LATER_PREFIX = `${PENDING_PREFIX}later:`;
export const isLaterId = (id: string | null | undefined): boolean => !!id?.startsWith(LATER_PREFIX);
export const laterId = (cwd: string) => `${LATER_PREFIX}${cwd}`;
/** The send-queue lane for a target: a pending session's screen id is not a
 *  lane, its create's is (`create:<cwd>`), which is where the prompts and the
 *  files behind that create already queue. */
export const laneFor = (id: string, cwd: string) => (isPendingId(id) && cwd ? `create:${cwd}` : id);

// ── Receipts and retries ──────────────────────────────────────────────────

/**
 * How long this entry's receipt may take before we put it back in the queue.
 *
 * Three different questions, so three different budgets:
 *   • a verified `input` — the host does not even try to answer until it has
 *     typed the prompt and proven the turn started, which legitimately takes
 *     tens of seconds on a booting TUI. Nothing adaptive is useful here; the
 *     delivery, not the link, dominates.
 *   • an `op` — the host acks on ACCEPT, so this is pure round-trip budget,
 *     and a fixed 20 s is wrong in both directions on a real phone. Size it
 *     from the MEASURED p95 ping (netlog.ts): on a direct Tailscale path that
 *     leaves the old number alone, and on a DERP-relayed one it stops eight
 *     expired windows from failing an op the host never even heard about.
 *   • everything else keeps the keystroke budget.
 *
 * `attempts` widens the window each time round. A retry that keeps missing the
 * same deadline is evidence the deadline is too small for this link, and the
 * cheapest correct response is to wait longer rather than to spend another of
 * MAX_SEND_ATTEMPTS proving the point.
 *
 * `rtt` is `rttP95()`, passed in so this stays pure.
 */
export function ackWindow(e: OutboxEntry, rtt: number | null): number {
  const tries = e.attempts ?? 0;
  const backoff = 1 + Math.min(3, tries); // 1×, 2×, 3×, 4× and then flat
  if (e.mode === "op") {
    const base = rtt == null ? OP_ACK_TIMEOUT_MS : Math.max(OP_ACK_TIMEOUT_MS, Math.min(120000, rtt * 6));
    return base * backoff;
  }
  if (e.mode === "backlog" || e.mode === "upload") return ACK_TIMEOUT_MS * backoff;
  return SUBMIT_ACK_TIMEOUT_MS;
}

/**
 * Put a failed attempt back in the queue, with a BACKOFF.
 *
 * `wasted` (nothing on the other end could have answered) rolls the attempt
 * back, so riding out a dead link never spends `MAX_SEND_ATTEMPTS` — that part
 * is unchanged and deliberate. What it left open is a failure that returns
 * INSTANTLY and forever: the attempt is rolled back, the lane release re-fires
 * the flusher ~450 ms later, and the entry re-attempts at ~2 Hz until its TTL
 * runs out, holding its lane the whole time so everything queued behind it is
 * stuck too. That is exactly what a refused CORS preflight looks like from the
 * client — and it is what made the queue flicker on every surface that renders
 * it while no image could upload and no prompt could go out.
 *
 * So `tries` (never rolled back) sizes a doubling delay and `retryAt` says
 * when the entry may go again; `selectSendable` skips it until then.
 */
export function requeue(x: OutboxEntry, wasted: boolean, now = Date.now()): OutboxEntry {
  const tries = (x.tries ?? 0) + 1;
  return {
    ...x,
    status: "queued" as const,
    attempts: wasted ? Math.max(0, (x.attempts ?? 1) - 1) : x.attempts,
    tries,
    retryAt: now + retryDelay(tries),
  };
}

// `serialStates` and `serialTextFor` live in `./serialStates.ts` (pure, no
// barrel imports) so the activity rows can read them without a cycle.
export { serialStates, serialTextFor } from "./serialStates.ts";

/** Drop an entry's park on an explicit send — keeping it only for the one
 *  entry whose park is not a wait it is serving now (see `flushOutbox`). */
export function unpark(e: { pendingCreate?: boolean; holdUntilIdle?: boolean }): true | undefined {
  return e.pendingCreate && e.holdUntilIdle ? true : undefined;
}

/**
 * The lanes whose session is gone, given a list the caller has already decided
 * to trust (`goneLanes` in the hook says when that is). Only `queued` `input`
 * entries that are not waiting on a create are read — see the hook's comment.
 */
export function goneLanesOf(outbox: readonly OutboxEntry[], liveIds: ReadonlySet<string>, exited: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const e of outbox) {
    if (e.status !== "queued" || e.pendingCreate) continue;
    if ((e.mode ?? "input") !== "input") continue;
    // `session.exit` is the earlier of the two signals and the one that
    // arrives while the list still says `running` — see the case in `onMsg`.
    if (!liveIds.has(e.sessionId) || exited.has(e.sessionId)) out.add(e.sessionId);
  }
  return [...out];
}

// ── How the bars word a row ───────────────────────────────────────────────

/** Group label for the queue sheet: the live session, else the repo folder.
 *  An op lane is not a session at all (`create:…` / `fanout` / `fu:…` /
 *  `build:…`), so it gets named after what it will DO. */
export function laneLabelOf(e: OutboxEntry, sessions: readonly SessionInfo[]): string {
  if (e.mode === "op") {
    const dir = e.cwd.split("/").filter(Boolean).pop() ?? "";
    // Firing a schedule by hand SHARES the fan-out lane (a sweep is a herd of
    // claude processes either way, so the concurrency argument is the same) —
    // but it is not a fan-out, and a failed row labelled "Fan-out" over a
    // schedule's name is a row nobody can place. The lane is a queueing
    // decision; this is the sentence a person reads.
    if (e.op?.t === "schedule.run") return "Scheduled run, by hand";
    if (e.sessionId === "fanout") return "Fan-out";
    if (e.sessionId.startsWith("fu:")) return "Fan-out follow-up";
    if (e.sessionId.startsWith("build:")) return `${dir || "repo"} · builds`;
    return `${dir || "repo"} · new session`;
  }
  const s = sessions.find((x) => x.id === e.sessionId);
  if (s) return `${s.title}${e.mode === "backlog" ? " · backlog" : ""}`;
  const dir = e.cwd.split("/").filter(Boolean).pop() ?? e.cwd;
  return `${dir}${e.mode === "backlog" ? " · backlog" : " · session gone"}`;
}

/** Human status for the in-flight sends, with the elapsed seconds of the
 *  OLDEST attempt — the one actually being waited on. */
export function sendingLabel(flying: OutboxEntry[], now = Date.now()): string {
  const started = flying.map((e) => e.sentAt ?? e.ts);
  const oldest = started.length ? Math.min(...started) : now;
  const secs = Math.max(0, Math.round((now - oldest) / 1000));
  const many = flying.length > 1 ? ` (${flying.length})` : "";
  const uploading = flying.some((e) => e.mode === "upload");
  const what = uploading ? "Uploading" : "Sending";
  // Nothing is on the wire right now — an attempt failed and the next one is
  // waiting out its backoff. Say the countdown rather than let the elapsed
  // counter imply a transfer that is not happening.
  const waits = flying.filter((e) => e.status === "queued" && e.retryAt != null).map((e) => e.retryAt!);
  if (waits.length === flying.length && waits.length) {
    // A long round wait (`roundDelay`) is minutes, and "retrying in 1140s" is
    // a number nobody converts. Seconds up to the minute, minutes after it.
    const ms = Math.max(1000, Math.min(...waits) - now);
    const inWords = ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
    // The one row's own words for why it is waiting, when there is one row it
    // can be about — same rule the failed bar follows.
    const why = flying.length === 1 && flying[0].waitReason ? ` — ${flying[0].waitReason}` : "";
    return `${what}${many}…${why ? `${why};` : ""} retrying in ${inWords}`;
  }
  // Past the receipt window the entry is about to be requeued and retried;
  // saying so beats a spinner that looks like it will run forever.
  const overdue = secs >= Math.round(OP_ACK_TIMEOUT_MS / 1000);
  return `${what}${many}… ${secs}s${overdue ? " — no receipt yet, will retry" : ""}`;
}

/** One failed row, in the fewest words that still identify it. `entryProse`
 *  rather than `e.text` — a `session.create` op carries its prompt inside the
 *  op, and reading `text` prints the lane label where the sentence goes. */
export function whichWords(e: OutboxEntry): string {
  const words = entryProse(e).trim().replace(/\s+/g, " ");
  if (!words) return e.mode === "upload" ? "a file" : "an action";
  return words.length > 64 ? `${words.slice(0, 64)}…` : words;
}

/** The sessions whose own budget holds their sends — `sessionBudgetHeld`, the
 *  one predicate both ends ask. Unknown is never in it (a stale reading holds
 *  nothing), so a lane is only ever held on a verdict somebody could see. */
export function budgetHeldLaneSet(sessions: readonly Pick<SessionInfo, "id" | "budget">[]): Set<string> {
  return new Set(sessions.filter(sessionBudgetHeld).map((s) => s.id));
}

/** True when a lane was held and is not any more — the over → ok edge a flush
 *  rides on (`busy → free`'s sibling). A session that merely vanished counts:
 *  its entries are the gone-lane rule's now, and a pass costs nothing. */
export function budgetReleased(prev: ReadonlySet<string>, now: ReadonlySet<string>): boolean {
  for (const id of prev) if (!now.has(id)) return true;
  return false;
}

/**
 * One delivery attempt, recorded on the entry: `pending`, one more attempt,
 * `sentAt` for the send bar's clock — and `firstTryAt` stamped ONCE, on this
 * ackId's first attempt, and never reset. It is what `MIN_TRY_MS` measures
 * (restarting it would make that floor unreachable) and it is the wire's
 * `firstSentAt` (`entryFrame`), which a desktop that lost its ack ledger reads
 * to tell a pre-loss re-send from a new op (`shared/sendstamp.ts`) — so a retry
 * that moved it would turn a refusal back into a second run. `retargetEntry`
 * drops it together with the old ackId.
 */
export function markAttempt(x: OutboxEntry, now: number): OutboxEntry {
  return {
    ...x, status: "pending" as const, attempts: (x.attempts ?? 0) + 1, sentAt: now,
    firstTryAt: x.firstTryAt ?? now,
    // Something is on the wire again — whatever the last round was waiting for
    // stops being the current answer to "why the wait?".
    waitReason: undefined,
  };
}

/**
 * The socket frame for one attempt of an entry (after `markAttempt`), or null
 * when there is nothing to write (an upload is an HTTP POST; an op row with no
 * payload). Every frame carries `firstSentAt` = the entry's `firstTryAt`, the
 * same on every retry of the same ackId; `web/ws.ts` adds `sentAt` at the write.
 */
export function entryFrame(e: OutboxEntry): ClientMessage | null {
  const firstSentAt = e.firstTryAt;
  if (e.mode === "upload") return null;
  if (e.mode === "op") {
    // A durable ACTION, sent verbatim: the payload was frozen (ackId and all)
    // when it was queued, so a re-send after a reload is the same message and
    // the host's persisted ledger re-acks it instead of starting a second
    // session / sweep / build. Deliberately NO session.record (nothing was
    // typed) and NO submitting Return — an op settles in `op.ack`, not in a
    // composer. The stamp rides on top of the frozen payload, not inside it,
    // so the stored op stays byte-identical.
    if (!e.op) return null;
    return firstSentAt == null ? e.op : withFirstSentAt(e.op, firstSentAt);
  }
  if (e.mode === "backlog") {
    // Durable work item: the host de-dupes on the same ackId, so a reconnect
    // re-send can't add it twice (host `routes/work.ts` "backlog.add").
    return {
      t: "backlog.add", text: e.text, repoDir: e.cwd, label: e.label ?? e.text.slice(0, 40),
      fire: e.fire, targetSessionId: e.targetSessionId, autoFire: e.autoFire, ackId: e.ackId, firstSentAt,
      // Additive, v1: an older desktop ignores both and runs `text`, which
      // is `steps[0]` — turn one of the chain, never nothing.
      steps: e.steps, resume: e.resume,
      // Additive, v1: absent inherits the global setting on the desktop.
      ...(typeof e.closeWhenDone === "boolean" ? { closeWhenDone: e.closeWhenDone } : {}),
      // Additive: an older desktop ignores it and the session is not flagged.
      ...(e.flagWhenDone ? { flagWhenDone: true } : {}),
      // Additive: an older desktop ignores it and the item runs uncapped.
      ...(e.budget ? { budget: e.budget } : {}),
      // Additive: an older desktop ignores it and opens on its own defaults.
      ...(e.launch ? { launch: e.launch } : {}),
      // Additive: an older desktop ignores it and the row waits for the budget.
      ...(e.pastBudget ? { pastBudget: true } : {}),
    };
  }
  if (e.answer) {
    // An ANSWER to a question box: raw keystrokes, not prose. No `submit`
    // (there is no composer to echo-check and no Return to prove — the digit
    // IS the submit for a single-choice box), and `expectPrompt` so the host
    // writes nothing if that question is no longer the one on screen. That
    // guard is what lets this entry have been sitting in localStorage since
    // before the tunnel came back.
    //
    // `promptSubmit` is the exception to "the digit IS the submit": a checkbox
    // box confirms on its own Submit ROW, so the host has to put the cursor
    // there before the Return — which is a thing only the side that can see
    // the screen can do.
    //
    // `promptChoice` is the second exception, and the stronger one: an
    // opencode permission box has no digits at all, so there is no keystroke
    // this side could send. The entry names the option and the host walks the
    // selection there against the rendered screen. Same reason as
    // `promptSubmit` — only the side that can see the screen can do it — and
    // the client knows to use it because the published box said `nav`, never
    // because it knows which binary drew the dialog.
    return { t: "session.input", id: e.sessionId, data: e.text, ackId: e.ackId, firstSentAt, expectPrompt: e.answer.fingerprint, promptSubmit: e.answer.submitBox, promptChoice: e.answer.choice };
  }
  // `submit: true` — the host types it, checks the echo, presses Return and
  // proves the turn started (deliver.ts), then acks. The client used to own
  // that Return: a bare, unacked `session.input "\r"` fired 50 ms AFTER the
  // receipt, i.e. after this entry had already been dropped from the queue. A
  // socket that died in between left the prompt sitting in the composer with
  // nothing left to retry and a UI that said "sent" — the lost-prompt bug. No
  // `session.record` either: the host records it, and only when the text
  // provably echoed, so history stops listing prompts that never ran. `cwd` is
  // a HINT, read only if the session turns out to be gone: the host then keeps
  // the words as a work item in that repo instead of refusing (`state:
  // "rescued"`). The rescue used to live here — a grace timer on the PHONE's
  // clock, which only ticks while a tab is foregrounded, i.e. never on the
  // device this queue exists for.
  return { t: "session.input", id: e.sessionId, data: e.text, ackId: e.ackId, firstSentAt, submit: true, cwd: e.cwd, view: e.view };
}
