/**
 * Firing one intent and the transitions it ends in (I6 of the split in
 * docs/notes/host-architecture.md): `fire` (the claim, the window condition,
 * `starting` persisted BEFORE the executor, and every outcome the executor can
 * answer), `execute` (which executor, and why), `resolveSessionFor` (the
 * session a hand fire would use), and the row transitions `fire` shares with
 * the rest of the store — `unspend`, `stampCleared`, `recordMissed`, `settle`,
 * `replace`.
 *
 * Owns no state: `inflight` and the completion ledgers are the facade's,
 * shared by reference through `core` (a test writes `store.inflight`), and
 * `deps.executors.<x>` is read at call time. The facade keeps one-line private
 * `fire()` and `settle()` delegations because `requeue.test.mjs` and
 * `backlogedit.test.mjs` call them. Reaches everything else only through `core`.
 */
import {
  INTENT_MAX_ATTEMPTS,
  isTimedWorkRow,
  postsScheduledBuild,
  queuesBacklogItem,
  liveConvSession,
  reopensConversation,
  windowCondition,
  type Intent,
  type IntentResult,
} from "@waterplane/shared";
import { isRecurring, type ExecutorResult, type IntentCore } from "./contract.js";

export class FireSlice {
  constructor(private readonly core: IntentCore) {}

