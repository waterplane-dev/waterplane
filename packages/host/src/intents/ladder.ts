/**
 * The ladder: one pass of the tick over every pending row, and `block` — the
 * one transition a pass writes itself. Moved whole from `manager.ts` (I5,
 * docs/notes/host-architecture.md); the facade keeps a one-line private
 * `pass()` delegation because `ladderpass.test.mjs` calls it.
 *
 * `pass` mutates rows directly beside the transitions (the `window` arming,
 * the expired-waiver drop, the limit re-aim) — those writes are behaviour, not
 * an oversight, and so is the whole ladder being re-asked on the far side of
 * the one microtask yield before each claim (it was the smart pick's
 * `pickHold` await until 2026-10-16; the yield is kept for the batching it
 * gives a kick). Every read of the rows goes through `core.rows()` at the
 * moment it is needed, never cached across that await.
 */
import {
  budgetWaived,
  busyIntentGroups,
  intentSerialHolders,
  intentVerdict,
  needsSlot,
  serialGroup,
  type BlockReason,
  type Intent,
  type IntentFacts,
  type IntentVerdict,
} from "@waterplane/shared";
import { isTerminal, START_WATCHDOG_MS, type IntentCore } from "./contract.js";

/** A mutable copy of `IntentFacts.local` for one pass. */
function localCopy(l: IntentFacts["local"]): { free: number; rows: ReadonlySet<string>; busy: Set<string> } | undefined {
  return l ? { free: l.free, rows: l.rows, busy: new Set(l.busy) } : undefined;
}

export class LadderSlice {
  constructor(private readonly core: IntentCore) {}

