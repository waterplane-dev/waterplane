/**
 * What ONE request costs, over time and by repo — the insight "a request costs
 * 25% less than the week before" as a series instead of one comparison.
 *
 * Pure and node-tested (`perRequest.test.mjs`). The rules:
 *
 * - **A ratio of sums, never a mean of ratios.** A day with three requests at
 *   $2 each and a day with three hundred at $0.05 average to about a dollar,
 *   which is the price of nothing that happened. The window's dollars over the
 *   window's requests is the price a request actually had.
 * - **Over a trailing 7 CALENDAR days**, like the day chart's mean — one day is
 *   too few requests to be a price (a single long turn is the whole figure).
 * - **Absent below `PER_REQ_MIN` requests in the window**, and the line is CUT
 *   there rather than joined across: a price read off four requests is a wrong
 *   number, not a noisy one.
 * - **Priced requests only** in the denominator (`RepoDaySlice.pricedTurns`):
 *   a request on a model with no list price adds no dollars, and counting it
 *   would make an unpriced model look like a cheap one. What was left out is
 *   COUNTED, so the screen can say so.
 */
import type { TokenDay, TokenGroup } from "@waterplane/shared";
import type { DayPoint } from "@waterplane/kit";

export const PER_REQ_DAYS = 7;
export const PER_REQ_MIN = 20;

/** One day's money and requests for one cut (everything, or one repo). */
export interface ReqDay { day: string; t: number; usd: number; priced: number; turns: number }

function dayMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