  /**
   * Start one intent.
   *
   * The order here is the whole file: `starting` (and, for an `at` trigger, the
   * occurrence it is spending) is persisted BEFORE the executor is invoked. A
   * crash in the gap leaves a row that is visibly stuck rather than a worktree
   * with two agents in it or a sweep that runs a second time on boot.
   *
   * Answers a SENTENCE only when it did not start the row because `starting`
   * could not be written (`runNow` hands it to the tapper); otherwise nothing.
   */
  async fire(
    row: Intent,
    opts: { sessionId?: string; occurrence?: number; late?: boolean; missing?: string[]; spendOccurrence?: boolean },
  ): Promise<string | void> {
    // ── The claim is the ONE gate, so it is asked here ──────────────────────
    //
    // Two callers reach this: the pass, which has just re-read the row on the
    // far side of its yield, and `runNow`, which has not been through the
    // ladder at all. Nothing compared their answers, so a tap that landed while
    // a pass was awaiting — or a second tap on a slow spawn — put two
    // executors on one row, which for a delivery means a prompt typed twice into
    // one session and for a fresh row means two agents in one worktree.
    //
    // Asked exactly as `requeueFailed` asks it: the persisted states cover a
    // restart, and the in-memory map covers the window between this line and
    // the executor's first `await`, where there is no persisted state yet. A
    // silent return rather than a throw — both callers treat firing as
    // best-effort and the row is already accounted for by whoever holds it.
    if (this.core.inflight.has(row.id) || row.state === "starting" || row.state === "running") return;
    const now = Date.now();
    // ── The condition, asked HERE and nowhere earlier ────────────────────────
    //
    // A `window` rule's condition is about what is true at the INSTANT it fires,
    // not at the instant it was armed hours ago — so it cannot live in
    // `nextFireAt`, and it deliberately does not live in `intentVerdict` either:
    // a verdict is re-asked every tick and a row that merely FAILS its condition
    // must not sit blocked, re-reporting the same sentence, waiting for a
    // percentage that will only move the wrong way until the reset it precedes.
    // The occurrence is spent, the row says why, and — for a recurring rule —
    // the next one is armed. A ONE-SHOT rule (`oneShot: true`) is armed for the
    // FOLLOWING reset too: a skip is not its one occurrence, a run is.
    if (row.trigger.kind === "at" && row.trigger.rule.kind === "window" && opts.occurrence != null) {
      const verdict = windowCondition(row.trigger.rule, this.core.deps.usageWindows?.());
      if (!verdict.ok) {
        // A ONE-SHOT window rule whose condition was not met has not had its
        // one shot — nothing ran. "Once, when 20% of the week is left at the
        // reset" is a standing offer to spend what would otherwise expire, not
        // a coin toss on the next reset: the row stays queued and is armed for
        // the FOLLOWING reset, and only a run that actually happens spends it.
        // `armFrom` may answer `undefined` (the next reset is not read yet),
        // which the ladder and `isSpentOnce` both read as *not computed* — an
        // explicit `null` is the only spelling of retired.
        const keep = isRecurring(row) || row.trigger.rule.oneShot === true;
        row.lastOccurrence = opts.occurrence;
        row.clearedOccurrence = undefined;
        // The occurrence the waiver was for is over; the next one waits for
        // the budget again, as it would have without this skip.
        row.pastBudget = undefined;
        row.leftoverOf = undefined;
        row.nextAt = keep ? this.core.armFrom(row, opts.occurrence, now) : null;
        row.state = keep ? "queued" : "failed";
        row.startedAt = undefined;
        row.blockReason = undefined;
        row.blockDetail = undefined;
        // `ok: false` with the reason in the row's own words. A skip is NOT a
        // failure of the run — nothing ran — but it is the thing the user asked
        // to be told about, and `settled` is the one channel every listener
        // already watches.
        const detail = keep && !isRecurring(row) ? `${verdict.detail} — kept for the next reset` : verdict.detail;
        const result: IntentResult = { at: now, ok: false, detail, occurrence: opts.occurrence };
        row.result = result;
        if (!keep) row.settledAt = now;
        this.core.persist();
        this.core.deps.onChange(row);
        this.core.emit("skipped", row, result);
        return;
      }
    }
    // What the row was, for the one case below where `starting` never reaches
    // the disk and the claim has to be taken back whole.
    const before: Intent = { ...row };
    this.core.inflight.set(row.id, now);
    row.state = "starting";
    row.startedAt = now;
    row.blockReason = undefined;
    row.blockDetail = undefined;
    row.sessionId = opts.sessionId ?? row.sessionId;
    // Assigned, never merged — including when there is nothing to assign.
    //
    // `missing` is the files this run went WITHOUT, and the promise attached to
    // it is unusually strong: "a launch that went without its files says so for
    // ever" is a deliberate rule, so the field is read as a statement about
    // THIS run. Setting it only when a new value arrived quietly made it a
    // statement about the last time anything was missing: a launch that waited
    // for its upload, got it, and then ran perfectly kept the list it was
    // blocked on, and every UI reading the row said the launch had gone without
    // files that were sitting right there. A false positive here is worse than
    // a missing feature, because it is a lie in the one place the user was
    // promised the truth. The tick only reaches `fire()` for a `files` trigger
    // once nothing is outstanding, so "no value" is not an absence of
    // information — it is the information.
    row.missing = opts.missing;
    const spend = opts.spendOccurrence !== false && opts.occurrence != null;
    // Cleared the moment the row actually starts, spent or not: the stamp is
    // about an occurrence WAITING to be run, and `runNow` deliberately does not
    // spend one — a revived one-off would otherwise carry a release from its
    // previous life into a fresh grace window.
    row.clearedOccurrence = undefined;
    // A waiver covers ONE start, and this is it — but it stays ON the row
    // through `starting` and is cleared only once the start's outcome is known
    // (below): a restart mid-start that reconciles to *nothing ran, queued
    // again* must hand back a row still let past, and the tick never evaluates
    // a starting row, so the flag is inert here.
    // Same for the resurrection flag: it is a fact about THIS run's session, and
    // a run that is only starting now has not followed anything yet.
    row.followed = undefined;
    if (spend) {
      row.lastOccurrence = opts.occurrence;
      row.nextAt = this.core.armFrom(row, opts.occurrence!, now);
    }
    // The completion baseline, taken BEFORE a single byte is typed. Snapshotting
    // it afterwards would race the agent: a fast turn's Stop can arrive while
    // `deliverPrompt` is still proving that it typed, and a baseline taken then
    // is already past the turn it was meant to measure.
    this.core.stopSeen.delete(row.id);
    if (opts.sessionId) this.core.stopBase.set(row.id, this.core.deps.stopCount(opts.sessionId));
    // `starting` BEFORE the executor is only a guarantee if it is on DISK. A
    // write that did not land (a full disk, a read-only state dir) would run the
    // work with the file still saying `queued`, and the restart after it would
    // run it again — so nothing runs: the row goes back to exactly what it was,
    // still queued, and the next pass asks again. The failure itself is logged
    // and told once (`disk.ts`'s `persist()`).
    if (!this.core.persist()) {
      for (const k of Object.keys(row) as (keyof Intent)[]) if (!(k in before)) delete row[k];
      Object.assign(row, before);
      this.core.inflight.delete(row.id);
      if (opts.sessionId) this.core.stopBase.delete(row.id);
      return this.core.readOnly() ?? `not started: could not save to disk: ${this.core.lastWriteError() ?? "the write failed"}`;
    }
    this.core.deps.onChange(row);

    let res: ExecutorResult;
    try {
      res = await this.execute(row);
    } catch (err) {
      res = { ok: false, detail: String((err as Error)?.message || err) };
    }
    this.core.inflight.delete(row.id);

    // The row may have been removed while the executor ran (a schedule deleted
    // mid-sweep). Record onto whatever is still in the list, and drop it
    // otherwise — never resurrect a row somebody deleted.
    if (!this.core.rows().includes(row)) { this.core.deps.onChange(); return; }

    const at = Date.now();
    const result: IntentResult = {
      at, ok: res.ok, detail: res.detail,
      targets: res.targets,
      childId: res.childId,
      exitCode: res.exitCode,
      artifacts: res.artifacts,
      occurrence: spend ? opts.occurrence : undefined,
      late: opts.late || undefined,
    };
    if (res.sessionId) row.sessionId = res.sessionId;

    if (!res.ok && res.retry) {
      // Provably nothing was typed. The one verdict that returns a row to the
      // queue: nothing is stacked, so a second attempt is safe. `unconfirmed`
      // never gets here — stated once, for every executor.
      //
      // Capped, though: a session that is permanently unable to take input
      // would otherwise be typed at every two seconds for the life of the
      // daemon, and the row would never say anything about it.
      const tries = (row.attempts ?? 0) + 1;
      this.core.stopBase.delete(row.id);
      if (tries < INTENT_MAX_ATTEMPTS) {
        row.attempts = tries;
        row.state = "queued";
        row.result = result;
        row.startedAt = undefined;
        row.sessionId = undefined;
        // Provably nothing was typed, so the waiver was not used either —
        // it stays, still bounded by its window.
        // Give the occurrence back: a queue with no instant left to wait for is
        // a row that will never run. See `unspend`.
        this.unspend(row, spend ? opts.occurrence : undefined);
        this.core.persist();
        this.core.deps.onChange(row);
        this.core.emit("settled", row, result);
        return;
      }
      row.attempts = tries;
      this.settle(row, "failed", result);
      return;
    }
    // Every other outcome USED the start the waiver was for: a recurring rule
    // let past once is held by the budget again from its next occurrence.
    row.pastBudget = undefined;
    row.leftoverOf = undefined;
    // A `Stop` past the pre-delivery baseline is POSITIVE evidence that the turn
    // this delivery started has already run — and it outranks a four-second echo
    // window that could not confirm what it typed. On a fast turn the hook beats
    // the executor's return value, and calling that row `unsubmitted` would
    // gravestone work the CLI itself has recorded as done. Not for `retry`,
    // which means provably nothing was typed: any Stop there is somebody else's.
    //
    // **Only about the FIRST step.** A `Stop` past the baseline says one turn
    // ended; on a chain, the turn that ended is step 1's, and step 1 running is
    // exactly what a later step's failure already takes for granted. Reproduced:
    // a three-step item whose step 2 came back `unconfirmed` after step 1's Stop
    // settled `done` with two turns never typed, and discarded the sentence that
    // said which step stopped. `ExecutorResult.step` is how the executor says
    // which turn it was talking about.
    const seenStop = this.core.stopSeen.get(row.id);
    const preBase = this.core.stopBase.get(row.id);
    if (!res.ok && !res.retry && (res.step ?? 0) === 0 && seenStop != null && preBase != null && seenStop > preBase) {
      this.core.complete(row, "its turn finished — the hook confirmed it even though the screen never echoed", at);
      return;
    }
    row.attempts = undefined;
    if (res.ok && res.watch && row.sessionId) {
      // Delivered, not finished. The row waits in `running` for the turn it
      // started to end — and if that turn ALREADY ended while the delivery was
      // still proving itself, it ends here rather than waiting for a second
      // Stop that is never coming.
      this.core.watchMode.set(row.id, res.watch);
      if (!this.core.stopBase.has(row.id)) this.core.stopBase.set(row.id, this.core.deps.stopCount(row.sessionId));
      row.state = "running";
      row.result = result;
      this.core.persist();
      this.core.deps.onChange(row);
      const seen = this.core.stopSeen.get(row.id);
      const base = this.core.stopBase.get(row.id) ?? 0;
      if (seen != null && seen > base) this.core.complete(row, "its turn finished");
      return;
    }
    this.core.stopBase.delete(row.id);
    this.core.stopSeen.delete(row.id);
    if (!res.ok && res.canceled) { this.settle(row, "canceled", result); return; }
    if (isRecurring(row)) {
      // Standing policy. The occurrence is recorded, the outcome is kept, and
      // the row goes back to waiting for the next one — a recurring intent
      // never terminates.
      row.state = "queued";
      row.result = result;
      row.startedAt = undefined;
      this.core.persist();
      this.core.deps.onChange(row);
      this.core.emit("settled", row, result);
      return;
    }
    // A one-off fired BY HAND has not spent its occurrence — `runNow` passes
    // `spendOccurrence: false`, and the button says as much ("this does not use
    // up the next scheduled run"). Settling it terminal broke that promise
    // silently: the tick skips terminal rows, so the schedule never fired again,
    // while the sheet went on counting down to an instant nothing was waiting
    // for. It goes back to waiting for its own clock instead.
    // …and it is a promise about a row with a NEXT RUN. A timed WORK row
    // (`isTimedWorkRow`) has none: its clock is spent by the one run, so
    // "this does not use up the next scheduled run" describes nothing, and
    // returning it to `queued` would leave a work item that has already run
    // sitting in the backlog waiting to run again. It settles like any other
    // work item; `settle()` already nulls `nextAt` for a non-recurring `at`.
    if (!spend && row.trigger.kind === "at" && !isTimedWorkRow(row) && row.nextAt != null && row.nextAt > at) {
      row.state = "queued";
      row.result = result;
      row.startedAt = undefined;
      this.core.persist();
      this.core.deps.onChange(row);
      this.core.emit("settled", row, result);
      return;
    }
    this.settle(row, res.ok ? "done" : "failed", result);
  }

