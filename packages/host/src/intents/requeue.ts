/**
 * The verbs a person (or an assessment, or the backlog) aims at ONE row that
 * already exists: mark it done, put it back (`requeue`, `requeueFailed`, over
 * the one transition `revive` and its pre-flight `wouldNotRun`), call it off,
 * dismiss it, remove it, run it now, name the session it opened, and the
 * upload nudge. Stateless — every fact lives on the row or behind `core`.
 * Reasoning: skill `host-work` ("A FAILED row can be PUT BACK") and
 * docs/notes/host-architecture.md ("IntentCore — the same, in
 * intents/contract.ts").
 */
import {
  busyIntentGroups,
  intentVerdict,
  isTimedWorkRow,
  REQUEUE_KEEP,
  type Intent,
  type IntentFacts,
  type IntentRequeue,
} from "@waterplane/shared";
import { isRecurring, isTerminal, PENDING_MAX, revivedShape, type IntentCore } from "./contract.js";

/** "I dealt with this by hand." The backlog's `markDone`, which is a claim
 *  about the WORK and therefore may be made about a row that is running. */
export function markDone(core: IntentCore, id: string, detail = "marked done by hand"): boolean {
  const row = core.get(id);
  if (!row || row.state === "done") return false;
  core.stopBase.delete(id);
  core.watchMode.delete(id);
  core.readopted.delete(id);
  core.settle(row, "done", { at: Date.now(), ok: true, detail });
  return true;
}

/**
 * The ONE transition from "this row is over" back to "this row is waiting its
 * turn" — the field work, with no policy in it.
 *
 * Private, and both public verbs go through it, because the damage a second
 * copy of this does is invisible: a row returned to `queued` still carrying
 * `startedAt` renders as having started, one still carrying `sessionId` gives
 * the phone a tappable session that belongs to the run before this one, and
 * one still carrying `dismissedAt` is pending work that `compact()` is already
 * allowed to evict. The two verbs differ in WHO may ask and in nothing else.
 *
 * ── What is cleared, and what is deliberately kept ────────────────────────
 *
 * Cleared: everything that is an account of the run that just ended, or of the
 * ladder's opinion of a row that is about to be re-judged from scratch —
 * `attempts` (the delivery-retry count, which is per-run and whose cap is what
 * stops a stuck session being typed at for ever), `startedAt`/`settledAt`,
 * `sessionId`, `dismissedAt`, `blockReason`/`blockDetail`, `missing` (the
 * files THAT run went without), `followed` (a fact about that run's session,
 * `fire()` clears it for the same reason) and `clearedOccurrence` (rung 3's
 * release of an occurrence this row is no longer waiting on).
 *
 * **KEPT: `result`.** It is the last thing anybody wrote about this work, and
 * a re-queue is not a claim that it did not happen — the row says "queued, and
 * this is how it went last time" until the next run overwrites it. That is
 * already the established posture on the other side of the wire:
 * `adapters.ts`'s `intentToBacklogItem` reads `error` only on a row whose
 * STATUS is failed, so a queued row's `result` renders as history rather than
 * as a red line. Clearing it here would instead lose the failure at the exact
 * moment somebody decided to do something about it.
 *
 * Untouched, and this list matters as much as the other two: `id`, `cwd`,
 * `payload`, `target`, `serial`, `holdForHost`, `auto`, `order`,
 * `handOrdered`, `label`, `title`, `origin`, `groupId`, `createdAt`. It is the
 * same work, in the same place, aimed at the same thing. **`origin` in
 * particular is never rewritten**: it is CLASSIFICATION, not provenance —
 * `scheduleIdFromOrigin` reads a rule's id back out of it and the fan-out
 * markers are read the same way, so stamping "an assessment put this back"
 * there would re-file the row under a rule that does not exist. Who put it
 * back is `requeues[].by`, which is the field that exists to say so.
 *
 * The history is capped by COUNT here exactly as `cleanIntentRow` caps it on
 * the way in — `REQUEUE_KEEP` newest, oldest dropped whole, nothing inside an
 * entry ever clipped. **And the COUNT is not the list's length**, which is
 * the whole of `Intent.requeueCount`: the list stops growing at five because
 * it carries words, the number must not, or a row that has been put back
 * eleven times says "the 5th time" for ever. The one legitimate read of
 * `requeues.length` is here and is a FLOOR taken ONCE — a row written before
 * the field existed has four entries and no count, and four is a better first
 * answer than one.
 *
 * ── `dropClock` is here rather than at the caller ─────────────────────────
 *
 * Because the probe in `requeueFailed` has to be able to ask the ladder about
 * the row as this transition WOULD leave it, and a second spelling of "what a
 * re-queue does to a row" is a probe that judges a row nobody is about to
 * write. `revivedShape()` below is that one spelling; this applies it.
 *
 * Persisting, announcing and kicking are the CALLER's: a re-queue that also
 * drops a clock has a second write to make first, and one `persist()` per
 * decision is the rule everywhere else in this file.
 */
