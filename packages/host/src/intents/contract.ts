/**
 * What every `intents/` slice is written against: the store's knobs, the
 * injected seams (`ExecutorResult`, `IntentExecutors`, `IntentDeps` — moved
 * whole from `manager.ts`, which re-exports them so the `dist/` contract is
 * unchanged), the four pure helpers, and `IntentCore` — the ONE way a slice
 * reaches shared state or another slice (docs/notes/host-architecture.md,
 * "IntentCore — the same, in intents/contract.ts").
 *
 * No class and no timer (`tools/hostshape.test.mjs`). The knobs are read from
 * the environment at IMPORT, exactly as they were in `manager.ts`: this module
 * is only ever evaluated as `manager.ts`'s import, so the read happens at the
 * same moment it always did. The facade builds the one object that implements
 * `IntentCore`, privately, in its constructor; every member is an arrow that
 * delegates at CALL time to the slice that owns the method (grouped below by
 * owning slice), so moving a method between slices retargets one arrow.
 */
import {
  resolveEnv,
  ruleRecurs,
  type BudgetCeiling,
  type Intent,
  type IntentFacts,
  type IntentResult,
  type SerialSessionState,
  type WindowResets,
} from "@waterplane/shared";

/**
 * The tick. 2 s — the finest of the four loops it replaces (the backlog's), on
 * the argument that a store which is late is a store nobody trusts to be the
 * only one. The work per pass is a verdict per pending row plus a `stat` for
 * each file a `files` trigger is still short of; everything else is already in
 * memory.
 */
export const TICK_MS = Math.max(250, Number(resolveEnv(process.env, "INTENT_TICK_MS").value || 2000));

/** Settled rows kept in the LIVE file. Past this they are archived, oldest
 *  first — see `compact()` for what may and may not be one of them. */
export const SETTLED_KEEP = 200;

/** Ceiling on the live file. A phone renders this list; a multi-megabyte JSON
 *  read on every tick is a cost the store must not grow into. */
export const FILE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How much of `intents-archive.jsonl` a chain may look back through.
 *
 * The `after` trigger has to answer two questions about a row that is no longer
 * in the live file: did it finish, and did it ever exist. Both answers are in
 * the archive, which only grows — so reading it whole would put an
 * ever-lengthening file read on the loop that also pumps every PTY, which is
 * the cost `tokenstats.ts` already had to yield to the event loop to survive.
 * So the read is the TAIL, in bytes rather than lines, because bytes are what
 * the read costs and a row's length varies with the prompt inside it.
 *
 * 256 KB is roughly 250–2,000 archived rows, against a live file that keeps the
 * newest `SETTLED_KEEP` (200) settled rows before it archives anything at all.
 * A predecessor has to be several hundred finished rows old before it falls off
 * the end.
 *
 * **What it costs when it does: the predecessor reads as GONE, and the row
 * FAILS** — it is absent from `knownIntents`, which is `intentVerdict`'s
 * "nothing is going to release it" sentence rather than a wait. That IS the
 * intended trade and the bound is picked for it: the alternative to failing is
 * a row that waits for ever with a perfectly reasonable sentence under it,
 * which is the exact shape of lost work this store exists to end. A chain that
 * has sat through hundreds of other finished rows is a chain whose predecessor
 * ran long before anybody looked, and being told so is worth more than being
 * told nothing. Raising the bound trades bytes per tick for how far back that
 * line falls; it does not change which side of it a row lands on.
 */
export const ARCHIVE_TAIL_BYTES = 256 * 1024;

/**
 * Hard cap on rows that have not run.
 *
 * Refusal, deliberately, and not eviction: an intent is never deleted by a
 * clock or by pressure, so the only honest response to a client that has posted
 * five hundred un-run intents is to say so out loud and refuse the next one.
 * Losing the oldest quietly is exactly the failure this store was built to end.
 */
export const PENDING_MAX = 500;

