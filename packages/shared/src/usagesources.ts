/**
 * Usage readings PER SOURCE — the pure rules both ends draw the meter by.
 *
 * Claude's `/usage` scrape stays `UsageInfo` (budget, the intent ladder's
 * window conditions, the burn calibrators and the plugin API all read that
 * object); a `UsageReading` is the list form BESIDE it, so a second account
 * (Copilot's quota, a plugin's probe) can sit next to claude's on one chip.
 *
 * The rules, each because the alternative is a wrong number or a dead control:
 * - a source with nothing to say is ABSENT — `claudeReading` and
 *   `readingAfterResets` answer null rather than a reading of empty windows,
 *   and `chipSegments` drops one that slips through, so it draws nothing;
 * - a window whose reset has PASSED is gone (`usageAfterResets`' rule, per
 *   window): a percentage of a window that rolled over is not a percentage of
 *   anything; a window that named no reset is left alone (unknown ≠ expired);
 * - claude's segment comes FIRST whenever it is present, so a desktop with only
 *   claude sees exactly the chip it had before sources existed;
 * - `chipCut` is the ONE bucketing function: the chip's segments and any
 *   "n of N sources" line are the same cut, never two copies of the edge;
 * - `usageReadingTitle` never prints `?` — what a source did not say is left
 *   out of the sentence.
 */
import type { UsageInfo, UsageReading, UsageSourceId, UsageWindow } from "./wire/telemetry.js";

/** What a source id may look like: short, lowercase, `[a-z0-9:_-]`. */
export const USAGE_SOURCE_RE = /^[a-z0-9][a-z0-9:_-]{0,47}$/;

export const isUsageSourceId = (s: unknown): s is UsageSourceId =>
  typeof s === "string" && USAGE_SOURCE_RE.test(s);

/** The default "this window is nearly spent" line — the chip's `danger` since before sources. */
export const USAGE_HOT_PCT = 80;

const finitePct = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;

/**
 * Claude's `UsageInfo` as a reading. Null unless the scrape parsed (`ok`) and
 * at least one window carries a percentage; a window the screen did not print
 * is left out rather than sent as `pct: null` with nothing beside it.
 */
export function claudeReading(u: UsageInfo | null | undefined): UsageReading | null {
  if (!u || !u.ok) return null;
  const windows: UsageWindow[] = [];
  if (finitePct(u.sessionPct)) windows.push({ id: "session", unit: "5h", pct: u.sessionPct, resetAt: u.sessionResetAt ?? null });
  if (finitePct(u.weeklyPct)) windows.push({ id: "week", unit: "wk", pct: u.weeklyPct, resetAt: u.weeklyResetAt ?? null });
  if (!windows.length) return null;
  const r: UsageReading = { source: "claude", label: "Claude", backend: "claude", checkedAt: u.checkedAt, windows };
  if (u.remembered) r.remembered = true;
  return r;
}

/** A window's used share, 0..100: its `pct`, else `used / limit`; null when neither is usable. */
export function usageWindowPct(w: UsageWindow): number | null {
  if (finitePct(w.pct)) return w.pct;
  if (typeof w.used === "number" && typeof w.limit === "number" && Number.isFinite(w.used)
    && Number.isFinite(w.limit) && w.limit > 0 && w.used >= 0) {
    return Math.min(100, Math.round((w.used / w.limit) * 100));
  }
  return null;
}

const hasUsd = (r: UsageReading): boolean =>
  !!r.usd && typeof r.usd.spentUsd === "number" && Number.isFinite(r.usd.spentUsd);

/**
 * The reading with every window (and a dollar period) whose reset has passed
 * dropped. Returns the SAME object when nothing expired — asked often — and
 * null when nothing is left to say.
 */
export function readingAfterResets(r: UsageReading, now = Date.now()): UsageReading | null {
  const gone = (at: number | null | undefined) => at != null && at <= now;
  const anyWindowGone = r.windows.some((w) => gone(w.resetAt));
  const usdGone = !!r.usd && gone(r.usd.resetAt);
  if (!anyWindowGone && !usdGone) {
    return r.windows.some((w) => usageWindowPct(w) != null) || hasUsd(r) ? r : null;
  }
  const next: UsageReading = { ...r, windows: r.windows.filter((w) => !gone(w.resetAt)) };
  if (usdGone) delete next.usd;
  return next.windows.some((w) => usageWindowPct(w) != null) || hasUsd(next) ? next : null;
}

/** The window with the highest used share; null when no window has one. First wins a tie. */
export function hottestWindow(r: UsageReading): UsageWindow | null {
  let best: UsageWindow | null = null;
  let bestPct = -1;
  for (const w of r.windows) {
    const p = usageWindowPct(w);
    if (p != null && p > bestPct) { best = w; bestPct = p; }
  }
  return best;
}

/** The dollar period's used share, when it has a cap. */
function usdPct(r: UsageReading): number | null {
  if (!hasUsd(r) || !r.usd || r.usd.capUsd == null || !(r.usd.capUsd > 0)) return null;
  return Math.min(100, Math.round((r.usd.spentUsd / r.usd.capUsd) * 100));
}

/** The reading's highest used share across windows and a capped dollar period; null when none. */
export function readingPct(r: UsageReading): number | null {
  const w = hottestWindow(r);
  const wp = w ? usageWindowPct(w) : null;
  const up = usdPct(r);
  if (wp == null) return up;
  if (up == null) return wp;
  return Math.max(wp, up);
}

/** Danger per segment: any window (or a capped dollar period) at or past `threshold`. */
export function readingHot(r: UsageReading, threshold = USAGE_HOT_PCT): boolean {
  const p = readingPct(r);
  return p != null && p >= threshold;
}

