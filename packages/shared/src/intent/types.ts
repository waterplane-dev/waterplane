/**
 * The Intent's VOCABULARY: its lifecycle words, the block reasons, what it
 * carries (payloads), where it goes (target), when (trigger), how it ended
 * (result), each time it was put back (requeue), and the two budget records a
 * row may carry (`BudgetPass`, `BudgetWaiver`).
 *
 * A slice of `../intent.ts`, which is the one door into the intent model —
 * import from there, never from here. Layout and import order:
 * docs/notes/shared-architecture.md.
 */

import type { BuildArtifact } from "../wire/work.js";
import type { CaptureBackendId } from "../wire/capture.js";
import type { ScheduleRule } from "../schedule.js";

// ── The vocabulary ───────────────────────────────────────────────────────────

/**
 * The ONE lifecycle. Fourteen enums across six subsystems collapse to these
 * seven, and `cancelled`/`canceled` is one spelling from here on.
 *
 * `blocked` is deliberately a state and not a flag on `queued`: a row that is
 * waiting for a reason the user could act on looks different on screen from one
 * that is simply next in line, and the difference is the whole point of the
 * Activity sheet. It is also the only state recomputed every tick and never
 * trusted from disk — see `IntentVerdict`.
 */
export type Lifecycle = "queued" | "blocked" | "starting" | "running" | "done" | "failed" | "canceled";

/**
 * Why a blocked intent is blocked.
 *
 * Lifecycle and delivery truth are separate axes and are never interleaved
 * again: nothing here says anything about whether a prompt that DID go out was
 * confirmed. That is `DeliveryTruth`'s job, and mixing the two is how
 * `unconfirmed` became a terminal state that ate 65 deliveries.
 */
export type BlockReason =
  /** Produced ONLY by the phone: the intent has not reached the host at all.
   *  It is not a failure and it never expires — it is a row that says so. */
  | "offline"
  /** A user switch says no: auto-fire is off, or a recurring rule is disabled. */
  | "gate"
  /** The account is past the usage ceiling (`shared/budget.ts`). */
  | "budget"
  /** The target session's OWN budget is spent (`sessionbudget.ts`) — held until
   *  it is raised or cleared. Distinct from `budget`, which is the account's. */
  | "sessionBudget"
  /** The target session is mid-turn, or another intent already holds it. */
  | "sessionBusy"
  /** The target session no longer exists. */
  | "sessionGone"
  /** A question box or an unparsable dialog is up in the target. */
  | "awaitingAnswer"
  /** The target session is parked on a usage limit, waiting for the reset. */
  | "limit"
  /** The `files` trigger's paths are not all on disk yet. */
  | "filesMissing"
  /** The `at` trigger's instant has not arrived. */
  | "notYet"
  /** One at a time in this working directory, and another intent holds it. */
  | "serial"
  /** `holdForHost`: something else is starting or running, anywhere. */
  | "hostBusy"
  /** Every automatic session this desktop runs at a time is in use, and this
   *  row's whole job is to OPEN one. The cap that used to be a refusal string
   *  inside the host's `openBacklogSession`, said as a wait a row can wear. */
  | "noSlot"
  /**
   * This repo's waiting items are being looked over before one of them is
   * picked — the *smart pick* tick-box.
   *
   * A WAIT and never a refusal: the row is next, everything else has said yes,
   * and the only thing between it and firing is a few seconds of a cheap
   * headless pass deciding whether a different item should go first. It is a
   * `blocked` row rather than a `starting` one on purpose — a held row claims
   * no cwd, no `hostBusy` and no automatic-session slot, so every other repo
   * keeps moving while one repo thinks.
   *
   * Self-resolving, with nothing for a person to press: the pass has a watchdog
   * and every way it can end — an answer, a timeout, a failure, a usage limit —
   * clears the hold and fires the item, in the worst case in exactly the order
   * it would have had without the feature.
   */
  | "picking";