/**
 * The version of `.waterplane/intents.json`.
 *
 * 1 was a bare array. 2 is `{ schema, intents }` and means "every repo target in
 * this file has been re-read as a session PER ITEM" — see `load()`. 3 means "the
 * legacy timed PARENTS in this file have been set aside" — see
 * `foldLegacyWorkParents()`, and note what the number buys there: the fold is a
 * judgement about rows a person may disagree with, so it must run once ever and
 * not once per boot, and the file is the only place that can remember it did.
 */
export const STORE_SCHEMA = 3;

/** How long a `starting` row may sit in memory before the tick stops waiting on
 *  its executor. It never expires the ROW — this only frees the in-memory
 *  re-entrancy guard, and the persisted `starting` state still covers restarts. */
export const START_WATCHDOG_MS = 30 * 60_000;

/** What an executor answers. `ok` means the side effect was DELIVERED, never
 *  that the turn it started has finished. */
export interface ExecutorResult {
  ok: boolean;
  /** One line for the row: what ran, or why it didn't. */
  detail: string;
  sessionId?: string;
  /** A row this executor CREATED — the schedule's work item. Kept as a field
   *  rather than left in the detail sentence, so a screen can follow it. */
  childId?: string;
  targets?: IntentResult["targets"];
  exitCode?: number | null;
  artifacts?: IntentResult["artifacts"];
  /**
   * Provably nothing was typed, so a second attempt cannot stack a copy — the
   * one verdict that returns a row to `queued` instead of failing it. Stated
   * once here for every executor: `unconfirmed` never requeues, and the count
   * is capped at `INTENT_MAX_ATTEMPTS` so a genuinely stuck session stops
   * churning instead of retrying for ever.
   */
  retry?: boolean;
  /**
   * WHICH step of a chain the executor stopped on, 0-based. Absent is 0 — the
   * single-step case, and every executor that has no chain.
   *
   * It exists because a `Stop` is evidence about ONE turn, and `fire()`'s Stop
   * shortcut below had no way to tell which. A three-step item whose step 1 ran
   * (its `Stop` arriving while step 2 was still being delivered) and whose step
   * 2 came back `unconfirmed` settled `done` — *"its turn finished — the hook
   * confirmed it even though the screen never echoed"* — with two of its three
   * turns never typed, and the sentence that named the stopped step thrown
   * away. The Stop proved step 1 ran, which the row already knew.
   *
   * So: the shortcut is valid only for step 0. `freshSession` sets it from
   * `failedStep`, `backlog.deliver` from its loop index.
   */
  step?: number;
  /** The side effect was called off, not attempted and failed — a build that
   *  was killed from the phone. Settles `canceled`, which is a different thing
   *  from `failed` everywhere it is rendered. */
  canceled?: boolean;
  /**
   * The work is NOT finished when the executor returns — it finished being
   * DELIVERED. The row waits in `running` for the turn it started to end, and
   * this says what counts as that ending:
   *
   *   • `"turn"` — a `Stop` past the pre-delivery baseline, or (on a session
   *     with no hook pipe) the silence fallback. The backlog's rule.
   *   • `"hook"` — a `Stop` only. A fan-out target keeps saying `running`
   *     rather than guessing from silence, because a sweep's whole output is
   *     the claim "these N repos did the work" and a guess is not that.
   */
  watch?: "turn" | "hook";
}

/**
 * The doing, injected.
 *
 * This module owns WHEN and every state transition; these own only WHAT,
 * exactly as `LaunchOpener` and `ScheduleRunner` did. Injection rather than
 * import is also what keeps the store free of the session manager, the fan-out
 * and the backlog — three modules that would otherwise all have to be
 * constructed to test a persistence rule.
 */
