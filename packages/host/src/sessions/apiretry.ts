/**
 * The retry of a turn the CLI GAVE UP on a transient API error (R-connection-024).
 *
 * The CLI retries a failed request on its own, but during a DNS or Wi-Fi outage
 * that budget runs out and the turn ENDS on "API Error: Can't reach the API
 * server (ENOTFOUND)" — and someone has to type "try again" by hand. Here the
 * host does, on a widening ladder (`netlog.ts`'s `netRetryDelay`), through the
 * ONE continue writer the usage-limit wall types with too
 * (`recover/recoverwrite.ts`): text and Return as two writes through the
 * facade's `write`, a history row and a `sent.json` row. Never `deliver.ts`
 * (that module says why), never a queue bypass of the phone's own.
 *
 * Read off the LOG only (`readNetLog`), on the ONE end-of-turn path
 * (`turn.ts`'s `settleStop`), and only where the give-up is FRESH — stamped
 * inside the turn that just ended. Called off by anything that says the person
 * or the account has taken over: a keystroke or prompt (`typed`), a turn
 * starting that is not ours (`turnStarted`), a wall (`limit.blocked` outranks),
 * the halt latch, the session ending (`clear`). A session that is busy — a box
 * up, a dialog, output still arriving — is PARKED, never typed into. Past the
 * cap it stops and says so (`state: "gaveup"`); there is no loop.
 *
 * State is memory only: a host restart forgets a pending retry, which is the
 * safe direction (it types nothing) — except a `gaveup`, which `persistLive`
 * keeps in the `live/` record (`LiveMeta.netGaveUp`): it types nothing either,
 * and it is what keeps work STALLED on the session from reading as silence.
 *
 * What the turn end MEANT travels on `turnEnded` (`TurnEndNet`): deferred work
 * waiting on the turn (`intents/watch.ts`) must not complete off a turn that
 * did not happen. `retrying` holds it, `gaveup` leaves it STALLED (`running`,
 * never failed: the prompt was delivered and the conversation is intact), and
 * `checking` (our `continue`'s turn ended before its log row landed) is
 * answered once by `netTurnSettled` after the re-read. A person's keystroke
 * cancels the retry and the next real turn end completes the work as ever —
 * and so does "Retry now" (`retryNow`, `session.netRetryNow`), which resumes
 * the ladder at try 1 and types its `continue` through `fire()`, the one
 * typing path here.
 *
 * Past the cap the work is STALLED, and a stalled row holds its repo's serial
 * slot — so the host keeps PROBING on a slow cadence (`NET_RETRY_STALL_MS`,
 * 30 min; `0` = never): the `gaveup` carries the next probe as `nextAt`, and
 * the probe is one `continue` through `fire()` (`probe: true`, so the work
 * still reads stalled while it runs). A real reply ends the episode and the
 * work completes as ever; another give-up waits for the next probe. No cap
 * while stalled; the switch off, the halt, a wall or a person typing stops it
 * the way they stop the ladder.
 *
 * Dismissing the session's line (`session.netRetryCancel` on a `gaveup`) only
 * HIDES it (`dismissed`): the stall stands, so the silence ceiling still
 * leaves the work alone. Cancelling a probe stops the probing; the stall
 * stands too. Only a real turn end, typing, or a wall ends a stall.
 *
 * The STALL ENTRY is the episode's give-up transition (`recover/giveuplatch.ts`,
 * lane `net`): the first `gaveup` of an episode — out of rungs, the halt, or a
 * standing give-up adopted at boot — is announced once; a probe that gives up
 * again falls back into the same stall and announces nothing. A served reply,
 * a person typing, a wall or "Retry now" ends the episode and clears it.
 *
 * ONE WAVE PER HOST (owner, 2026-11-02): a rung, a park's look-again, a stall
 * probe and "Retry now" never type directly — they ASK the host-scope wave gate
 * (`recover/wavegate.ts`, `netWave`), whose dispatch is `fire()`. Alone, a
 * session goes at once and its ladder is what it was. With several due, the
 * first types alone; its served reply (the turn end, or a served row in its log
 * while the turn still runs) proves the network and the rest follow; its fresh
 * give-up holds the rest until its own next rung. Held sessions say so
 * (`NET_WAVE_WHY`) and, behind a STALLED probe, read stalled themselves.
 */