function revive(row: Intent, entry: IntentRequeue, dropClock = false): void {
  Object.assign(row, revivedShape(row, dropClock));
  // The uncapped number, bumped once per transition. `requeues.length` is the
  // floor for a row that predates the field and is read exactly here — see
  // `Intent.requeueCount`, which promises that absent means nobody counted.
  row.requeueCount = (row.requeueCount ?? row.requeues?.length ?? 0) + 1;
  // The failure itself travels INTO the entry, whole: `result` stays on the
  // row until the next run replaces it, and then the entry is the only copy
  // of what happened the time before. Written here rather than by the callers
  // so there is one moment at which the pair is taken.
  const kept = [...(row.requeues ?? []), { ...entry, result: entry.result ?? row.result }];
  row.requeues = kept.length > REQUEUE_KEEP ? kept.slice(-REQUEUE_KEEP) : kept;
}

/** Put a settled row back in the queue, keeping every word of it. The
 *  backlog's "re-fire a done/failed item", which was never a new item: the
 *  row is the account of the work, and a second one would split it in two.
 *
 *  `allowDone` is the caller saying it means a row that RAN — which is what
 *  the backlog's re-fire button is for, and what `requeueFailed` refuses in
 *  words. It is an opt-in rather than the default because "put this back" and
 *  "run this again" are different sentences, and only one of them may be
 *  reached by a verdict about work that finished.
 *
 *  `by` is WHOSE re-queue this was, and the caller is the only thing that
 *  knows: `backlog.fire()` reaches this verb and then fires the row in the
 *  same breath, so its entry says `run` — "put back only as the first half of
 *  running it now" — where a bare tap on *put it back* says `hand` and leaves
 *  the row waiting. The two read differently on the phone and the difference
 *  is not derivable from anything on the row. */
export function requeue(core: IntentCore, id: string, opts?: { allowDone?: true; by?: IntentRequeue["by"] }): boolean {
  const row = core.get(id);
  if (!row || row.state === "starting" || row.state === "running") return false;
  if (row.state === "done" && !opts?.allowDone) return false;
  revive(row, { at: Date.now(), by: opts?.by ?? "hand" });
  core.persist();
  core.deps.onChange(row);
  core.kick();
  return true;
}