export interface IntentExecutors {
  /** `{kind:"repo", fresh:true}` — open a session here and run the words. */
  freshSession(i: Intent): Promise<ExecutorResult>;
  /** `{kind:"repos"}` — one prompt, a fresh session in each of `dirs`. */
  sweep(i: Intent, dirs: string[]): Promise<ExecutorResult>;
  /** `{kind:"session"}` / `{kind:"repo"}` — type it into a session that exists. */
  deliver(i: Intent, sessionId: string): Promise<ExecutorResult>;
  /** The schedule's "queue a work item" adapter — see `ORIGIN_SCHEDULE_WORK`. */
  workItem(i: Intent): Promise<ExecutorResult>;
  /** A build rule's occurrence (`postsScheduledBuild`): post ONE ordinary
   *  build run through the build manager's own `run()`, stamped with the
   *  rule's origin, and finish — `childId` is the run. */
  scheduledBuild?(i: Intent): Promise<ExecutorResult>;
  /** `{kind:"sessions"}` — re-drive sessions that already exist, spawn nothing. */
  followUp?(i: Intent, sessionIds: string[]): Promise<ExecutorResult>;
  /** `{kind:"shell"}` — a build command, no agent. Resolves when the process
   *  exits, which is why it is the one executor that can take an hour. */
  build?(i: Intent): Promise<ExecutorResult>;
  /** `{kind:"assess"}` — read the repo and propose what is left. Also a
   *  `shell` target and also long-running, but a DIFFERENT executor: it spawns
   *  a headless agent rather than a build command, and dispatching both off
   *  `target.kind` alone would run an assessment through the build pty. */
  assess?(i: Intent): Promise<ExecutorResult>;
  /** `{kind:"capture"}` — take a picture of a running screen and say how much
   *  the picture can be trusted. A `shell` target for the third time, and
   *  dispatched off the PAYLOAD for `assess`'s reason: it spawns no build
   *  command and no agent, it drives a browser / a device / the desktop, and
   *  routing on the target alone would hand it to the build pty. */
  capture?(i: Intent): Promise<ExecutorResult>;
}

/**
 * Every fact about the world the store needs, as functions.
 *
 * Functions rather than values because a tick runs every two seconds and most
 * of these are answers the host already holds — asking is cheaper than being
 * told, and it removes any chance of the store acting on a snapshot somebody
 * forgot to refresh.
 */
