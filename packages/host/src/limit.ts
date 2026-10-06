/**
 * Usage-limit detection + reset-time parsing for auto-continue.
 *
 * Works on ANSI-stripped PTY tail text, like prompt.ts, and is equally
 * heuristic: the phrasings are pinned to what the Claude Code TUI prints when a
 * plan limit blocks the session (the "reached your <model> limit" banner, the
 * "resets at 3am" note, the stop-and-wait menu option). TUI copy changes can
 * break this — the e2e script pins the expected shapes.
 *
 * NOTE for editors: keep the full rendered phrases out of comments/strings in
 * this repo — a session displaying such text on screen would false-positive.
 * The regex literals themselves are safe (their escaped source doesn't match
 * what they match).
 */

/**
 * Wall-clock ↔ epoch in a NAMED zone. Shared with the schedule clock
 * (shared/schedule.ts) because both need the same thing for the same reason: a
 * time expressed in the user's zone — a banner's "(Europe/Berlin)", a schedule's
 * anchor — has to resolve to an instant even when the daemon's own process TZ
 * differs, and it has to survive DST.
 */
import { wallClockToEpoch, zoneOffsetMs } from "@waterplane/shared";

/** The blocked-banner phrasings, matched line-wise. */
const BLOCKED_RES: RegExp[] = [
  /you'?ve (?:reached|hit) (?:your|the) [^\n]{0,40}?limit\b/i, // "… reached your Fable 5 limit."
  /(?:session|weekly|5-hour|usage) limit (?:reached|hit|exceeded)/i,
  /limit (?:will )?resets? at\b/i,
  /run \/usage-credits to continue/i,
  /out of (?:extra )?usage credits/i,
];

/** The limit menu's wait option ("1. Stop-and-wait…" until the reset). */
export const STOP_WAIT_RE = /stop and wait for (?:the )?limit to reset/i;

/** Lines that merely WARN (not block) — never treat these as blocked. */
const WARNING_RE = /approaching[^\n]{0,60}limit/i;

/** A WEEKLY (not session/5-hour) usage-limit block. The weekly banner prints a
 *  BARE wall-clock time ("resets 7pm") with no calendar date, so the parsed
 *  reset lands on the wrong DAY — the real weekly window resets days out. */
const WEEKLY_RE = /\bweekly limit\b/i;

export interface LimitDetection {
  /** A blocked-on-usage-limit banner is present in the text. */
  blocked: boolean;
  /** Parsed expected reset time (epoch ms), or null when the text doesn't say. */
  resetAt: number | null;
  /** The block is a WEEKLY limit (bare-time banner, unreliable reset). */
  weekly: boolean;
}