/**
 * Put a FAILED row back in the queue — the verb an assessment's *still
 * wanted* is allowed to reach, and the row's own re-queue tap.
 *
 * ── Why `failed` only, and why that is the safety rather than a limitation ─
 *
 * A verdict is about the list as it was when the run STARTED — `AssessInput`
 * is a snapshot, twenty minutes old by the time anybody reads it — so
 * `AssessMutations.requeue` means "the person approved putting these back",
 * never "these are failed right now". Between the two, a row may have been
 * fired by hand, picked up by the ladder, finished, or called off. So the
 * state is re-asked HERE, against the live row, and everything that is not
 * `failed` is refused: a late apply cannot revive work that has since run,
 * cannot re-queue a row that is already queued, and cannot overrule a person
 * who called something off. That is what makes the whole path safe to apply
 * late, which is the case it exists for.
 *
 * Every refusal is a SENTENCE, because these are shown to a person and
 * "refused" is not a reason. `done` and `canceled` get their own words rather
 * than a shared "it is already done": the answer to each is different — a done
 * item is RE-FIRED (`requeue(id, {allowDone: true})` behind the backlog's own
 * button), a called-off one is posted again — and a refusal that does not name
 * the next move is a dead end on a phone.
 *
 * ── The spent one-off clock ────────────────────────────────────────────────
 *
 * A failed `isTimedWorkRow` row carries `nextAt: null` (`settle()` writes it)
 * and an instant that is in the past. Putting it back exactly as it was queues
 * a row rung 3 will fail again on the next tick for the only reason it can:
 * that instant has passed. The person taps *still wanted* and watches it die
 * of the same sentence — which is the bug this whole verb exists to fix, moved
 * two seconds later.
 *
 * So the clock is dropped: `{kind: "idle"}`, no armed instant, no spent
 * occurrence, no release. This is exactly what the phone's *drop the clock*
 * does through `update()`, and it is the same trade — the row runs in its
 * turn instead of at a time that is gone. It is a change to what somebody
 * asked for, so the row SAYS so: `clockDropped: true` on the entry, never
 * inferred later from a trigger that is `idle` for a dozen other reasons.
 *
 * And a trigger-KIND change needs the bare `deps.onChange()` on top of the
 * row's own, for `update()`'s reason: every list a listener keeps is filtered
 * by something derived from the row, and a row LEAVING a list is not
 * expressible as a changed row.
 *
 * ── No event ──────────────────────────────────────────────────────────────
 *
 * `this.emit("requeued", …)` is the usage-limit channel — `server/intentEvents.ts` turns
 * it into a "Backlog paused" push about work the HOST parked. A person tapping
 * *still wanted* is not that, and a notification saying the backlog was paused
 * because they asked for something to run is worse than silence. `onChange` +
 * `kick()` and nothing else: the row moves, the list re-renders, the ladder
 * looks at it on the next pass.
 *
 * ── What a chain does around this ─────────────────────────────────────────
 *
 * `chainFacts()` supplies `settled` and `knownIntents` from the same walk, and
 * the two answer differently about a revived row, which is the behaviour this
 * verb relies on:
 *  - it is dropped from `settled` the moment it is no longer terminal, so a
 *    successor waiting on it goes back to WAITING and will wait for the NEW
 *    finish. It does not inherit the old one, which is the only reading that
 *    could run a successor against a predecessor that has not re-run yet.
 *  - it stays in `knownIntents`, so the successor waits rather than failing
 *    with "the row it is waiting for is gone".
 *  - a successor that has ALREADY failed is not revived by its predecessor
 *    coming back. It is terminal and nothing here walks forward; putting the
 *    chain back is a decision per row, which is what the assessment judges and
 *    what the tap makes.
 *
 * ── The PRE-FLIGHT: would the revived row actually get anywhere? ──────────
 *
 * Everything above repairs the row. None of it asks the question a person
 * taps *still wanted* to have answered, which is whether the row can run —
 * and for three shapes the honest answer is no, for ever:
 *
 *  - a CHAIN whose predecessor is gone, archived or recurring. `intentVerdict`
 *    fails it on the very next tick with the same sentence it is already
 *    wearing: the tap produced a history entry, a list re-render and a second
 *    gravestone. That is the "did nothing observable" bug this verb exists to
 *    remove, one tick slower.
 *  - a `{kind: "session"}` target whose session has closed. Rung 5 answers
 *    `sessionGone` and nothing in this store ever re-aims it (the one thing
 *    that does is the limit resurrection, and only for a limit exit), so the
 *    row waits for ever, politely, in a list of things that are going to run.
 *  - an ARCHIVED row. `buildAssessInput` filters on STATE, so an unscoped
 *    assessment judges set-aside rows too; re-queued, rung 1 holds them at
 *    *set aside* until somebody brings them back.
 *
 * The failure that makes it worth a rung of its own is the sentence: Apply
 * says "19 put back in the queue … they run again when their turn comes", and
 * for several of them that is untrue at the moment it is printed.
 *
 * So the ladder is asked FIRST, about a COPY of the row as this transition
 * would leave it (`revivedShape`, clock and all), with the same facts a tick
 * supplies — `chainFacts()`, the live sessions, the budget, the cap. A `fail`
 * verdict, a `sessionGone` wait and an archived row are refused in words
 * quoting the ladder's own detail, and the row is left `failed`, uncounted and
 * unmutated: nothing is written down about a re-queue that did not happen.
 *
 * **The ordinary waits are NOT refused, and that list is the whole safety of
 * the rule.** Budget, `serial`, `noSlot`, `hostBusy`, quiet hours, a live
 * chain still running, auto-fire switched off — every one of those is exactly
 * what "it runs again when its turn comes" MEANS. A rung that refused them
 * would turn a busy desktop into a phone that will not put anything back.
 */