export interface IntentDeps {
  root: string;
  /** Where the store persists: the daemon's global state dir (`branddirs.ts`'
   *  `hostStateDir`). Absent ⇒ `<root>/<state dir>`, a test's scratch layout. */
  stateDir?: string;
  /**
   * `jsonstore.ts`'s two halves, injected (this store is a leaf and may not
   * import them): the guarded boot read — a present-but-corrupt file is MOVED
   * ASIDE, never overwritten — and the atomic write. `server/intentDeps.ts`
   * passes both. Absent only in a unit fake: a plain parse (corrupt ⇒ empty)
   * and a tmp+rename write, the store's behaviour before they were injected.
   */
  files?: {
    readGuarded(path: string, fallback: unknown, accept?: (v: unknown) => boolean): { value: unknown; corrupt?: { movedTo: string | null; error: string } };
    writeText(path: string, body: string): void;
  };
  /** Live sessions, flattened to what the pure rule reads. */
  sessions(): SerialSessionState[];
  /** Is this session id still live? */
  sessionAlive(id: string): boolean;
  /**
   * The BACKLOG session for a repo — what automatic work may type into.
   *
   * `adopt` is the manual-fire exception, and it is the ONE implementation of
   * this question in the host (`BacklogManager.resolveRepoSession`): automatic
   * work never types into a session you opened by hand, and a person tapping
   * "fire" has just said they want it to. The tick always asks with `adopt`
   * false; `runNow` asks with it true.
   */
  repoSession(cwd: string, adopt?: boolean): string | null;
  /**
   * How many more sessions MACHINERY may open right now — `IntentFacts.
   * autoSlotsFree`, and the whole of what `BACKLOG_SESSIONS_MAX` now does.
   *
   * It replaces `openBacklogSession`, which was a side door with a refusal
   * string in it: the host was asked to spawn, answered "waiting for a free
   * backlog session — …open this repo's backlog session yourself", and that
   * sentence was a second ladder nobody could see from the row. Now the cap is a
   * FACT the pure rule reads (rung 4.6, `noSlot`) and opening is just what the
   * executor does once the ladder has said yes.
   *
   * Counted off the SESSIONS and never off a map of rows — see
   * `BacklogManager.autoSessionCount` for why.
   */
  autoSlotsFree(): number;
  /**
   * That cap in the host's own words, with the numbers in it.
   *
   * The same arrangement `budgetDetail` has, and for the same reason: the pure
   * rule is handed `autoSlotsFree` and never the ceiling it was subtracted from,
   * so a sentence written there would have to guess at "3 at a time" and would
   * be wrong on any desktop that set `WATERPLANE_BACKLOG_SESSIONS`. The specific
   * sentence when somebody knows the numbers, the general one when nobody does,
   * and never a plausible number nobody measured.
   */
  autoSlotsDetail?(): string | undefined;
  /**
   * The local-model cap (`IntentFacts.local`, rung 4.55 `localModel`) — asked
   * once per pass like `autoSlotsFree`, decremented per fire of a row in
   * `rows`, re-read monotonically on the far side of the pass's yield. Absent = the
   * rung is skipped (`localslot.ts`).
   */
  localSlots?(): IntentFacts["local"];
  /** That cap's sentence in the host's numbers (`localSlotWaitText`). */
  localSlotsDetail?(): string | undefined;
  /**
   * Is the local model this row opens on LOADED? A sentence holds it
   * (`localModel`, nothing claimed), `null` lets it fire. Synchronous: the
   * load runs in the background and kicks the tick when it ends. Asked after
   * the whole ladder and the sweep pool, last before the claim; never by `runNow`.
   */
  localHold?(row: Intent): string | null;
  /**
   * The live session that REPLACED this exact one after a usage-limit exit, so
   * a row whose session died can follow it — and null when nothing did.
   *
   * Keyed on the DEAD SESSION and never on its directory. Asked by directory it
   * answered "the newest live session in that repo", and the gap between a limit
   * exit and its reset is hours: a session a person opened by hand in that
   * worktree in the meantime was handed the row, and the person's own next Stop
   * marked work `done` that had never run. `SessionManager.revivedSessionFor`
   * records the pairing at the one place that knows both ids.
   */
  revivedSessionFor(deadSessionId: string): string | null;
  /** That session exited at the usage limit, not by crashing or `/quit`. It
   *  comes back at the reset, so its work is REQUEUED rather than failed — and
   *  never, ever marked done. */
  diedAtLimit(sessionId: string): boolean;
  /**
   * The CLI CONVERSATION a session is driving (`claudeSessionId`), or null
   * where there is none to name — an opencode session, a session too young to
   * have published one, or one this host has never heard of.
   *
   * Snapshotted onto a session-targeted row when it is written, never read at
   * fire time: by then the session may be gone, and a conversation nobody wrote
   * down is a conversation this store may not guess at
   * (`IntentTarget.resumeConvId`).
   */
  convIdFor?(sessionId: string): string | null;
  /** Finished turns so far. The completion baseline is one of these, taken
   *  BEFORE anything is typed. */
  stopCount(sessionId: string): number;
  /** The hook pipe is live, so `Stop` is positive evidence a turn ended and the
   *  silence guess is not needed (and must not be made). */
  isHooked(sessionId: string): boolean;
  /** A TURN-shaped hook (`SessionStart`/`UserPromptSubmit`/`Stop`) has reported
   *  since this process attached to the session. `isHooked` flips on any hook,
   *  and after a restart the first is often a `Notification` about a turn that
   *  ended while the host was down — its Stop went nowhere, so waiting for one
   *  waits for ever. Hooked without this ⇒ the silence rule still applies.
   *  Optional; absent ⇒ every hooked session counts as having seen one. */
  turnHookSeen?(sessionId: string): boolean;
  /** Milliseconds since that session last produced output; `null` when it is
   *  gone, or when there is no honest reading (a tmux pane in copy-mode). */
  sessionIdleMs(sessionId: string): number | null;
  /** A choice box is up. The silence is a question waiting for an answer, which
   *  looks exactly like a finished turn and is the opposite of one. */
  sessionHasPrompt(sessionId: string): boolean;
  /** How long of nothing counts as "the turn ended" on an unhooked session. */
  idleWindowMs(): number;
  /** How long a HOOKED session may be silent with a row still `running` before
   *  the row is given up on — the backlog's `REAP_CEILING_MS`, handed over so
   *  there is one definition. Optional; absent ⇒ no backstop. */
  reapCeilingMs?(): number;
  /** Is this session's net retry `gaveup` (`SessionInfo.netRetry`, `sessions/apiretry.ts`)?
   *  A row running in it is STALLED, not silent: the sweep neither fails nor
   *  completes it. Optional; absent ⇒ never stalled. */
  sessionNetStalled?(sessionId: string): boolean;
  /** How many rows of ONE `groupId` may be delivering at once — a fan-out's
   *  concurrency pool, which is a bound on real `claude` processes. */
  groupConcurrency(): number;
  /**
   * Directories a sweep may legally name (`discoverTargets`). Cached by the
   * caller; the tick awaits it only when a sweep is actually pending.
   *
   * `null` means NO LISTING — the scan has never succeeded — and is deliberately
   * distinct from an empty set. Empty is an answer ("this root holds no repos",
   * which correctly fails a sweep aimed at one); null is the absence of one, and
   * the tick refuses to judge a sweep on it.
   */
  knownDirs(): Promise<Set<string> | null>;
  /**
   * The usage reset instants and percentages a `window` rule is measured
   * against — `usage.ts`'s cached reading, injected rather than imported so
   * this module keeps having no host in it.
   *
   * Returns whatever is known RIGHT NOW, including nulls: an unread reset arms
   * nothing (`nextFireAt`) and an unread percentage skips (`windowCondition`),
   * and both of those are decisions the pure rules make, not this seam.
   */
  usageWindows?(): WindowResets;
  budgetBlocked(): boolean;
  /** The one sentence for that pause — which ceiling, and when it lifts. */
  budgetDetail?(): string | undefined;
  /** Every tripped ceiling, session first (`budgetCeilings`). Optional, and
   *  absent is the old behaviour: a before-reset row is held like any other. */
  budgetOver?(): readonly BudgetCeiling[];
  /** The leftover ceiling when tripped (`leftoverCeiling`), else null. Optional,
   *  and absent holds no leftover — the behaviour before it existed. */
  leftoverOver?(): BudgetCeiling | null;
  /** Sessions whose OWN budget is spent (`sessionBudgetHeld`). Optional; absent
   *  is "nobody said" = none held, exactly the old behaviour. */
  budgetHeldSessions?(): ReadonlySet<string>;
  /** The emergency halt's refusal (`halt.ts`'s `haltRefusal`), or null. While it
   *  answers, the ladder fires nothing and `runNow` refuses: rows are held,
   *  never spent. Optional; absent = never halted (a unit fake). */
  halted?(): string | null;
  autoFire(): boolean;
  /**
   * What the CLI's own conversation log says about a delivery — `settle.ts`'s
   * `logVerdict`, injected. Restart reconciliation is the one place this store
   * needs evidence rather than facts, and the log is the only evidence that
   * outlives the process that produced it.
   *
   * `claimer` is the intent's own id. A log turn is evidence for exactly one
   * delivery, and two rows carrying the same words — a schedule that fires the
   * same instruction twice, a retry of a row — must not both read the one turn
   * as proof they ran.
   */
  logVerdict(sessionId: string, text: string, since: number, claimer: string): "landed" | "absent" | "unknown";
  executors: IntentExecutors;
  /** One row changed (or, with no argument, several did). */
  onChange(intent?: Intent): void;
  /**
   * `intents.json` stopped reaching the disk (`disk.ts`'s `persist()`), with the
   * error's own words — called ONCE per failing streak, so the daemon can tell a
   * person. Optional: absent, the failure is still logged and still refuses.
   */
  onWriteError?(message: string): void;
}