import { NET_HELD_WHY, logTag, netGaveUpDetail, netRetryLine, netRetryStalls, netStallWait, type SessionNetRetry, type TurnEndNet } from "@waterplane/shared";
import { freshGiveUp, netRetryDelay, readNetLog, readStandingGiveUp } from "../netlog.js";
import { transcriptPath } from "../transcript.js";
import { continueBlockerNow, draftReader, writeContinue } from "../recover/recoverwrite.js";
import { endGiveUp, giveUpOnce, holdGiveUp } from "../recover/giveuplatch.js";
import { derive } from "../backends/derive.js";
import { haltRefusal as hostHalt } from "../halt.js";
import type { Session, SessionCore } from "./core.js";
import { NET_RETRY_LADDER_MS, NET_RETRY_MAX, NET_RETRY_PARK_MS, NET_RETRY_STALL_MS } from "./knobs.js";
import { netRetryOn } from "../netretrycfg.js";
import { WaveGate, type WavePolicy, type WaveVerdict } from "../recover/wavegate.js";

/** How long a busy session is parked before the retry looks again. */
const PARK_MS = NET_RETRY_PARK_MS;
/** Words in the composer: the park doubles per draft park in a row, up to this. */
const DRAFT_PARK_MAX_MS = 5 * 60_000;
/** The net retry's line while a person's words sit in the composer. */
export const NET_DRAFT_WHY = "words in the composer";

/**
 * The park for the `n`-th draft park in a row (0-based): `base`, doubling, capped
 * at `DRAFT_PARK_MAX_MS` (never below `base`). A draft can sit for hours, and
 * every look replays 100 rows of screen — so the looks thin out; the words
 * clearing (any other outcome of a look) starts the count over.
 */
export function draftParkMs(n: number, base = PARK_MS): number {
  return Math.min(base * 2 ** Math.min(Math.max(0, n), 20), Math.max(base, DRAFT_PARK_MAX_MS));
}
/** Output this recent means the screen is still moving — park briefly. */
const QUIET_MS = 3000;
/** A turn starting this soon after our `continue` is ours. */
const OURS_MS = 60_000;
/** The log row can land a moment after the Stop: one re-read this much later. */
const RECHECK_MS = 1500;
/** Once the wave is proven, the rest go this far apart (a rate limit, not a queue). */
const WAVE_GAP_MS = 1000;
/** While a probe's `continue` turn runs, its log is asked this often for a served row. */
const WAVE_LOOK_MS = 5000;
/** A probe with no verdict this long frees its slot (`timeout`): the next one probes alone. */
const WAVE_SETTLE_MAX_MS = 10 * 60_000;
/** A held session's line (`SessionNetRetry.why`): it waits for another session's probe. */
export const NET_WAVE_WHY = NET_HELD_WHY;

export class NetRetrySlice {
  /**
   * The HOST-scope wave gate (`recover/wavegate.ts`): a network outage is one
   * fact about this desktop, so when several sessions' rungs come due together
   * ONE types its `continue` (the probe) and the rest wait. The probe's served
   * reply proves the network is back and the rest follow, all of them,
   * `WAVE_GAP_MS` apart; a probe that gives up again holds the rest until ITS
   * next rung (`{ by: id }`), so one ladder runs per host rather than one per
   * session. Alone in the gate a session's ladder runs exactly as before: its
   * rung asks, the gate is empty, it goes.
   */
  private gate: WaveGate;
  /**
   * Held sessions whose `probe: true` is BORROWED from a stalled holder
   * (`publishWave`), not their own stall probe: it makes the work waiting on
   * them read stalled, and nothing else — `fire` strips it, and `schedule`,
   * `cancelById` and `switched` read only a session's OWN probe (`ownProbe`),
   * so a released session runs its own remaining rungs.
   */
  private borrowed = new Set<string>();
  /** Draft parks in a row, per session, keyed to the episode (`netRetry.at`) they counted in. */
  private draftParks = new Map<string, { at: number; n: number }>();
  /** True while `switched(false)` walks the sessions: the wave dispatches nothing (`waveOrder`). */
  private pausing = false;

