/**
 * Claude Code usage checker. There's no local file or CLI flag with live
 * rate-limit consumption, so we scrape `/usage` from a short-lived `claude`
 * PTY (server-fetched), parse the session + weekly percentages AND the reset
 * instants printed under them, and cache.
 *
 * Fragile by nature (TUI format can change between `claude` versions) — every
 * field is best-effort and `ok:false` when parsing fails, so callers fail safe.
 */
import * as pty from "node-pty";
import type { UsageInfo, UsageSample } from "@waterplane/shared";
import { parseResetTime } from "./limit.js";
import { renderCapture } from "./render.js";
import { readNavBox, trustKeys } from "./prompt.js";

// `trustKeys` moved beside `readNavBox`; deliver.ts presses the same keys.
export { trustKeys };
import { claudeBackend } from "./backends/index.js";
import { ptyEnv } from "./ptyenv.js";
import { isHalted, trackRun } from "./halt.js";
import { env } from "./env.js";

// Read once at boot, as before — `backends/claude.ts` owns the env knob.
const CLAUDE_BIN = claudeBackend.bin();
const TTL_MS = Number(env("USAGE_TTL_MS") || 8 * 60 * 1000);
/**
 * How long a FAILED probe is believed before another one is spawned.
 *
 * A failure used to be cached like a reading — `checkedAt: Date.now()`, two
 * nulls — so one probe that came back unparsed blanked the gauge for the whole
 * eight-minute TTL with nothing asking again. Now the last good reading
 * survives a failure (see `fail()`), and this is the only thing keeping a
 * screen that asks on every navigation from spawning a `claude` per tap while
 * the CLI is genuinely unreadable.
 */
const FAIL_TTL_MS = Math.max(15_000, Number(env("USAGE_FAIL_TTL_MS") || 60_000));
/** The poll period, published so a history chart can say what "dense" would
 *  have looked like. Readings are NOT guaranteed at this rate — polling is only
 *  on when the auto-fire gate needs it (`usagelog.ts`). */
export const USAGE_POLL_MS = TTL_MS;
/** Probe width. The replay must use the SAME number or lines wrap differently
 *  than they did on the probe's own screen. */
const COLS = 100;

const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[PX^_].*?\x1b\\|\x1b\][^\x07]*\x07|\r/g, "");

/**
 * Parse a RENDERED `/usage` screen → percentages and reset instants, anchored on
 * the LABELS, never on the order the numbers appear in.
 *
 * **Rendered, not stripped.** The TUI draws with absolute cursor moves, so the
 * gap between `Current` and `session` is a cursor jump and not a space: ANSI-
 * stripped bytes carry `Currentsession` and `ResetsSep10at7pm(Europe/Berlin)`.
 * The percentages survived that because they are read off a squashed copy, but
 * every reset was read off a spaced one and so was never found — measured, a
 * screen printing both instants published `sessionResetAt: null,
 * weeklyResetAt: null`, and both windows said the screen had named no reset.
 * `scrape()` therefore replays the capture through a headless VT
 * (`render.ts`) first. The `strip()` here stays: it costs nothing on rendered
 * text and keeps a hand-fed raw capture from parsing as garbage.
 *
 * The old parse took the first two `N% used` on screen as session-then-weekly.
 * That is a positional read of a screen that repaints while we watch it: a
 * frame that dropped the "Current session" row (or drew it before its bar
 * filled in) shifts every later number one slot left, so the weekly figure is
 * reported as the session one and the next number — a per-model weekly row,
 * `Current week (Fable) 0% used`, or whatever sits below — becomes "the week".
 * Observed as a phone chip reading `63% / 100% wk` for a real 7% / 63%: both
 * numbers wrong, neither of them nonsense-looking, which is the worst shape a
 * usage gauge can fail in — the weekly figure is what strands you for days.
 *
 * So each figure is read from the text that NAMES it, the per-model weekly rows
 * are ignored (only `(all models)` is the account-wide week), and the LAST
 * matching frame in the buffer wins — the newest complete render. A label that
 * arrives mangled mid-repaint simply doesn't match, so a corrupt frame is
 * skipped rather than parsed. No labels found ⇒ null, not a guess: `ok:false`
 * hides the chip, which is honest, while a wrong percentage is acted on.
 */