/** The lifecycle states a tick will not touch. */
export const isTerminal = (i: Intent): boolean =>
  i.state === "done" || i.state === "failed" || i.state === "canceled";

/** A recurring `at` rule is standing policy: it never terminates and is never
 *  evicted, exactly as a schedule entry never was. `ruleRecurs` is the one
 *  place that reads recurrence apart from anchor (`kind`) — a `weekly` or
 *  `window` rule marked `oneShot` is `kind !== "once"` and is NOT recurring. */
export const isRecurring = (i: Intent): boolean =>
  i.trigger.kind === "at" && ruleRecurs(i.trigger.rule);

/** A duration as words for a sentence — "an hour", "2 hours", "45 minutes".
 *  Derived from the number that decided, so the sentence cannot drift from it. */
export const spanWords = (ms: number): string => {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min % 60 === 0) return min === 60 ? "an hour" : `${min / 60} hours`;
  return min === 1 ? "a minute" : `${min} minutes`;
};

/**
 * The row as a re-queue would leave it — as a COPY, deciding nothing.
 *
 * Pure and module-level because it is read twice for two different purposes,
 * and the second one is the reason it exists at all: `revive()` applies it to
 * the real row, and `requeueFailed()`'s pre-flight applies it to a throwaway
 * and asks the ladder what would become of THAT. A probe built from a second,
 * hand-written spelling of this transition is a probe about a row nobody is
 * about to write — it would clear ten of the eleven fields, or forget the
 * clock, and the answer would be confidently about something else.
 *
 * `dropClock` is the one thing a re-queue is allowed to CHANGE (see
 * `requeueFailed`): a spent one-off's instant is gone, so it comes back on
 * `{kind: "idle"}` with the bookkeeping about that clock gone with it, rather
 * than on a deadline rung 3 would gravestone it for on the next tick.
 *
 * What it does NOT do is the history: `requeues`, `requeueCount` and `result`
 * are carried across untouched, because writing them is a decision about who
 * asked and what they were looking at, and this function is handed neither.
 *
 * Nor the NAME — `headline`, `headlineBy`, `category`, `categoryBy` all ride
 * across untouched too, and for a reason of the same shape: what a row is
 * CALLED is not a fact about the run that just failed. A re-queue that cleared
 * the title would leave a row a person had named by hand nameless the moment it
 * stopped, and the next naming pass would then title it — a `hand` name lost to
 * a machine one without anybody deciding anything.
 */