  constructor(private readonly core: SessionCore) {
    this.gate = new WaveGate(this.netWave());
  }

  /**
   * The turn just ended (`settleStop`). `retrying` ⇒ a retry is scheduled, and
   * the turn-finished ping is held: the turn is not done, it is being tried
   * again. Null ⇒ an ordinary turn end.
   */
  turnEnded(s: Session): TurnEndNet | null {
    // Off ⇒ nothing is read — unless an episode is live (a person's Retry now
    // while the switch is off): its turn end must still be told apart from a
    // served reply, or the work waiting on it completes off a failed turn.
    if (!(netRetryOn() || s.info.netRetry) || !s.info.running || !s.hooksActive || !derive(s.backend).keepsClaudeLog || !s.info.claudeSessionId) return null;
    const v = readNetLog(transcriptPath(s.info.cwd, s.info.claudeSessionId));
    if (!freshGiveUp(v, s.info.turnStartedAt)) {
      // A served reply ends the outage. The row may also land just after the
      // Stop: look once more, without the ping. Mid-episode (our `continue`'s
      // turn) the episode is KEPT until that look — clearing it here restarted
      // the ladder at 0 and the cap was never reached — and the turn end is
      // `checking`, so work waiting on it waits for the answer.
      const live = !!s.info.netRetry;
      if (v.state !== "clear") { this.recheckLater(s); return live ? { net: "checking" } : null; }
      this.verdict(s, "resumed");
      if (live) this.set(s, null);
      return null;
    }
    return this.schedule(s, v.at!, v.error!);
  }

  /** A turn started. Ours (just typed) keeps the ladder; anyone else's ends it. */
  turnStarted(s: Session): void {
    const n = s.info.netRetry;
    if (!n) return;
    if (n.state === "sent" && Date.now() - (s.netSentAt ?? 0) < OURS_MS) return;
    this.cancel(s, "a turn started");
  }

  /** Someone typed into the session — our own `continue` excepted. */
  typed(s: Session): void {
    if (s.netWriting || !s.info.netRetry) return;
    this.cancel(s, "typed into the session");
  }

  /**
   * The phone's Cancel / dismiss (`session.netRetryCancel`). A `gaveup` is only
   * HIDDEN (`dismissed`) — the work stalled on it stays stalled; a probe is
   * stopped back into a `gaveup` with no next probe; a ladder rung is cancelled.
   */
  cancelById(id: string): void {
    const s = this.core.sessions.get(id);
    const n = s?.info.netRetry;
    if (!s || !n) return;
    if (n.state === "gaveup") {
      if (n.dismissed) return;
      console.log(`${logTag} net retry line dismissed · ${s.info.title} (${s.info.id}) · the stall stands`);
      this.set(s, { ...n, dismissed: true });
      return;
    }
    if (this.ownProbe(s)) { this.stopProbing(s, "cancelled from the phone"); return; }
    this.cancel(s, "cancelled from the phone");
  }

  /**
   * The switch moved (`netretry.set`). Off: a pending ladder rung is cancelled
   * and the probing stops — a stall stays a stall (its note and Retry now
   * stand on it). On: a stall with no probe armed gets one. A probe whose turn
   * is running is left to its turn end (`schedule` reads the switch then).
   */
  switched(on: boolean): void {
    // Off: nothing may be DISPATCHED while the walk runs. Stopping a holder's
    // probe lifts its hold and pumps the gate, and `fire()` writes `sent` before
    // its first await — a session later in the walk would be skipped as `sent`
    // and its `continue` typed after the switch went off. Paused, the gate's
    // pump finds an empty line (`waveOrder`); every request in it is a session
    // this walk cancels or stops anyway.
    this.pausing = !on;
    try {
      for (const s of this.core.sessions.values()) {
        const n = s.info.netRetry;
        if (!n || !s.info.running) continue;
        if (!on) {
          if (n.state === "sent") continue;
          if (this.ownProbe(s) || (n.state === "gaveup" && n.nextAt != null)) this.stopProbing(s, "automatic retry is off");
          else if (n.state !== "gaveup") this.cancel(s, "automatic retry is off");
        } else if (n.state === "gaveup" && n.nextAt == null && !hostHalt()) {
          this.armProbe(s, n);
        }
      }
    } finally { this.pausing = false; }
  }