  /** Which executor, and why. Dispatch is on the TARGET, with the one
   *  documented exception the schedule adapter needs (`ORIGIN_SCHEDULE_WORK`). */
  execute(row: Intent): Promise<ExecutorResult> {
    const ex = this.core.deps.executors;
    // …and that exception is now for STANDING RULES only. A recurring rule
    // outlives each of its occurrences, so each occurrence needs a row of its
    // own to be the account of, and `workItem` mints one (F14's inheritance is
    // unchanged).
    //
    // A ONE-OFF has nothing to outlive: it is spent by its single run, so a
    // child row is a second row for one piece of work — and the parent could
    // fail at rung 3 (its grace missed) with the child never made, which is why
    // this desktop had seven failed scheduled items that were in no backlog. It falls through to the ordinary
    // repo/session dispatch below, where `freshSession`'s AWAITED branch runs
    // it exactly as any other backlog row — `isBacklogRow` is true for it now,
    // which is the one line that branch turns on. `serial` and `holdForHost`
    // are already on the row (`scheduleToIntent` sets both from
    // `waitUntilFree`), so the rungs hold it exactly as the tick meant to.
    //
    // A waiver on the rule is still on it here (cleared once this returns): the
    // rule STARTING is this occurrence, but the work is the child's, so the
    // child is what inherits it (`workItemInherits`), window and all.
    if (queuesBacklogItem(row)) return ex.workItem(row);
    // The build twin, before the build branch below would run the RULE's own
    // row as if it were a run: a build rule's occurrence POSTS one ordinary
    // run (`postsScheduledBuild`), and that row is what executes.
    if (postsScheduledBuild(row)) {
      return ex.scheduledBuild?.(row) ?? Promise.resolve({ ok: false, detail: "this host cannot run scheduled builds yet" });
    }
    // Before the shell branch, because an assessment is a `shell` target too:
    // it runs no session and delivers nothing, but it is a headless agent and
    // not a build command, so the PAYLOAD decides here and the target does not.
    if (row.payload.kind === "assess") {
      return ex.assess?.(row) ?? Promise.resolve({ ok: false, detail: "this host cannot run assessments yet" });
    }
    // And before it for the same reason: a capture is a `shell` target that
    // runs no shell command.
    if (row.payload.kind === "capture") {
      return ex.capture?.(row) ?? Promise.resolve({ ok: false, detail: "this host cannot take captures yet" });
    }
    if (row.payload.kind === "build" || row.target.kind === "shell") {
      return ex.build?.(row) ?? Promise.resolve({ ok: false, detail: "this host cannot run build intents yet" });
    }
    switch (row.target.kind) {
      case "repos":
        return ex.sweep(row, row.target.dirs);
      case "sessions":
        return ex.followUp?.(row, row.target.sessionIds) ?? Promise.resolve({ ok: false, detail: "this host cannot run follow-up intents yet" });
      case "session":
        // ── The session is gone, and this row knows which conversation ─────
        //
        // Rung 5 let it through on exactly this test (`reopensConversation`),
        // so the executor has to answer it the same way or the row is typed
        // into a dead id. `freshSession` opens the session — `openItemSession`
        // reads the same snapshot and reopens THAT conversation rather than
        // starting an empty one, which is the difference between the words
        // landing where they were aimed and landing in a window that has never
        // heard of the work.
        if (reopensConversation(row) && !this.core.deps.sessionAlive(row.target.sessionId)) {
          // The conversation may already be open under another id — type into
          // that one rather than start a second process on it (`liveConvSession`,
          // the same answer rung 5 gave).
          const open = liveConvSession(row, this.core.deps.sessions());
          return open ? ex.deliver(row, open) : ex.freshSession(row);
        }
        return ex.deliver(row, row.target.sessionId);
      case "repo": {
        if (row.target.fresh) return ex.freshSession(row);
        // The tick never gets here without a session (rung 5 blocks first), so
        // this is the hand-fired path: a person tapped "run it" on a repo with
        // nothing open. It FAILS rather than requeuing, because a tap deserves
        // an answer and the answer is a button they have to press.
        const sid = row.sessionId ?? this.core.deps.repoSession(row.cwd, true);
        if (!sid) return Promise.resolve({ ok: false, detail: "No open session for this repo. Open a session for it (the “session” button), then fire." });
        return ex.deliver(row, sid);
      }
      default:
        return Promise.resolve({ ok: false, detail: "this host does not know how to run that" });
    }
  }

