/**
 * The retry of a turn the CLI GAVE UP on a transient API error (R-connection-024).
 *
 * The CLI retries a failed request on its own, but during a DNS or Wi-Fi outage
 * that budget runs out and the turn ENDS on "API Error: Can't reach the API
 * server (ENOTFOUND)" — and someone has to type "try again" by hand. Here the
 * host does, on a widening ladder (`netlog.ts`'s `netRetryDelay`), the way the
 * usage-limit wall types its `continue` (`wall.ts`'s `doLimitContinue`): text and
 * Return as two writes through the facade's `write`, a history row and a
 * `sent.json` row. Never `deliver.ts`, never a queue bypass of the phone's own.
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
 */
import { logTag, netGaveUpDetail, netRetryLine, netRetryStalls, netStallWait, type SessionNetRetry, type TurnEndNet } from "@waterplane/shared";
import { freshGiveUp, netRetryDelay, readNetLog } from "../netlog.js";
import { transcriptPath } from "../transcript.js";
import { recordSent } from "../sentlog.js";
import { derive } from "../backends/derive.js";
import { haltRefusal as hostHalt } from "../halt.js";
import type { Session, SessionCore } from "./core.js";
import { NET_RETRY_LADDER_MS, NET_RETRY_MAX, NET_RETRY_STALL_MS } from "./knobs.js";
import { netRetryOn } from "../netretrycfg.js";

/** How long a busy session is parked before the retry looks again. */
const PARK_MS = 30_000;
/** Output this recent means the screen is still moving — park briefly. */
const QUIET_MS = 3000;
/** A turn starting this soon after our `continue` is ours. */
const OURS_MS = 60_000;
/** The log row can land a moment after the Stop: one re-read this much later. */
const RECHECK_MS = 1500;