  /**
   * After a restart (`reattach`): a restored stall's probe is armed again — and
   * a session with no stall on record whose log still ENDS on a give-up nobody
   * typed after is adopted as one (`adoptStanding`).
   */
  restored(id: string): void {
    const s = this.core.sessions.get(id);
    const n = s?.info.netRetry;
    if (s && !n) { this.adoptStanding(s); return; }
    if (s && n?.state === "gaveup") holdGiveUp(s, "net"); // announced before the restart
    if (!s || !n || n.state !== "gaveup" || n.nextAt == null) return;
    if (!netRetryOn() || NET_RETRY_STALL_MS <= 0) { this.set(s, { ...n, nextAt: null }); return; }
    const at = Math.max(n.nextAt, Date.now() + PARK_MS);
    this.arm(s, at - Date.now(), () => this.probe(s));
    if (at !== n.nextAt) this.set(s, { ...n, nextAt: at });
  }

  /**
   * A give-up the host never saw end — the turn ended while the host was down,
   * or before it listened for `StopFailure` — left the session sitting on
   * "API Error: Can't reach…" with no retry and no stall, for days. Found on
   * re-attach and adopted as a STALL (`gaveup`, attempt 0): the line says so,
   * and the stall's own probe tries once after a park; a probe that fails
   * again falls back to the 30-min cadence, uncapped, as any stall does.
   * Only where the log proves nobody typed since (`readStandingGiveUp`), the
   * switch is on, there is no halt and no wall.
   */
  private adoptStanding(s: Session): void {
    if (!netRetryOn() || NET_RETRY_STALL_MS <= 0 || hostHalt()) return;
    if (!s.info.running || s.info.limit?.blocked || !derive(s.backend).keepsClaudeLog || !s.info.claudeSessionId) return;
    const v = readStandingGiveUp(transcriptPath(s.info.cwd, s.info.claudeSessionId));
    if (v.state !== "transient" || v.at == null || !v.error) return;
    const wait = Math.min(PARK_MS, NET_RETRY_STALL_MS);
    const g: SessionNetRetry = { state: "gaveup", attempt: 0, max: NET_RETRY_MAX, nextAt: Date.now() + wait, error: v.error, at: v.at, why: "found stuck when the host started" };
    this.arm(s, wait, () => this.probe(s));
    this.set(s, g);
    console.log(`${logTag} net retry adopted a standing give-up · ${s.info.title} (${s.info.id}) · ${v.error} · trying in ${netStallWait(wait)}`);
    this.stalled(s, "found stuck when the host started");
  }

  /**
   * "Retry now" (`session.netRetryNow`): a `gaveup` episode resumes at try 1
   * (the cap is a ceiling on what the host types BY ITSELF — a person's tap is
   * a new start), a `waiting` rung fires early; `sent` (a retry's turn is
   * running) and no episode are no-ops. Typed by `fire()` — the ladder's own
   * path, with its busy/halt/wall checks — never a write of its own, and through
   * the wave gate as a FORCED request: no gap or hold, but another session's
   * probe still in flight is waited for.
   */
  retryNow(id: string): void {
    const s = this.core.sessions.get(id);
    const n = s?.info.netRetry;
    if (!s || !n || n.state === "sent" || !s.info.running) return;
    this.clearTimers(s);
    endGiveUp(s, "net"); // a person's tap is a new start: its own give-up is owed its own word
    const attempt = n.state === "gaveup" ? 0 : n.attempt;
    this.set(s, { ...n, state: "waiting", attempt, nextAt: Date.now(), why: undefined, heldBy: undefined, probe: undefined, dismissed: undefined });
    console.log(`${logTag} net retry now (from the phone) · ${s.info.title} (${s.info.id})`);
    // Forced, like the account wall's resume-now: the gap and the hold are
    // overruled, the first-alone rule is not — another session's probe in
    // flight is still the open question about the network.
    this.gate.requestAll([s.info.id], { forced: true });
  }