export function requeueFailed(
  core: IntentCore,
  id: string,
  by: { kind: "assess"; runId: string } | { kind: "hand" } | { kind: "run" },
  /** `kick: false` for a caller with more to do before the ladder should
   *  look: `applyProposal` writes N re-queues and then the approved ranks,
   *  and `runNow` fires the row itself. See the option's own note below. */
  opts?: { kick?: false },
): { ok: boolean; reason?: string } {
  const row = core.get(id);
  if (!row) return { ok: false, reason: "that intent is gone" };
  // `inflight` is asked with the states for the reason `runNow` asks it: the
  // persisted state covers a restart, the map covers a slow spawn inside this
  // process, and a row being typed into right now must not be re-queued under
  // the executor's feet.
  if (core.inflight.has(row.id) || row.state === "starting" || row.state === "running") {
    return { ok: false, reason: "it is already running" };
  }
  if (row.state === "queued" || row.state === "blocked") return { ok: false, reason: "it is already waiting its turn" };
  if (row.state === "done") return { ok: false, reason: "it already ran — a done item is re-fired, not put back in the queue" };
  if (row.state === "canceled") return { ok: false, reason: "it was called off — post it again if you still want it" };
  if (core.pending().length >= PENDING_MAX) {
    // The same sentence `post()` refuses with, because it is the same ceiling
    // and a reader must not have to work out that two wordings are one rule.
    return { ok: false, reason: `this host is already holding ${PENDING_MAX} intents that have not run — clear some before adding more` };
  }
  const dropClock = isTimedWorkRow(row) && row.trigger.kind === "at";
  // Before ANYTHING is written: would this row get anywhere? See the
  // pre-flight note above for the three shapes that answer no for ever.
  const stuck = wouldNotRun(core, revivedShape(row, dropClock));
  if (stuck) return { ok: false, reason: stuck };
  const was = row.trigger.kind;
  revive(row, {
    at: Date.now(),
    by: by.kind,
    runId: by.kind === "assess" ? by.runId : undefined,
    clockDropped: dropClock ? true : undefined,
  }, dropClock);
  core.persist();
  core.deps.onChange(row);
  if (was !== row.trigger.kind) core.deps.onChange();
  if (opts?.kick !== false) core.kick();
  return { ok: true };
}

/**
 * The pre-flight itself: ask the ladder about a row that does not exist yet.
 *
 * Handed the COPY `revivedShape()` made, so what is judged is the row the
 * write is about to produce and not the terminal one on disk. Answers a
 * SENTENCE to refuse with, or `null` for "put it back".
 *
 * ── Which outcomes are a refusal ──────────────────────────────────────────
 *
 *  - `archived`, asked on the row rather than read off the verdict. Rung 1
 *    turns it into a `gate` wait, and `gate` is also what auto-fire being
 *    switched off looks like — one of those is a row that will run the moment
 *    a switch flips, the other is a row somebody set aside and did not bring
 *    back. Reading the two off one reason would refuse the wrong one.
 *  - `kind: "fail"` — the ladder would settle it again on the next tick, with
 *    this exact sentence. Quoted, because "it would stop again straight away"
 *    on its own is the refusal without the reason.
 *  - a `sessionGone` wait — the one wait that nothing in this store ever
 *    ends.
 *
 * ── And the facts ─────────────────────────────────────────────────────────
 *
 * The same ones `pass()` builds, read here rather than shared with it because
 * this runs from a wire op and a pass runs from a timer: a snapshot handed
 * between them would be a fact about a different instant. Cheap — one verdict,
 * one `chainFacts()` walk (whose archive read is cached on the file's
 * size+mtime), no listing and no spawn.
 *
 * **`knownDirs` is the one fact this cannot go and get**: it is async, this
 * verb is not, and making it async would put an `await` between a route
 * handler's decision and its ack. So the last listing a pass took is reused,
 * and when there has never been one a `repos` row is NOT judged — absent means
 * nobody said, and a sweep refused on a listing this host has not read would
 * be the wrong number the whole file refuses to invent.
 */
