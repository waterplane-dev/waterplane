/**
 * THE sign-in episode of one account (Phase D, blocked sessions): the sessions
 * a sign-out stopped, the confirmation that the account is signed in again, and
 * the wave the person's "continue" goes through.
 *
 * A sign-out is an ACCOUNT fact: every session of that account stops on its next
 * turn (`StopFailure authentication_failed`, `sessions/turn.ts`), and one sign-in
 * fixes all of them. So the sessions are one episode, the person is told once
 * (not once per session), and signs in once from any of them.
 *
 * What it owns, and nothing about sessions (the slice, `sessions/signinwait.ts`,
 * answers every question about one through `AuthEpisodeDeps`, so the rule is
 * asserted without a PTY — `packages/host/test/authgate.test.mjs`):
 *
 *  - MEMBERS: ids whose turn the sign-out stopped. A member leaves when its own
 *    continue got through (`resumed`), when a person started a turn in it by hand,
 *    or when it ended — never on the on-screen flags, which `/login` clears while
 *    the stopped turn still waits.
 *  - CONFIRMATION, by poll + evidence, never by a clock: while the account is
 *    signed out and has members, `claude auth status` is read every `pollMs`
 *    (fresh — the reader's 5-minute "in" cache is bypassed) and at once on
 *    EVIDENCE (a sign-in link that finished, another session's served turn).
 *    "in" is believed only after this episode saw an "out" or STRONG evidence
 *    (another session's served turn, the CLI's own post-login row): a
 *    credential the API refused can still read "in" locally, and confirming off
 *    it would ask the person to continue into the same wall. A sign-in link
 *    merely leaving the screen is WEAK evidence (Esc out of `/login`, a scroll,
 *    a resize retire it too): it buys a read now, and that read counts only as
 *    an "in" FOLLOWING an "out" of this episode. No member ⇒ no poll (nothing
 *    unattended that is not needed); confirmed ⇒ the poll stops.
 *  - BOUNDED POLL: consecutive "in" reads that prove nothing (a stale local
 *    credential, the sign-in done on another machine) back the poll off,
 *    doubling up to `maxPollMs` (5 min). After `unsureAfter` of them with no
 *    "out" ever read this episode, the members wear `unsure` — "cannot tell;
 *    continue if you have signed in" — so the person is not left waiting on a
 *    confirmation this reader cannot give. Still nothing typed without a tap.
 *  - ASK, NEVER TYPE (owner, 2026-11-02): confirmation only stamps
 *    `signedInAt` and announces once. A continue is typed only after the
 *    person's tap (`continueIds`), which is also taken BEFORE a confirmation —
 *    the person may know better; the phone offers it only after.
 *  - THE WAVE: one `WaveGate` per episode, event-shaped — `holdFor` is
 *    `{until: Infinity}`, every request is forced (a tap), the first goes alone
 *    and the rest only once it got through (`resumed`). A first that is still
 *    signed out (`blocked`) puts the episode back to "signed out": the queued
 *    rest are taken out of line (a fresh sign-in ASKS again rather than typing on
 *    an old tap), the poll resumes, and nothing is pushed again.
 *  - ANNOUNCEMENTS, once per transition: `signedOut` a moment after the first
 *    member joins (so sessions failing together are one count), `signedIn` on
 *    each confirmation, `stillOut` when a confirmed episode goes back to signed
 *    out (so the standing "signed in again" item stops saying so), `ended` when
 *    the last member leaves.
 *  - GENERATION: `generation()` changes on every move that withdraws a tap
 *    (back to signed out, the end). A caller re-requesting a tap later (the
 *    slice's park) stamps it first and re-requests only while it is unchanged —
 *    a continue is never typed on a tap the episode already took back.
 */
import type { SessionSignInWait } from "@waterplane/shared";
import { WaveGate, type WaveVerdict } from "./wavegate.js";
import type { SignInTransition } from "./blockpush.js";

export interface AuthEpisodeDeps {
  /** One fresh `claude auth status` read: "in", "out", or null (unreadable — proves nothing). */
  read(): Promise<"in" | "out" | null>;
  /** Type the continue for `id`; the verdict comes back through `verdict` (or `settle`). */
  dispatch(id: string): void;
  /** Is `id` still a session that can be continued (else it is dropped from line)? */
  alive(id: string): boolean;
  /** `id`'s wire field moved (null = it left the episode). */
  publish(id: string, w: SessionSignInWait | null): void;
  /** Tell the person — once per transition. */
  announce(t: SignInTransition, n: number): void;
  /** Asked every `settleMs` while `id`'s continue is in flight: a verdict, or `wait`. */
  settle(id: string, elapsedMs: number): WaveVerdict | "wait";
  pollMs: number;
  /** The backed-off poll's ceiling (default 5 min). */
  maxPollMs?: number;
  /** Consecutive unproving "in" reads, no "out" ever, before members wear `unsure` (default 2). */
  unsureAfter?: number;
  /** How long the `signedOut` announcement waits for the other sessions failing together. */
  announceDelayMs: number;
  settleMs: number;
  /** Breath between two continues once the first got through. */
  gapMs: number;
  now?: () => number;
}