  /** The session is going (exit, detach, kill, remove): drop the timer, and its place in the wave. */
  clear(s: Session): void {
    this.clearTimers(s);
    this.borrowed.delete(s.info.id);
    this.draftParks.delete(s.info.id);
    this.gate.drop(s.info.id);
  }

  /** The session's OWN stall probe — never one lent by a stalled holder (`borrowed`). */
  private ownProbe(s: Session): boolean {
    return !!s.info.netRetry?.probe && !this.borrowed.has(s.info.id);
  }

  private clearTimers(s: Session): void {
    if (s.netTimer) { clearTimeout(s.netTimer); s.netTimer = null; }
    if (s.netRecheck) { clearTimeout(s.netRecheck); s.netRecheck = null; }
  }

  private cancel(s: Session, why: string): void {
    this.clear(s);
    console.log(`${logTag} net retry off · ${s.info.title} (${s.info.id}) · ${why}`);
    this.set(s, null);
  }

  private set(s: Session, n: SessionNetRetry | null): void {
    const wasStall = netRetryStalls(s.info.netRetry);
    // Absent, never `undefined`-valued, on the wire.
    if (n) for (const k of ["why", "probe", "dismissed"] as const) if (n[k] === undefined) delete n[k];
    s.info.netRetry = n;
    if (!n?.probe) this.borrowed.delete(s.info.id);
    if (!n) endGiveUp(s, "net"); // the episode is over
    // Nothing more will be typed by itself (the episode ended, or a stall with
    // no probe): out of the wave, and a hold it carried lifts.
    if (!n || (n.state === "gaveup" && n.nextAt == null)) this.gate.drop(s.info.id);
    // A stall survives a restart (`LiveMeta.netGaveUp`, taken off the live
    // session by `persistLive`): rewrite the record on every move while stalled.
    if (wasStall || netRetryStalls(n)) { const m = this.core.loadLive(s.info.id); if (m) this.core.persistLive(m); }
    this.core.emit("updated", s.info);
    // The holder's record moved (its next rung, a park, its stall): the held
    // lines borrow its clock and its stall, so they are re-published from it.
    if (n && this.gate.heldBy() === s.info.id) this.publishWave();
  }

  /** Probing stops; the stall stands (a `gaveup` with no next probe). */
  private stopProbing(s: Session, why: string): void {
    const n = s.info.netRetry!;
    this.clear(s);
    console.log(`${logTag} net retry stall probe off · ${s.info.title} (${s.info.id}) · ${why}`);
    this.set(s, { ...n, state: "gaveup", nextAt: null, probe: undefined });
  }

  /** Arm the next stall probe on a `gaveup` (switch on, knob > 0, no halt); else none. */
  private armProbe(s: Session, n: SessionNetRetry): SessionNetRetry {
    if (!netRetryOn() || NET_RETRY_STALL_MS <= 0 || hostHalt()) return { ...n, nextAt: null };
    this.arm(s, NET_RETRY_STALL_MS, () => this.probe(s));
    const next = { ...n, nextAt: Date.now() + NET_RETRY_STALL_MS };
    if (s.info.netRetry?.state === "gaveup") this.set(s, next);
    return next;
  }

  /** The stall probe is due: one `continue` through `fire()`, flagged `probe`. */
  private probe(s: Session): void {
    const n = s.info.netRetry;
    if (!n || n.state !== "gaveup" || n.nextAt == null) return;
    if (this.core.sessions.get(s.info.id) !== s || !s.info.running) return;
    if (!netRetryOn() || NET_RETRY_STALL_MS <= 0) { this.stopProbing(s, "automatic retry is off"); return; }
    console.log(`${logTag} net retry stall probe (try ${n.attempt + 1}) · ${s.info.title} (${s.info.id}) · ${n.error}`);
    this.borrowed.delete(s.info.id); // its own probe from here
    this.set(s, { ...n, state: "waiting", probe: true, nextAt: Date.now(), why: undefined, heldBy: undefined });
    this.gate.request(s.info.id);
  }