function wouldNotRun(core: IntentCore, probe: Intent): string | null {
  if (probe.archived) {
    return "it is set aside — bring it back first, or it would sit in the queue as a row the ladder never looks at";
  }
  if (probe.target.kind === "repos" && !core.lastKnownDirs()) return null;
  const sessions = core.deps.sessions();
  const running = core.rows().filter((r) => r.state === "starting" || r.state === "running");
  const facts: IntentFacts = {
    sessions,
    repoSession: new Map([[probe.cwd, core.deps.repoSession(probe.cwd)]]),
    busyCwds: busyIntentGroups(sessions, running.map((r) => r.cwd)),
    busySessions: new Set(running.filter((r) => r.sessionId).map((r) => r.sessionId!)),
    budgetBlocked: core.deps.budgetBlocked(),
    budgetDetail: core.deps.budgetDetail?.(),
    budgetOver: core.deps.budgetOver?.(),
    budgetHeldSessions: core.deps.budgetHeldSessions?.(),
    autoFire: core.deps.autoFire(),
    knownDirs: core.lastKnownDirs() ?? new Set<string>(),
    hostBusy: running.length > 0,
    autoSlotsFree: core.deps.autoSlotsFree(),
    present: probe.trigger.kind === "files"
      ? new Set(probe.trigger.needs.filter((p) => core.present(probe.cwd, p)))
      : new Set<string>(),
    ...core.chainFacts(),
  };
  const verdict = intentVerdict(probe, facts, Date.now());
  if (verdict.kind === "fail") return `it would stop again straight away: ${verdict.detail}`;
  if (verdict.kind === "wait" && verdict.reason === "sessionGone") {
    return `it would wait for ever: ${verdict.detail}`;
  }
  return null;
}

/** Re-broadcast the lists without a row having changed — for a switch that
 *  changes what every row is waiting for, rather than what any of them says. */
export function emitChanged(core: IntentCore): void { core.deps.onChange(); }

export function cancel(core: IntentCore, id: string, reason = "called off from the phone"): boolean {
  const row = core.get(id);
  if (!row || isTerminal(row)) return false;
  if (row.state === "starting" || row.state === "running") return false;
  core.settle(row, "canceled", { at: Date.now(), ok: false, detail: reason });
  return true;
}

/** "I have seen this one." The gate a terminal row must pass before it may
 *  ever leave the live file. */
export function dismiss(core: IntentCore, id: string): boolean {
  const row = core.get(id);
  if (!row || !isTerminal(row) || row.dismissedAt) return false;
  row.dismissedAt = Date.now();
  core.persist();
  core.deps.onChange(row);
  return true;
}

/** Delete a row outright — the schedule sheet's "remove", and the ONLY way a
 *  row leaves this store other than compaction. It is archived first: an
 *  explicit delete is a user's decision, but the words were still theirs. */
export function remove(core: IntentCore, id: string): boolean {
  const row = core.get(id);
  if (!row) return false;
  core.stopBase.delete(id);
  core.stopSeen.delete(id);
  core.watchMode.delete(id);
  core.readopted.delete(id);
  core.archive([row]);
  core.setRows(core.rows().filter((r) => r.id !== id));
  core.persist();
  core.deps.onChange();
  return true;
}

/**
 * Run it now, trigger or no trigger.
 *
 * Two honesty rules carried over verbatim from what this replaces:
 *  - a `files` trigger records which files it went WITHOUT (`launch.ts`), so
 *    a session opened without its picture never renders as one that got it;
 *  - an `at` trigger does NOT spend its occurrence (`schedule.ts`), because
 *    testing Thursday's sweep on Tuesday must not eat Thursday.
 *
 * And one rule that is not carried over, because it was wrong: a FAILED row is
 * put back in the queue first (`requeueFailed`) rather than refused. See the
 * branch below.
 */