interface Member { since: number }

export class AuthEpisode {
  private members = new Map<string, Member>();
  private signedInAt: number | null = null;
  /** This episode read "out" — so a later "in" is a change, not a stale credential. */
  private sawOut = false;
  /** STRONG evidence a sign-in happened (another session was served, the post-login row). */
  private evidenceSeen = false;
  /** An "out" was read at any point in this episode (never reset by `backToSignedOut`). */
  private everOut = false;
  /** Consecutive "in" reads that confirmed nothing — the poll's back-off. */
  private idleIns = 0;
  /** Members wear `unsure`: the reader cannot tell (see the header). */
  private unsure = false;
  private announced = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private reading = false;
  /** Bumped by every move that makes a read in flight stale (a reset, the end). */
  private epoch = 0;
  private stamped = new Map<string, string>();
  private ended = false;
  private readonly gate: WaveGate;
  private readonly now: () => number;

  constructor(private readonly deps: AuthEpisodeDeps) {
    this.now = deps.now ?? Date.now;
    this.gate = new WaveGate({
      order: () => [...this.members.entries()]
        .filter(([id]) => this.deps.alive(id) && (this.gate.isWaiting(id) || this.gate.isInFlight(id)))
        .sort((a, b) => (a[1].since - b[1].since) || (a[0] < b[0] ? -1 : 1))
        .map(([id]) => id),
      mode: () => "all",
      group: () => undefined,
      dispatch: (id) => this.deps.dispatch(id),
      holdFor: () => ({ until: Infinity }),
      publish: () => this.stampAll(),
      gapMs: deps.gapMs,
      releaseGapMs: () => 0,
      settleMs: deps.settleMs,
      // The verdict is handled HERE (`verdict`), so a member that got through
      // leaves and a blocked one resets the episode; the gate then sees it released.
      settle: (id, elapsed) => {
        const v = this.deps.settle(id, elapsed);
        if (v !== "wait") this.verdict(id, v);
        return "wait";
      },
    });
  }

  get size(): number { return this.members.size; }
  isMember(id: string): boolean { return this.members.has(id); }
  isInFlight(id: string): boolean { return this.gate.isInFlight(id); }
  /** When the host confirmed the sign-in, or null while signed out. */
  confirmedAt(): number | null { return this.signedInAt; }
  /** True while a poll timer is armed or a read runs (the cost rule's test). */
  polling(): boolean { return this.pollTimer != null || this.reading; }
  /** The member ids, in join order. */
  memberIds(): string[] { return [...this.members.keys()]; }
  /** Changes whenever a taken tap is withdrawn (back to signed out, the end). */
  generation(): number { return this.epoch; }
  /** The members wear `unsure` (the reader cannot tell). */
  isUnsure(): boolean { return this.unsure; }

  /**
   * `id`'s turn just stopped on a sign-out. A member whose continue is in
   * flight is the `blocked` verdict; anyone else joins. A join while the
   * episode reads "signed in again" contradicts it: back to "signed out".
   */
  signedOut(id: string): void {
    if (this.ended) return;
    if (this.gate.isInFlight(id)) { this.verdict(id, "blocked"); return; }
    const fresh = !this.members.has(id);
    if (fresh) this.members.set(id, { since: this.now() });
    if (this.signedInAt != null) { this.backToSignedOut(); return; }
    if (fresh) this.stamp(id);
    if (!this.announced && !this.announceTimer) {
      this.announceTimer = setTimeout(() => {
        this.announceTimer = null;
        if (this.ended || !this.members.size || this.announced) return;
        this.announced = true;
        this.deps.announce("signedOut", this.members.size);
      }, this.deps.announceDelayMs);
      this.announceTimer.unref?.();
    }
    this.ensurePoll();
  }

  /**
   * `id` was a member before a restart (`since` from its `live/` record): back
   * in, with no push — a restart is not a transition, and the item from before
   * it still stands. The poll starts as for any member; nothing is typed.
   */
  restore(id: string, since: number): void {
    if (this.ended || this.members.has(id)) return;
    this.members.set(id, { since });
    this.announced = true;
    if (this.announceTimer) { clearTimeout(this.announceTimer); this.announceTimer = null; }
    this.stamp(id);
    this.ensurePoll();
  }

  /** `id` left: continued by hand, ended, or taken over by another wall. */
  leave(id: string): void {
    if (!this.members.has(id)) return;
    this.members.delete(id);
    this.gate.drop(id);
    this.stamped.delete(id);
    this.deps.publish(id, null);
    if (!this.members.size) this.end();
  }

  /**
   * Something says a sign-in may have happened: look now (only while signed
   * out). `strong` (another session served, the CLI's post-login row) lets the
   * next "in" confirm; weak (a sign-in link left the screen) only buys the read,
   * which then confirms only as an "in" following an "out" of this episode.
   */
  evidence(strong = true): void {
    if (this.ended || !this.members.size || this.signedInAt != null) return;
    if (strong) this.evidenceSeen = true;
    this.idleIns = 0; // look at the normal cadence again
    this.clearPoll();
    void this.poll();
  }