  /** The session an intent would use right now, for the paths that fire outside
   *  the ladder (`runNow`). */
  resolveSessionFor(row: Intent): string | undefined {
    if (row.target.kind === "session") return row.target.sessionId;
    // `adopt`: this is only reached from `runNow`, and a person who taps "fire"
    // on a repo whose only session they opened themselves has just said which
    // session they mean. Automatic work never gets that argument.
    // A FRESH repo target resolves to nothing on purpose, hand fire or not: the
    // session it runs in does not exist yet, and opening one is what
    // `freshSession` is. Passing a session id here would hand the executor a
    // conversation somebody else is in — which, for the default shape of every
    // work item, is the whole thing this design removed.
    if (row.target.kind === "repo" && !row.target.fresh) {
      // A row old enough to predate the normalisation (`cleanTarget` gives every
      // repo target `fresh: true` now). A tap, so a hand-driven session may be
      // adopted; `execute`'s own repo branch answers in words if there is
      // nothing to adopt.
      return this.core.deps.repoSession(row.cwd, true) ?? undefined;
    }
    return undefined;
  }

  /**
   * A recurring occurrence blew past its grace window.
   *
   * It is not run and it is not failed: the row keeps standing and says it was
   * missed. That is the hole this store closes — `schedule.ts` recorded the
   * miss onto a `once` row it then DELETED, taking the prompt text with it, and
   * emitted nothing at all, so an occurrence that never ran looked exactly like
   * one that had.
   */
  /**
   * Give a NON-RECURRING `at` row its occurrence back.
   *
   * `fire()` spends the occurrence before the executor is invoked — that
   * ordering is the whole file, and it is right for everything that spends one
   * by RUNNING. A `retry` is the one verdict that says the opposite: provably
   * nothing was typed. So the row goes back to the queue with nothing left to
   * wait for — `nextAt` is `null` for a `once` (or, worse, NEXT WEEK for a
   * `window oneShot`, because `armFrom` obligingly finds the following reset) —
   * and the next tick's rung 3, seeing a non-recurring `at` with no occurrence
   * left, gravestones it with *"that instant has passed and this was a one-off
   * — post it again"*. The instant had not passed; the spawn failed.
   *
   * Reproduced against the built store before this existed — a `once` row due
   * 1 s ago whose executor answers `retry` exactly once:
   *
   *     once after tick 1: queued attempts=1 nextAt=null
   *     once after tick 2: failed attempts=1 ran=1 | that instant has passed…
   *     idle (control) tick 2: done ran=2        | delivered
   *
   * Zero runs, and the sentence on the gravestone tells the person to retype a
   * prompt the daemon never typed. That is this repo's worst failure class, and
   * it landed on exactly the rows `isTimedWorkRow` moved into the backlog: a
   * one-off with a clock now takes `freshSession`'s awaited branch, which is
   * the one executor that can answer `retry` at all (full pty table,
   * `notready`, an ambiguous echo).
   *
   * A RECURRING rule is deliberately untouched: its occurrence is one of many,
   * `armFrom` has already placed the next one, and handing this one back would
   * arm the same instant twice — the standing-policy reading `reconcileOne` and
   * `recordMissed` both take.
   *
   * `clearedOccurrence` is restored with it, and that is a statement of fact
   * rather than a kindness: reaching `fire()` IS rung 3 having released this
   * occurrence, so the retry must not be judged a second time against a grace
   * the first attempt spent. `INTENT_MAX_ATTEMPTS` is what bounds the loop, as
   * it already did.
   */
  unspend(row: Intent, occurrence: number | undefined): void {
    if (occurrence == null) return;
    if (row.trigger.kind !== "at" || isRecurring(row)) return;
    // Not this fire's to give back — something else has already moved the row on.
    if (row.lastOccurrence !== occurrence) return;
    row.nextAt = occurrence;
    row.lastOccurrence = undefined;
    row.clearedOccurrence = occurrence;
  }

