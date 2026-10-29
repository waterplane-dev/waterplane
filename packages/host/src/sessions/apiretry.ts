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
 * safe direction (it types nothing).
 *
 * What the turn end MEANT travels on `turnEnded` (`TurnEndNet`): deferred work
 * waiting on the turn (`intents/watch.ts`) must not complete off a turn that
 * did not happen. `retrying` holds it, `gaveup` fails it, and `checking` (our
 * `continue`'s turn ended before its log row landed) is answered once by
 * `netTurnSettled` after the re-read. A person's keystroke cancels the retry
 * and the next real turn end completes the work as ever.
 */
import { logTag, netGaveUpDetail, netRetryLine, type SessionNetRetry, type TurnEndNet } from "@waterplane/shared";
import { freshGiveUp, netRetryDelay, readNetLog } from "../netlog.js";
import { transcriptPath } from "../transcript.js";
import { recordSent } from "../sentlog.js";
import { derive } from "../backends/derive.js";
import { haltRefusal as hostHalt } from "../halt.js";
import type { Session, SessionCore } from "./core.js";
import { NET_RETRY_LADDER_MS, NET_RETRY_MAX } from "./knobs.js";
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
    if (!netRetryOn() || !s.info.running || !s.hooksActive || !derive(s.backend).keepsClaudeLog || !s.info.claudeSessionId) return null;
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

  /** The phone's Cancel (`session.netRetryCancel`). */
  cancelById(id: string): void {
    const s = this.core.sessions.get(id);
    if (s?.info.netRetry) this.cancel(s, "cancelled from the phone");
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
    s.info.netRetry = n;
    this.core.emit("updated", s.info);
  }

  /** Arm the next rung (`retrying`), or stop at the cap (`gaveup`); null ⇒ a wall outranks. */
  private schedule(s: Session, at: number, error: string): TurnEndNet | null {
    const prev = s.info.netRetry;
    const attempt = prev && prev.state === "sent" ? prev.attempt : 0;
    const delay = netRetryDelay(attempt, NET_RETRY_MAX, NET_RETRY_LADDER_MS);
    this.clear(s);
    if (s.info.limit?.blocked) { if (prev) this.set(s, null); return null; } // a wall outranks
    if (delay == null) {
      const why = `after ${attempt} ${attempt === 1 ? "try" : "tries"}`;
      this.set(s, { state: "gaveup", attempt, max: NET_RETRY_MAX, nextAt: null, error, at, why });
      console.log(`${logTag} net retry gave up · ${s.info.title} (${s.info.id}) · ${error}`);
      return { net: "gaveup", detail: netGaveUpDetail(error, why) };
    }
    const n: SessionNetRetry = { state: "waiting", attempt, max: NET_RETRY_MAX, nextAt: Date.now() + delay, error, at };
    this.arm(s, delay);
    this.set(s, n);
    console.log(`${logTag} ${netRetryLine(n, Date.now())} · ${s.info.title} (${s.info.id}) · ${error}`);
    return { net: "retrying" };
  }

  private arm(s: Session, ms: number): void {
    if (s.netTimer) clearTimeout(s.netTimer);
    s.netTimer = setTimeout(() => { s.netTimer = null; void this.fire(s); }, ms);
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
      this.set(s, { ...n, state: "gaveup", nextAt: null, why: "the emergency halt is on" });
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
