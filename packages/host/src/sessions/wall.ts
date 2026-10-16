import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LimitResumeMode, SessionLimit } from "@waterplane/shared";
import { stripAnsi } from "../prompt.js";
import { detectLimitText, STOP_WAIT_RE } from "../limit.js";
import { readLimitLog, type LimitLogVerdict } from "../limitlog.js";
import { spendRetry } from "../spendwall.js";
import { logMtime, transcriptPath } from "../transcript.js";
import { recordSent } from "../sentlog.js";
import { adoptCarriedBlock, nextLimitAttempt } from "../limitretry.js";
import type { Session, SessionCore } from "./core.js";
import {
  IDLE_PING_MS, LIMIT_RESET_BUFFER_MS, LIMIT_LOG_UNKNOWN, LIMIT_MAX_ATTEMPTS, LIMIT_GIVEUP_MS,
  LIMIT_CARRY_MS, LIMIT_PROBE_MS, LIMIT_LADDER_MS, SERVING_TURN_MS,
} from "./knobs.js";
import { logTag } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";

/**
 * The account wall, per session: the auto-continue config (the global switch,
 * the per-session override, and the resume queue's release mode — persisted
 * together in `.waterplane/limit.json`), reading a block off the screen and the CLI's
 * own log, and the ladder of continue attempts that lifts it.
 *
 * The resume queue (`resume.ts`) decides WHEN a due attempt may type; this
 * slice decides whether one is due at all. Everything the queue owns is
 * reached through `core`, never held here.
 */
export class WallSlice {
  /** Global auto-continue-on-usage-limit switch (persisted; per-session overridable). */
  private autoContinueOn = true;
  private readonly limitCfgPath: string;
  /** How many of them may run at once, and on what grouping. Persisted beside
   *  the global auto-continue switch. */
  resumeMode: LimitResumeMode = "one";

  constructor(private readonly core: SessionCore) {
    this.limitCfgPath = join(hostStateDir(core.root), "limit.json");
    try {
      if (existsSync(this.limitCfgPath)) {
        const cfg = readJsonGuarded<any>(this.limitCfgPath, null);
        this.autoContinueOn = !!cfg.enabled;
        if (cfg.resumeMode === "one" || cfg.resumeMode === "repo" || cfg.resumeMode === "all") this.resumeMode = cfg.resumeMode;
      }
    } catch { /* default on */ }
  }

  // ── Auto-continue on usage limit ────────────────────────────────────
  // A session that hits a Claude usage limit prints a blocked banner (and often
  // a stop-and-wait menu). We badge it, and — when auto-continue is on for the
  // session — take the wait option, schedule a "continue" for the reset time
  // (parsed from the banner; retry cadence when unknown), and verify the
  // outcome on the next idle scan. All heuristic, like prompt detection.

  newLimitState(): SessionLimit {
    return { blocked: false, blockedSince: 0, resetAt: null, nextAttemptAt: null, attempts: 0, weekly: false, autoContinue: this.autoContinueOn, autoContinueOverride: null, queuePos: null, resuming: false, first: false };
  }

  /** Effective auto-continue for a session (override ?? global). */
  limitAuto(s: Session): boolean {
    return s.info.limit?.autoContinueOverride ?? this.autoContinueOn;
  }

  private refreshLimit(s: Session): void {
    if (s.info.limit) s.info.limit.autoContinue = this.limitAuto(s);
  }

  getAutoContinue(): boolean {
    return this.autoContinueOn;
  }

  /** Flip the global switch; re-derives every session and (un)schedules attempts. */
  setAutoContinue(enabled: boolean): void {
    this.autoContinueOn = enabled;
    this.writeLimitCfg();
    for (const s of this.core.sessions.values()) this.refreshLimit(s);
    // Queue places first, so the update a client sees carries the switch and its
    // consequence together — a frame saying "auto-continue off" while the same
    // session still holds a queue position is a screen contradicting itself.
    this.core.publishQueue();
    for (const s of this.core.sessions.values()) {
      this.core.emit("updated", s.info);
      if (s.info.limit?.blocked) this.scheduleLimitAttempt(s);
    }
    this.core.pumpResume();
  }