  /**
   * Remember that rung 3 let this occurrence through.
   *
   * The whole of the fix for the observed case in `Intent.clearedOccurrence`:
   * without it, every tick re-judges an occurrence that is only still waiting
   * because a rung below rung 3 told it to, and the grace the person set gets
   * spent by the hold rather than by the thing it was measuring.
   *
   * Idempotent and quiet — it writes only on a CHANGE, because it runs for
   * every held row on every 2 s tick and `persist()` is a tmp+rename of the
   * whole store. `block()` (the caller's next line) does the persisting when the
   * row's reason changed; a stamp that changed with the reason unchanged is
   * persisted here, because losing it to a restart is exactly the failure this
   * field exists to prevent.
   */
  stampCleared(row: Intent, occurrence: number | undefined): void {
    if (occurrence == null || row.clearedOccurrence === occurrence) return;
    row.clearedOccurrence = occurrence;
    this.core.persist();
  }

  recordMissed(row: Intent, occurrence: number, detail: string, now: number): void {
    if (row.lastOccurrence === occurrence) return; // already recorded
    row.lastOccurrence = occurrence;
    // The occurrence is over. A stamp left behind would be a release belonging
    // to an instant nothing will ask about again.
    row.clearedOccurrence = undefined;
    // And a waiver given for that occurrence goes with it.
    row.pastBudget = undefined;
    row.leftoverOf = undefined;
    row.nextAt = this.core.armFrom(row, occurrence, now);
    row.result = { at: now, ok: false, detail, occurrence };
    row.state = "queued";
    row.blockReason = undefined;
    row.blockDetail = undefined;
    this.core.persist();
    this.core.deps.onChange(row);
    this.core.emit("missed", row, row.result);
  }