export async function runNow(core: IntentCore, id: string): Promise<{ ok: boolean; reason?: string }> {
  const ro = core.readOnly(); // a newer host's file: nothing fires (`intents/disk.ts`)
  if (ro) return { ok: false, reason: ro };
  const row = core.get(id);
  if (!row) return { ok: false, reason: "that intent is gone" };
  if (core.inflight.has(row.id)) return { ok: false, reason: "it is already running" };
  if (row.state === "starting" || row.state === "running") return { ok: false, reason: "it is already running" };
  if (isTerminal(row)) {
    // ── A FAILED row is put back before it is fired ────────────────────────
    //
    // This branch used to refuse it — `it is already failed` — while
    // `ActivitySheet` offered *run it now* on exactly those rows, which is the
    // whole of the bug: the phone showed the verb, the host answered that the
    // row was in the state the verb exists for. A person tapping fire on a
    // failed item means "do this again", and the row is the account of that
    // work, so it goes back through the one transition rather than being
    // half-revived here (the carve-out below clears four fields; `revive`
    // clears eleven and writes down that this happened).
    //
    // Refusals travel: `PENDING_MAX`, and the states that cannot be reached
    // from here anyway. `done` and `canceled` fall to the carve-out and are
    // refused exactly as they were today.
    //
    // `by: "run"` and NOT kicked, and the second half is a correctness rule
    // rather than an optimisation. A kick runs a pass synchronously as far as
    // its first `await`, so the revived row was handed to the ladder in the
    // same breath — and the ladder's honest answer for some of these rows is
    // not `go`: a chain whose predecessor failed, or a spent one-off that
    // `isTimedWorkRow` does not cover (a `repos` sweep keeps its null `nextAt`
    // and rung 3 gravestones it), settle FAILED in that pass, and the `fire()`
    // below then started a row this store had just written down as over. The
    // only thing standing between that and a genuine double fire was the pass
    // happening to `await pickHold?.()` first. So the tick is not invited: the
    // tap fires the row itself, `fire()` refuses a row that is already
    // claimed, and the sentence below is true again.
    if (row.state === "failed") {
      const r = requeueFailed(core, id, { kind: "run" }, { kick: false });
      if (!r.ok) return r;
    } else {
      // A SPENT one-off is the one terminal row a person can still mean. Its
      // instant passed — while the host was asleep, or because they ran it once
      // already — and "run it now" is the obvious answer to a row sitting there
      // with the words still in it. Refusing sent them off to retype a prompt
      // that is on the screen in front of them.
      //
      // Deliberately NOT kicked: the tick would re-ask the ladder, whose honest
      // answer for a spent one-off is `fail`. This is the exception to that
      // ladder rather than a hole in it — a person asked, now — and `fire()`
      // claims the row synchronously below, so nothing reaches it in between.
      // The failed branch above says the same thing now; it did not, and the
      // one sentence that was not true of it was this one.
      if (isRecurring(row) || row.trigger.kind !== "at") return { ok: false, reason: `it is already ${row.state}` };
      row.state = "queued";
      row.attempts = undefined;
      row.settledAt = undefined;
      row.blockReason = undefined;
      row.blockDetail = undefined;
    }
  }
  let missing: string[] | undefined;
  if (row.trigger.kind === "files") {
    const absent = row.trigger.needs.filter((p) => !core.present(row.cwd, p));
    missing = absent.length ? absent : undefined;
  }
  const sessionId = core.resolveSessionFor(row);
  await core.fire(row, { sessionId, missing, spendOccurrence: false });
  return { ok: true };
}

/**
 * "This row is running in THAT session" — said the moment the session exists,
 * rather than when the executor finally returns.
 *
 * An executor that OPENS a session and then delivers into it holds the row in
 * `starting` for the whole delivery — seconds, while `deliverPrompt` proves
 * what it typed — and for that whole window the row rendered as running with
 * no session on it: the phone showed a work item in flight and "open the
 * session" led nowhere. `ExecutorResult.sessionId` cannot fix that, because it
 * arrives at the end.
 *
 * It also takes the completion baseline HERE, which is the earliest honest
 * moment for it: the session is up and nothing has been typed into it yet, so
 * the first `Stop` past this count is genuinely this row's turn ending. On a
 * fast turn the hook used to arrive against a `starting` row with no baseline
 * at all and was dropped.
 */
export function noteSession(core: IntentCore, id: string, sessionId: string): void {
  const row = core.get(id);
  if (!row || row.sessionId === sessionId) return;
  if (row.state !== "starting" && row.state !== "running") return;
  row.sessionId = sessionId;
  if (!core.stopBase.has(id)) core.stopBase.set(id, core.deps.stopCount(sessionId));
  core.persist();
  core.deps.onChange(row);
}

/** An upload landed in this worktree — re-ask the gate now rather than in two
 *  seconds. Cheap: the tick only stats the paths it is still waiting on. */
export function fileLanded(core: IntentCore, cwd: string): void {
  if (!core.rows().some((r) => !isTerminal(r) && r.trigger.kind === "files" && r.cwd === cwd)) return;
  core.kick();
}
