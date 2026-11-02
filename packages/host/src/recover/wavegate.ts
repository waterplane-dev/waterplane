/**
 * THE wave gate: when several blocked sessions come due together, the FIRST
 * goes alone; only once it has proven the block lifted do the rest follow.
 *
 * Lifted out of the account wall's resume queue (`sessions/resume.ts`, which
 * keeps the limit's POLICY) so a second scope can use the same rule: the net
 * retry (`sessions/apiretry.ts`) runs one host-scope gate, the account wall one
 * account-scope gate. A gate knows ids, never sessions — everything it needs to
 * know about a session it asks its `WavePolicy`, so the rule can be asserted
 * without a PTY (`packages/host/test/wavegate.test.mjs`).
 *
 * What the gate owns — moved verbatim from the resume queue:
 *  - `waiting`: ids whose recovery is DUE and that wait for a slot;
 *  - `inFlight`: ids whose recovery was dispatched and whose verdict is owed;
 *  - `proven`: one in-flight recovery came back `resumed` — the block lifted.
 *    Until then every mode lets ONE go (the probe), and a `blocked` verdict
 *    makes the wave unproven again;
 *  - `forced`: ids a person asked for — they ignore the hold-off and the gap,
 *    never the first-alone rule (a tap says the clock is wrong, not that the
 *    account can take five sessions at once);
 *  - the HOLD after a `blocked` verdict, in one of three shapes (`WaveHold`):
 *    a time (the limit: nobody else spends an attempt learning the limit has not
 *    reset), an id (the net: the rest wait for the probe's own next rung, so one
 *    ladder runs per host), or an event (`until: Infinity` — lifted only by a
 *    forced request or `lift()`; Phase D's sign-in);
 *  - the dispatch GAP (a rate limit, not a concurrency one: even in `all` mode
 *    two dispatches are spaced) and the per-dispatch settle guard — an outcome
 *    that never becomes observable is released `timeout`, or asked again where
 *    the policy can look (`settle`).
 *
 * What the policy owns: who is in line and in which order (derived on demand,
 * never stored — a stored order drifts from the state that decides), the
 * release mode once proven, the dispatch itself, what a hold looks like for
 * its kind, and what it publishes. A gate assumes no timer or ladder exists:
 * `request` is the only way in, so a caller may be a ladder's rung, a clock, or
 * a person's tap after an event (`requestAll`).
 */

/** How a dispatched recovery ended. `resumed` proves the wave; `blocked` withdraws it and holds the rest. */
export type WaveVerdict = "resumed" | "blocked" | "gone" | "timeout";
/** The release mode once a wave is proven (the first of a wave always goes alone). */
export type WaveMode = "one" | "repo" | "all";
/** After a `blocked` verdict: until a time (`Infinity` = until lifted or forced), or until that id's own next verdict — it alone may go meanwhile. */
export type WaveHold = { until: number } | { by: string };

export interface WavePolicy {
  /** Every id in line, best first. A waiting id missing here stopped being eligible and is dropped. */
  order(): string[];
  /** The release mode once the wave is proven. */
  mode(): WaveMode;
  /** The serial group (`repo` mode); undefined = no such session any more, never counted. */
  group(id: string): string | undefined;
  /** Start the recovery for `id`; its verdict comes back through `release`. */
  dispatch(id: string): void;
  /** A request came in (before the pump). */
  requested?(id: string): void;
  /** A `blocked` verdict on `id`: how the rest of the wave is held. */
  holdFor(id: string): WaveHold;
  /** The hold was just set (the limit re-arms booked attempts that fall inside it). */
  afterHold?(): void;
  /** Stamp the gate's state wherever the policy shows it. Called on every move. */
  publish(): void;
  /** Breath between two dispatches. */
  gapMs: number;
  /** Breath after a verdict before the next dispatch. */
  releaseGapMs(why: WaveVerdict): number;
  /** How long a dispatch may go without a verdict before `settle` (or `timeout`). */
  settleMs: number;
  /** Asked when the settle guard fires: a verdict, or `wait` to ask again in `settleMs`. Absent ⇒ `timeout`. */
  settle?(id: string, elapsedMs: number): WaveVerdict | "wait";
}