  /** Arm the next rung (`retrying`), or stop at the cap (`gaveup`); null ⇒ a wall outranks. */
  private schedule(s: Session, at: number, error: string): TurnEndNet | null {
    const prev = s.info.netRetry;
    const attempt = prev && prev.state === "sent" ? prev.attempt : 0;
    // A stall probe's own give-up is never a ladder rung: back to the stall.
    // (Its OWN probe: one lent by a stalled holder is no stall of this session's.)
    const delay = this.ownProbe(s) ? null : netRetryDelay(attempt, NET_RETRY_MAX, NET_RETRY_LADDER_MS);
    this.clearTimers(s);
    if (s.info.limit?.blocked) { if (prev) this.set(s, null); return null; } // a wall outranks
    // A fresh give-up anywhere says the network failed just now: the wave is
    // unproven again (the limit's rule for a fresh block, `wall.ts`), so the next
    // session due probes alone. If THIS was the probe, the rest of the wave waits
    // for its next rung (or stall probe) — published once its record is final
    // (`verdict` after `set`), so the held lines borrow its real clock and stall.
    this.gate.setProven(false);
    // The switch off (only reached with a live episode: a Retry now while off)
    // ⇒ one try, never a ladder.
    if (delay == null || !netRetryOn()) {
      const why = `after ${attempt} ${attempt === 1 ? "try" : "tries"}${delay != null ? " — automatic retry is off" : ""}`;
      // The stall's next probe rides as `nextAt`; a dismissed line stays hidden.
      const g = this.armProbe(s, { state: "gaveup", attempt, max: NET_RETRY_MAX, nextAt: null, error, at, why, ...(prev?.dismissed ? { dismissed: true } : {}) });
      this.set(s, g);
      this.verdict(s, "blocked");
      console.log(`${logTag} net retry gave up · ${s.info.title} (${s.info.id}) · ${error}${g.nextAt != null ? ` · next try in ${netStallWait(g.nextAt - Date.now())}` : ""}`);
      this.stalled(s, why);
      return { net: "gaveup", detail: netGaveUpDetail(error, why) };
    }
    const n: SessionNetRetry = { state: "waiting", attempt, max: NET_RETRY_MAX, nextAt: Date.now() + delay, error, at };
    this.arm(s, delay);
    this.set(s, n);
    this.verdict(s, "blocked");
    console.log(`${logTag} ${netRetryLine(n, Date.now())} · ${s.info.title} (${s.info.id}) · ${error}`);
    return { net: "retrying" };
  }

  /** A rung (or a park) is due: ask the wave gate, which types through `fire()` when it is this session's turn. */
  private arm(s: Session, ms: number, run: () => void = () => this.gate.request(s.info.id)): void {
    if (s.netTimer) clearTimeout(s.netTimer);
    s.netTimer = setTimeout(() => { s.netTimer = null; run(); }, ms);
    s.netTimer.unref?.();
  }

  private recheckLater(s: Session): void {
    if (s.netRecheck) clearTimeout(s.netRecheck);
    const stops = s.stopCount;
    s.netRecheck = setTimeout(() => {
      s.netRecheck = null;
      // Only if nothing moved since: same turn end, no turn running, nothing scheduled.
      if (s.stopCount !== stops || s.turnActive || s.info.netRetry?.state === "waiting") return;
      if (this.core.sessions.get(s.info.id) !== s || !s.info.running || !s.info.claudeSessionId) return;
      const v = readNetLog(transcriptPath(s.info.cwd, s.info.claudeSessionId));
      let end: TurnEndNet | null = null;
      if (freshGiveUp(v, s.info.turnStartedAt)) end = this.schedule(s, v.at!, v.error!);
      else if (s.info.netRetry) { this.verdict(s, "resumed"); this.set(s, null); } // the episode `turnEnded` kept: no give-up landed
      // The answer to a `checking` turn end (and harmless after a plain one: the
      // work waiting on it already settled, so there is nothing to apply it to).
      this.core.emit("netTurnSettled", s.info.id, stops, end);
    }, RECHECK_MS);
    s.netRecheck.unref?.();
  }

  /** Busy: look again in `ms`. The slot is freed with no hold — a box says nothing about the network. */
  private park(s: Session, why: string, ms = PARK_MS): void {
    const n = s.info.netRetry!;
    this.arm(s, ms);
    this.set(s, { ...n, nextAt: Date.now() + ms, why, heldBy: undefined });
    this.gate.release(s.info.id, "gone");
  }