// ── What an intent IS ────────────────────────────────────────────────────────

/**
 * Prose for an agent.
 *
 * `steps` rather than one string because a chain is delivered one turn at a
 * time and must never be concatenated (the pad's shape). Everything that reads
 * an intent as a single prompt reads `steps[0]`, which is how a chained intent
 * degrades rather than breaks.
 */
export interface IntentPayload {
  kind: "prompt";
  /** Full text, NEVER clipped. `steps[0]` is the first turn. */
  steps: string[];
}

/** A build command: no agent, no session, no tokens — the rate-limit escape
 *  hatch, run by `builds.ts` against a per-repo definition. */
export interface BuildPayload {
  kind: "build";
  buildId: string;
  /** The build's NAME, COMMAND and working dir as they were at fire time.
   *  Snapshotted rather than looked up, because `builds.json` is edited between
   *  runs and a run row that renames itself weeks later is a lie about what
   *  ran. This is what `BuildRun.name`/`cmd`/`cwd` have always meant. */
  name?: string;
  cmd?: string;
  cwd?: string;
  /** The parameter values the run was fired with, snapshotted for `cmd`'s
   *  reason and one of its own: `cmd`/`cwd` above are already substituted, so
   *  this is what the executor still needs to export as `WATERPLANE_PARAM_*` — and it
   *  must survive the round trip through disk, or a run reconciled after a
   *  restart re-spawns the same command line with the environment missing. */
  params?: Record<string, string>;
}

/**
 * A repo assessment: go through everything still open for this repo and say,
 * per item, whether it is already done, obsolete, superseded, part of one
 * merged job, or still wanted — with evidence.
 *
 * Carries no fields. `cwd` is on the intent and the run id IS the intent id,
 * the same arrangement `BuildPayload` uses for `BuildRun.runId` — a second
 * identifier for one row is a second thing that can disagree. What the run
 * produced lives in its own sidecar (`.waterplane/assess.json`, keyed by this id),
 * for `reviews.json`'s reason: a proposal is not lifecycle, it outlives the run
 * that made it, and putting it here would put fields on every intent that one
 * sheet reads.
 */
export interface AssessPayload {
  kind: "assess";
  /**
   * **The cut this run was asked about** — absent means the whole repo, which
   * is what every run before this field was and what an older client still
   * sends.
   *
   * It is on the PAYLOAD, not merely in the message that started it, because
   * the scope is part of what the run IS: the row is on disk before the tap
   * returns and the executor may not run until after a restart, and a run that
   * came back from disk having forgotten it was scoped would read a whole repo
   * somebody asked a question about seven rows of — an unattended spender doing
   * nine times the work it was told to, with nothing on the row to show why.
   *
   * These are ASSESSABLE row ids. They narrow what the run may form a verdict
   * about; they do not narrow the finished rows that go in as context, which
   * are evidence rather than candidates and which `cleanAssessment` already
   * refuses to let a verdict name.
   */
  ids?: string[];
}

/**
 * A verified capture: take a picture of a running screen and say how much the
 * picture can be trusted. No agent, no session, no tokens — `builds.ts`'s class
 * of work, run by `capture.ts` against a per-repo target definition.
 *
 * `name` and `backend` are snapshotted at fire time for `BuildPayload`'s reason:
 * `.waterplane/capture.json` is edited between runs, and a row that renames itself —
 * or worse, re-labels itself with a different backend — weeks later is a lie
 * about what ran. Both are optional so a row written by an older host still
 * loads; the run degrades to showing the id, never to showing the wrong name.
 *
 * What the run PRODUCED (the verdict, the frames, the evidence) lives in a
 * sidecar JSON in `.claude/outbox/` keyed by this id, for `AssessPayload`'s
 * reason: evidence is not lifecycle, it outlives the run, and putting it here
 * would put capture fields on every intent that Activity renders.
 */