  /** Both halves of the limit config in one file — the switch and the release
   *  mode. Written whole, so flipping one never drops the other. */
  writeLimitCfg(): void {
    try {
      mkdirSync(hostStateDir(this.core.root), { recursive: true });
      writeJsonAtomic(this.limitCfgPath, { enabled: this.autoContinueOn, resumeMode: this.resumeMode });
    } catch { /* non-fatal */ }
  }

  /** Per-session auto-continue override; null = inherit the global switch. */
  setSessionLimitOverride(id: string, override: boolean | null): void {
    const s = this.core.sessions.get(id);
    if (!s || !s.info.limit) return;
    s.info.limit.autoContinueOverride = override;
    this.refreshLimit(s);
    this.core.publishQueue();          // same frame carries the switch and its queue place
    this.core.emit("updated", s.info);
    if (s.info.limit.blocked) this.scheduleLimitAttempt(s);
    this.core.pumpResume();
  }

  /**
   * What the CLI's OWN log says about the account for this session, cached
   * until the file moves.
   *
   * `unknown` whenever there is nothing to read — no conversation id yet, no
   * file, a log adopted from a tmux session the CLI wrote elsewhere. The caller
   * keeps the screen heuristic in that case; this never turns a missing file
   * into a verdict.
   */
  limitLog(s: Session): LimitLogVerdict {
    if (!s.backend.caps.usageLimits || s.backend.caps.transcript !== "claude-jsonl") return LIMIT_LOG_UNKNOWN;
    if (!s.info.claudeSessionId) return LIMIT_LOG_UNKNOWN;
    const path = transcriptPath(s.info.cwd, s.info.claudeSessionId);
    const mtime = logMtime(path);
    if (mtime == null) return LIMIT_LOG_UNKNOWN;
    // The cache is keyed on the file NOT MOVING — but `blocked` is the one
    // verdict that also depends on the CLOCK (its reset instant passing turns it
    // into a `clear`), and a session sitting at a wall writes nothing, so the
    // mtime never moves across its own reset. Re-read once the instant is past.
    const cached = s.limitLog && s.limitLog.mtime === mtime && s.limitLog.path === path ? s.limitLog.verdict : null;
    if (cached && !(cached.state === "blocked" && cached.resetAt != null && cached.resetAt <= Date.now())) return cached;
    const verdict = readLimitLog(path);
    s.limitLog = { path, mtime, verdict };
    return verdict;
  }