/** One segment of the launcher's usage chip. */
export interface ChipSegment {
  source: UsageSourceId;
  /** As drawn: `"Claude"`, `"Copilot"`. */
  label: string;
  /** The hottest figure as text: `"5%"`, or `"$12.30"` for a dollar-only source. */
  text: string;
  /** The hottest window's unit (`"5h"`, `"wk"`, `"mo"`); `""` for a dollar-only source. */
  unit: string;
  hot: boolean;
  /** The reading it was cut from — claude's segment draws both its windows from it. */
  reading: UsageReading;
  /**
   * Set on the LAST drawn segment only, when sources were cut past `max`: their
   * labels, for the long-press title. Names only — not a control.
   */
  hidden?: string[];
}

/** `chipCut`'s answer: what is drawn, what was cut, and out of how many with a reading. */
export interface ChipCut {
  segments: ChipSegment[];
  /** Labels of sources that HAVE a reading but did not fit under `max`. */
  hidden: string[];
  /** Sources with a reading at all (`segments.length + hidden.length`). */
  total: number;
}

const fmtUsd = (n: number): string => `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;

function segmentOf(r: UsageReading, threshold: number): ChipSegment | null {
  const w = hottestWindow(r);
  const wp = w ? usageWindowPct(w) : null;
  if (w && wp != null) return { source: r.source, label: r.label, text: `${wp}%`, unit: w.unit, hot: readingHot(r, threshold), reading: r };
  if (hasUsd(r) && r.usd) {
    const up = usdPct(r);
    return { source: r.source, label: r.label, text: up != null ? `${up}%` : fmtUsd(r.usd.spentUsd), unit: "", hot: readingHot(r, threshold), reading: r };
  }
  return null;
}

/**
 * THE cut: claude first when present, then the others hottest first (ties by
 * label), a reading with nothing to draw dropped, the rest past `max` named in
 * `hidden`. Duplicate sources keep the first.
 */
export function chipCut(readings: readonly UsageReading[] | null | undefined, max = 3, threshold = USAGE_HOT_PCT): ChipCut {
  const seen = new Set<string>();
  const all: ChipSegment[] = [];
  for (const r of readings ?? []) {
    if (!r || seen.has(r.source)) continue;
    const s = segmentOf(r, threshold);
    if (!s) continue;
    seen.add(r.source);
    all.push(s);
  }
  const rank = (s: ChipSegment) => readingPct(s.reading) ?? -1;
  all.sort((a, b) => {
    if (a.source === "claude") return b.source === "claude" ? 0 : -1;
    if (b.source === "claude") return 1;
    return rank(b) - rank(a) || a.label.localeCompare(b.label);
  });
  const cap = Math.max(1, Math.floor(max));
  const segments = all.slice(0, cap);
  const hidden = all.slice(cap).map((s) => s.label);
  if (hidden.length) segments[segments.length - 1] = { ...segments[segments.length - 1], hidden };
  return { segments, hidden, total: all.length };
}

/** The chip's segments — `chipCut(...).segments`. */
export const chipSegments = (readings: readonly UsageReading[] | null | undefined, max = 3, threshold = USAGE_HOT_PCT): ChipSegment[] =>
  chipCut(readings, max, threshold).segments;

const pad2 = (n: number) => String(n).padStart(2, "0");

function inText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** A reset instant: local `HH:MM` inside 20 h, else `Nov 1`. */
function resetText(at: number, now: number): string {
  const d = new Date(at);
  if (at - now <= 20 * 3600e3) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Words for a window id the chip only spells as a unit. */
const WINDOW_WORDS: Record<string, string> = { session: "5-hour session", week: "week" };

/**
 * The long-press wording for one reading:
 * `Copilot usage — chat 5% (9 / 200 credits) · resets Nov 1 (in 16d) · checked 2m ago`.
 * What the source did not say is left out; never `?`.
 */
export function usageReadingTitle(r: UsageReading, now = Date.now()): string {
  const parts: string[] = [];
  for (const w of r.windows) {
    const p = usageWindowPct(w);
    if (p == null) continue;
    const name = r.source === "claude" ? WINDOW_WORDS[w.id] ?? w.id : w.id;
    const count = typeof w.used === "number" && typeof w.limit === "number"
      ? ` (${w.used} / ${w.limit}${w.unitName ? ` ${w.unitName}` : ""})` : "";
    const reset = w.resetAt != null && w.resetAt > now
      ? ` · resets ${resetText(w.resetAt, now)} (in ${inText(w.resetAt - now)})` : "";
    parts.push(`${name} ${p}%${count}${reset}`);
  }
  if (hasUsd(r) && r.usd) {
    const cap = r.usd.capUsd != null && r.usd.capUsd > 0 ? ` of ${fmtUsd(r.usd.capUsd)}` : "";
    const reset = r.usd.resetAt != null && r.usd.resetAt > now
      ? ` · resets ${resetText(r.usd.resetAt, now)} (in ${inText(r.usd.resetAt - now)})` : "";
    parts.push(`${r.usd.label} ${fmtUsd(r.usd.spentUsd)}${cap}${reset}`);
  }
  const head = `${r.label} usage`;
  const checked = Number.isFinite(r.checkedAt) && r.checkedAt > 0
    ? ` · checked ${agoText(now - r.checkedAt)}${r.remembered ? " (kept from before a restart)" : ""}` : "";
  return `${head}${parts.length ? ` — ${parts.join(" · ")}` : ""}${checked}`;
}
