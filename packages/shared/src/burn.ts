/**
 * How fast the WEEKLY figure is climbing, and when that is worth a push.
 *
 * Two readers need the same cut of the usage readings: the phone's limit-window
 * chart (where a rollover is a dashed rule and a hole is a break) and the
 * host's burn watcher (where a reset inside the lookback must start a new
 * stretch, never count as usage going backwards). They used to be one copy in
 * the web kit (`kit/chart/stats/splotUsage.ts`); the rule moved HERE so the
 * host and the phone cannot word it two ways, and the kit re-exports it.
 *
 * The burn reading itself is a heuristic and degrades like every other one in
 * this package: too few readings, too short a span, or a figure that did not
 * climb is NULL — never a rate somebody would plan around that was made up.
 * And the push is words only. Nothing here pauses, holds or refuses anything.
 */
import type { UsageSample } from "./wire/telemetry.js";
import { fmtUsd } from "./pricing.js";

const HOUR = 3_600_000;

// ── the segment rule (moved from the web kit, unchanged) ─────────────────

export interface UsagePoint {
  t: number;
  v: number;
  /** The reset instant this reading named, so the crosshair can say WHICH
   *  window a past point belongs to rather than only when it was taken. */
  r: number | null;
}
export interface UsageSegment {
  pts: UsagePoint[];
  /** Whether this segment begins a NEW window — i.e. the reading before it
   *  named a different reset instant. The first segment never does. */
  rolled: boolean;
}

/**
 * How far two scraped reset instants may sit apart and still be ONE window.
 *
 * The instant is read off a TUI that prints a wall-clock minute ("resets
 * 10:59"), and the CLI recomputes that minute as the window slides, so the
 * SAME window is scraped as 10:59 and then 11:00 minutes later. Compared for
 * equality, every one of those flips was a rollover: the line was cut and a
 * dashed rule drawn at a window that never ended, which put dozens of breaks
 * into a 24-hour strip and made the marks unreadable — a mark that fires on
 * noise teaches a reader to ignore it.
 *
 * Three minutes is far above the jitter (one minute of rounding, plus the
 * scrape's own age) and far below a real rollover, which moves the instant by
 * five hours or by a week. Comparing at minute granularity would not do: the
 * jitter straddles the boundary it would round to.
 */
export const RESET_EPS_MS = 3 * 60_000;

/** Whether two scraped reset instants describe the same window. Unknown on
 *  either side ⇒ unknown, never "different": a reading whose reset the screen
 *  did not print is not evidence that the window changed. */
export function sameWindow(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= RESET_EPS_MS;
}

/**
 * A fall in the figure this big is a NEW window, whatever the reset said.
 *
 * The reset instant alone cannot see every rollover: the reading taken at the
 * moment a window rolls is `0%` with no reset named at all (there is no window
 * in force to name), so the instants either side of it are only ever compared
 * against an unknown — and an unknown must not be read as a change. Inside one
 * window the count only ever goes up; two points of slack because the figure
 * is an integer percentage off a screen that can correct itself by one.
 */
export const DROP_EPS_PCT = 2;

/**
 * The kept readings, cut into polylines that may honestly be drawn as lines.
 *
 * Two cuts, and both of them are the same rule: **only join two readings when
 * something connects them.** A window rollover (the reset instant moved past
 * `RESET_EPS_MS`, or the figure fell past `DROP_EPS_PCT`) cuts and marks the
 * new segment `rolled`; a gap in the observations longer than `maxGapMs` cuts
 * without marking. Readings whose value is null for the window being drawn are
 * DROPPED rather than zeroed — the screen not printing a figure is not the
 * figure being zero.
 */
export function usageSegments(
  samples: readonly UsageSample[],
  which: "session" | "week",
  maxGapMs = 45 * 60_000,
): UsageSegment[] {
  const val = (r: { s: number | null; w: number | null }) => (which === "session" ? r.s : r.w);
  const reset = (r: { sr: number | null; wr: number | null }) => (which === "session" ? r.sr : r.wr);
  const out: UsageSegment[] = [];
  let cur: UsageSegment | null = null;
  let prev: (typeof samples)[number] | null = null;
  let prevV: number | null = null;
  // The reset instant the segment being drawn belongs to — the last one that
  // was actually PRINTED inside it, not the previous reading's, which is null
  // for exactly the reading a rollover happens on.
  let winReset: number | null = null;
  for (const r of samples) {
    const v = val(r);
    if (v == null) continue;
    const res = reset(r);
    const moved = winReset != null && res != null && !sameWindow(winReset, res);
    const fell = prevV != null && v < prevV - DROP_EPS_PCT;
    const rolled = !!prev && (moved || fell);
    const stale = !!prev && r.t - prev.t > maxGapMs;
    if (!cur || rolled || stale) {
      cur = { pts: [], rolled };
      out.push(cur);
      // A new segment forgets the old window's instant rather than carrying it
      // into the comparison for the next reading, which would cut the line a
      // second time at the first reading that finally names the new one.
      winReset = res;
    } else if (winReset == null) {
      winReset = res;
    }
    cur.pts.push({ t: r.t, v, r: res });
    prev = r;
    prevV = v;
  }
  return out;
}