  /**
   * Idle-time scan: does the current screen say we're limit-blocked? After an
   * attempt, only text at/after the last "continue" echo decides — the old
   * banner usually stays visible in the conversation above it, and counting
   * that would keep a resumed session "blocked" forever.
   */
  checkLimit(s: Session): void {
    if (!s.info.running) return;
    // No account, no account limit. A local model cannot be told to come back in
    // five hours, and a banner-shaped line printed by one must never be read as
    // a wall — `SessionInfo.limit` is absent for these sessions, so every path
    // below (the badge, the queue, the auto-continue schedule) has nothing to
    // write to anyway. This is the early exit that keeps the SCAN from running.
    if (!s.backend.caps.usageLimits) return;
    const lim = s.info.limit;
    const cleaned = stripAnsi(s.scrollback.slice(-6000));
    let scan = cleaned;
    // Once a continue has been typed, only a banner AFTER its echo is a wall —
    // and that holds after the block CLEARED too (`attempts` is kept until the
    // next block), not just while it stands. A REPAINT redraws the old banner
    // still on screen above the echo: tmux does it for every pane on a resize, a
    // re-attach and ~5 s after a client starts (its terminal-query timeout), so
    // read from the stream that banner looked like a NEW one and re-blocked a
    // session that had just resumed — when the conversation log could not
    // outrank the screen (`unknown`), which is exactly when the screen decides.
    // "After" is therefore asked of the RENDERED grid, where a repaint changes
    // nothing: rows below the last echo row. The byte tail is the fallback for a
    // grid that does not show the echo (scrolled off, no recorder).
    if (lim && lim.attempts > 0) {
      const echo = /[❯>]\s*continue\b/gi;
      const afterLastEcho = (text: string): string | null => {
        let last = -1;
        echo.lastIndex = 0;
        for (let m = echo.exec(text); m; m = echo.exec(text)) last = m.index;
        return last >= 0 ? text.slice(last) : null;
      };
      scan = afterLastEcho(s.screenLog?.gridText() ?? "") ?? afterLastEcho(cleaned) ?? cleaned;
    }
    const det = detectLimitText(scan);
    // The log OUTRANKS the screen, in both directions, because it is the only
    // one of the two that is dated. A banner is the last thing a blocked session
    // prints, so it sits in the scrollback tail for as long as that session sits
    // idle — days — and every scan re-affirms a wall that came down on Wednesday,
    // re-resolving its bare "resets 10pm" against today. Nothing lifted it
    // either: while the session is quiet the banner never leaves the window, so
    // the scan below could only ever confirm. `clear` also carries the positive
    // half — an assistant turn stamped after the rejection is the account
    // serving us again, which needs nobody to type anything.
    const log = this.limitLog(s);
    // The screen cannot date its banner — that is the whole reason `limitlog.ts`
    // exists — and when the log answers `unknown` (no conversation id, no file,
    // a tail with nothing parseable in it) there is no dated source at all. The
    // wall is then the last thing the CLI printed before the turn it killed, so
    // it sits in the rendered tail for as long as the session lives and every
    // scan re-affirms it. Measured (2026-09-07, 00:42): a `waterplane` session that
    // had been working for 19m28s, its reset four hours past, wearing "blocked —
    // usage limit" with the banner still the last line on screen.
    //
    // A turn IN FLIGHT is dated, and a session cannot be running one while the
    // account refuses it. Not "a turn started at some point": `blockedSince` is
    // stamped on the `!was` edge ONLY, so an auto-continue attempt that failed
    // leaves `turnStartedAt > blockedSince` true for the rest of a block that is
    // entirely real — which is exactly what the screen branch is here to catch.
    // What separates the two is DURATION. A rejected turn dies in seconds, the
    // banner being the CLI's answer to it; a turn still running past
    // SERVING_TURN_MS is work. A resume in flight is excluded outright, since
    // that window belongs to `releaseResume`'s verdict (`e2e-limitqueue.mjs`).
    const servingNow = !!lim?.blocked
      && s.info.turnActive
      && (s.info.turnStartedAt ?? 0) > lim.blockedSince
      && Date.now() - (s.info.turnStartedAt ?? 0) > SERVING_TURN_MS
      && !this.core.isResuming(s.info.id);
    // WHY a `clear` is clear decides what it may outrank (`limitlog.ts`).
    //
    // `none` — a readable log with no rejection row in it at all — is not an
    // answer about the banner on screen: the CLI prints the wall and writes the
    // row a moment after, and the verdict is then MEMOISED on the file's mtime,
    // so a read taken in that gap suppressed the screen for as long as the
    // session stayed quiet (measured 2026-09-10: rejected at 20:20, the block
    // finally noticed at 22:21 — two hours of a live wall wearing no badge and
    // arming no resume). Only a clear that has SEEN the rejection — served
    // since, or its instant passed — may overrule what is on the screen now.
    const logSpeaksOfAWall = log.state === "clear" && log.clearedBy !== "none";
    // `reset` is the weakest of the three: the rejection still stands, nothing
    // has been served, and only the CLOCK has moved past the instant. That says
    // the wall SHOULD be gone — not that anything ran. Clearing on it cancels
    // the pending auto-continue (`clearLimitBlock` kills `limitTimer`), which is
    // exactly what happened the same night: reset at 00:00, the sweep cleared
    // two sessions at 00:00:38, their attempts were due at 00:02, no "continue"
    // was ever typed and the prompts that hit the wall never ran. So a
    // clock-only clear WAITS for the attempt it would cancel. It still clears
    // when no attempt is owed — auto-continue off, attempts spent, nothing
    // armed — or the badge would outlive the block with nothing to lift it.
    // Only an UNSPENT attempt is worth holding the block for. Once a continue
    // has been typed, `attempts > 0` is already one of the positive proofs
    // below, and a resume that failed re-blocks through the branches above — so
    // extending the hold past the first attempt would be the mirror bug: a
    // badge with nothing left to lift it.
    const attemptOwed = !!lim?.blocked && log.clearedBy === "reset" && lim.attempts === 0
      && this.limitAuto(s)
      && (!!s.limitTimer || this.core.isResuming(s.info.id) || this.core.resumeQueue().includes(s.info.id));
    if (log.state === "blocked") {
      // Its `resetAt` is an INSTANT off the CLI's own record: no zone, no date
      // guessed from a bare clock time.
      // The LOG dated this one, so its instant is kept even for a weekly wall.
      this.markLimitBlocked(s, log.resetAt, log.weekly, scan.slice(-600), true, log.spend);
    } else if (det.blocked && !logSpeaksOfAWall && !servingNow) {
      this.markLimitBlocked(s, det.resetAt, det.weekly, scan.slice(-600), false, det.spend);
    } else if (lim?.blocked && !attemptOwed && (log.state === "clear" || lim.attempts > 0 || (s.info.turnStartedAt ?? 0) > lim.blockedSince)) {
      // No live wall, AND some positive proof: the log says the account served
      // us since the rejection, or we attempted a continue, or a TURN HAS
      // STARTED since the block. The banner leaving the scan window is never
      // evidence on its own: the block is the last thing in a
      // conversation that is now sitting quietly at an empty composer, so any
      // repaint that pushes it out of the last 6000 chars looks identical to a
      // reset. This gate used to accept `lastRealInputAt`, i.e. ANY non-passive
      // byte — an Esc, an arrow, a digit from the special-keys row. None of those
      // runs a turn, let alone proves the account is unblocked, and one of them
      // landing while the session waited in the resume queue cleared the block
      // with attempts still 0: the session left the queue, no "continue" was ever
      // typed, and the prompt that hit the wall never ran. `turnStartedAt` is the
      // positive signal in both worlds — the UserPromptSubmit hook where the pipe
      // is live, markSubmitted's Return where it isn't.
      this.clearLimitBlock(s);
    }
  }