  /**
   * The person's continue (`signin.continue`). Members only — the rest are
   * named back; forced through the wave (first alone). Taken before a
   * confirmation too: the person may know better.
   */
  continueIds(ids: readonly string[]): { taken: string[]; ignored: string[] } {
    const taken: string[] = [];
    const ignored: string[] = [];
    for (const id of new Set(ids)) (this.members.has(id) && this.deps.alive(id) ? taken : ignored).push(id);
    if (taken.length && !this.ended) this.gate.requestAll(taken, { forced: true });
    return { taken, ignored };
  }

  /** How `id`'s continue ended. `resumed` ⇒ it leaves; `blocked` ⇒ back to signed out; else it waits for a tap again. */
  verdict(id: string, v: WaveVerdict): void {
    if (!this.gate.isInFlight(id)) return;
    if (v === "resumed") {
      // Out of the episode BEFORE the release pumps the next one.
      this.members.delete(id);
      this.stamped.delete(id);
      this.deps.publish(id, null);
      this.gate.release(id, "resumed");
      if (!this.members.size) this.end();
      return;
    }
    this.gate.release(id, v);
    if (v === "blocked") this.backToSignedOut();
    else this.stamp(id);
  }

  /** Every timer cleared, nothing announced (a test's teardown, or the slice's). */
  dispose(): void {
    this.ended = true;
    this.epoch++;
    this.clearPoll();
    if (this.announceTimer) { clearTimeout(this.announceTimer); this.announceTimer = null; }
    this.gate.dispose();
  }

  /**
   * Still signed out after all: the confirmation is withdrawn, the queued
   * continues are taken out of line (a later sign-in ASKS again), and the poll
   * starts over — needing a fresh "out" or fresh evidence before an "in" counts.
   * Nothing is pushed: the person was told, and the item still stands.
   */
  private backToSignedOut(): void {
    const wasIn = this.signedInAt != null;
    this.signedInAt = null;
    this.sawOut = false;
    this.evidenceSeen = false;
    this.idleIns = 0;
    this.unsure = false;
    this.epoch++;
    for (const id of [...this.gate.waiting()]) this.gate.drop(id);
    this.stampAll();
    // The standing item said "signed in again": take that back, once per transition.
    if (wasIn) this.deps.announce("stillOut", this.members.size);
    this.ensurePoll();
  }

  private end(): void {
    if (this.ended) return;
    this.dispose();
    this.deps.announce("ended", 0);
  }

  private confirm(): void {
    this.signedInAt = this.now();
    this.unsure = false;
    this.idleIns = 0;
    this.clearPoll();
    if (this.announceTimer) { clearTimeout(this.announceTimer); this.announceTimer = null; }
    this.announced = true;
    this.stampAll();
    this.deps.announce("signedIn", this.members.size);
  }

  private ensurePoll(): void {
    if (this.ended || !this.members.size || this.signedInAt != null || this.pollTimer || this.reading) return;
    void this.poll();
  }

  private clearPoll(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const epoch = this.epoch;
    let state: "in" | "out" | null = null;
    try { state = await this.deps.read(); } catch { state = null; } finally { this.reading = false; }
    if (this.ended || !this.members.size || this.signedInAt != null) return;
    if (epoch === this.epoch) {
      if (state === "out") {
        this.sawOut = true;
        this.everOut = true;
        this.idleIns = 0;
        if (this.unsure) { this.unsure = false; this.stampAll(); }
      } else if (state === "in" && (this.sawOut || this.evidenceSeen)) { this.confirm(); return; }
      else if (state === "in") {
        this.idleIns++;
        if (!this.unsure && !this.everOut && this.idleIns >= (this.deps.unsureAfter ?? 2)) { this.unsure = true; this.stampAll(); }
      }
    }
    this.clearPoll();
    this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.poll(); }, this.pollDelay());
    this.pollTimer.unref?.();
  }

  /** `pollMs`, doubled per consecutive unproving "in", capped at `maxPollMs`. */
  private pollDelay(): number {
    const cap = Math.max(this.deps.pollMs, this.deps.maxPollMs ?? 5 * 60_000);
    return Math.min(cap, this.deps.pollMs * 2 ** Math.min(this.idleIns, 20));
  }

  private wireOf(id: string): SessionSignInWait | null {
    const m = this.members.get(id);
    if (!m) return null;
    const w: SessionSignInWait = { since: m.since };
    if (this.signedInAt != null) w.signedInAt = this.signedInAt;
    else if (this.unsure) w.unsure = true;
    if (this.gate.isWaiting(id)) w.queued = true;
    if (this.gate.isInFlight(id)) w.continuing = true;
    return w;
  }

  private stamp(id: string): void {
    const w = this.wireOf(id);
    const key = JSON.stringify(w);
    if (this.stamped.get(id) === key) return;
    if (w) this.stamped.set(id, key); else this.stamped.delete(id);
    this.deps.publish(id, w);
  }

  private stampAll(): void {
    for (const id of this.members.keys()) this.stamp(id);
  }
}