export class WaveGate {
  private waitingIds: string[] = [];
  private inFlightIds = new Set<string>();
  private forcedIds = new Set<string>();
  private isProven = false;
  private holdUntilMs = 0;
  private heldById: string | null = null;
  private guards = new Map<string, NodeJS.Timeout>();
  private gapTimer: NodeJS.Timeout | null = null;

  constructor(private readonly policy: WavePolicy) {}

  // ── what the policy (and its slice's accessors) may read ──
  isInFlight(id: string): boolean { return this.inFlightIds.has(id); }
  isWaiting(id: string): boolean { return this.waitingIds.includes(id); }
  /** The due ids, in arrival order — reassigned, so asked each time. */
  waiting(): readonly string[] { return this.waitingIds; }
  inFlight(): ReadonlySet<string> { return this.inFlightIds; }
  proven(): boolean { return this.isProven; }
  setProven(proven: boolean): void { this.isProven = proven; }
  /** The time-shaped hold (0 = none; `Infinity` = until lifted). */
  holdUntil(): number { return this.holdUntilMs; }
  /** The id-shaped hold: the probe whose next ask lifts it. */
  heldBy(): string | null { return this.heldById; }

  /**
   * `id`'s recovery is due: get in line (it may go at once). `forced` = a
   * person asked — it overrides the hold, never the first-alone rule.
   */
  request(id: string, opts: { forced?: boolean } = {}): void {
    if (opts.forced) this.forcedIds.add(id);
    if (this.inFlightIds.has(id)) return;
    if (!this.waitingIds.includes(id)) this.waitingIds.push(id);
    this.policy.requested?.(id);
    this.policy.publish();
    this.pump();
  }

  /**
   * Many at once — the shape an EVENT releases (Phase D: a sign-in confirmed
   * and the person tapped "continue all"). Forced skips the gap already counting
   * down: that timer is exactly what the person overrules.
   */
  requestAll(ids: readonly string[], opts: { forced?: boolean } = {}): void {
    if (opts.forced && ids.length) this.skipGap();
    for (const id of ids) this.request(id, opts);
  }

  /** Drop the gap/hold-off timer the gate is counting down (a person's tap overrules it). */
  skipGap(): void {
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
  }

  /** Lift a hold of any shape and let the line move (an event said the block is over). */
  lift(): void {
    this.holdUntilMs = 0;
    this.heldById = null;
    this.policy.publish();
    this.pump();
  }

  /**
   * `id` left recovery (its episode ended, it has nothing more to ask, the
   * session went): out of line, its slot released, a hold it carried lifted.
   */
  drop(id: string): void {
    const wasWaiting = this.waitingIds.includes(id);
    if (wasWaiting) this.waitingIds = this.waitingIds.filter((x) => x !== id);
    this.forcedIds.delete(id);
    const held = this.heldById === id;
    if (held) this.heldById = null;
    if (this.inFlightIds.has(id)) { this.release(id, "gone"); return; }
    if (!wasWaiting && !held) return;
    this.policy.publish();
    this.pump();
  }

  pump(): void {
    if (this.gapTimer) return;
    const order = this.policy.order();
    const inLine = new Set(order);
    // Drop requests that stopped being eligible — else the line waits forever
    // on a session that is never going to run.
    if (this.waitingIds.some((id) => !inLine.has(id))) {
      this.waitingIds = this.waitingIds.filter((id) => inLine.has(id));
      for (const id of [...this.forcedIds]) if (!inLine.has(id)) this.forcedIds.delete(id);
    }
    if (!this.waitingIds.length) return;
    const forced = this.waitingIds.some((id) => this.forcedIds.has(id));
    const now = Date.now();
    if (!forced && this.holdUntilMs > now) {
      // Come back when it lifts rather than dropping the request. An event-shaped
      // hold has no clock: a forced request or `lift()` pumps again.
      if (Number.isFinite(this.holdUntilMs)) this.armGap(this.holdUntilMs - now);
      return;
    }
    // The id-shaped hold: the rest wait until the probe asks again — its own
    // next rung pumps (`request`), and it goes first.
    const by = this.heldById;
    if (!forced && by != null && !this.waitingIds.includes(by)) return;
    // The first CANDIDATE, not the first entry: in `repo` mode the head can be
    // held by its own worktree while one further down is free. With no capacity
    // `find` returns nothing and the pump stops — capacity only ever opens in
    // `release` or a mode change, and both pump again.
    const line = by != null && this.waitingIds.includes(by) ? [by, ...order.filter((x) => x !== by)] : order;
    const next = line.find((id) => this.waitingIds.includes(id) && this.canGoAlongside(id));
    if (next == null) return;
    this.waitingIds = this.waitingIds.filter((x) => x !== next);
    this.forcedIds.delete(next);
    this.inFlightIds.add(next);
    this.policy.publish();
    this.armGuard(next, Date.now());
    this.policy.dispatch(next);
    this.armGap(this.policy.gapMs);
  }