  /**
   * `sample` is the text the block notice was matched in. It is captured for
   * the health record and it has one rule: it may reach disk, the wire and the
   * phone, and it must **never be routed back into a PTY** — no plugin prompt event,
   * no delivered text, no sent-log replay. Printing that phrasing onto a claude
   * screen false-positives the very detector the sample documents. Nothing in
   * `clihealth.ts` writes to a session; keep it that way.
   */
  markLimitBlocked(s: Session, resetAt: number | null, weekly = false, sample?: string, dated = false, spend = false): void {
    const lim = s.info.limit;
    if (!lim) return;
    const was = lim.blocked;
    // Read BEFORE the weekly override below nulls it: the question this signal
    // asks is whether the parser got an instant out of the CLI's own notice, and
    // a weekly block declining to USE the instant (its bare time lands on the
    // wrong day) is a decision of ours, not a parse that failed.
    const parsedReset = resetAt != null;
    lim.blocked = true;
    lim.weekly = weekly;
    if (spend) lim.spend = true; else delete lim.spend;
    // A weekly banner's bare time lands on the wrong DAY — don't surface it as a
    // countdown, and don't wait for it; the backoff carries that wait instead
    // (`limitretry.ts`).
    //
    // `dated` is the exception, and it is the half that was missing: the CLI's
    // own log records the reset as an INSTANT (`limitlog.ts`'s `resetsAt`),
    // which is as true of a weekly window as of a five-hourly one. Dropping it
    // with the screen's guess is what left every weekly wall with nothing to
    // wait for, and therefore on a cadence that ran out of attempts the same
    // afternoon.
    if (weekly && !dated) resetAt = null;
    // A session hitting the wall for the first time is fresh evidence that the
    // limit is ON — whatever an earlier resume proved, it did not prove this.
    if (!was) {
      // The SAME wall, if this session was opened to replace one that died on
      // it moments ago (`Session.limitCarried`) — the count and the clock carry
      // over, or every reopen resets both and neither bound is ever reached
      // (`adoptCarriedBlock`, where that rule and its staleness are pinned).
      const adopted = adoptCarriedBlock(s.limitCarried, Date.now(), LIMIT_CARRY_MS);
      s.limitCarried = undefined;
      lim.blockedSince = adopted.blockedSince;
      lim.attempts = adopted.attempts;
      this.core.setResumeProven(false);
      // A new wall is a new wait: whatever this session gave up on last time is
      // not what it is waiting for now.
      s.limitGaveUp = false;
      // A block BEGINNING is the edge — a block is a state that lasts hours and
      // is re-scanned throughout, so this is recorded once per wall hit rather
      // than once per sweep. Without an instant the session has nothing to
      // resume at and waits on a blind re-scan instead, which is what makes a
      // parse failure here worth a word.
      // A spend wall with no printed instant is the rule answering correctly:
      // there is no clock in it to parse, so it is neither a miss nor a good.
      if (!spend || parsedReset) this.core.noteFor(s, "limit.reset", parsedReset ? "good" : "fallback", {
        ...(parsedReset ? {} : { via: "a periodic re-scan with no scheduled resume" }),
        ...(sample ? { raw: sample } : {}),
      });
    }
    // A spend wall lifts at the dollar period's reset if one is configured -
    // never at a time anybody invented. No period: resetAt stays null.
    if (spend && resetAt == null) resetAt = spendRetry(Date.now()).resetAt;
    if (resetAt != null && resetAt !== lim.resetAt) { lim.resetAt = resetAt; if (was) this.core.emit("updated", s.info); }
    this.refreshLimit(s);
    if (!was) {
      this.core.emit("updated", s.info);
      this.core.emit("limit", s.info.id, s.info, "blocked");
      this.core.publishQueue();
      this.scheduleLimitAttempt(s);
    } else if (this.core.isResuming(s.info.id) && lim.attempts > 0) {
      // The banner came back BELOW our own "continue" echo (checkLimit only scans
      // from there) — this resume failed, and it is evidence about the account,
      // not about this session. Release with the hold-off so the rest of the
      // queue doesn't spend an attempt each rediscovering the same wall.
      this.core.releaseResume(s.info.id, "blocked");
      this.scheduleLimitAttempt(s);
    } else if (!s.limitTimer) {
      // An attempt just failed (or auto was off): line up the next one.
      this.scheduleLimitAttempt(s);
    }
  }