export class NetRetrySlice {
  constructor(private readonly core: SessionCore) {}

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
    if (n.probe) { this.stopProbing(s, "cancelled from the phone"); return; }
    this.cancel(s, "cancelled from the phone");
  }

  /**
   * The switch moved (`netretry.set`). Off: a pending ladder rung is cancelled
   * and the probing stops — a stall stays a stall (its note and Retry now
   * stand on it). On: a stall with no probe armed gets one. A probe whose turn
   * is running is left to its turn end (`schedule` reads the switch then).
   */
  switched(on: boolean): void {
    for (const s of this.core.sessions.values()) {
      const n = s.info.netRetry;
      if (!n || !s.info.running) continue;
      if (!on) {
        if (n.state === "sent") continue;
        if (n.probe || (n.state === "gaveup" && n.nextAt != null)) this.stopProbing(s, "automatic retry is off");
        else if (n.state !== "gaveup") this.cancel(s, "automatic retry is off");
      } else if (n.state === "gaveup" && n.nextAt == null && !hostHalt()) {
        this.armProbe(s, n);
      }
    }
  }

  /** After a restart (`reattach`): a restored stall's probe is armed again. */
  restored(id: string): void {
    const s = this.core.sessions.get(id);
    const n = s?.info.netRetry;
    if (!s || !n || n.state !== "gaveup" || n.nextAt == null) return;
    if (!netRetryOn() || NET_RETRY_STALL_MS <= 0) { this.set(s, { ...n, nextAt: null }); return; }
    const at = Math.max(n.nextAt, Date.now() + PARK_MS);
    this.arm(s, at - Date.now(), () => this.probe(s));
    if (at !== n.nextAt) this.set(s, { ...n, nextAt: at });
  }

  /**
   * "Retry now" (`session.netRetryNow`): a `gaveup` episode resumes at try 1
   * (the cap is a ceiling on what the host types BY ITSELF — a person's tap is
   * a new start), a `waiting` rung fires early; `sent` (a retry's turn is
   * running) and no episode are no-ops. Typed by `fire()` — the ladder's own
   * path, with its busy/halt/wall checks — never a write of its own.
   */
  retryNow(id: string): void {
    const s = this.core.sessions.get(id);
    const n = s?.info.netRetry;
    if (!s || !n || n.state === "sent" || !s.info.running) return;
    this.clear(s);
    const attempt = n.state === "gaveup" ? 0 : n.attempt;
    this.set(s, { ...n, state: "waiting", attempt, nextAt: Date.now(), why: undefined, probe: undefined, dismissed: undefined });
    console.log(`${logTag} net retry now (from the phone) · ${s.info.title} (${s.info.id})`);
    void this.fire(s);
  }

  /** The session is going (exit, detach, kill, remove): drop the timer. */
  clear(s: Session): void {
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
    // A stall survives a restart (`LiveMeta.netGaveUp`, taken off the live
    // session by `persistLive`): rewrite the record on every move while stalled.
    if (wasStall || netRetryStalls(n)) { const m = this.core.loadLive(s.info.id); if (m) this.core.persistLive(m); }
    this.core.emit("updated", s.info);
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
    this.set(s, { ...n, state: "waiting", probe: true, nextAt: Date.now(), why: undefined });
    void this.fire(s);
  }

  /** Arm the next rung (`retrying`), or stop at the cap (`gaveup`); null ⇒ a wall outranks. */
  private schedule(s: Session, at: number, error: string): TurnEndNet | null {
    const prev = s.info.netRetry;
    const attempt = prev && prev.state === "sent" ? prev.attempt : 0;
    // A stall probe's own give-up is never a ladder rung: back to the stall.
    const delay = prev?.probe ? null : netRetryDelay(attempt, NET_RETRY_MAX, NET_RETRY_LADDER_MS);
    this.clear(s);
    if (s.info.limit?.blocked) { if (prev) this.set(s, null); return null; } // a wall outranks
    // The switch off (only reached with a live episode: a Retry now while off)
    // ⇒ one try, never a ladder.
    if (delay == null || !netRetryOn()) {
      const why = `after ${attempt} ${attempt === 1 ? "try" : "tries"}${delay != null ? " — automatic retry is off" : ""}`;
      // The stall's next probe rides as `nextAt`; a dismissed line stays hidden.
      const g = this.armProbe(s, { state: "gaveup", attempt, max: NET_RETRY_MAX, nextAt: null, error, at, why, ...(prev?.dismissed ? { dismissed: true } : {}) });
      this.set(s, g);
      console.log(`${logTag} net retry gave up · ${s.info.title} (${s.info.id}) · ${error}${g.nextAt != null ? ` · next try in ${netStallWait(g.nextAt - Date.now())}` : ""}`);
      return { net: "gaveup", detail: netGaveUpDetail(error, why) };
    }
    const n: SessionNetRetry = { state: "waiting", attempt, max: NET_RETRY_MAX, nextAt: Date.now() + delay, error, at };
    this.arm(s, delay);
    this.set(s, n);
    console.log(`${logTag} ${netRetryLine(n, Date.now())} · ${s.info.title} (${s.info.id}) · ${error}`);
    return { net: "retrying" };
  }

  private arm(s: Session, ms: number, run: () => void = () => void this.fire(s)): void {
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
      else if (s.info.netRetry) this.set(s, null); // the episode `turnEnded` kept: no give-up landed
      // The answer to a `checking` turn end (and harmless after a plain one: the
      // work waiting on it already settled, so there is nothing to apply it to).
      this.core.emit("netTurnSettled", s.info.id, stops, end);
    }, RECHECK_MS);
    s.netRecheck.unref?.();
  }

  private park(s: Session, why: string, ms = PARK_MS): void {
    const n = s.info.netRetry!;
    this.arm(s, ms);
    this.set(s, { ...n, nextAt: Date.now() + ms, why });
  }

  /** The rung is due: type `continue`, unless something says not to. */
  private async fire(s: Session): Promise<void> {
    const id = s.info.id;
    const n = s.info.netRetry;
    if (!n || n.state !== "waiting") return;
    if (this.core.sessions.get(id) !== s || !s.info.running) { s.info.netRetry = null; return; }
    const halted = hostHalt();
    if (halted) {
      this.set(s, { ...n, state: "gaveup", nextAt: null, why: "the emergency halt is on", probe: undefined });
      // No turn end follows this one: tell the work waiting on the session now.
      this.core.emit("netTurnSettled", id, s.stopCount, { net: "gaveup", detail: netGaveUpDetail(n.error, "because the emergency halt is on") });
      return;
    }
    if (s.info.limit?.blocked) { this.cancel(s, "a usage or spend wall is up"); return; }
    if (s.turnActive) { this.cancel(s, "a turn is running"); return; }
    if (s.info.prompt || s.info.awaitingInput) { this.park(s, "waiting for the open box to be answered"); return; }
    if (Date.now() - s.lastDataAt < QUIET_MS) { this.park(s, "waiting for the screen to settle", 5000); return; }
    const attempt = n.attempt + 1;
    s.netSentAt = Date.now();
    // Before the first byte: a person typing between the two writes cancels, and the Return is skipped.
    this.set(s, { ...n, state: "sent", attempt, nextAt: null, why: undefined });
    s.netWriting = true;
    try { this.core.write(id, "continue"); } finally { s.netWriting = false; }
    await new Promise((r) => setTimeout(r, 250));
    if (this.core.sessions.get(id) !== s || !s.info.running || s.info.netRetry?.state !== "sent") return;
    s.netWriting = true;
    try { this.core.write(id, "\r"); } finally { s.netWriting = false; }
    this.core.recordPrompt(id, "continue (auto, network error)", "backlog");
    // `written`, as the limit wall's: the Return is pressed blind, and the
    // outcome is the next turn end's log row.
    recordSent({
      sessionId: id, actor: "auto", source: "netretry", kind: "prompt",
      text: "continue", result: "written",
      detail: `retry after a transient API error (${attempt}/${n.max}): ${n.error}`,
    });
  }
}