export function revivedShape(row: Intent, dropClock: boolean): Intent {
  const next: Intent = {
    ...row,
    state: "queued",
    attempts: undefined,
    startedAt: undefined,
    settledAt: undefined,
    sessionId: undefined,
    dismissedAt: undefined,
    blockReason: undefined,
    blockDetail: undefined,
    missing: undefined,
    followed: undefined,
    clearedOccurrence: undefined,
    // A waiver is for ONE start and the settled run was it — a row put back
    // waits for the budget again unless somebody lets it past again.
    pastBudget: undefined,
  };
  if (dropClock) {
    next.trigger = { kind: "idle" };
    // The clock is gone, so the bookkeeping ABOUT that clock goes with it —
    // `update()`'s note says why absent is the honest shape for an untimed row,
    // and a queued row still carrying a spent occurrence and a null `nextAt` is
    // a row two readers will disagree about.
    next.nextAt = undefined;
    next.lastOccurrence = undefined;
  }
  return next;
}

/**
 * The ONE way an `intents/` slice reaches shared state or another slice.
 *
 * Derived by script, not by reading (host-architecture.md, "S1 as landed"):
 * every `this.<member>` in every method of `manager.ts`, each method and field
 * assigned to its slice by the inventory; a member is here when a method of one
 * slice (or the facade's `tick`) reaches it and another slice — or the facade —
 * owns it. Grouped by OWNING slice, so an integrator retargets exactly one
 * group. A slice's method that no other slice calls is NOT here, and is
 * therefore unreachable from another slice: that is the narrowness.
 *
 * Deliberately absent, because only their own slice touches them: `reconciled`
 * (watch's `reconcile` alone reads and writes it — `WatchSlice`'s field),
 * `path`/`archivePath`/`loadedSchema`/`archiveTail` (disk's), `timer`/`ticking`
 * (the facade's `start`/`stop`/`tick`), and `load`/`foldLegacyWorkParents`,
 * which the facade's constructor calls on the disk slice directly as its only
 * two boot calls.
 */