  private clearLimitBlock(s: Session): void {
    const lim = s.info.limit;
    if (!lim?.blocked) return;
    this.clearLimitTimer(s);
    lim.blocked = false;
    s.limitGaveUp = false;
    // Served again ⇒ whatever wall this session was carrying is over.
    s.limitCarried = undefined;
    lim.resetAt = null;
    lim.nextAttemptAt = null;
    this.core.dropResumeFirst(s.info.id);   // the tap was about THIS block
    this.core.emit("updated", s.info);
    this.core.emit("limit", s.info.id, s.info, "resumed");
    this.core.releaseResume(s.info.id, "resumed");
    this.core.publishQueue();
  }

  /**
   * This session's next limit attempt, or the reason there is none.
   *
   * One call site's worth of plumbing around `limitretry.ts`, shared by the two
   * paths that wait on a wall — a session still RUNNING behind a block
   * (`scheduleLimitAttempt`) and one that EXITED at it
   * (`maybeScheduleResurrect`). They used to carry two copies of the cadence and
   * the same weekly special case, and only one of them had been thought about
   * since: the resurrect copy reopened a weekly-blocked conversation every five
   * seconds until the attempts ran out, minutes into a wall lasting days.
   *
   * `resetAt` is whatever this session was told, which is null for a weekly
   * banner read off a SCREEN (`markLimitBlocked` refuses to date a bare time)
   * and an instant when the CLI's own log recorded one.
   */
  limitRetry(s: Session, now: number, resetAt?: number | null) {
    const lim = s.info.limit;
    return nextLimitAttempt({
      attempts: lim?.attempts ?? 0,
      resetAt: resetAt !== undefined ? resetAt : lim?.resetAt ?? null,
      blockedSince: lim?.blockedSince ?? 0,
      now,
      holdUntil: this.core.resumeHoldUntil(),
      buffer: LIMIT_RESET_BUFFER_MS,
      probeMs: LIMIT_PROBE_MS || undefined,
      ladder: LIMIT_LADDER_MS.length ? LIMIT_LADDER_MS : undefined,
      maxAttempts: LIMIT_MAX_ATTEMPTS,
      giveUpMs: LIMIT_GIVEUP_MS,
    });
  }