/**
 * The same cut with the WINDOW semantics a calculation needs: only a reset
 * ends a stretch. A gap in the readings is a hole in the picture, but it is
 * not usage coming back — across a gap inside one window the figure still
 * only went up, so the climb from one side to the other is a measurement.
 */
export function usageStretches(samples: readonly UsageSample[], which: "session" | "week"): UsageSegment[] {
  return usageSegments(samples, which, Infinity);
}

// ── the burn reading ─────────────────────────────────────────────────────

export interface BurnStretch {
  /** First and last reading counted (epoch ms). `from` is also the stretch's
   *  identity for "already told" — the same readings never push twice. */
  from: number;
  to: number;
  /** Weekly points climbed between them. */
  dPts: number;
  ptsPerHour: number;
  /** Readings inside `[from, to]`. */
  samples: number;
}

export const BURN_LOOKBACK_MS = 3 * HOUR;
export const BURN_MIN_SPAN_MS = 45 * 60_000;
export const BURN_MIN_DPTS = 1;

/**
 * The weekly figure's climb over the LAST stretch (reset-cut), clipped to
 * `now - lookbackMs`. Null when fewer than two readings are left, when they
 * span less than `minSpanMs`, or when the figure climbed under `minDpts`
 * (which includes falling) — a rate from that would be invented.
 */
export function burnStretch(
  samples: readonly UsageSample[],
  now: number,
  opts: { lookbackMs?: number; minSpanMs?: number; minDpts?: number } = {},
): BurnStretch | null {
  const lookbackMs = opts.lookbackMs ?? BURN_LOOKBACK_MS;
  const minSpanMs = opts.minSpanMs ?? BURN_MIN_SPAN_MS;
  const minDpts = opts.minDpts ?? BURN_MIN_DPTS;
  const segs = usageStretches(samples, "week");
  const last = segs[segs.length - 1];
  if (!last) return null;
  const pts = last.pts.filter((p) => p.t >= now - lookbackMs && p.t <= now);
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const span = b.t - a.t;
  if (!(span >= minSpanMs) || span <= 0) return null;
  const dPts = b.v - a.v;
  if (!(dPts >= minDpts)) return null;
  return { from: a.t, to: b.t, dPts, ptsPerHour: (dPts * HOUR) / span, samples: pts.length };
}

// ── when a push is owed ──────────────────────────────────────────────────

/** What the watcher remembers between observations: when it last pushed, and
 *  which stretch (`BurnStretch.from`) that push was about. */
export interface BurnState { lastAt?: number; lastFrom?: number; }
export const BURN_DEFAULT_PTS_PER_HOUR = 4;
export const BURN_DEFAULT_COOLDOWN_MS = 3 * HOUR;

export type BurnWhy = "off" | "noStretch" | "underThreshold" | "cooldown" | "told";

/**
 * Fire iff the rate is at or over the threshold (a threshold ≤ 0 is OFF), the
 * last push is older than the cooldown, and this stretch was not already told.
 * `why` names the first reason it does not, in that order.
 */
export function burnVerdict(
  s: BurnStretch | null,
  thresholdPtsPerHour: number,
  state: BurnState,
  now: number,
  cooldownMs: number,
): { fire: boolean; why?: BurnWhy } {
  if (!(thresholdPtsPerHour > 0)) return { fire: false, why: "off" };
  if (!s) return { fire: false, why: "noStretch" };
  if (!(s.ptsPerHour >= thresholdPtsPerHour)) return { fire: false, why: "underThreshold" };
  if (state.lastAt != null && now - state.lastAt < cooldownMs) return { fire: false, why: "cooldown" };
  if (state.lastFrom != null && state.lastFrom === s.from) return { fire: false, why: "told" };
  return { fire: true };
}

/** `6`, `2.5`, `0.8` — a points figure, one decimal below ten. */
function fmtPts(n: number): string {
  return n >= 10 ? String(Math.round(n)) : String(Number(n.toFixed(1)));
}

/** `2 h 15 min` / `50 min`. */
function fmtSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * The push: a title and a body, words only. `top` is the dearest launch (a
 * fan-out run, a backlog item or a session) in the stretch, if the caller had
 * one; `pts` is its share of the week already worded (`ptsText`), or null to
 * leave that clause out. The body always ends "Nothing was paused."
 */
export function burnPushText(
  s: BurnStretch,
  top: { label: string; usd: number; share: number } | null,
  pts: string | null,
): { title: string; body: string } {
  const pts1 = fmtPts(s.dPts);
  const title = `Weekly limit climbing fast: +${pts1} ${s.dPts === 1 ? "point" : "points"} in ${fmtSpan(s.to - s.from)}`;
  const parts = [`The weekly figure rose ${pts1} ${s.dPts === 1 ? "point" : "points"} in ${fmtSpan(s.to - s.from)}, about ${fmtPts(s.ptsPerHour)} an hour.`];
  if (top && top.label && Number.isFinite(top.usd) && top.usd > 0) {
    const share = Number.isFinite(top.share) && top.share > 0 ? `, ${Math.round(Math.min(1, top.share) * 100)}% of the stretch` : "";
    parts.push(`Dearest in it: ${top.label} — ${fmtUsd(top.usd)} at list price${pts ? ` ${pts}` : ""}${share}.`);
  }
  parts.push("Nothing was paused.");
  return { title, body: parts.join(" ") };
}
