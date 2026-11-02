/**
 * Sessions a SIGN-OUT stopped, kept per account until the person continues
 * them (Phase D, blocked sessions; the rule is `recover/authgate.ts`'s
 * `AuthEpisode`, this slice is what it asks about sessions).
 *
 * The account key: a session of the `claude` backend, in the CLI config dir
 * every pane inherits from this daemon (`tmux.ts`'s pane env carries the
 * daemon's `CLAUDE_CONFIG_DIR`, so all claude panes share one credential
 * store) — `claude|<config dir>`. `claude-local` and `claude-endpoint` launch
 * with a token of their own (`ANTHROPIC_AUTH_TOKEN`), which neither `/login`
 * nor `claude auth status` speaks for: an `authentication_failed` there is
 * their own key, so they never join an episode (their `signedOut` bar stands
 * as before). Never mixed with another backend.
 *
 * Edges (all from `turn.ts` / `boxread.ts`, through `SessionCore`):
 *  - `signedOut` — the hook router just set `SessionInfo.signedOut` (a turn
 *    ended `StopFailure authentication_failed`): join, or, for a member whose
 *    continue is in flight, the `blocked` verdict.
 *  - `turnStarted` — a turn started. Ours (the continue in flight) is noted;
 *    anyone else's means a person continued the session by hand: it leaves.
 *    Raw keystrokes do NOT make it leave — `/login` is typed into a member, and
 *    the stopped turn still needs its continue after it.
 *  - `served` — a `Stop` hook: the API served a turn. Ours ⇒ `resumed`; on
 *    another session of the account ⇒ evidence of a sign-in (look now).
 *  - `loginRetired` — a sign-in link left a session's screen: WEAK evidence
 *    (Esc out of `/login`, a scroll or a resize retire it too) — look now, but
 *    only an "in" following an "out" of this episode confirms — unless the
 *    CLI's own post-login row is on that screen (`loginOk`), which is strong.
 *  - `clear` — the session is going: it leaves.
 *
 * The continue itself is the ONE blind writer (`recover/recoverwrite.ts`,
 * kind `auth`, actor `user`: a person's tap released it). A box, a moving
 * screen or a person's words in the composer PARKS it (slot freed, asked again
 * shortly, a bounded number of times) — the re-ask is the SAME tap, so it is
 * stamped with the episode's `generation()` and dropped once the episode took
 * the tap back (back to signed out, the end) or the session left; a wall or a
 * turn not ours takes the session out; the halt stops it in place.
 * Across a restart: `signedOut` and each member's `since` ride in the `live/`
 * record (`LiveMeta.signedOut`/`signInSince`, written on every move), and the
 * episode re-forms from the re-attached members (`restored`) with no push — a
 * restart is not a transition. A tap, a park and a confirmation are memory
 * only: after a restart the host reads the account again and ASKS again.
 */
import type { SessionSignInWait } from "@waterplane/shared";
import { logTag } from "@waterplane/shared";
import { AuthEpisode } from "../recover/authgate.js";
import type { SignInEvent } from "../recover/blockpush.js";
import { continueBlockerNow, draftReader, writeContinue } from "../recover/recoverwrite.js";
import type { WaveVerdict } from "../recover/wavegate.js";
import { claudeConfigDir } from "../claudeconfig.js";
import { claudeSignInState } from "../doctorclaude.js";
import type { Session, SessionCore } from "./core.js";
import { SIGNIN_POLL_MS } from "./knobs.js";

/** Sessions failing together are one count in the signed-out push. */
const ANNOUNCE_DELAY_MS = 2000;
/** While a continue is in flight, its verdict is asked this often. */
const SETTLE_MS = 2000;
/** A continue's turn still running this long with no sign-in refusal: it got through.
 *  The refusal comes on the turn's first request, within seconds. */
const SERVED_RUNNING_MS = 15_000;
/** A continue that started no turn this long proves nothing: its slot is freed. */
const NO_TURN_MS = 60_000;
/** Two continues once the first got through are this far apart. */
const GAP_MS = 1000;
/** Output this recent: the screen is still moving (the post-`/login` repaint). */
const QUIET_MS = 1500;
/** A busy member is asked again this much later… */
const PARK_MS = 5000;
/** …at most this many times per tap, then it waits for the next tap. */
const MAX_PARKS = 12;

