/**
 * `weekSavingOf`: what carrying `extra` less on every request would have saved, per week, over the
 * last 14 days of sessions. tokens x requests x CACHE-READ rate per session, at list price. It
 * counts every request at the read rate (cache writes and rebuilds left out), so it errs LOW.
 * A session on an unpriced model stays in `tokens` and out of `usd`. Never split by group
 * (R-metrics-070). Fewer than SETUP_COST_MIN_N sessions: no saving.
 */
import { addLocalDays } from "../calday.js";
import { CHARS_PER_TOKEN } from "../contextweight.js";
import { cacheReadRate, SETUP_COST_DAYS, SETUP_COST_MIN_N } from "../agentseries/setupcost.js";
import { seriesFilter, seriesReadingOf } from "../agentseries/series.js";
import { localDayOf } from "../agentseries/stats.js";
import type { SeriesPoint } from "../agentseries/types.js";
import type { FindingSaving } from "./types.js";

export interface WeekSavingOpts {
  now: number;
  /** Tokens dropped from the start context of every request. */
  extraTok?: number;
  /** Or characters (an estimate: / CHARS_PER_TOKEN). extraTok wins when both are given. */
  extraChars?: number;
  repo?: string;
  days?: number;
}

export function weekSavingOf(points: readonly SeriesPoint[], opts: WeekSavingOpts): FindingSaving | { absent: string } {
  const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? SETUP_COST_DAYS)));
  const measured = opts.extraTok !== undefined;
  const perReq = measured ? opts.extraTok! : (opts.extraChars ?? 0) / CHARS_PER_TOKEN;
  if (!Number.isFinite(perReq) || perReq <= 0) return { absent: "Nothing to take off the start context." };
  const from = addLocalDays(opts.now, -days);
  const ps = seriesFilter(points, opts.repo === undefined ? {} : { repo: opts.repo })
    .filter((p) => p.t0 >= from && p.t0 < opts.now && seriesReadingOf(p, "start") !== undefined && Number.isFinite(p.req) && p.req > 0);
  if (ps.length < SETUP_COST_MIN_N) {
    return { absent: `${ps.length} fresh interactive sessions in the last ${days} days; a saving needs at least ${SETUP_COST_MIN_N}.` };
  }
  const scale = 7 / days;
  let tok = 0, usd = 0, pricedN = 0, unpriced = 0;
  const repos = new Set<string>();
  for (const p of ps) {
    const t = perReq * p.req;
    tok += t;
    repos.add(p.repo);
    const rate = cacheReadRate(p.model, localDayOf(p.t0));
    if (rate === null) unpriced++;
    else { usd += (t * rate) / 1e6; pricedN++; }
  }
  return {
    tokens: Math.round(tok * scale),
    ...(pricedN > 0 ? { usd: usd * scale } : {}),
    per: "week",
    basis: measured ? "measured" : "estimate",
    errs: "low",
    sessions: ps.length,
    repos: repos.size,
    ...(unpriced > 0 ? { unpricedSessions: unpriced } : {}),
  };
}