export interface CapturePayload {
  kind: "capture";
  targetId: string;
  name?: string;
  backend?: CaptureBackendId;
  /** Keep capturing until cancelled, emitting a frame only past the target's
   *  diff threshold. */
  watch?: boolean;
}

/** Where the work lands. */
export type IntentTarget =
  /**
   * One named, live session.
   *
   * `resumeConvId` is the CLI CONVERSATION that session was driving
   * (`SessionInfo.claudeSessionId`), snapshotted by the host when the row was
   * made. A session id lasts as long as the process; a conversation outlives
   * it, so this is the difference between a row that comes due days later
   * finding its target gone for ever (`sessionGone`, a wait nothing in the
   * store resolves) and one that reopens EXACTLY the conversation it was aimed
   * at — `--resume <id>`, the same argv `doResurrect` uses, never "the newest
   * session in that directory".
   *
   * Only a CLOCK row spends it (`reopensConversation`): a row aimed at a
   * session for *now* or *when it's free* is about a process that exists at the
   * moment it was written, and reopening a conversation on behalf of one of
   * those would put a second agent in the worktree every time a host restart
   * took the sessions with it.
   *
   * Absent means nobody snapshotted one — an opencode session (whose id is not
   * a claude conversation), a session too young to have published its id, or a
   * row written before this field existed. Absent degrades to the old
   * behaviour, never to a guessed conversation.
   */
  | { kind: "session"; sessionId: string; resumeConvId?: string }
  /**
   * This repo, in a session opened FOR this piece of work (`fresh`).
   *
   * `fresh` stays optional because rows written before it existed are still on
   * disk and still have to be answerable — but nothing PRODUCES a non-fresh
   * repo target any more: `cleanTarget` normalises it on the way in, for the
   * reason written there, and rung 5 keeps the old reading only so a row that
   * predates the normalisation still gets a sentence instead of a crash.
   */
  | { kind: "repo"; fresh?: boolean }
  /** A sweep: one prompt, a fresh session in each of N repos. */
  | { kind: "repos"; dirs: string[] }
  /** A fan-out follow-up: re-drive sessions that already exist, spawn nothing. */
  | { kind: "sessions"; sessionIds: string[] }
  /** A shell command in `cwd`. No agent is involved at all. */
  | { kind: "shell" };