  /**
   * The episode stalled — said once per episode (`recover/giveuplatch.ts`).
   * No push yet: the net give-up needs a notification kind of its own (`limit`
   * is the person's usage-limit switch); until then the transition is this line.
   */
  private stalled(s: Session, why: string): void {
    giveUpOnce(s, "net", () => { console.log(`${logTag} net retry stalled · ${s.info.title} (${s.info.id}) · ${why}`); });
  }

  /** The gate let this session through: type `continue`, unless something says not to. */
  private async fire(s: Session): Promise<void> {
    const id = s.info.id;
    let n = s.info.netRetry;
    if (!n || n.state !== "waiting") { this.gate.release(id, "gone"); return; }
    // The writer's ladder (`recover/recoverwrite.ts`), in its order; what each
    // blocker means here: halt ⇒ stall now, a wall or another turn ⇒ the
    // episode is over, a box, a moving screen or a person's words in the
    // composer ⇒ park and look again (never typed over).
    const blocker = await continueBlockerNow(s, () => this.core.sessions.get(id) === s && s.info.running,
      { quietMs: QUIET_MS, wallBlocks: true, turnBlocks: true, dialogBlocks: true },
      draftReader(s.backend?.delivery, (lines) => this.core.screenCells(id, lines)));
    // The read took a moment: the episode may have moved (a keystroke cancels it).
    if (blocker !== "gone") {
      const cur = s.info.netRetry;
      if (!cur || cur.state !== "waiting") { this.gate.release(id, "gone"); return; }
      n = cur;
    }
    if (blocker === "gone") { s.info.netRetry = null; this.borrowed.delete(id); this.draftParks.delete(id); endGiveUp(s, "net"); this.gate.drop(id); return; }
    // Any look that did not find words in the composer ends a run of draft parks.
    if (blocker !== "draft") this.draftParks.delete(id);
    if (blocker === "halted") {
      this.set(s, { ...n, state: "gaveup", nextAt: null, why: "the emergency halt is on", heldBy: undefined, probe: undefined });
      this.stalled(s, "the emergency halt is on");
      // No turn end follows this one: tell the work waiting on the session now.
      this.core.emit("netTurnSettled", id, s.stopCount, { net: "gaveup", detail: netGaveUpDetail(n.error, "because the emergency halt is on") });
      return;
    }
    if (blocker === "wall") { this.cancel(s, "a usage or spend wall is up"); return; }
    if (blocker === "turn") { this.cancel(s, "a turn is running"); return; }
    if (blocker === "box") { this.park(s, "waiting for the open box to be answered"); return; }
    if (blocker === "unsettled") { this.park(s, "waiting for the screen to settle", 5000); return; }
    if (blocker === "draft") {
      // Back off while the words stay: 30 s, doubling, to 5 min (per episode).
      const prev = this.draftParks.get(id);
      const k = prev && prev.at === n.at ? prev.n : 0;
      this.draftParks.set(id, { at: n.at, n: k + 1 });
      this.park(s, NET_DRAFT_WHY, draftParkMs(k));
      return;
    }
    const attempt = n.attempt + 1;
    s.netSentAt = Date.now();
    // Before the first byte: a person typing between the two writes cancels, and the Return is skipped.
    // A `probe` lent by a stalled holder stays behind: this is the session's own rung.
    this.set(s, { ...n, state: "sent", attempt, nextAt: null, why: undefined, heldBy: undefined, probe: this.ownProbe(s) || undefined });
    const res = await writeContinue({
      sessionId: id,
      kind: "net",
      detail: `retry after a transient API error (${attempt}/${n.max}): ${n.error}`,
      stillOurs: () => this.core.sessions.get(id) === s && s.info.running && s.info.netRetry?.state === "sent",
      // Our own write is marked, so `typed()` does not read it as a person.
      write: (data) => { s.netWriting = true; try { this.core.write(id, data); } finally { s.netWriting = false; } },
      recordPrompt: (text) => { this.core.recordPrompt(id, text, "backlog"); },
    });
    // Stopped being ours mid-write (a keystroke, the session went): whatever
    // cancelled it already dropped the slot; this covers the rest.
    if (res === "gone" && s.info.netRetry?.state === "sent") this.gate.release(id, "gone");
  }