export function parseUsage(raw: string, now = Date.now()): {
  sessionPct: number | null; weeklyPct: number | null;
  sessionResetAt: number | null; weeklyResetAt: number | null;
} {
  const sq = strip(raw).replace(/\s+/g, "").toLowerCase();

  /** Last `N%used` that follows `label`, before the next `current…` heading. */
  const after = (label: RegExp): number | null => {
    let val: number | null = null;
    for (const m of sq.matchAll(label)) {
      const from = m.index! + m[0].length;
      let rest = sq.slice(from, from + 400);
      const next = rest.search(/current(session|week)/);
      if (next >= 0) rest = rest.slice(0, next);
      const hit = /(\d{1,3})%used/.exec(rest);
      if (!hit) continue;
      const n = Number(hit[1]);
      if (n >= 0 && n <= 100) val = n;
    }
    return val;
  };

  const sessionPct = after(/currentsession/g);
  // `(all models)` is the account-wide week; `(opus)`/`(fable)` are per-model
  // sub-limits and must never stand in for it. Bare `current week` is the
  // fallback for a build that stops printing the qualifier.
  const weeklyPct =
    after(/currentweek\(allmodels\)/g) ?? after(/currentweek(?!\()/g);

  // Reset instants are read from a copy that KEEPS the spaces, because
  // `parseResetTime` reads words ("resets sep 3 at 7pm (europe/berlin)") and a
  // squashed screen has none. Whitespace is collapsed per line and the newlines
  // are kept, so a reset stays attributable to the heading above it and the
  // context window can't run off the end of its own line.
  const nl = strip(raw).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).join("\n").toLowerCase();
  const sessionResetAt = resetAfter(nl, /current session/g, now, false);
  const weeklyResetAt =
    resetAfter(nl, /current week \(all models\)/g, now, true) ??
    resetAfter(nl, /current week(?! *\()/g, now, true);

  return { sessionPct, weeklyPct, sessionResetAt, weeklyResetAt };
}

/** A reset instant that appears under `label`, before the next `current …` heading. */
function resetAfter(nl: string, label: RegExp, now: number, needDate: boolean): number | null {
  let val: number | null = null;
  for (const m of nl.matchAll(label)) {
    const from = m.index! + m[0].length;
    let rest = nl.slice(from, from + 400);
    const next = rest.search(/current (session|week)/);
    if (next >= 0) rest = rest.slice(0, next);
    // The weekly window resets DAYS out, so a bare wall-clock time would be
    // resolved onto today or tomorrow — the exact wrong-day failure `limit.ts`
    // refuses to make. No date named ⇒ no answer.
    if (needDate) {
      const ctx = /resets?\b[^\n]{0,80}/.exec(rest);
      if (!ctx || !/\b(sun|mon|tue|wed|thu|fri|sat|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(ctx[0])) continue;
    }
    // Last complete frame in the buffer wins, like the percentages above.
    const t = parseResetTime(rest, now);
    if (t != null) val = t;
  }
  return val;
}

/**
 * A reading with every window whose reset instant has PASSED dropped.
 *
 * The percentage is a fact about a window, and a window that has rolled over
 * is gone: 46% of a 5-hour session that reset twenty minutes ago is not 46% of
 * anything. Nothing re-scrapes on the clock here (polling is only on when the
 * auto-fire gate needs it), so a cache can outlive its own window by hours —
 * and the number it keeps printing is exactly the plausible-wrong-number this
 * file exists to refuse. A window the screen named no reset for is left alone:
 * unknown is not expired.
 *
 * Returns the SAME object when nothing expired — `get()` is asked several times
 * a second by the backlog tick.
 */
export function usageAfterResets(u: UsageInfo, now = Date.now()): UsageInfo {
  const sessionGone = u.sessionResetAt != null && u.sessionResetAt <= now;
  const weeklyGone = u.weeklyResetAt != null && u.weeklyResetAt <= now;
  if (!sessionGone && !weeklyGone) return u;
  const sessionPct = sessionGone ? null : u.sessionPct;
  const weeklyPct = weeklyGone ? null : u.weeklyPct;
  return {
    ...u,
    ok: sessionPct != null || weeklyPct != null,
    sessionPct, weeklyPct,
    sessionResetAt: sessionGone ? null : u.sessionResetAt,
    weeklyResetAt: weeklyGone ? null : u.weeklyResetAt,
  };
}

/**
 * The last kept reading, re-offered at boot as what it is.
 *
 * The daemon restarts on every `npm run restart` — which is what shipping a new
 * web bundle IS — and the cache lives in memory, so the phone reconnected to a
 * checker that had never probed and drew `? / ? wk` until something asked for a
 * scrape and the scrape came back. Nothing about the account changed in those
 * seconds; the reading was on disk the whole time.
 *
 * Honest rather than merely helpful:
 * - a window is re-offered ONLY while the reset instant the screen named is
 *   still in the future — `usageAfterResets`' rule, asked of the sample, and a
 *   sample that named no reset for a window cannot claim that window at all;
 * - `checkedAt` stays the original probe's instant, so it reads as old to every
 *   staleness rule (`budget.ts` fails open past `BUDGET_STALE_MS`, `getFresh`
 *   re-probes past the TTL) and the phone says "checked 12m ago";
 * - `remembered: true`, so a reader that must not act on a reading nobody took
 *   this boot (a plugin's answer policy, via `api.claudeUsage`) can refuse it by name.
 *
 * Null when there is nothing worth offering — never a reading of two nulls.
 */
export function rememberedUsage(s: UsageSample | null | undefined, now = Date.now()): UsageInfo | null {
  if (!s || !(s.t > 0) || s.t > now) return null;
  const sessionPct = s.sr != null && s.sr > now ? s.s : null;
  const weeklyPct = s.wr != null && s.wr > now ? s.w : null;
  if (sessionPct == null && weeklyPct == null) return null;
  return {
    ok: true,
    sessionPct, weeklyPct,
    sessionResetAt: sessionPct != null ? s.sr : null,
    weeklyResetAt: weeklyPct != null ? s.wr : null,
    checkedAt: s.t,
    remembered: true,
  };
}

export class UsageChecker {
  private cache: UsageInfo = {
    ok: false, sessionPct: null, weeklyPct: null,
    sessionResetAt: null, weeklyResetAt: null, checkedAt: 0,
  };
  private inflight: Promise<UsageInfo> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** When the last probe failed, 0 = never (or since recovered). */
  private failedAt = 0;

  constructor(private cwd: string, private onUpdate: (u: UsageInfo) => void) {}

  get(): UsageInfo {
    return usageAfterResets(this.cache);
  }

  /**
   * Offer the last kept reading, ONCE, before anything has been probed.
   *
   * Boot only — it never overwrites a reading this process took, and it
   * publishes nothing (there are no clients yet, and the sample is already in
   * the log it came from).
   */
  seed(sample: UsageSample | null | undefined): void {
    if (this.cache.checkedAt) return;
    const u = rememberedUsage(sample);
    if (u) this.cache = u;
  }

  /** Cached value if fresh, else refresh. */
  async getFresh(): Promise<UsageInfo> {
    const now = Date.now();
    if (this.cache.checkedAt && now - this.cache.checkedAt < TTL_MS) return this.get();
    // A probe that just failed is not retried on every navigation — see
    // `FAIL_TTL_MS`. The last good reading (if any) is what `get()` answers.
    if (this.failedAt && now - this.failedAt < FAIL_TTL_MS) return this.get();
    return this.refresh();
  }

  /** Keep usage warm (only worth it when auto-fire needs the gate). */
  startPolling(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), TTL_MS);
  }
  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<UsageInfo> {
    // The probe is a real `claude` process; halted (`halt.ts`) means none is
    // started. The kept reading stands, exactly as after a failed probe.
    if (isHalted()) return usageAfterResets(this.cache);
    if (this.inflight) return this.inflight;
    this.inflight = this.scrape().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private scrape(): Promise<UsageInfo> {
    return new Promise<UsageInfo>((resolve) => {
      let proc: pty.IPty;
      try {
        proc = pty.spawn(CLAUDE_BIN, [], {
          name: "xterm-256color", cols: COLS, rows: 44, cwd: this.cwd,
          // The SAME floor a session gets (`ptyenv.ts`): under launchd there is
          // no `USER`, and a `claude` without one draws `/usage` with the
          // account rows missing for ever — the probe then "fails" on a screen
          // that is working perfectly.
          env: { ...ptyEnv(), ...claudeBackend.spawnEnv },
        });
      } catch {
        return resolve(this.fail());
      }
      let buf = "";
      let done = false;
      let onDone: (() => void) | null = null;
      // The probe is a real `claude`: a halt (`halt.ts`) reaches it like any
      // headless run — its group gets the signal, and the read ends as a failed one.
      const untrack = trackRun((sig) => {
        try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch { /* gone */ } }
        finish(this.fail());
      });
      const finish = (u: UsageInfo) => {
        if (done) return;
        done = true;
        untrack();
        onDone?.();
        try { proc.kill(); } catch { /* gone */ }
        if (u.ok && !u.remembered) this.failedAt = 0;
        this.cache = u;
        this.onUpdate(u);
        resolve(u);
      };
      proc.onData((d) => (buf += d));

      const sq = () => strip(buf).replace(/\s+/g, "").toLowerCase();
      // 1) clear trust prompt if present, 2) send /usage, 3) wait for it to render.
      // Looked for until /usage is typed, not once: a cold `claude` (WSL reading a Windows drive)
      // may not have drawn the box 1.5 s in.
      let trustAnswered = false;
      const trust = setInterval(() => {
        if (done || trustAnswered || !/trustthisfolder|createdoroneyoutrust/.test(sq())) return;
        trustAnswered = true;
        void renderCapture(buf, COLS).then((text) => { if (!done) proc.write(trustKeys(readNavBox(text))); }, () => {});
      }, 500);
      setTimeout(() => { clearInterval(trust); buf = ""; proc.write("/usage\r"); }, 4000);
      /**
       * Look at the screen REPEATEDLY, and stop at the first one that names a
       * window.
       *
       * It used to be one look, nine seconds in, and whatever was on the screen
       * at that instant was the answer. The probe this daemon spawns first is
       * the one racing a cold `claude` — boot, right after `npm run restart` —
       * and nine seconds is not reliably enough for it to paint `/usage`, so the
       * reading that reached the phone was a blank screen's. Waiting longer for
       * everyone would make every warm probe slower; looking again is free
       * (`renderCapture` on a buffer already in memory) and ends sooner.
       *
       * A look that finds nothing says nothing — the hard stop below is what
       * turns "never painted" into a failed probe, once.
       */
      let looking = false;
      const look = () => {
        if (done || looking) return;
        looking = true;
        // Render before parsing: the reset instants are only legible as words on
        // a screen, and a stripped capture has none of the spaces between them.
        void renderCapture(buf, COLS).then((text) => {
          looking = false;
          const u = parseUsage(text);
          // Neither window named ⇒ not painted yet (or not parseable at all).
          // This used to publish `ok:false` with a fresh `checkedAt`, which
          // overwrote a perfectly good reading and stood for the whole
          // eight-minute TTL with nothing asking again — the `? / ? wk` the
          // phone drew after every restart. A blank screen never outranks a
          // reading again: see `fail()`.
          if (u.sessionPct == null && u.weeklyPct == null) return;
          finish({
            ok: true,
            sessionPct: u.sessionPct, weeklyPct: u.weeklyPct,
            sessionResetAt: u.sessionResetAt, weeklyResetAt: u.weeklyResetAt,
            checkedAt: Date.now(),
          });
        }, () => { looking = false; });
      };
      // The looking starts AFTER `/usage` was typed — a render of the screen
      // before it is a render of a screen that cannot carry the answer.
      let looks: NodeJS.Timeout | null = null;
      setTimeout(() => {
        if (done) return;
        look();
        looks = setInterval(look, 1500);
      }, 7000);
      // Hard safety timeout — and the only place a probe is declared failed.
      setTimeout(() => finish(this.fail()), 20000);
      onDone = () => { if (looks) clearInterval(looks); };
    });
  }

  /**
   * A probe that produced nothing.
   *
   * **It does not blank a reading that is still true.** `usagelog.ts` already
   * states the rule for the history — "a failed probe is a fact about this
   * daemon, not about the account's limits" — and the live gauge is the same
   * fact: a `claude` that would not start, or a screen that did not render
   * inside fifteen seconds, says nothing about the week. So the last reading
   * survives, minus any window that has since rolled over, and `checkedAt`
   * stays ITS instant — the phone keeps saying how old it is, and `getFresh`
   * keeps treating it as stale.
   *
   * Only when nothing usable is left does the gauge go to nulls, which is the
   * honest `?` and never a number.
   */
  private fail(): UsageInfo {
    const now = Date.now();
    this.failedAt = now;
    const kept = usageAfterResets(this.cache, now);
    if (kept.ok) return kept;
    return {
      ok: false, sessionPct: null, weeklyPct: null,
      sessionResetAt: null, weeklyResetAt: null, checkedAt: now,
    };
  }
}