  settle(row: Intent, state: "done" | "failed" | "canceled", result: IntentResult, missing?: string[]): void {
    row.state = state;
    // A terminal row has no next start for a waiver to be about.
    row.pastBudget = undefined;
    row.leftoverOf = undefined;
    row.result = result;
    row.settledAt = result.at;
    // A one-off that has reached a terminal state is not ARMED any more, and
    // `nextAt` is the only field on the wire that can say so: `intentToSchedule`
    // derives `enabled` from it and the schedule sheet renders `inWords(nextAt)`
    // as the row's chip. Left standing, a `once` that missed its grace window
    // wore a bright "due now" for ever — the one thing it could not be, a
    // terminal row being exactly what the tick skips — and `isSpentOnce` could
    // not correct it, keying as it does on the null this never became. Recurring
    // rules keep theirs; they never reach here. Same for a `weekly`/`window`
    // rule marked `oneShot` — it has exactly the same "nothing left to arm"
    // shape as a `once`, just a different anchor.
    if (row.trigger.kind === "at" && !isRecurring(row)) row.nextAt = null;
    row.blockReason = undefined;
    row.blockDetail = undefined;
    // Set, never cleared — the opposite rule to `fire()`/`block()`, and
    // deliberately. By the time a row settles, `fire()` has already stamped what
    // this run went without (usually nothing), and that record is the whole
    // point: a launch that ran early without its picture must keep saying so.
    // The only settle that ARRIVES with a list is the files trigger giving up,
    // which is naming the files it never got.
    if (missing) row.missing = missing;
    this.core.persist();
    this.core.deps.onChange(row);
    this.core.emit("settled", row, result);
  }

  replace(row: Intent): void {
    this.core.setRows(this.core.rows().map((r) => (r.id === row.id ? row : r)));
    this.core.persist();
    this.core.deps.onChange(row);
  }
}