  /**
   * The waiting is over — said ONCE per block, and logged with the bound that
   * ended it.
   *
   * Both callers are re-asked while a session stays blocked (the minute sweep
   * re-enters `scheduleLimitAttempt`; an exited session is re-examined on every
   * scan), so emitting from them directly pushed one notification a minute for
   * as long as the wall stood.
   */
  noteGaveUp(s: Session, why: string): void {
    if (s.limitGaveUp) return;
    s.limitGaveUp = true;
    console.log(`${logTag} limit gave up · ${s.info.title} (${s.info.id}) · ${why}`);
    this.core.emit("limit", s.info.id, s.info, "gaveup");
  }

  /** Schedule the next continue attempt (a probe, the dated reset, or a
   *  widening backoff — `limitretry.ts` decides which). */
  scheduleLimitAttempt(s: Session, atOverride?: number): void {
    this.clearLimitTimer(s);
    const lim = s.info.limit;
    if (!lim || !lim.blocked || !s.info.running) return;
    if (!this.limitAuto(s)) {
      if (lim.nextAttemptAt != null) { lim.nextAttemptAt = null; this.core.emit("updated", s.info); }
      return;
    }
    // Already in line: the queue owns the moment from here, and requestResume
    // deliberately cleared nextAttemptAt so the row shows its queue place instead.
    // Re-arming (the sweep calls this every minute while a session waits) would
    // publish a countdown that lapses without producing an attempt — the exact
    // "auto 12:03 that silently doesn't" this feature exists to remove.
    if (this.core.isResuming(s.info.id) || this.core.resumeQueue().includes(s.info.id)) return;
    const now = Date.now();
    let at: number;
    if (atOverride != null && !lim.spend) {
      at = Math.max(atOverride, this.core.resumeHoldUntil());
    } else {
      // One rule for every window, weekly included (`limitretry.ts`): one early
      // probe, then a reset anybody DATED, then a widening backoff — and a
      // give-up on the clock rather than on the attempt count, which is what
      // used to end every weekly wait hours into a wall that lasts days.
      //
      // The hold-off travels IN rather than being clamped on after: a resume
      // that came back still blocked is evidence about the ACCOUNT, so no
      // session's next attempt may precede it.
      // A SPEND wall (`spendwall.ts`) takes one attempt at a reset somebody can
      // name, never a probe or a backoff: the wall is a balance, so typing into
      // it earlier changes nothing. No reset, or the attempt failed: it needs
      // the person, and `noteGaveUp` says so.
      const next = lim.spend ? spendRetry(now, lim.resetAt, lim.attempts, LIMIT_RESET_BUFFER_MS) : this.limitRetry(s, now);
      if (next.kind === "giveup") {
        if (lim.nextAttemptAt != null) { lim.nextAttemptAt = null; this.core.emit("updated", s.info); }
        this.noteGaveUp(s, next.why);
        return;
      }
      at = lim.spend ? Math.max(next.at, atOverride ?? 0, this.core.resumeHoldUntil()) : next.at;
    }
    lim.nextAttemptAt = at;
    s.limitTimer = setTimeout(() => { this.onLimitDue(s); }, Math.max(50, at - now));
    this.core.emit("updated", s.info);
    this.core.emit("limit", s.info.id, s.info, "scheduled"); // log-only phase (no notification)
  }