/** Scan cleaned (ANSI-stripped) terminal text for a usage-limit block. */
export function detectLimitText(cleanText: string, now = Date.now()): LimitDetection {
  let blocked = false;
  for (const line of cleanText.split("\n")) {
    if (WARNING_RE.test(line)) continue;
    if (BLOCKED_RES.some((re) => re.test(line)) || STOP_WAIT_RE.test(line)) { blocked = true; break; }
  }
  const weekly = blocked && WEEKLY_RE.test(cleanText);
  return { blocked, resetAt: blocked ? parseResetTime(cleanText, now) : null, weekly };
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Parse a reset time out of limit-banner text, relative to `now`.
 *
 * The banner prints the time in a zone it names explicitly, e.g.
 * "Resets Jul 9 at 7pm (Europe/Berlin)" — we honor that zone so the schedule is
 * right even when the daemon's process TZ differs. With no printed zone we fall
 * back to host-local (same machine claude runs on).
 *
 * Handles: "resets at 3am", "resets 4:30pm", "will reset at 14:00",
 * "resets Tue 3am", "resets Jul 9 at 7pm", "resets in 2 hours". Returns epoch
 * ms, or null.
 */
export function parseResetTime(text: string, now: number): number | null {
  const t = text.toLowerCase();
  // Only look near the word "reset" so stray clock times elsewhere don't win.
  const m0 = /resets?\b[^\n]{0,80}/.exec(t);
  if (!m0) return null;
  const ctx = m0[0];

  // "resets in 2 hours" / "in 2h 30m" / "in 45 minutes" — always relative to now.
  const rel = /in\s+(?:(\d+)\s*h(?:ou)?r?s?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/.exec(ctx);
  if (rel && (rel[1] || rel[2])) {
    return now + (Number(rel[1] || 0) * 3600 + Number(rel[2] || 0) * 60) * 1000;
  }

  // The banner names its zone in a trailing "(Area/City)" — honor it (else local).
  const zoneM = /\(([a-z]+\/[a-z_\/+-]+|utc|gmt)\)/i.exec(text);
  const zone = zoneM ? zoneM[1].replace(/^gmt$/i, "UTC") : null;

  // Optional weekday ("resets Tue 3am") or month+day ("resets Jul 9 at 7pm").
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s/.exec(ctx);
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/.exec(ctx);
  // Clock time: "3am", "4:30pm", "14:00". Bare hours without am/pm are too
  // ambiguous ("resets 3") — require am/pm OR a minutes part.
  const clock = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(ctx) ?? /\b(\d{1,2}):(\d{2})\b/.exec(ctx);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] || 0);
  const ampm = clock[3];
  if (hour > 23 || minute > 59) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  // Resolve the target date in the banner's zone (the day/month/weekday roll must
  // reason about "today" as the banner's zone sees it, not the daemon's).
  const zParts = zone ? zoneOffsetMs(zone, now) : null;
  const zn = new Date(zParts != null ? now + zParts : now); // wall clock in the target zone (via UTC getters)
  const g = zParts != null
    ? { y: zn.getUTCFullYear(), mo: zn.getUTCMonth(), d: zn.getUTCDate(), dow: zn.getUTCDay() }
    : { y: zn.getFullYear(), mo: zn.getMonth(), d: zn.getDate(), dow: zn.getDay() };

  let y = g.y, mo = g.mo, d = g.d;
  if (md) {
    // Explicit calendar date (weekly limits): this year, or next year if the
    // date already sits more than the grace in the past (a Dec banner read in Jan).
    mo = MONTHS.indexOf(md[1]);
    d = Number(md[2]);
    let epoch = wallClockToEpoch(y, mo, d, hour, minute, zone);
    if (epoch <= now - PAST_GRACE_MS) epoch = wallClockToEpoch(y + 1, mo, d, hour, minute, zone);
    return epoch;
  }
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1]);
    let delta = (target - g.dow + 7) % 7;
    let epoch = wallClockToEpoch(y, mo, d + delta, hour, minute, zone);
    if (delta === 0 && epoch <= now - PAST_GRACE_MS) epoch = wallClockToEpoch(y, mo, d + 7, hour, minute, zone);
    return epoch;
  }
  let epoch = wallClockToEpoch(y, mo, d, hour, minute, zone);
  // More than the grace in the past → the banner really means tomorrow
  // (e.g. "resets 3am" read at 11pm). Within the grace we return the PAST time
  // as-is: the banner outlives the reset on screen (and across host restarts),
  // and a stale "resets 12:40pm" read at 15:03 means the reset already happened
  // — the caller catches up now, not a day later. Session limits reset within 5h.
  if (epoch <= now - PAST_GRACE_MS) epoch = wallClockToEpoch(y, mo, d + 1, hour, minute, zone);
  return epoch;
}

/** How far in the past a parsed clock time may lie and still mean "already
 *  reset" rather than "tomorrow". Session-limit windows are 5h. */
const PAST_GRACE_MS = 6 * 3600e3;

/**
 * The same question, asked of a HEADLESS run's own output.
 *
 * `claude -p --output-format json` answers a limit the way it answers anything
 * else: exit code non-zero, an envelope on stdout whose `result` is the banner
 * as one line, and — measured, `2.1.236` — NOTHING on stderr. Every caller here
 * reported `String(err)`, i.e. `Command failed: claude -p --output-format json`,
 * which names no fact anybody can act on and reads as a broken install. The
 * sentence that says what actually happened, and when it stops being true, was
 * already in `stdout` and was being thrown away.
 *
 * Same posture as the PTY path: the TEXT is upstream's and may change, so a
 * miss degrades to the caller's old message, never to a wrong claim.
 */
export function detectHeadlessLimit(stdout: string, stderr: string, now = Date.now()): LimitDetection {
  const text = [envelopeResult(stdout), stdout, stderr].filter(Boolean).join("\n");
  return detectLimitText(text, now);
}

/** The assistant text inside a `-p --output-format json` envelope, or "". */
function envelopeResult(stdout: string): string {
  try {
    const env = JSON.parse(stdout) as { result?: unknown; error?: unknown };
    const parts = [env?.result, env?.error].filter((v) => typeof v === "string") as string[];
    return parts.join("\n");
  } catch { return ""; }
}

/**
 * One sentence for a screen: what stopped this run, and when to try again.
 *
 * `verb` is what did not happen ("checked", "assessed"), because "it failed" and
 * "it never ran" are different claims and only the second one is true here —
 * nothing was judged, so no verdict on the work itself may be implied.
 *
 * Deliberately NOT the banner's own wording: this string travels to a phone, a
 * notification and a log, and re-printing upstream's phrasing is how a readout
 * false-positives the detector that produced it.
 */
export function limitNote(det: LimitDetection, verb: string, now = Date.now()): string {
  const until = det.resetAt ? ` until ${clockOf(det.resetAt, now)}` : "";
  const window = det.weekly ? " (weekly window)" : "";
  return `Nothing was ${verb} — the account is out of quota${until}${window}.`;
}

/** A reset instant as a short local wall clock ("17:10", or "Fri 17:10"). */
function clockOf(at: number, now = Date.now()): string {
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? hhmm : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hhmm}`;
}