/** `YYYY-MM-DD` of local midnight `t`. */
function keyOf(t: number): string {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whether the document can answer this at all — an older host sends no
 *  `byRepo`, and then the section says so instead of drawing zeros. */
export function hasRepoDays(days: readonly TokenDay[]): boolean {
  return days.some((d) => d.byRepo != null);
}

/**
 * The day rows for one cut: every repo (`repo` absent) or one. Days the cut
 * had nothing on are left out — the rolling window fills them as the zeros
 * they were, over calendar time.
 */
export function reqDays(days: readonly TokenDay[], repo?: string): ReqDay[] {
  const out: ReqDay[] = [];
  for (const d of days) {
    if (!d.byRepo) continue;
    let usd = 0, priced = 0, turns = 0;
    for (const r of d.byRepo) {
      if (repo != null && r.repo !== repo) continue;
      usd += r.usd; priced += r.pricedTurns; turns += r.turns;
    }
    if (turns > 0) out.push({ day: d.day, t: dayMs(d.day), usd, priced, turns });
  }
  return out;
}

/** One point of the rolling line, with what it was made of for the readout. */
export interface ReqPoint extends DayPoint { usd: number; priced: number }

/**
 * The trailing-window price per request, one point per CALENDAR day, split
 * into RUNS wherever the window held too few priced requests.
 *
 * A point is only emitted once a whole window lies inside the record (the
 * first `days - 1` days have no full week behind them, and a partial one would
 * draw a ramp out of the left edge). Calendar days, not active days: a quiet
 * weekend is inside the week it belongs to.
 */
export function rollingPerRequest(rows: readonly ReqDay[], days = PER_REQ_DAYS, min = PER_REQ_MIN): ReqPoint[][] {
  if (!rows.length) return [];
  const byT = new Map(rows.map((r) => [r.t, r]));
  const first = rows[0].t, last = rows[rows.length - 1].t;
  const win: ReqDay[] = [];
  let usd = 0, priced = 0;
  const runs: ReqPoint[][] = [];
  let run: ReqPoint[] = [];
  // Step by calendar day through local midnights; `setDate` rather than
  // `+ DAY_MS` so a DST change cannot walk the key off midnight.
  for (let d = new Date(first); d.getTime() <= last; d.setDate(d.getDate() + 1)) {
    const t = d.getTime();
    const r = byT.get(t);
    if (r) { win.push(r); usd += r.usd; priced += r.priced; }
    // Anything older than the window's first day leaves it.
    const lo = new Date(t); lo.setDate(lo.getDate() - (days - 1));
    while (win.length && win[0].t < lo.getTime()) { const o = win.shift()!; usd -= o.usd; priced -= o.priced; }
    const full = lo.getTime() >= first;
    if (full && priced >= min && usd > 0) {
      run.push({ t, day: keyOf(t), v: usd / priced, usd, priced });
    } else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Clip runs to `[lo, hi]` (epoch ms), dropping any run left empty. */
export function clipRuns(runs: readonly ReqPoint[][], lo: number, hi: number): ReqPoint[][] {
  return runs.map((r) => r.filter((p) => p.t >= lo && p.t <= hi)).filter((r) => r.length > 0);
}

/** A day key's local midnight — `dayToMs`'s rule, kept here so this file stays import-light. */
function dayMsOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

/** Sum of a span of day rows. */
function spanSum(rows: readonly ReqDay[], from: string, to: string): { usd: number; priced: number; turns: number } {
  let usd = 0, priced = 0, turns = 0;
  for (const r of rows) if (r.day > from && r.day <= to) { usd += r.usd; priced += r.priced; turns += r.turns; }
  return { usd, priced, turns };
}

/** A price per request, or null where there were too few to be one. */
function per(s: { usd: number; priced: number }, min: number): number | null {
  return s.priced >= min && s.usd > 0 ? s.usd / s.priced : null;
}

export interface RepoReqRow {
  key: string;
  label: string;
  /** Last 7 days (to today inclusive) and the 7 before, or null below the floor. */
  cur: number | null;
  prev: number | null;
  /** Whole-percent change, only where both weeks are a price. */
  change: number | null;
  /** Every day on record. */
  all: number | null;
  curRequests: number;
  allRequests: number;
  allUsd: number;
}

/**
 * The per-repo table: each repo's price per request this week, last week and
 * over everything, ordered by what the repo cost this week and then all time
 * — the rows worth reading first are the ones the money is in.
 *
 * A repo with too few priced requests EVER to have a price is left out and
 * counted (`hidden`), never listed with a dash in every column.
 */
export function repoPerRequest(
  days: readonly TokenDay[], repos: readonly Pick<TokenGroup, "key" | "label">[], now: number, min = PER_REQ_MIN,
  /** The token sheet's span, as inclusive day keys: compared against the equally long run of days
   *  before it (2026-10-15, the one-span filter). Absent = the last 7 days against the 7 before. */
  span?: { from: string; to: string },
): { rows: RepoReqRow[]; hidden: number } {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const back = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return keyOf(d.getTime()); };
  const shift = (key: string, n: number) => { const d = new Date(dayMsOf(key)); d.setDate(d.getDate() - n); return keyOf(d.getTime()); };
  const len = span ? Math.round((dayMsOf(span.to) - dayMsOf(span.from)) / 86_400_000) + 1 : 0;
  const k0 = span ? span.to : back(0);
  const k7 = span ? shift(span.from, 1) : back(7);
  const k14 = span ? shift(span.from, 1 + len) : back(14);
  const keys = new Set<string>();
  for (const d of days) for (const r of d.byRepo ?? []) keys.add(r.repo);
  const label = new Map(repos.map((r) => [r.key, r.label]));
  const rows: RepoReqRow[] = [];
  let hidden = 0;
  for (const key of keys) {
    const rs = reqDays(days, key);
    const all = rs.reduce((s, r) => ({ usd: s.usd + r.usd, priced: s.priced + r.priced, turns: s.turns + r.turns }), { usd: 0, priced: 0, turns: 0 });
    const allPer = per(all, min);
    if (allPer == null) { hidden++; continue; }
    const a = spanSum(rs, k7, k0), b = spanSum(rs, k14, k7);
    const cur = per(a, min), prev = per(b, min);
    rows.push({
      key, label: label.get(key) ?? (key.split("/").pop() || key),
      cur, prev,
      change: cur != null && prev != null ? Math.round(((cur - prev) / prev) * 100) : null,
      all: allPer, curRequests: a.priced, allRequests: all.priced, allUsd: all.usd,
    });
  }
  rows.sort((x, y) => ((y.cur ?? 0) * y.curRequests - (x.cur ?? 0) * x.curRequests) || (y.allUsd - x.allUsd));
  return { rows, hidden };
}

/** Requests in the cut that no list price covered, over `[lo, hi]` day keys. */
export function unpricedIn(rows: readonly ReqDay[], lo: string, hi: string): number {
  let n = 0;
  for (const r of rows) if (r.day >= lo && r.day <= hi) n += r.turns - r.priced;
  return n;
}