/** When the work may start. */
export type IntentTrigger =
  /** As soon as the target can take it. */
  | { kind: "now" }
  /** Same, but the wait is the point — see `intentVerdict`'s rung 3 note. */
  | { kind: "idle" }
  /**
   * A wall clock, once or recurring.
   *
   * `graceMin` is how late a missed occurrence may still START; 0 means skip it
   * unless it can start within `ON_TIME_MS` of the moment it was allowed to —
   * there is no timer at the instant itself, so a grace with no floor under it
   * means never.
   *
   * **The deadline is spent only while nothing has cleared the row to run.** It
   * used to be plain wall clock — "time this row spends held on a lower rung (a
   * busy repo, a full desktop, a paused account) is spent out of it" — and that
   * documented behaviour was a BUG, not a design: a `waitUntilFree` rule that
   * rung 3 had already released was failed by the very wait it had been told to
   * perform, and blamed the desktop for it. The real case is in
   * `Intent.clearedOccurrence`. So: the grace governs the window in which a row
   * may be CLEARED to start, and once it has been, only `HELD_MAX_MS` can still
   * expire it. Set `graceMin` as "how long is this still worth starting", which
   * is what the send sheet's chips have always said it is.
   */
  | { kind: "at"; rule: ScheduleRule; graceMin: number; keepAfterRun?: boolean }
  /** The files the prompt names, and the instant we stop waiting for them. */
  | { kind: "files"; needs: string[]; deadlineAt: number }
  /** When the usage window allows it again. */
  | { kind: "budget" }
  /**
   * When ANOTHER intent has finished — a chain across rows, and across repos.
   *
   * The two triggers that already existed for "not yet" both answer to the
   * world: a clock, or the state of one session. Neither can say "when the
   * migration finishes, review it", which is the commonest real dependency
   * there is and which people were expressing by guessing a wall clock far
   * enough out — a guess that is either wasteful or wrong, and silently wrong
   * in the direction of running a review over a half-finished migration.
   *
   * `id` is the predecessor's intent id, which is stable for that row's whole
   * life (`Intent.id`). `onlyIfOk` is the difference between "afterwards" and
   * "if it worked": absent, a failed predecessor still releases the chain,
   * because "run the tests, then tell me what happened" wants to run either
   * way. `graceMin` is how long after the predecessor settled this may still
   * start — absent means NO deadline at all, which is the honest default for a
   * chain: the person named an event, not an instant, so a desktop that was
   * asleep for the event has lost nothing by picking it up now. 0 means skip it
   * if it is not immediate, matching what `at`'s grace has always meant — with
   * the same `ON_TIME_MS` floor under it, because the tick that notices the
   * predecessor settled is already seconds behind the event.
   *
   * The deadline runs from the predecessor's settlement and stops the moment
   * this rung CLEARS the row. It used to be spent by every wait below this rung
   * too — "a chain with `graceMin: 60` held an hour on `serial` or `noSlot`
   * misses, having been awake and ready the whole time" was written here as a
   * documented property, and it was a bug: the row was failed for performing
   * the wait it was told to perform. `Intent.clearedOccurrence` carries the real
   * case that proved it (an `at` row, same rung, same mechanism) and
   * `HELD_MAX_MS` is the backstop that can still expire a cleared row. Set
   * `graceMin` as "how long is this work still worth STARTING", never as "how
   * long should the desktop have to pick it up" — the row cannot tell those
   * apart, and `chainMissedText` is careful not to claim it can.
   *
   * `title` is a SNAPSHOT of the predecessor's title at the moment the chain
   * was made, for `BuildPayload.name`'s reason: the row has to be able to say
   * what it is waiting for, and the predecessor may be finished, compacted and
   * gone by the time anybody reads the sentence. It is optional and the
   * sentence degrades to naming no title rather than to naming a wrong one.
   */
  | { kind: "after"; id: string; onlyIfOk?: boolean; graceMin?: number; title?: string };

/** What happened the last time this intent ran. Recurring rows keep the newest;
 *  one-shot rows keep the only one. */
export interface IntentResult {
  at: number;
  ok: boolean;
  /** One line: what ran, or why it didn't. */
  detail: string;
  /** `repos`/`sessions` targets: the per-target outcomes of one sweep. */
  targets?: { dir: string; sessionId?: string; status: "done" | "failed"; error?: string }[];
  /** `shell` target. */
  exitCode?: number | null;
  artifacts?: BuildArtifact[];
  /** `at` trigger: the scheduled instant this was (which may be < `at`). */
  occurrence?: number;
  /** It ran after a missed window (the host was asleep), not on time. */
  late?: boolean;
  /**
   * The row this fire CREATED, when firing means creating one.
   *
   * A `backlog` schedule does not run a prompt — it adds a work item, which
   * then waits for a session on its own clock. The detail line said so in prose
   * ("queued in myapp · item 936ff54f") and that was the end of the trail: no
   * screen could get from the schedule to the item, or from the item to the CLI
   * that ran it, because the only link between them was inside a sentence. This
   * is that link as a field.
   */
  childId?: string;
}