  /** The scheduled moment arrived — get in line rather than typing straight away. */
  private onLimitDue(s: Session): void {
    s.limitTimer = null;
    const lim = s.info.limit;
    if (!lim || !lim.blocked || !s.info.running || this.core.sessions.get(s.info.id) !== s) return;
    if (!this.limitAuto(s)) { lim.nextAttemptAt = null; this.core.emit("updated", s.info); return; }
    this.core.requestResume(s);
  }

  /** Type the continue. Only ever called by the queue, for the session it let through. */
  async doLimitContinue(s: Session): Promise<void> {
    const id = s.info.id;
    const lim = s.info.limit;
    if (!lim || !lim.blocked || !s.info.running || this.core.sessions.get(id) !== s) { this.core.releaseResume(id, "gone"); return; }
    if (!this.limitAuto(s)) { lim.nextAttemptAt = null; this.core.emit("updated", s.info); this.core.releaseResume(id, "gone"); return; }
    // Busy session (it may have resumed on its own) or a non-limit prompt up →
    // don't type into it; look again shortly. Quiet threshold never exceeds the
    // idle threshold (which e2e shrinks via env). Release without a hold-off:
    // this says nothing about the account, so the next in line should go now.
    const nonLimitPrompt = s.info.prompt && !s.info.prompt.options.some((o) => STOP_WAIT_RE.test(o.label));
    if (Date.now() - s.lastDataAt < Math.min(3000, IDLE_PING_MS) || nonLimitPrompt) {
      this.core.releaseResume(id, "gone");
      this.scheduleLimitAttempt(s, Date.now() + 60_000);
      return;
    }
    if (lim.attempts >= LIMIT_MAX_ATTEMPTS) {
      lim.nextAttemptAt = null;
      this.core.emit("updated", s.info);
      this.core.emit("limit", s.info.id, s.info, "gaveup");
      this.core.releaseResume(id, "gone");
      return;
    }
    lim.attempts += 1;
    lim.nextAttemptAt = null;
    this.core.emit("updated", s.info);
    this.core.emit("limit", s.info.id, s.info, "attempt");
    // If the limit menu is still up, take its stop-and-wait option first so the
    // composer is free to type into.
    const stopWait = s.info.prompt?.options.find((o) => STOP_WAIT_RE.test(o.label));
    if (stopWait) {
      s.proc.write(String(stopWait.index) + "\r");
      recordSent({
        sessionId: s.info.id, actor: "auto", source: "limit", kind: "answer",
        text: String(stopWait.index), result: "written",
        detail: `cleared the usage-limit menu before continuing`,
      });
      await new Promise((r) => setTimeout(r, 1200));
      if (!s.info.running || this.core.sessions.get(s.info.id) !== s) { this.core.releaseResume(id, "gone"); return; }
    }
    // Split text/Return (one chunk can be read as a paste, not a submit).
    this.core.write(s.info.id, "continue");
    await new Promise((r) => setTimeout(r, 250));
    this.core.write(s.info.id, "\r");
    this.core.recordPrompt(s.info.id, "continue (auto, usage limit reset)", "backlog");
    // `written`, not `ok`: this path presses Return blind (there is no echo
    // check here), and the outcome only lands on the next idle scan.
    recordSent({
      sessionId: s.info.id, actor: "auto", source: "limit", kind: "prompt",
      text: "continue", result: "written",
      detail: `auto-continue after a usage limit (attempt ${lim.attempts})`,
    });
    // Outcome lands on the next idle scan: banner below the echo → still
    // blocked → retry cadence; gone → "resumed".
  }

  clearLimitTimer(s: Session): void {
    if (s.limitTimer) { clearTimeout(s.limitTimer); s.limitTimer = null; }
  }
}