  async pass(): Promise<void> {
    // A read-only store (a newer host's file) fires nothing: a `starting` that
    // cannot reach the disk is a row the next restart may run a second time.
    if (this.core.readOnly()) return;
    // Halted (`halt.ts`): nothing fires, and nothing is used up — a row that
    // tried and was refused would be spent. It waits for the lift.
    if (this.core.deps.halted?.()) return;
    const now = Date.now();
    // Free the in-memory guard for an executor that never answered. The row
    // stays `starting` on disk — only a restart may reconcile that.
    for (const [id, at] of this.core.inflight) if (now - at > START_WATCHDOG_MS) this.core.inflight.delete(id);

    // Rows already delivered and waiting for their turn to end. Swept first,
    // because a row that completes here frees the session the rows below it are
    // queued behind — doing it the other way round costs every one of them a
    // whole tick.
    this.core.sweepRunning(now);

    // ── Arm the rules whose anchor is not a clock ────────────────────────────
    //
    // A `window` rule is anchored to a usage reset the host reads off the CLI,
    // so at the moment it is posted — and at every boot before the first scrape
    // lands — there is simply no instant to arm it at. `armFrom` answers
    // `undefined` for that ("not computed"), which `intentVerdict` reads as
    // *waiting for a reading* rather than as *switched off*; this is what
    // eventually turns it into a real occurrence. Cheap: it only touches rows
    // that are both `window` and unarmed, and it stops the moment one is.
    let armedAny = false;
    for (const row of this.core.rows()) {
      if (isTerminal(row) || row.trigger.kind !== "at" || row.trigger.rule.kind !== "window") continue;
      if (row.nextAt != null) continue;
      const at = this.core.armFrom(row, row.lastOccurrence ?? this.core.newBasis(row), now);
      if (at != null) { row.nextAt = at; armedAny = true; }
    }
    // ── Drop the waivers whose window has reset ──────────────────────────────
    //
    // `budgetWaived` already refuses an expired one everywhere it is asked;
    // this makes the stored row SAY so, so no phone draws a waiver chip over a
    // row the budget is holding again. Not a starting row: its waiver is
    // cleared by the start's own outcome. A WEEKLY waiver that ran out before
    // its row started leaves the row a leftover of that week, so the new week
    // is not spent on it at once (`leftoverCeiling`).
    for (const row of this.core.rows()) {
      if (row.pastBudget && !budgetWaived(row, now) && row.state !== "starting" && row.state !== "running") {
        if (row.pastBudget.weekly && !isTerminal(row)) row.leftoverOf = row.pastBudget.until;
        row.pastBudget = undefined;
        armedAny = true;
      }
    }
    if (armedAny) { this.core.persist(); this.core.deps.onChange(); }

    const live = this.core.rows()
      .filter((r) => !isTerminal(r) && r.state !== "starting" && r.state !== "running" && !this.core.inflight.has(r.id))
      // An explicit position first, then oldest first. The backlog's list order
      // IS its run order — a drag is a statement about what should go next —
      // and `createdAt` is what that meant before anybody dragged anything.
      .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
    if (!live.length) return;

    // The dir listing is the one expensive fact, and only a sweep reads it.
    const knownDirs = live.some((r) => r.target.kind === "repos")
      ? await this.core.deps.knownDirs()
      : null;
    // Kept for `wouldNotRun()`, which cannot ask for one. Only a listing that
    // actually came back is remembered: the `null` branch above is "no sweep in
    // this pass", not "this root holds no repos", and the two must not merge.
    if (knownDirs) this.core.setLastKnownDirs(knownDirs);

    const sessions = this.core.deps.sessions();
    // Two sources of "occupied", both from facts the host owns and both QUEUED
    // work: a cwd where an intent is starting or running, and a live AUTOMATIC
    // session there behind a wall (`intentSerialHolders` — a hand session
    // never holds a serial row). No startup-grace timer — the host holds the
    // intent in `starting` across exactly the window that timer existed to cover.
    const occupiedRows = this.core.rows().filter((r) => r.state === "starting" || r.state === "running");
    const occupied = occupiedRows.map((r) => r.cwd);
    const busyCwds = busyIntentGroups(sessions, occupied);
    // WHO holds each of those groups, for the `serial` sentence only — same
    // inputs, same `sessionWall`, so it names exactly the groups `busyCwds` holds.
    const holders = intentSerialHolders(sessions, occupiedRows.map((r) => ({ cwd: r.cwd, sessionId: r.sessionId })));
    const busySessions = new Set(
      this.core.rows().filter((r) => (r.state === "starting" || r.state === "running") && r.sessionId).map((r) => r.sessionId!),
    );
    const repoSession = new Map<string, string | null>();
    for (const r of live) {
      if (repoSession.has(r.cwd)) continue;
      repoSession.set(r.cwd, this.core.deps.repoSession(r.cwd));
    }
    // The local-model cap, read and spent exactly like `autoSlotsFree`
    // (`localslot.ts`). Copied, so the per-fire decrement below cannot write
    // through to whatever the dep handed back; `base.local` IS this object.
    const local = localCopy(this.core.deps.localSlots?.());
    const base: Omit<IntentFacts, "present"> = {
      sessions,
      repoSession,
      busyCwds,
      serialHolders: holders,
      busySessions,
      budgetBlocked: this.core.deps.budgetBlocked(),
      budgetDetail: this.core.deps.budgetDetail?.(),
      budgetOver: this.core.deps.budgetOver?.(),
      leftoverOver: this.core.deps.leftoverOver?.(),
      budgetHeldSessions: this.core.deps.budgetHeldSessions?.(),
      autoFire: this.core.deps.autoFire(),
      knownDirs: knownDirs ?? new Set<string>(),
      // Mutated below as this pass fires rows — same trick as `busyCwds`, a
      // plain boolean instead of a Set because `holdForHost` cares about the
      // whole host and not which group. `occupied` already answers it at the
      // top of the pass; the mutation is what makes a SECOND `holdForHost`
      // row, due in the same pass as the first, see the first as busy too,
      // rather than both reading the pre-pass snapshot and both firing.
      hostBusy: occupied.length > 0,
      // Mutated below for exactly the same reason, and this is the fact that
      // makes it matter most: a fresh repo target passes rung 5 unconditionally
      // (nothing exists yet for the tick to see busy), so five rows due in five
      // repos in one pass would each read the cap as untouched and each open a
      // session. Decremented per fire, a pass opens min(due, free) of them.
      autoSlotsFree: this.core.deps.autoSlotsFree(),
      local,
      // What a chain reads. Built once per pass off the live rows plus the tail
      // of the archive — see `chainFacts()` for why all four are supplied
      // together and `ARCHIVE_TAIL_BYTES` for what the tail's far end costs.
      ...this.core.chainFacts(),
    };
    /** Slots this pass has already handed out per group, on top of what is
     *  already in flight — a pass fires several rows before any of them reports. */
    const claimed = new Map<string, number>();
    const groupBusy = (gid: string): number =>
      this.core.rows().filter((r) => r.groupId === gid && r.state === "starting").length + (claimed.get(gid) ?? 0);

    /**
     * What a verdict that is not `go` does to a row.
     *
     * Written once and called TWICE — before the yield and again after it,
     * because the facts are stale on the other side of it (see the re-ask
     * below). Two spellings of this would be two answers to one question,
     * and the one that drifted would be the one nobody reads.
     */
    const nonGo = (row: Intent, verdict: Extract<IntentVerdict, { kind: "fail" | "wait" }>): void => {
      if (verdict.kind === "fail") {
        this.core.settle(row, "failed", { at: now, ok: false, detail: verdict.detail }, verdict.missing);
        return;
      }
      if (verdict.missedOccurrence != null) { this.core.recordMissed(row, verdict.missedOccurrence, verdict.detail, now); return; }
      // Rung 3 released this occurrence and a rung BELOW it is holding the row.
      // Remembering that is what stops the next tick's rung 3 spending the same
      // deadline again on the wait this row was told to perform — the fix for a
      // real, observed loss of a user's work. See `Intent.clearedOccurrence`.
      this.core.stampCleared(row, verdict.clearedOccurrence);
      // The cap, and how much of it is in use, are the HOST's numbers — the
      // pure rule is handed `autoSlotsFree` and never the ceiling it was
      // subtracted from, so it writes the general sentence and this is where
      // the specific one replaces it. Exactly `budgetDetail`'s arrangement.
      const detail = verdict.reason === "noSlot"
        ? this.core.deps.autoSlotsDetail?.() ?? verdict.detail
        : verdict.reason === "localModel"
          ? this.core.deps.localSlotsDetail?.() ?? verdict.detail
          : verdict.detail;
      // Nothing is closed to make room: only a WORKING automatic session holds
      // a slot (`slotBusy`, R-automation-042), so closing an idle one would free
      // nothing — the slot frees itself when a working one goes idle, and the
      // next tick's fresh `autoSlotsFree()` hands it to the first row in order.
      this.block(row, verdict.reason, detail, verdict.missing, verdict.holderSessionId);
    };

    for (const row of live) {
      // Re-read: an earlier iteration in this same pass may have settled it.
      if (!this.core.rows().includes(row) || isTerminal(row) || this.core.inflight.has(row.id)) continue;
      // A row aimed at a session that exited at the usage LIMIT follows its own
      // resurrection: the host reopens that worktree as a new session at the
      // reset, and re-aiming is the difference between the work resuming and
      // the row saying "that session is gone" for ever. Only for a limit exit —
      // a crashed or quit session proves nothing about where its work belongs.
      if (row.target.kind === "session" && !this.core.deps.sessionAlive(row.target.sessionId) && this.core.deps.diedAtLimit(row.target.sessionId)) {
        const revived = this.core.deps.revivedSessionFor(row.target.sessionId);
        if (revived) {
          // The snapshot travels: a resurrection reopens the SAME conversation
          // (`--resume <id>` keeps the id), so the row that could reopen it
          // before the wall must still be able to after one.
          row.target = { ...row.target, sessionId: revived };
          row.sessionId = undefined;
          this.core.persist();
          this.core.deps.onChange(row);
        }
      }
      // NO listing is not the same as an empty one. An empty listing is an
      // answer — this root holds no repos, so a sweep aimed at one has indeed
      // lost its targets — while a scan that has never succeeded is the absence
      // of an answer, and the pure rule would read it as "none of these exist
      // any more" and fail the sweep permanently on it.
      if (row.target.kind === "repos" && !knownDirs) continue;
      const present = row.trigger.kind === "files"
        ? new Set(row.trigger.needs.filter((p) => this.core.present(row.cwd, p)))
        : new Set<string>();
      const verdict = intentVerdict(row, { ...base, present }, now);
      if (verdict.kind !== "go") { nonGo(row, verdict); continue; }
      // The fan-out's concurrency pool, as a store rule rather than a private
      // loop: each target of a sweep is a real `claude` process, so a 20-repo
      // sweep fired in one pass would stampede the machine. Only DELIVERY holds
      // a slot (`starting`) — a target left `running` while its agent works is
      // not occupying the pool, which is what the old in-process pool meant too.
      if (row.groupId && groupBusy(row.groupId) >= this.core.deps.groupConcurrency()) {
        // The pool is below rung 3 too: a 20-repo sweep drains at
        // `groupConcurrency()` a pass, and the last repo in the queue must not
        // be failed as *missed* for having waited its turn.
        this.core.stampCleared(row, verdict.occurrence);
        this.block(row, "serial", `waiting its turn in this sweep — ${this.core.deps.groupConcurrency()} repos at a time`);
        continue;
      }
      // The row cleared the whole ladder, so whatever it was waiting for is over:
      // its old sentence must not outlive the yield below. A broadcast lands in
      // that yield — the auto switch's own, sent right after its kick — and it
      // said "auto is off" beside `auto: true` (`e2e-backlog-wait.mjs`).
      // Words only: the state is the transition's to write (`block`/`fire`).
      if (row.state === "blocked") {
        row.blockReason = undefined;
        row.blockDetail = undefined;
        row.blockSessionId = undefined;
        row.missing = undefined;
      }
      // The local model, LOADED, before the row opens on it — synchronous (the
      // load runs in the background and kicks the tick when it ends), so this
      // is not a yield. A sentence holds the row `localModel` and claims
      // nothing; below rung 3, so the wait costs no deadline.
      const localHold = this.core.deps.localHold?.(row);
      if (localHold) { this.core.stampCleared(row, verdict.occurrence); this.block(row, "localModel", localHold); continue; }
      // ── The one yield in this loop, kept on purpose ───────────────────────
      //
      // A bare microtask before every `go` row is claimed. Until 2026-10-16
      // this was the smart pick's `await pickHold?.(row)`; the smart pick is
      // gone, the yield is not. A kick runs the pass synchronously only as far
      // as here, so a synchronous batch of writes — a bulk waive, an apply's
      // re-queues, a post and its kick — lands BEFORE any of its rows is
      // claimed, and the claim below is judged against all of it. Removing it
      // turned ~30 host tests red (intentsched, pastbudget, requeue): that
      // batching is behaviour, not an accident of the old dep.
      await Promise.resolve();
      // That `await` is the first yield inside this loop, so it is the first
      // moment a `cancel()`, a `remove()` or an `edit()` off the wire can land
      // mid-pass. Re-read exactly what the top of the iteration reads, for the
      // same reason it reads it: firing a row somebody cancelled while the pass
      // was thinking about it is the one thing this seam could newly break.
      if (!this.core.rows().includes(row) || isTerminal(row) || this.core.inflight.has(row.id)) continue;
      // ── …and the VERDICT is older than the await, too ────────────────────
      //
      // Re-reading the row is not enough. `busyCwds`, `busySessions`, `hostBusy`
      // and `autoSlotsFree` were all computed at the top of the pass, and any
      // continuation queued ahead of this one — an async route handler
      // resuming into `runNow` — reaches `fire()` DIRECTLY, not through this
      // loop, and can start a sibling in this very worktree. When this await
      // was the smart pick's (which spawned `git`, a macrotask window) the held
      // row fired on the pre-await verdict: reproduced as `ran = ["B", "A"]`,
      // both `starting`, one cwd. That is precisely the "five due rows putting
      // five agents in one worktree" that `serial` exists to stop.
      //
      // So the busy facts are re-read and the ladder is asked again. Every
      // re-read is MONOTONIC — nothing is ever removed from `busyCwds` or
      // `busySessions` and `hostBusy` is never un-set — because those sets also
      // carry this pass's own claims, and a cwd that went quiet during the await
      // is a row that can simply run on the next tick. Cheap: pure arithmetic
      // plus one count of the host's live automatic sessions, and only for a row
      // that has already cleared the whole ladder.
      const runningNow = this.core.rows().filter((r) => r.state === "starting" || r.state === "running");
      const sessionsNow = this.core.deps.sessions();
      for (const g of busyIntentGroups(sessionsNow, runningNow.map((r) => r.cwd))) busyCwds.add(g);
      // The names follow the same monotonic rule: a group first named here is
      // added, one already named keeps what it had.
      for (const [g, hs] of intentSerialHolders(sessionsNow, runningNow.map((r) => ({ cwd: r.cwd, sessionId: r.sessionId })))) {
        if (!holders.has(g)) holders.set(g, hs);
      }
      for (const r of runningNow) if (r.sessionId) busySessions.add(r.sessionId);
      if (!base.hostBusy) base.hostBusy = runningNow.length > 0;
      // The cap the same way — and the live count is ALREADY comparable, so
      // nothing is subtracted from it here.
      //
      // Subtracting this pass's own fires from it was a double count, and it
      // shipped in the first version of this re-read. `autoSlotsFree()` is `BACKLOG_SESSIONS_MAX -
      // backlog.autoSessionCount()`, and `autoSessionCount()` counts sessions
      // that ALREADY EXIST — a fired row's session exists synchronously (`fire()`
      // → `execute()` → `freshSession()` → `openItemSession()` → `sessions.
      // create()` all run before the executor's first `await`). So the host's
      // live count already holds every session this pass opened, and taking them
      // off again put the figure one-per-fire below the truth on every pass that
      // had fired anything.
      //
      // Reproduced: cap 3, an empty host, three due rows in three repos (the
      // re-ask runs for every `go` row) — `a` and `b` fire, and `c` reads `noSlot` with one slot genuinely free — and
      // the reap of that time closed a lingering finished session somebody may
      // still have wanted to read, to make room that was already there. `c` then
      // fired anyway on the next tick.
      //
      // The PRE-await decrement (`base.autoSlotsFree -= 1` at the bottom of the
      // loop) stays: it is what makes the rows behind a fire in the SAME pass see
      // one fewer slot before anything has been counted by the host.
      base.autoSlotsFree = Math.min(base.autoSlotsFree, this.core.deps.autoSlotsFree());
      // The local cap the same way: the live reading already counts every
      // row this pass fired (`starting` is written before the executor), so
      // MIN, never a subtraction; busy sessions only ever added.
      const localNow = this.core.deps.localSlots?.();
      if (local && localNow) {
        local.free = Math.min(local.free, localNow.free);
        for (const id of localNow.busy) local.busy.add(id);
      }
      const again = intentVerdict(row, { ...base, present }, now);
      if (again.kind !== "go") { nonGo(row, again); continue; }
      // `go`. Claim the group and the session for the rest of THIS pass — the
      // tick's own "at most one new fire per session" rule, which is a fact
      // about one sweep of the loop and therefore not in the pure ladder.
      busyCwds.add(serialGroup(row.cwd));
      // …and say so: the row behind it in this pass reads "an automatic job is
      // starting here" rather than the generic line.
      if (!holders.has(serialGroup(row.cwd))) holders.set(serialGroup(row.cwd), [{ wall: "starting", ...(again.sessionId ? { sessionId: again.sessionId } : {}) }]);
      if (again.sessionId) busySessions.add(again.sessionId);
      if (row.groupId) claimed.set(row.groupId, (claimed.get(row.groupId) ?? 0) + 1);
      base.hostBusy = true;
      // Spent whether or not the ROW was bounded by the cap. Rung 4.6 only holds
      // `auto` rows — a person's own tap has decided to spend a slot and is not
      // asked twice — but the session it opens is as real as any other, so the
      // automatic row behind it in the same pass must see one fewer.
      if (needsSlot(row)) base.autoSlotsFree -= 1;
      // …and a local row spends one of the local cap, so the next local row in
      // this same pass reads it as taken.
      if (local?.rows.has(row.id)) local.free -= 1;
      void this.core.fire(row, { sessionId: again.sessionId, occurrence: again.occurrence, late: again.late });
    }
  }

  // ── State transitions ─────────────────────────────────────────────────────

  private block(row: Intent, reason: BlockReason, detail: string, missing?: string[], holderSessionId?: string): void {
    const sameMissing = (a?: string[], b?: string[]) =>
      (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((p, k) => p === (b ?? [])[k]);
    const holder = reason === "serial" ? holderSessionId : undefined;
    if (row.state === "blocked" && row.blockReason === reason && row.blockDetail === detail && row.blockSessionId === holder && sameMissing(row.missing, missing)) return;
    row.state = "blocked";
    row.blockReason = reason;
    // The sentence arrives FINISHED (`intentReasonText` already ran). Store it
    // and render it as is — re-weaving it is not a no-op.
    row.blockDetail = detail;
    // The session that sentence names, so the row can offer to open it.
    row.blockSessionId = holder;
    // Same rule as `fire()`: the list belongs to the reason the row is blocked
    // NOW. A files-triggered row that got its uploads and is then held for the
    // worktree being busy must not still be showing the paths it waited on
    // yesterday — "blocked on `serial`" and "missing two files" are different
    // sentences and only one of them is true.
    row.missing = missing;
    this.core.persist();
    this.core.deps.onChange(row);
  }
}
