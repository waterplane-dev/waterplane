/**
 * The resume queue and resurrection — slice S7 of `sessions.ts`
 * (docs/notes/host-architecture.md).
 *
 * Owns the account-scope wave gate (`recover/wavegate.ts`: waiting, in flight,
 * proven, the hold-off, its gap and settle timers) with the limit's policy over
 * it, `resumeFirst`, and the revived pairings with their file — never
 * `resumeMode` (wall's: `writeLimitCfg` persists it beside the switch, so it is
 * read and written here through `core.resumeMode()`/`core.assignResumeMode()`).
 * Every call into another slice goes through `core`.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LimitResumeMode } from "@waterplane/shared";
import { serialGroup } from "@waterplane/shared";
import { stripAnsi } from "../prompt.js";
import { detectLimitText } from "../limit.js";
import { spendRetry } from "../spendwall.js";
import type { Session, SessionCore } from "./core.js";
import { LIMIT_RESUME_GAP_MS, LIMIT_RESUME_SETTLE_MS, LIMIT_RETRY_MS, LIMIT_RESET_BUFFER_MS } from "./knobs.js";
import { hostStateDir } from "../branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";
import { derive } from "../backends/derive.js";
import { WaveGate, type WavePolicy, type WaveVerdict } from "../recover/wavegate.js";

export class ResumeSlice {
  /**
   * The session that REPLACED each one that exited at the usage limit — dead id
   * → the id `doResurrect` opened for it, in insertion order.
   *
   * The exact answer to a question that used to be guessed. `revivedSessionFor`
   * was `runningSessionFor(cwd)` — the newest live session in that directory,
   * whichever it was — and the window between a limit exit and its reset is
   * HOURS. Open a session by hand in that repo in that window (or tap the
   * sheet's *open a session here*) and the row following the resurrection was
   * re-aimed at the session a PERSON was driving: their next Stop completed the
   * item, which never ran, and the real `--continue` that arrived at the reset
   * finished the work with no row watching it — so a failure there was lost
   * under a `done` row. That is the default path of every fired item now, not
   * an edge case, which is why the guess had to go.
   *
   * **Persisted** (`.waterplane/revived.json`), and that is a change from what this
   * comment used to argue. "Memory-only, because the resurrection timer is
   * memory too" holds for a PTY, whose ids are per-boot — but under tmux the
   * sessions and their ids SURVIVE a restart (`rediscover()`), and the gap
   * between a weekly wall and its reset is DAYS, which is many restarts. So the
   * one fact nothing else can reconstruct — which live session replaced which
   * dead one — was being dropped on every restart inside exactly the window it
   * exists for, and every row following a resurrection went back to waiting on
   * a session that was never coming.
   *
   * Bounded by count (`REVIVED_MAX`, oldest dropped) — a long-lived desktop
   * must not grow a file any more than it may grow a map — and each entry
   * carries when it was written, because "oldest" has to mean something after a
   * reload.
   */
  private revivedBy = new Map<string, string>();
  /** When each pairing was recorded, so the cap can drop the oldest across a
   *  restart rather than whatever the JSON happened to list first. */
  private revivedAt = new Map<string, number>();
  private revivedPath: string;
  private static readonly REVIVED_MAX = 200;

  // ── resume queue (see LIMIT_RESUME_* above) ──
  /**
   * The wave gate (`recover/wavegate.ts`) — the ACCOUNT-scope one: what is
   * waiting, what is in flight, whether the wave is proven, the hold-off, the
   * gap and the settle guard. Its rule is "the first of a wave goes alone"; the
   * limit's POLICY is this slice's (`limitWave`): who is in line and in which
   * order, the release mode, resume-or-resurrect, and the hold-off after a
   * resume that came back still blocked (`LIMIT_RETRY_MS`) — the limit provably
   * has not reset, so no other session may spend an attempt learning that.
   */
  private gate: WaveGate;
  /** id → the instant the user pushed it to the front (older stamp wins, so two
   *  "go first" taps keep the order they were made in). */
  private resumeFirst = new Map<string, number>();
  /** Last broadcast host-wide queue state, so publishQueue only speaks up on a
   *  real transition (it is called from every scan of every blocked session). */
  private lastQueueSig = "";

  constructor(private readonly core: SessionCore) {
    this.gate = new WaveGate(this.limitWave());
    this.revivedPath = join(hostStateDir(core.root), "revived.json");
    try {
      if (existsSync(this.revivedPath)) {
        const raw = readJsonGuarded<any>(this.revivedPath, null) as Record<string, { to?: unknown; at?: unknown }>;
        for (const [dead, v] of Object.entries(raw ?? {})) {
          if (!v || typeof v.to !== "string" || !v.to) continue;
          this.revivedBy.set(dead, v.to);
          this.revivedAt.set(dead, typeof v.at === "number" ? v.at : 0);
        }
      }
    } catch { /* corrupt or missing — the pairings are a memory aid, never a source of truth */ }
  }

  // ── the hub's accessors (`SessionCore`'s resume.ts group) ──
  /** The gate's in-flight set has `id`. */
  isResuming(id: string): boolean { return this.gate.isInFlight(id); }
  /** The gate's waiting ids — reassigned, so asked each time. */
  queue(): readonly string[] { return this.gate.waiting(); }
  holdUntil(): number { return this.gate.holdUntil(); }
  proven(): boolean { return this.gate.proven(); }
  setProven(proven: boolean): void { this.gate.setProven(proven); }
  firstAt(id: string): number | undefined { return this.resumeFirst.get(id); }
  dropFirst(id: string): boolean { return this.resumeFirst.delete(id); }

  // ── The resume queue ────────────────────────────────────────────────
  // Membership is DERIVED on demand — blocked, auto-continue on for it, attempts
  // left — never stored on the session. A stored order drifts from the state
  // that actually decides, the same trap `backlog.waiting()` avoids by re-using
  // the eligibility ladder rather than describing it a second time.

  /** Every session in line to be resumed, best first. */
  private resumeOrder(): Session[] {
    const inLine = [...this.core.sessions.values()].filter((s) => {
      const lim = s.info.limit;
      if (!lim || s.killed) return false;
      // A session that EXITED at the limit is in line too — it resumes by being
      // reopened with --continue, which from the queue's side is the same act.
      // Its evidence is the banner in the tail, NOT the blocked flag: the CLI
      // often quits before an idle scan ever ran, so requiring the flag here
      // would drop exactly the sessions resurrection exists for.
      const requested = this.gate.isWaiting(s.info.id) || this.gate.isInFlight(s.info.id);
      if (!lim.blocked && !requested) return false;
      // Out of line when there is no next attempt to make — the same verdict
      // the scheduler acts on, asked once so a session cannot be in the queue
      // for a resume nothing will ever arm.
      if (!this.core.limitAuto(s) || this.core.limitRetry(s, Date.now()).kind === "giveup") return false;
      return s.info.running || s.resurrectTimer != null || requested;
    });
    // Explicit "go first" (oldest tap first) → starred → longest blocked. Id last
    // so the order is total, hence stable across calls: the position published to
    // the phone must not shuffle between two ties.
    const key = (s: Session): number[] => [
      this.resumeFirst.has(s.info.id) ? 0 : 1,
      this.resumeFirst.get(s.info.id) ?? 0,
      s.info.starred ? 0 : 1,
      s.info.limit?.blockedSince || Number.MAX_SAFE_INTEGER,
    ];
    return inLine.sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return a.info.id < b.info.id ? -1 : 1;
    });
  }

  /** Stamp queuePos/resuming/first onto every session, publishing what changed. */
  publishQueue(): void {
    const pos = new Map(this.resumeOrder().map((s, i) => [s.info.id, i + 1]));
    for (const s of this.core.sessions.values()) {
      const lim = s.info.limit;
      if (!lim) continue;
      const queuePos = pos.get(s.info.id) ?? null;
      const resuming = this.gate.isInFlight(s.info.id);
      const first = this.resumeFirst.has(s.info.id);
      if (lim.queuePos === queuePos && lim.resuming === resuming && lim.first === first) continue;
      lim.queuePos = queuePos; lim.resuming = resuming; lim.first = first;
      this.core.emit("updated", s.info);
    }
    // Broadcast the host-wide half only on a real transition. This runs on every
    // scan of a blocked session, and a socket message per scan would be noise
    // that hides the transitions that matter.
    const hold = this.gate.holdUntil();
    const sig = `${[...this.gate.inFlight()].sort().join(",")}|${this.core.resumeMode()}|${hold > Date.now() ? hold : 0}`;
    if (sig !== this.lastQueueSig) { this.lastQueueSig = sig; this.core.emit("limitQueue"); }
  }

  /** Host-wide queue state for the client (rides on limit.config). `resumingId`
   *  is kept beside the set: it is the older field, and a client that only knows
   *  it must still read something true rather than nothing. */
  resumeState(): { resumingId: string | null; resumingIds: string[]; holdUntil: number | null; mode: LimitResumeMode } {
    const ids = [...this.gate.inFlight()];
    const hold = this.gate.holdUntil();
    return {
      resumingId: ids[0] ?? null,
      resumingIds: ids,
      holdUntil: hold > Date.now() ? hold : null,
      mode: this.core.resumeMode(),
    };
  }

  getResumeMode(): LimitResumeMode {
    return this.core.resumeMode();
  }

  /**
   * Choose how the queue releases sessions once the limit lifts.
   *
   * Widening the mode can free capacity immediately (three sessions parked
   * behind one in-flight resume, in three different worktrees), so this pumps —
   * a setting that only takes effect at the next verdict would read as ignored.
   */
  setResumeMode(mode: LimitResumeMode): void {
    if (mode !== "one" && mode !== "repo" && mode !== "all") return;
    if (mode === this.core.resumeMode()) return;
    this.core.assignResumeMode(mode);
    this.core.writeLimitCfg();
    this.publishQueue();
    this.gate.pump();
  }

  /** Push a session to the front of the queue (`on: false` clears it). */
  setResumeFirst(id: string, on: boolean): void {
    if (!this.core.sessions.has(id)) return;
    if (on) { if (!this.resumeFirst.has(id)) this.resumeFirst.set(id, Date.now()); }
    else this.resumeFirst.delete(id);
    this.publishQueue();
    this.gate.pump();
  }

  /**
   * "Stop waiting for the clock" — one session when `id` is given, else every
   * queued one. It does NOT widen the release mode: a tap says the clock is
   * wrong, not that the account can take five sessions at once, and the probe
   * rule stands either way.
   */
  resumeNow(id?: string): void {
    const targets = this.resumeOrder().filter((s) => !id || s.info.id === id);
    // An explicit tap must not sit behind the gap/hold-off timer the queue is
    // already counting down — that timer is exactly what the user is overruling.
    if (targets.length) this.gate.skipGap();
    for (const s of targets) {
      this.core.clearLimitTimer(s);
      this.clearResurrectTimer(s);
      this.gate.request(s.info.id, { forced: true });
    }
  }

  /** A session's scheduled moment arrived: get in line (it may go immediately). */
  requestResume(s: Session): void {
    this.gate.request(s.info.id);
  }

  pumpResume(): void {
    this.gate.pump();
  }

  /**
   * The session we were resuming reached a verdict — let the next one go.
   * "blocked" also arms the host-wide hold-off: the limit demonstrably has NOT
   * reset, and the entire point of serializing is that the others must not each
   * spend one of their bounded attempts rediscovering that.
   */
  releaseResume(id: string, why: WaveVerdict): void {
    this.gate.release(id, why);
  }

  /**
   * The limit's policy over the account-scope gate — today's resume queue,
   * unchanged: the line is `resumeOrder`, the mode is the person's
   * `LimitResumeMode`, `repo` asks `serialGroup`, the dispatch resumes a
   * running session in place and reopens one that exited, a request clears the
   * booked `nextAttemptAt` (the queue owns the moment from here), and a
   * still-blocked verdict holds the rest for `LIMIT_RETRY_MS` and re-books every
   * attempt that would fall inside it — "auto 12:02" that silently does not
   * fire is the ambiguity the queue exists to remove.
   */
  private limitWave(): WavePolicy {
    return {
      order: () => this.resumeOrder().map((s) => s.info.id),
      mode: () => this.core.resumeMode(),
      group: (id) => { const s = this.core.sessions.get(id); return s ? serialGroup(s.info.cwd) : undefined; },
      requested: (id) => { const l = this.core.sessions.get(id)?.info.limit; if (l) l.nextAttemptAt = null; },
      dispatch: (id) => {
        const next = this.core.sessions.get(id)!;
        if (next.info.running) void this.core.doLimitContinue(next);
        else void this.doResurrect(next).catch((e) => console.error(`[resume] could not reopen ${id}: ${(e as Error)?.message ?? e}`)); // the settle guard releases the slot
      },
      holdFor: () => ({ until: Date.now() + LIMIT_RETRY_MS }),
      afterHold: () => {
        const hold = this.gate.holdUntil();
        for (const s of this.core.sessions.values()) {
          const l = s.info.limit;
          if (l?.blocked && l.nextAttemptAt != null && l.nextAttemptAt < hold) this.core.scheduleLimitAttempt(s);
        }
      },
      publish: () => this.publishQueue(),
      // The gap is a RATE limit, not a concurrency one: even in `all` mode the
      // resumes are spaced, so a mis-set mode cannot type "continue" into eleven
      // sessions inside one second.
      gapMs: LIMIT_RESUME_GAP_MS,
      releaseGapMs: (why) => (why === "resumed" ? LIMIT_RESUME_GAP_MS : 500),
      settleMs: LIMIT_RESUME_SETTLE_MS,
    };
  }

  // ── Resurrect a session that EXITED at the usage limit ──────────────
  // The current CLI quits on a plan limit rather than parking at a wait-menu, so
  // in-place auto-continue can't work — the process is gone. Instead we reopen
  // the conversation with `--continue` once the limit resets. Bounded by the same
  // attempts cap so a session that keeps re-hitting the wall stops churning.

  /** Did this session exit because of a usage limit (banner in its tail, or a
   *  block we'd already flagged)? Used by the backlog to requeue vs. fail. */
  diedAtLimit(id: string): boolean {
    const s = this.core.sessions.get(id);
    // A session this host no longer holds — a restart took the record with it —
    // is not unknowable when we WROTE DOWN that we reopened it at a wall: that
    // file is only ever written by `doResurrect`, which runs on a limit exit and
    // nothing else. Without this, every row following a resurrection across a
    // restart was told its session merely "went", and the follow (`intents/watch.ts`)
    // never happened — inside the days-long window the follow exists for.
    if (!s) return this.revivedBy.has(id);
    // Asked by the backlog to choose between "requeue, the wall will lift" and
    // "fail". A backend with no account limit can never have died at one, and
    // answering `true` from a banner-shaped line on its screen would park work
    // for ever on a reset that is never coming.
    //
    // `true` here makes a row FOLLOW a resurrection, so it answers true only for an exit that
    // `maybeScheduleResurrect` would reopen: claude's `limit-ts` (below), or a backend's own
    // `usage.wall` (`{source:true}`) last seen blocked at a DATED reset on a conversation whose
    // id is known (`sourceWallExit`). An undated source wall (`needsYou`) reopens nothing, so
    // its work fails in words rather than waiting for a revival that nothing would ever start.
    if (derive(s.backend).screen("limits") !== "limit-ts") return this.sourceWallExit(s) != null;
    // Same asymmetry `checkLimit` documents: the screen cannot date its banner,
    // so a session that exited hours after an old wall looks identical to one
    // the wall just killed. A readable log settles it.
    const log = this.core.limitLog(s);
    // A clear whose only cause is the CLOCK ("clearedBy: reset") is not a clear
    // about THIS death: the rejection is still the newest thing in the log and
    // nothing was served after it, so the session did die at the wall — the
    // reset simply arrived while it lay there. Reading that as "not a limit
    // death" fails its work items (`backlog.ts` requeues a limit death and fails
    // everything else) for the one reason that was going to lift by itself.
    if (log.state === "clear" && log.clearedBy !== "reset") return false;
    if (log.state === "blocked" || log.clearedBy === "reset") return true;
    if (s.info.limit?.blocked) return true;
    return detectLimitText(stripAnsi(s.scrollback.slice(-6000))).blocked;
  }

  /**
   * Record "this dead session was replaced by that live one", and keep the file
   * in step with the map.
   *
   * One writer, because there is one moment at which both ids are known for
   * certain. The cap drops the OLDEST pairing rather than whichever key the map
   * lists first, so a reload cannot change which one goes; the write is
   * best-effort (a pairing this host still holds in memory is worth having even
   * when the disk refuses).
   */
  private noteRevived(deadId: string, newId: string): void {
    this.revivedBy.set(deadId, newId);
    this.revivedAt.set(deadId, Date.now());
    while (this.revivedBy.size > ResumeSlice.REVIVED_MAX) {
      let oldest: string | null = null;
      let oldestAt = Number.MAX_SAFE_INTEGER;
      for (const [k] of this.revivedBy) {
        const at = this.revivedAt.get(k) ?? 0;
        if (at < oldestAt) { oldestAt = at; oldest = k; }
      }
      if (oldest == null) break;
      this.revivedBy.delete(oldest);
      this.revivedAt.delete(oldest);
    }
    try {
      mkdirSync(hostStateDir(this.core.root), { recursive: true });
      const out: Record<string, { to: string; at: number }> = {};
      for (const [dead, to] of this.revivedBy) out[dead] = { to, at: this.revivedAt.get(dead) ?? 0 };
      writeJsonAtomic(this.revivedPath, out);
    } catch { /* non-fatal — see the field */ }
  }

  clearResurrectTimer(s: Session): void {
    if (s.resurrectTimer) { clearTimeout(s.resurrectTimer); s.resurrectTimer = null; }
  }

  /**
   * A source-walled session's exit, as resurrection reads it: the reset to wait for, or null.
   *
   * The source dies with the process, so the evidence is the LAST verdict `wall.ts`'s
   * `applySourceWall` wrote onto `info.limit` while the session ran — blocked, and DATED (the
   * source's `resetAt` is an instant, trusted like claude's log). Null — nothing scheduled — for
   * a backend whose `limits` is not a source, a session not blocked when it went, an undated
   * wall (`needsYou`: credit does not come back by itself, so a reopen would only spend the
   * first credit the person adds), and a conversation whose id was never learnt: the plugin's
   * bare "continue" picks the directory's NEWEST conversation, which may be somebody else's.
   */
  private sourceWallExit(s: Session): { resetAt: number; convId: string } | null {
    if (!derive(s.backend).askSource("limits")) return null;
    const lim = s.info.limit;
    if (!lim?.blocked || lim.needsYou != null) return null;
    const resetAt = lim.resetAt;
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) return null;
    const convId = s.info.backendSessionId;
    if (!convId) return null;
    return { resetAt, convId };
  }

  maybeScheduleResurrect(s: Session): void {
    // Resurrection is "reopen the conversation when the ACCOUNT serves again".
    // A backend with no account limit has no such moment to wait for, so an exit
    // is just an exit. A backend whose wall is its own `usage.wall` is resumed while it RUNS
    // (`wall.ts` → the same queue), and reopened at its dated reset when it EXITED there
    // (`maybeScheduleSourceResurrect`, the plugin's own resume argv by exact id).
    if (derive(s.backend).screen("limits") !== "limit-ts") { this.maybeScheduleSourceResurrect(s); return; }
    // If this was the session the queue let through, its verdict is in: it EXITED
    // rather than resuming. Treat a limit exit as evidence about the account (so
    // the rest of the queue holds off), anything else as merely gone.
    if (this.gate.isInFlight(s.info.id)) {
      const stillLimited = s.info.limit?.blocked || detectLimitText(stripAnsi(s.scrollback.slice(-6000))).blocked;
      this.releaseResume(s.info.id, stillLimited && (s.info.limit?.attempts ?? 0) > 0 ? "blocked" : "gone");
    }
    if (s.killed || s.detaching) return;               // an intentional close — leave it dead
    const det = detectLimitText(stripAnsi(s.scrollback.slice(-6000)));
    const log = this.core.limitLog(s);
    // A stale banner must not book a resurrect: reopening a conversation with
    // `--continue` starts a turn nobody asked for, at a wall that came down days
    // ago. The log is the half of the evidence that carries a date.
    // Same split as `diedAtLimit`: `served` (an ordinary turn after the
    // rejection) and `none` (no rejection at all) say this exit had nothing to
    // do with a wall. `reset` says the opposite — the wall is the last thing in
    // this conversation and its instant has since passed, which is precisely the
    // session a resurrect is FOR, and refusing it made a limit exit permanent
    // whenever the reset happened to arrive before the session was asked about.
    const limited = log.state === "clear" && log.clearedBy !== "reset"
      ? false
      : log.state === "blocked" || log.clearedBy === "reset" || s.info.limit?.blocked || det.blocked;
    if (!limited || !this.core.limitAuto(s)) return;
    const now = Date.now();
    // ── WHICH reset instant, and whether there is one at all ─────────────────
    //
    // The log's is an instant the CLI recorded and is trusted whatever the
    // window is (an old line threw it away with the screen's guess, and then
    // reopened the conversation every five seconds until the attempts ran out).
    // The screen's weekly notice prints a bare clock time with no date, resolved
    // to its next occurrence: the EARLIEST the window can lift (owner,
    // 2026-10-31), so it is waited for as a DAILY lower bound — a reopen there
    // that dies on the same wall is re-armed at that time tomorrow
    // (`limitretry.ts`'s `daily`), never in a loop. The same rule the in-place
    // path follows (`markLimitBlocked`'s `limitResetKind`).
    const weekly = log.rejectedAt != null ? log.weekly : det.weekly;
    const resetAt = log.resetAt ?? s.info.limit?.resetAt ?? det.resetAt;
    const daily = log.resetAt == null && resetAt != null
      && (s.limitResetKind ? s.limitResetKind === "daily" : weekly);
    // A SPEND wall has no ladder: one attempt at a reset somebody can name (the
    // message's own, or a configured dollar period's), else the person is told.
    const spend = log.rejectedAt != null ? log.spend : det.spend;
    const next = spend
      ? spendRetry(now, resetAt ?? spendRetry(now).resetAt, s.info.limit?.attempts ?? 0, LIMIT_RESET_BUFFER_MS)
      : this.core.limitRetry(s, now, resetAt, daily);
    if (next.kind === "giveup") {
      this.core.noteGaveUp(s, next.why);
      return;
    }
    this.armResurrect(s, next.at, now);
  }

  /** Book the reopen at `at`: the row says when, the queue takes it from there. */
  private armResurrect(s: Session, at: number, now: number): void {
    if (s.info.limit) { s.info.limit.nextAttemptAt = at; this.core.emit("updated", s.info); }
    this.clearResurrectTimer(s);
    s.resurrectTimer = setTimeout(() => { s.resurrectTimer = null; this.requestResume(s); }, Math.max(50, at - now));
    s.resurrectTimer.unref?.();
    this.core.emit("limit", s.info.id, s.info, "scheduled");
  }

  /** The source-wall half of `maybeScheduleResurrect`: the same queue verdict, timer and attempts
   *  cap, on the last verdict the source gave (`sourceWallExit`) — never a screen or a claude log. */
  private maybeScheduleSourceResurrect(s: Session): void {
    if (!s.info.limit) return; // no account limit (no `limits`, or no wall to ask) ⇒ an exit
    if (this.gate.isInFlight(s.info.id)) {
      this.releaseResume(s.info.id, s.info.limit.blocked && s.info.limit.attempts > 0 ? "blocked" : "gone");
    }
    if (s.killed || s.detaching) return;
    const exit = this.sourceWallExit(s);
    if (!exit || !this.core.limitAuto(s)) return;
    const now = Date.now();
    const next = this.core.limitRetry(s, now, exit.resetAt);
    if (next.kind === "giveup") { this.core.noteGaveUp(s, next.why); return; }
    this.armResurrect(s, next.at, now);
  }

  /** Reopen a limit-exited conversation with `--continue`, carrying the block —
   *  its attempt count AND when it started — forward, so the backoff and the
   *  patience clock go on counting instead of restarting per reopen. */
  private async doResurrect(old: Session): Promise<void> {
    old.resurrectTimer = null;
    const id = old.info.id;
    if (old.killed || !this.core.limitAuto(old)) { this.releaseResume(id, "gone"); return; }
    // Someone already reopened this id (manual resume) → nothing to do.
    if (this.core.sessions.get(id)?.info.running) { this.releaseResume(id, "gone"); return; }
    const attempts = (old.info.limit?.attempts ?? 0) + 1;
    const created = await this.core.create(old.info.cwd, {
      cols: old.cols, rows: old.rows, title: old.info.title,
      // A plugin's conversation is its own id (`sourceWallExit` refused one without it); each
      // plugin turns continue + id into its argv (Copilot `--session-id=`, Codex `resume <id>`,
      // Gemini `--resume <id>`). claude carries no `backendSessionId`, so its launch is unchanged.
      resumeMode: "continue", resumeSessionId: old.info.claudeSessionId ?? old.info.backendSessionId, launch: old.launch,
      // The item it was working for (if any) is still what it is working for.
      origin: { ...(old.origin?.itemId ? { itemId: old.origin.itemId } : {}), ...(old.origin?.itemLabel ? { itemLabel: old.origin.itemLabel } : {}), kind: "resurrect", fromSession: id },
    });
    // The closed row the limit exit left says where the conversation went.
    const closed = this.core.closedRow(id);
    if (closed) { closed.resumedAs = created.id; this.core.publishClosed(); }
    // Written down HERE, where both ids are known for certain, and nowhere else:
    // this is the only place a session is reopened on a limit exit, so it is the
    // only place that can answer "which one replaced it" without guessing.
    this.noteRevived(id, created.id);
    this.core.repointCompanions(id, created.id); // its companion shells follow it
    const ns = this.core.sessions.get(created.id);
    if (ns) {
      // Carried on the SESSION as well as written into its limit state: the
      // reopened conversation re-marks itself blocked a moment from now, and
      // that path is where the count and the clock were being reset.
      ns.limitCarried = { attempts, blockedSince: old.info.limit?.blockedSince || Date.now(), at: Date.now() };
      if (ns.info.limit) {
        ns.info.limit.attempts = attempts;
        ns.info.limit.blockedSince = ns.limitCarried.blockedSince;
        this.core.emit("updated", ns.info);
      }
    }
    this.core.emit("limit", created.id, created, "attempt");
    // The resume moved to a NEW session id — hand the queue slot over rather than
    // releasing, so the next session waits for THIS conversation's verdict (it
    // re-blocks, or starts a turn) instead of piling on behind a dead id.
    if (this.gate.isInFlight(id)) {
      if (this.resumeFirst.delete(id)) this.resumeFirst.set(created.id, Date.now() - 1);
      this.gate.handOver(id, created.id);
    }
  }

  /**
   * The live session that REPLACED this one after a usage-limit exit, or null.
   *
   * Exact, never "the newest session in that directory" — see `revivedBy` for
   * what that guess cost. Two walls in one item is a real sequence (the revived
   * session hits the limit again and is resurrected in its turn), so the chain
   * is followed to its end; `seen` is there because a map written by a loop is
   * a map that can be made to contain one.
   *
   * Answers null unless the session it lands on is actually RUNNING: a row
   * following a resurrection may only be re-aimed at a process that exists.
   */
  revivedSessionFor(deadSessionId: string): string | null {
    const seen = new Set<string>([deadSessionId]);
    let cur = deadSessionId;
    for (;;) {
      const next = this.revivedBy.get(cur);
      if (!next || seen.has(next)) break;
      seen.add(next);
      cur = next;
    }
    if (cur === deadSessionId) return null;
    return this.core.sessions.get(cur)?.info.running ? cur : null;
  }
}