/**
 * One time a row that had already SETTLED was put back in the queue.
 *
 * ── Why the failure is copied in here ──────────────────────────────────────
 *
 * Re-queueing a settled row replaces its answer: the next run overwrites
 * `Intent.result`, so the moment the row starts again, the failure it was
 * wearing when somebody decided to try it anyway is gone. That failure is the
 * only reason a person had to think twice about it — "the session it was aimed
 * at had gone" and "the suite says the work is wrong" are the same `failed` row
 * on a list and completely different decisions to re-take — and after the second
 * run nothing on the row can say which it was. So it is copied HERE, beside the
 * decision that overrode it, instead of being left where it will be written
 * over.
 *
 * ── The fields ─────────────────────────────────────────────────────────────
 *
 * `by` is who decided, and it is never guessed. There are THREE taps that put
 * a settled row back, and they are three different sentences:
 *
 *   • `assess` — a *still wanted* verdict a person applied. The row says so
 *     ("re-queued by the assessment"), so a reader who disagrees with the
 *     assessment knows where to go and look.
 *   • `hand` — the row's own *run it again*. It puts the row back where the
 *     ladder can see it and stops there: what happens next is whatever the
 *     trigger already said, which may be nothing for hours.
 *   • `run` — put back only as the FIRST HALF of running it now. The backlog's
 *     *re-fire* and Activity's *run it now* both revive the row and then fire
 *     it in the same breath; the re-queue is plumbing under a tap whose whole
 *     content was "start this again".
 *
 * ── Why `run` is not `hand` ────────────────────────────────────────────────
 *
 * Because the phone draws this entry as a sentence about the PAST — *put back
 * in the queue from the phone, 3 s ago* — and on a row the same tap fired, that
 * sentence is drawn over a row that is `running` this second. It reads as a
 * re-queue that did nothing, under the one row on the list that is busiest.
 * With the third value the phone can say *started again from the phone* for
 * `run` and keep *put back in the queue* for `hand`, which is the only one of
 * the two that is actually waiting. All three were `hand` for exactly as long
 * as there was one tap; there are three now, so there are three values.
 *
 * `runId` is that assessment run, so the sentence is one tap from the verdicts
 * it came out of. Absent on `hand` and on `run`, neither of which has a
 * document behind it.
 *
 * `clockDropped` records the one thing a re-queue is allowed to CHANGE about
 * the row. A settled one-off `at` row's instant is in the past, so putting it
 * back on the same clock queues a row that is already late and rung 3 fails it
 * again on the next tick — the person taps *still wanted* and watches it die of
 * the same sentence. Dropping the clock is the only way to honour the tap, and
 * it is a change to what somebody asked for, so the row SAYS it rather than
 * quietly being a different row afterwards. `true` or absent, never `false`.
 */
export interface IntentRequeue {
  at: number;
  by: "assess" | "hand" | "run";
  runId?: string;
  /** The `Intent.result` the row carried at that moment — the failure itself,
   *  in full, never clipped here or anywhere downstream. */
  result?: IntentResult;
  clockDropped?: true;
}

/**
 * How many re-queues one row keeps.
 *
 * A COUNT cap, which is the only kind this file has. Five is enough to see the
 * shape that matters — a row that keeps coming back and keeps failing is a row
 * to stop re-queueing — and a row re-queued weekly for a year must not grow a
 * field without a bound in a file every tick rewrites. The words INSIDE an
 * entry are never touched: dropping the oldest ENTRY loses a decision somebody
 * can still see four of, clipping a `detail` loses the sentence that decision
 * was taken against.
 *
 * **What this cap must never be read as is the number of times it happened.**
 * The list is the capped WORDS; `Intent.requeueCount` is the uncapped NUMBER,
 * and it exists because this constant made the number wrong — see there.
 */
export const REQUEUE_KEEP = 5;

/** A lift of ONE window's budget ceiling, from an occurrence to its reset. */
export interface BudgetPass {
  window: "session" | "weekly";
  /** The occurrence — the row's own time. Held by the ceiling before it. */
  from: number;
  /** The reset the occurrence was timed ahead of. Held again from it on. */
  until: number;
}

/** `Intent.pastBudget`: let past the budget until `until` — the reset of the
 *  window the waiver was granted in. */
export interface BudgetWaiver {
  until: number;
}