  /**
   * The recovery in flight reached a verdict — let the next one go. A verdict
   * is evidence about the SCOPE (the account, the network), so it moves the
   * wave's proof either way.
   */
  release(id: string, why: WaveVerdict): void {
    if (!this.inFlightIds.has(id)) return;
    const guard = this.guards.get(id);
    if (guard) { clearTimeout(guard); this.guards.delete(id); }
    this.inFlightIds.delete(id);
    // The id-shaped hold outlives its holder's own dispatch: a holder that
    // PARKED (`gone` — busy, nothing learnt about the scope) asks again and goes
    // first again, so the rest never inherit the probe while it waits on a box.
    // A proof frees everyone; a holder that timed out frees its hold.
    if (why === "resumed" || (why === "timeout" && this.heldById === id)) this.heldById = null;
    if (why === "resumed") this.isProven = true;
    if (why === "blocked") {
      this.isProven = false;
      const hold = this.policy.holdFor(id);
      if ("by" in hold) this.heldById = hold.by;
      else this.holdUntilMs = hold.until;
      this.policy.afterHold?.();
    }
    this.policy.publish();
    this.armGap(this.policy.releaseGapMs(why));
  }

  /**
   * The recovery in flight moved to a NEW id (the limit reopened an exited
   * session as a new one): the slot is handed over, not released, so the rest
   * wait for THAT conversation's verdict, under a fresh settle guard.
   */
  handOver(from: string, to: string): void {
    if (!this.inFlightIds.has(from)) return;
    const guard = this.guards.get(from);
    if (guard) { clearTimeout(guard); this.guards.delete(from); }
    this.inFlightIds.delete(from);
    this.inFlightIds.add(to);
    this.armGuard(to, Date.now());
    this.policy.publish();
  }

  /** Every timer this gate holds, cleared (a test's teardown). */
  dispose(): void {
    this.skipGap();
    for (const t of this.guards.values()) clearTimeout(t);
    this.guards.clear();
  }

  /**
   * May `id` go alongside what is in flight? Nothing in flight ⇒ yes. Otherwise
   * the FIRST of a wave is always alone: until it is proven the scope is the open
   * question, not the throughput. Past that the mode decides — `repo` asks the
   * send queue's question, because two agents in one checkout is a different
   * problem from two agents on one plan.
   */
  private canGoAlongside(id: string): boolean {
    if (!this.inFlightIds.size) return true;
    if (!this.isProven) return false;
    const mode = this.policy.mode();
    if (mode === "one") return false;
    if (mode === "all") return true;
    const group = this.policy.group(id);
    for (const other of this.inFlightIds) {
      const g = this.policy.group(other);
      if (g !== undefined && g === group) return false;
    }
    return true;
  }

  private armGuard(id: string, since: number): void {
    const prev = this.guards.get(id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.guards.delete(id);
      const v = this.policy.settle ? this.policy.settle(id, Date.now() - since) : "timeout";
      if (v === "wait") { if (this.inFlightIds.has(id)) this.armGuard(id, since); return; }
      this.release(id, v);
    }, this.policy.settleMs);
    t.unref?.();
    this.guards.set(id, t);
  }

  private armGap(ms: number): void {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => { this.gapTimer = null; this.pump(); }, Math.max(50, ms));
    this.gapTimer.unref?.();
  }
}
