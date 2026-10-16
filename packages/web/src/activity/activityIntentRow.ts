import {
  AGENT_POSTED_WORDS,
  type FanoutRun,
  type Intent,
  type Lifecycle,
  SPENT_ONCE_TEXT,
  describeRule,
  intentKind,
  isAgentPosted,
  isTimedWorkRow,
  queuesBacklogItem,
} from "@waterplane/shared";
import { QUEUES_ITEM_RUN_NOTE, SKIP_QUEUE_BUSY_NOTE, busyInCheckout, skipQueueNote } from "../sendIntent.ts";
import {
  KIND_ACTIVITY,
  KIND_SOURCE,
  intentProse,
  intentTitle,
  intentVerdictText,
  resultSaysPlace,
  spentOnce,
} from "./activityIntentWords.ts";
import {
  act,
  baseName,
  clip,
  intentRowKey,
  needsLink,
} from "./activityPieces.ts";
import {
  bucketOf,
} from "./activityBucket.ts";
import type { ActivityAction, ActivityInput, ActivityRow } from "./activityTypes.ts";

export function intentRow(i: Intent, input: ActivityInput, run: FanoutRun | null): ActivityRow {
  const { online, now, deps } = input;
  const kind = intentKind(i);
  const source = KIND_SOURCE[kind];
  const reason = i.blockReason ?? null;
  const prose = intentProse(i);
  const spent = kind === "schedule" && spentOnce(i, now);
  const head = clip(intentTitle(i));
  const session = input.sessions?.find((s) => s.id === i.sessionId);

  /** What every verb other than *delete* and *edit* says on a spent one-off.
   *  Stated once: three buttons refuse for exactly the same reason. */
  const spentBlocker = spent ? SPENT_ONCE_TEXT : null;
  const terminal = i.state === "done" || i.state === "failed" || i.state === "canceled";
  const live = i.state === "running" || i.state === "starting";
  /**
   * *run it now* reaches `runNow`, which skips the whole queue — so it says
   * so, and into a checkout another agent is already working in it SAYS that
   * too, as text. It never asks: it is the manual override, one tap, always
   * (the two-tap confirm disarmed on a timer, so a tap only ever armed it).
   * Only a row that opens a session of its own can start a second one.
   */
  // A sweep (`repos`) or a follow-up (`sessions`) is N places, which neither
  // sentence describes — those say nothing rather than the wrong thing.
  // A standing rule whose action QUEUES a backlog item is repo-targeted too,
  // but its run only adds a row that waits its turn: nothing is skipped and no
  // second agent starts, so it says that and never asks.
  const ownSession = i.target.kind === "repo";
  const skipQueue = queuesBacklogItem(i) ? { note: QUEUES_ITEM_RUN_NOTE } : ownSession || i.target.kind === "session" ? {
    note: ownSession && busyInCheckout(i.cwd, input.intents ?? [], i.id, input.sessions)
      ? `${skipQueueNote(ownSession)} — ${SKIP_QUEUE_BUSY_NOTE}`
      : skipQueueNote(ownSession),
  } : {};

  /**
   * WHERE it is going, said the way the rest of the app now says it.
   *
   * A repo target used to render as the bare repo name, which was true of five
   * different destinations at once — the repo's shared backlog conversation, a
   * session opened for this item, a `--continue` of the last one. It is one
   * destination now, and the row says which conversation rather than leaving
   * the reader to work it out: *in a new session*, *picking up the last
   * conversation*, or the session's own title once one exists.
   *
   * `session` wins wherever there IS one: a running row has a real session and
   * naming it is what makes the row tappable through to a terminal. The
   * fragments below are what a row says before that — which is most of the life
   * of a queued one, and the whole life of one that never ran. And never what the
   * RESULT beside it already says: once a fresh row has run, its result names the
   * repo and the session it opened (`resultSaysPlace`), and the line read
   * `todo-garden · in a new session` over `ran in todo-garden · a session of its
   * own`. *picking up the last conversation* stays: no result sentence says it.
   */
  /** …and, on a row an AGENT posted through the host's loopback route, that an
   *  agent did (`AGENT_POSTED_WORDS`, the backlog row's words too). */
  const agentFragment = isAgentPosted(i) ? AGENT_POSTED_WORDS : "";
  /**
   * …and, on a one-off with a CLOCK, what that clock is. Such a row is `work`
   * (recurrence, not trigger kind, decides the list): work verbs, titled by its
   * prose, and without this the one thing that sets it apart — it waits for
   * Saturday, not for its turn — was nowhere on the row. Its bucket says
   * *scheduled* and sorts by `dueAt`; this says WHY. `describeRule` is shared,
   * never re-worded: the backlog chip, the Schedules directory line and this
   * fragment are one rule said one way.
   */
  const clockFragment = isTimedWorkRow(i) && i.trigger.kind === "at" ? describeRule(i.trigger.rule) : "";
  const repo = deps.repoName(i.cwd);
  const placeSaid = i.target.kind === "repo" && resultSaysPlace(i.result?.detail, repo);
  const place = i.target.kind === "repos" ? `${i.target.dirs.length} ${i.target.dirs.length === 1 ? "repo" : "repos"}`
    : i.target.kind === "sessions" ? `${i.target.sessionIds.length} sessions`
    : session?.title
      ?? (i.target.kind === "repo"
        ? i.resume ? `${placeSaid ? "" : `${repo} · `}picking up the last conversation` : placeSaid ? "" : `${repo} · in a new session`
        // A row aimed at a live session it has not reached yet: name the
        // session it is WAITING for, not the repo it happens to be in. `in <x>`
        // rather than the bare title, because the repo name is already the
        // reader's anchor and a lone title reads as a second repo.
        : i.target.kind === "session"
          ? `in ${input.sessions?.find((s) => s.id === (i.target as { sessionId: string }).sessionId)?.title ?? repo}`
          : repo);
  const where = [place, agentFragment, clockFragment].filter(Boolean).join(" · ");

  const needs = i.trigger.kind === "files" ? i.trigger.needs : null;
  const fu = run?.followUps;
  const lastFollowUp = fu?.length ? fu[fu.length - 1] : null;
  const arts = i.result?.artifacts ?? [];

  const actions: ActivityAction[] = [];
  if (kind === "launch") {
    actions.push(
      act("runNow", "open it without the files", {
        primary: i.state === "blocked",
        disabledReason: i.state === "blocked" ? needsLink(online, "opening it") : "it is not waiting any more",
      }),
      act("cancel", "call it off", {
        danger: true,
        disabledReason: !terminal ? needsLink(online, "calling it off") : "it is not waiting any more",
      }),
    );
  } else if (kind === "schedule") {
    actions.push(
      // `runNow` deliberately does NOT spend the next occurrence — the host's
      // rule, restated here so the label cannot promise otherwise.
      // A spent one-off can still be RUN — the host revives the row in place and
      // fires it (`IntentManager.runNow`), and a schedule missed while the
      // desktop slept is exactly the one you want to fire by hand. This screen
      // refused it with `spentBlocker` while the schedule sheet offered it: one
      // row, two surfaces, opposite answers about the same tap.
      act("runNow", "run it now", {
        primary: true,
        disabledReason: live ? "it is firing" : needsLink(online, "running it"),
        ...skipQueue,
      }),
      act("toggle", i.nextAt != null ? "switch it off" : "switch it on", {
        disabledReason: spentBlocker ?? needsLink(online, "the switch"),
      }),
      act("edit", "edit the schedule", { disabledReason: needsLink(online, "an edit") }),
      act("cancel", "delete it", { danger: true, disabledReason: needsLink(online, "deleting it") }),
    );
  } else if (kind === "fanout") {
    const openable = run?.targets.find((t) => t.sessionId);
    actions.push(
      act("open", "open a session from it", {
        primary: true,
        disabledReason: openable ? undefined : "no session was opened by this sweep",
      }),
      act("sendNow", "send a follow-up to these sessions", {
        disabledReason: openable ? needsLink(online, "a follow-up") : "no session is left to drive",
      }),
    );
  } else if (kind === "build" || kind === "capture") {
    // One arm for both: a capture's three verbs are a build's three verbs. Its
    // artifacts are the frames and the sidecar under `.claude/outbox/`, fetched
    // by the same download action, and `intent.cancel` stops either one.
    actions.push(
      // No `needsLink` here on purpose: a download is HTTP plus a local queue
      // (`download.ts`), not a socket message. It is queued with the link down
      // and resumes on its own.
      act("download", arts.length === 1 ? "download what it made" : `download (${arts.length})`, {
        primary: arts.length > 0,
        disabledReason: arts.length ? undefined : "it produced no file to fetch",
      }),
      act("cancel", "stop it", {
        danger: true,
        disabledReason: live ? needsLink(online, "stopping it") : "it is not running",
      }),
      act("runNow", "run it again", { disabledReason: needsLink(online, "a run") }),
    );
  } else {
    actions.push(
      act("sendNow", "run it now", {
        primary: i.state === "queued" || i.state === "blocked",
        disabledReason: live ? "it is running" : i.state === "done" ? "it already ran" : needsLink(online, "running it"),
        ...skipQueue,
      }),
      // "Was this really lost, or did somebody implement it anyway?" — the
      // question a row that failed weeks ago is read with, and the only thing
      // on this screen that can answer it without spending the prompt again.
      //
      // Its "a check is already running" refusal is GONE from here on purpose:
      // `review.ts` refuses a second check on the same id itself, so the phone
      // was carrying a second copy of a guard the host enforces — and carrying
      // it meant shipping `checkStatus` in a DTO for no other reason.
      act("check", "check whether it is already done", {
        // On a failed row this outranks running it again, and deliberately: a
        // prompt that never went is re-fired on the assumption the work is
        // undone, and that assumption is exactly what is worth testing first.
        primary: i.state === "failed",
        disabledReason: needsLink(online, "a check"),
      }),
      act("edit", "rewrite it", {
        disabledReason: live ? "it is running — rewriting it now would change work already in flight" : needsLink(online, "an edit"),
      }),
      act("retarget", "aim it at another session", {
        disabledReason: live ? "it is running" : needsLink(online, "a re-aim"),
      }),
      act("toggle", i.pinned ? "stop firing it on its own" : "fire it on its own", {
        disabledReason: terminal ? "it has already run" : needsLink(online, "the switch"),
      }),
      act("discard", "remove it", { danger: true, alwaysShown: true, disabledReason: needsLink(online, "removing it") }),
    );
  }
  if (i.sessionId) {
    actions.push(act("open", "open the session", {
      alwaysShown: true,
      disabledReason: session ? undefined : "that session is not open any more",
    }));
  }

  const verdict = intentVerdictText(i, kind, now, run);
  const said = !!i.result?.detail && verdict.includes(i.result.detail);
  return {
    key: intentRowKey(i.id),
    id: i.id,
    source,
    kind: KIND_ACTIVITY[kind],
    // Taken, not inferred. The whole point of the file.
    state: i.state,
    bucket: bucketOf(i.state, reason),
    blockReason: reason,
    verdict,
    ...head,
    fullText: prose,
    // A shell command is not prose: it names build outputs at most, and those
    // are what the `download` action is for.
    attachText: kind === "build" ? null : prose,
    where,
    cwd: i.cwd || null,
    sessionId: i.sessionId ?? null,
    // None, even done: `done` IS "it reached the session", which sat under "ran in …" — twice.
    delivery: null,
    at: i.settledAt ?? i.startedAt ?? i.createdAt,
    createdAt: i.createdAt,
    dueAt: i.trigger.kind === "at" ? i.nextAt ?? null
      : i.trigger.kind === "files" && i.state === "blocked" ? i.trigger.deadlineAt
      : null,
    asOf: online ? null : input.hostSeenAt,
    progress: needs?.length
      ? { done: needs.length - (i.missing?.length ?? 0), total: needs.length, label: "files" }
      : run
        ? { done: run.targets.filter((t) => t.status === "done").length, total: run.targets.length, label: "repos" }
        : null,
    targets: run
      ? run.targets.map((t) => ({
          label: t.title || baseName(t.dir),
          sessionId: t.sessionId,
          state: FANOUT_TARGET_STATE[t.status] ?? "queued",
          detail: t.error,
        }))
      : [],
    // A sweep's "last thing that happened" is its newest FOLLOW-UP, not the
    // parent row's own result: the follow-ups are children folded into the run
    // (`fanoutRuns`), so without this the one row that represents them says
    // nothing about them at all.
    //
    // …and never the row's own result said again. A settled row's verdict IS `result.detail`,
    // or quotes it (an old failure, framed so its errand is not re-issued — unframed here, it
    // was), and its head carries the age: the words drop off, the line too unless `(late)`.
    lastRun: lastFollowUp
      ? { at: lastFollowUp.at, ok: true, detail: `follow-up sent to ${lastFollowUp.dirs.length} of them` }
      : i.result && !(said && terminal && !i.result.late)
        ? { at: i.result.at, ok: i.result.ok, detail: said ? "" : i.result.detail, late: i.result.late }
        : null,
    attempts: i.attempts ?? 0,
    actions,
    subject: { source: "intent", intent: i, run },
  };
}

const FANOUT_TARGET_STATE: Record<string, Lifecycle> = {
  pending: "queued", starting: "starting", running: "running", done: "done", failed: "failed",
};