export interface IntentCore {
  // ── facade: state the facade keeps, shared with every slice ──────────────
  /** The constructor's OWN object — never a copy, never destructured: a test
   *  replaces `deps.executors.freshSession` after construction
   *  (`ladderpass.test.mjs`), so `deps.executors.<x>` is read at call time. */
  readonly deps: IntentDeps;
  /** The live rows. `this.rows` is REASSIGNED in four slices (`upsert`,
   *  `remove`, `replace`, `load`/`compact`), so it is never shared by
   *  reference: every read is `core.rows()`, every replacement
   *  `core.setRows(next)`, and neither is cached across an `await`. */
  rows(): Intent[];
  setRows(next: Intent[]): void;
  /** The in-memory ledgers, shared BY REFERENCE — none is ever reassigned, and
   *  `inflight` stays a facade field because `requeue.test.mjs` writes it. */
  readonly inflight: Map<string, number>;
  readonly stopBase: Map<string, number>;
  readonly stopSeen: Map<string, number>;
  readonly watchMode: Map<string, "turn" | "hook">;
  readonly readopted: Set<string>;
  /** The last repo listing a pass took — written by ladder's `pass`, read by
   *  requeue's `wouldNotRun`. `null` is "nobody said". */
  lastKnownDirs(): Set<string> | null;
  setLastKnownDirs(dirs: Set<string>): void;
  /** The facade's EventEmitter: `settled` | `requeued` | `skipped` | `missed`,
   *  always `(row, result)`, and always after `persist()`. */
  emit(event: string, ...args: unknown[]): void;
  kick(): void;
  get(id: string): Intent | undefined;
  pending(): Intent[];

  // ── disk (disk.ts) ───────────────────────────────────────────────────────
  /** The ONE write to `intents.json` (pinned per file). `false` ⇒ nothing reached
   *  the disk (read-only this boot, or the write failed — `lastWriteError()`). */
  persist(): boolean;
  /** Why the last write failed, or null when it landed. */
  lastWriteError(): string | null;
  /** A sentence when the store must not write this boot (a newer host's file), else null. */
  readOnly(): string | null;
  archive(rows: readonly Intent[]): void;
  chainFacts(): Pick<IntentFacts, "settled" | "knownIntents" | "chainWaits" | "neverSettles">;
  present(cwd: string, rel: string): boolean;

  // ── clock (clock.ts) ─────────────────────────────────────────────────────
  armNew(row: Intent, now: number): number | null | undefined;
  newBasis(row: Intent): number;
  armFrom(row: Intent, basis: number, now: number): number | null | undefined;

  // ── ladder (ladder.ts) ───────────────────────────────────────────────────
  /** The facade's `tick` (and `ladderpass.test.mjs`, through the facade's
   *  private delegation). */
  pass(): Promise<void>;

  // ── fire (fire.ts) ───────────────────────────────────────────────────────
  fire(
    row: Intent,
    opts: { sessionId?: string; occurrence?: number; late?: boolean; missing?: string[]; spendOccurrence?: boolean },
  ): Promise<string | void>;
  settle(row: Intent, state: "done" | "failed" | "canceled", result: IntentResult, missing?: string[]): void;
  replace(row: Intent): void;
  resolveSessionFor(row: Intent): string | undefined;
  unspend(row: Intent, occurrence: number | undefined): void;
  stampCleared(row: Intent, occurrence: number | undefined): void;
  recordMissed(row: Intent, occurrence: number, detail: string, now: number): void;

  // ── watch (watch.ts) ─────────────────────────────────────────────────────
  complete(row: Intent, detail: string, now?: number): void;
  sweepRunning(now: number): void;
}