  /** A verdict on the probe in flight (a no-op for a session the gate did not let through). */
  private verdict(s: Session, why: WaveVerdict): void {
    this.gate.release(s.info.id, why);
  }

  /** Every session in the wave line, oldest give-up first. */
  private waveOrder(): string[] {
    if (this.pausing) return [];
    const line: Session[] = [];
    for (const s of this.core.sessions.values()) {
      const n = s.info.netRetry;
      if (!n || !s.info.running) continue;
      const id = s.info.id;
      if ((this.gate.isWaiting(id) && n.state === "waiting") || this.gate.isInFlight(id)) line.push(s);
    }
    return line
      .sort((a, b) => (a.info.netRetry!.at - b.info.netRetry!.at) || (a.info.id < b.info.id ? -1 : 1))
      .map((s) => s.info.id);
  }

  /**
   * A held session's line says why it is not typing: another session's probe
   * is the open question. When that probe has STALLED, the held ones are stalled
   * too (`probe: true` ⇒ `netRetryStalls`): the work waiting on them is stuck on
   * the same outage, and must read so (the silence ceiling leaves it alone).
   * Once the wave is proven the rest go within seconds — their lines are left.
   */
  private publishWave(): void {
    const by = this.gate.heldBy();
    // The probe the rest wait on: the one holding them, else the one in flight.
    const leadId = by ?? [...this.gate.inFlight()][0];
    const lead = leadId != null ? this.core.sessions.get(leadId) : undefined;
    const holding = !this.gate.proven() && leadId != null;
    for (const id of this.gate.waiting()) {
      const s = this.core.sessions.get(id);
      const n = s?.info.netRetry;
      if (!s || !n || n.state !== "waiting" || id === by || !holding) continue;
      const nextAt = lead?.info.netRetry?.nextAt ?? null;
      // Its own stall probe stands; the holder's stall is LENT, and taken back
      // when the holder stops stalling (never sticky — `borrowed`).
      const own = this.ownProbe(s);
      const lent = !own && netRetryStalls(lead?.info.netRetry);
      const probe = own || lent || undefined;
      if (lent) this.borrowed.add(id); else if (!own) this.borrowed.delete(id);
      if (n.why === NET_WAVE_WHY && n.heldBy === leadId && n.nextAt === nextAt && n.probe === probe) continue;
      this.set(s, { ...n, why: NET_WAVE_WHY, heldBy: leadId, nextAt, probe });
    }
  }

  /**
   * The net's policy over its gate. The mode is ALWAYS `all` — `LimitResumeMode`
   * is the account wall's setting: an outage proven over is over for every
   * session on this desktop, and each of them was already running in its
   * checkout before the outage, so `repo` would only delay a state the person
   * had. The dispatch is `fire()`, with its blockers (a park frees the slot,
   * no hold). The verdict is the probe's next turn end (`turnEnded`: a served
   * reply ⇒ `resumed`, a fresh give-up ⇒ `blocked` via `schedule`) — or, since
   * a served turn may run for many minutes, a served row in its log, looked for
   * every `WAVE_LOOK_MS` while it runs (`settle`).
   */
  private netWave(): WavePolicy {
    return {
      order: () => this.waveOrder(),
      mode: () => "all",
      group: (id) => this.core.sessions.get(id)?.info.cwd,
      dispatch: (id) => { const s = this.core.sessions.get(id); if (s) void this.fire(s); else this.gate.release(id, "gone"); },
      holdFor: (id) => ({ by: id }),
      publish: () => this.publishWave(),
      gapMs: WAVE_GAP_MS,
      releaseGapMs: () => 0,
      settleMs: WAVE_LOOK_MS,
      settle: (id, elapsed) => {
        const s = this.core.sessions.get(id);
        if (!s || !s.info.running || s.info.netRetry?.state !== "sent") return "gone";
        if (s.info.claudeSessionId && readNetLog(transcriptPath(s.info.cwd, s.info.claudeSessionId)).state === "clear") return "resumed";
        return elapsed >= WAVE_SETTLE_MAX_MS ? "timeout" : "wait";
      },
    };
  }
}