export class SignInSlice {
  private episodes = new Map<string, AuthEpisode>();
  /** Per member in flight: when our continue was typed, and when its turn started. */
  private flight = new Map<string, { sentAt: number; startedAt?: number }>();
  private parks = new Map<string, number>();
  /** The pending re-ask per parked member (one at most), cleared with the member. */
  private parkTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly core: SessionCore, private readonly read = claudeSignInState, private readonly parkMs = PARK_MS) {}

  /** The account a session's sign-in belongs to, or null (not a claude.ai sign-in). */
  accountOf(s: Session): string | null {
    return s.backend?.id === "claude" ? `claude|${claudeConfigDir()}` : null;
  }

  signedOut(s: Session): void {
    const account = this.accountOf(s);
    if (!account || !s.info.running) return;
    let ep = this.episodes.get(account);
    if (!ep) {
      ep = this.episodeFor(account, s.backend.bin());
      this.episodes.set(account, ep);
      console.log(`${logTag} sign-in episode began · ${s.info.title} (${s.info.id})`);
    }
    if (ep.isInFlight(s.info.id)) console.log(`${logTag} sign-in continue refused: still signed out · ${s.info.title} (${s.info.id})`);
    ep.signedOut(s.info.id);
  }

  turnStarted(s: Session): void {
    const ep = this.episodeOf(s);
    if (!ep?.isMember(s.info.id)) return;
    const f = this.flight.get(s.info.id);
    if (ep.isInFlight(s.info.id) && f) { f.startedAt ??= Date.now(); return; }
    console.log(`${logTag} sign-in episode: continued by hand · ${s.info.title} (${s.info.id})`);
    ep.leave(s.info.id);
  }

  served(s: Session): void {
    const ep = this.episodeOf(s);
    if (!ep) return;
    if (ep.isInFlight(s.info.id)) { ep.verdict(s.info.id, "resumed"); return; }
    if (!ep.isMember(s.info.id)) ep.evidence();
  }

  /** A sign-in link left `s`'s screen; `loginOk` = the CLI's post-login row is on it (strong). */
  loginRetired(s: Session, loginOk = false): void {
    this.episodeOf(s)?.evidence(loginOk);
  }

  clear(s: Session): void {
    this.flight.delete(s.info.id);
    this.unpark(s.info.id);
    for (const ep of this.episodes.values()) ep.leave(s.info.id);
  }

  private unpark(id: string): void {
    this.parks.delete(id);
    const t = this.parkTimers.get(id);
    if (t) { clearTimeout(t); this.parkTimers.delete(id); }
  }

  /** Re-attach after a restart: `id` was a member (`LiveMeta.signInSince`) — back in, silently. */
  restored(id: string, since: number | undefined): void {
    if (typeof since !== "number" || !Number.isFinite(since)) return;
    const s = this.core.sessions.get(id);
    const account = s ? this.accountOf(s) : null;
    if (!s || !account || !s.info.running) return;
    let ep = this.episodes.get(account);
    if (!ep) {
      ep = this.episodeFor(account, s.backend.bin());
      this.episodes.set(account, ep);
      console.log(`${logTag} sign-in episode re-formed after a restart · ${s.info.title} (${id})`);
    }
    ep.restore(id, since);
  }

  /** The person's tap (`signin.continue`): ids grouped by account, members only. */
  continueIds(ids: readonly string[]): { taken: string[]; ignored: string[] } {
    const taken: string[] = [];
    const ignored: string[] = [];
    const byAccount = new Map<string, string[]>();
    for (const id of new Set(ids)) {
      const s = this.core.sessions.get(id);
      const account = s ? this.accountOf(s) : null;
      if (!s || !account || !this.episodes.get(account)?.isMember(id)) { ignored.push(id); continue; }
      byAccount.set(account, [...(byAccount.get(account) ?? []), id]);
    }
    for (const [account, list] of byAccount) {
      for (const id of list) this.unpark(id); // a tap is a new start
      const r = this.episodes.get(account)!.continueIds(list);
      taken.push(...r.taken);
      ignored.push(...r.ignored);
    }
    if (taken.length) console.log(`${logTag} sign-in continue (from the phone) · ${taken.length} session(s)${ignored.length ? ` · ignored ${ignored.length}` : ""}`);
    return { taken, ignored };
  }

  /** Test seam: the episode a session's account is in. */
  episodeOf(s: Session): AuthEpisode | undefined {
    const account = this.accountOf(s);
    return account ? this.episodes.get(account) : undefined;
  }

  private episodeFor(account: string, bin: string): AuthEpisode {
    const ep: AuthEpisode = new AuthEpisode({
      // Fresh every time: a five-minute "in" in the reader's cache is the stale answer.
      read: () => this.read(bin, Date.now(), 0),
      dispatch: (id) => { void this.fire(ep, id); },
      alive: (id) => !!this.core.sessions.get(id)?.info.running,
      publish: (id, w) => this.publish(id, w),
      announce: (t, n) => {
        if (t === "ended") {
          if (this.episodes.get(account) === ep) this.episodes.delete(account);
          console.log(`${logTag} sign-in episode ended`);
        } else console.log(`${logTag} sign-in episode: ${t === "signedOut" ? "signed out" : t === "stillOut" ? "still signed out (the confirmation is withdrawn)" : "signed in again (asking, typing nothing)"} · ${n} session(s)`);
        this.core.emit("signIn", { transition: t, n, account } satisfies SignInEvent);
      },
      settle: (id, elapsed) => this.settle(id, elapsed),
      pollMs: SIGNIN_POLL_MS,
      announceDelayMs: ANNOUNCE_DELAY_MS,
      settleMs: SETTLE_MS,
      gapMs: GAP_MS,
    });
    return ep;
  }

  private publish(id: string, w: SessionSignInWait | null): void {
    const s = this.core.sessions.get(id);
    if (!w) { this.flight.delete(id); this.unpark(id); }
    else if (!w.continuing) this.flight.delete(id);
    if (!s) return;
    const had = s.info.signInWait?.since;
    if (w) s.info.signInWait = w; else delete s.info.signInWait;
    this.core.emit("updated", s.info);
    // Membership survives a restart (`LiveMeta.signInSince`): rewrite on join and leave only.
    if (had !== w?.since) { const m = this.core.loadLive?.(id); if (m) this.core.persistLive(m); }
  }

  private settle(id: string, elapsed: number): WaveVerdict | "wait" {
    const s = this.core.sessions.get(id);
    const f = this.flight.get(id);
    if (!s || !s.info.running || !f) return "gone";
    if (f.startedAt != null) {
      if (s.turnActive) return Date.now() - f.startedAt >= SERVED_RUNNING_MS ? "resumed" : "wait";
      // Ended with neither a served Stop nor a sign-in refusal (an API give-up): nothing learnt.
      return "gone";
    }
    return elapsed >= NO_TURN_MS ? "timeout" : "wait";
  }

  /** The wave let this member through: type its continue, unless something says not to. */
  private async fire(ep: AuthEpisode, id: string): Promise<void> {
    const s = this.core.sessions.get(id);
    if (!s) { ep.leave(id); return; }
    const blocker = await continueBlockerNow(s, () => this.core.sessions.get(id) === s && s.info.running && ep.isInFlight(id),
      { quietMs: QUIET_MS, wallBlocks: true, turnBlocks: true, dialogBlocks: true },
      draftReader(s.backend?.delivery, (lines) => this.core.screenCells(id, lines)));
    // Not in flight any more after the read (the episode moved): nothing to do.
    if (blocker === "gone" && ep.isMember(id) && s.info.running && this.core.sessions.get(id) === s) return;
    if (blocker === "gone") { ep.leave(id); return; }
    if (blocker === "halted") { console.log(`${logTag} sign-in continue held: the emergency halt is on · ${s.info.title} (${id})`); ep.verdict(id, "gone"); return; }
    if (blocker === "wall" || blocker === "turn") {
      console.log(`${logTag} sign-in episode: ${blocker === "wall" ? "a usage or spend wall took over" : "a turn is running"} · ${s.info.title} (${id})`);
      ep.leave(id);
      return;
    }
    if (blocker === "box" || blocker === "unsettled" || blocker === "draft") {
      ep.verdict(id, "gone");
      this.park(ep, s, blocker === "draft" ? "words in the composer" : "a quiet screen");
      return;
    }
    this.unpark(id);
    this.flight.set(id, { sentAt: Date.now() });
    console.log(`${logTag} sign-in continue · ${s.info.title} (${id})`);
    const res = await writeContinue({
      sessionId: id,
      kind: "auth",
      actor: "user",
      detail: "continue after the sign-in, released by your tap",
      stillOurs: () => this.core.sessions.get(id) === s && s.info.running && ep.isInFlight(id),
      write: (data) => { this.core.write(id, data); },
      recordPrompt: (text) => { this.core.recordPrompt(id, text, "backlog"); },
    });
    if (res === "gone" && ep.isInFlight(id)) ep.verdict(id, "gone");
  }

  /**
   * Ask again in `PARK_MS` — on the SAME tap, so only while the episode still
   * holds it: `generation()` unchanged (not back to signed out, not ended), the
   * member still waiting, the session still this one. Bounded per tap.
   */
  private park(ep: AuthEpisode, s: Session, why: string): void {
    const id = s.info.id;
    const n = (this.parks.get(id) ?? 0) + 1;
    const old = this.parkTimers.get(id);
    if (old) { clearTimeout(old); this.parkTimers.delete(id); }
    if (n > MAX_PARKS) { this.parks.delete(id); console.log(`${logTag} sign-in continue gave up waiting for ${why} to clear · ${s.info.title} (${id})`); return; }
    this.parks.set(id, n);
    if (n === 1) console.log(`${logTag} sign-in continue parked: ${why} · ${s.info.title} (${id})`);
    const gen = ep.generation();
    const t = setTimeout(() => {
      if (this.parkTimers.get(id) !== t) return;
      this.parkTimers.delete(id);
      if (ep.generation() !== gen || !ep.isMember(id) || ep.isInFlight(id)) return;
      if (this.core.sessions.get(id) !== s || !s.info.running) return;
      ep.continueIds([id]);
    }, this.parkMs);
    t.unref?.();
    this.parkTimers.set(id, t);
  }
}
