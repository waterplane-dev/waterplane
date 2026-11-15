/**
 * `setupCostOf` — what the setup costs a median session, the Agent readings region's headline
 * (R-metrics-070): the start context (what the first request carried before anyone typed: the
 * instruction files, tool schemas, skill and subagent listings) is carried again by every request
 * of the session, so per session it costs `start × requests` tokens, priced at the model's
 * CACHE-READ rate at LIST price. The figure is the median over the window's sessions of that
 * per-session product, in tokens and in dollars, never the product of two medians.
 *
 * It counts every request at the read rate: the first request's cache write and any rebuild
 * after a pause are left out, so it errs low, and the words say so.
 *
 * Its split is by whose each part is (`START_GROUPS`: the repo's, yours, the CLI's, not split),
 * as each group's share of the measured part CHARACTERS summed over the same sessions — a ratio
 * of sums, never a per-group dollar figure (characters are not tokens, and the parts do not add up
 * to the first request: what the log leaves unattributed is not a part).
 *
 * Degrades to `{ absent }` with the sentence why: too few sessions, or no priced model. A session
 * on a model with no list price stays in the token median and out of the dollar median, and the
 * count left out is carried.
 */
import { addLocalDays } from "../calday.js";
import { CACHE_READ_MULT, normalizeModel, rateFor } from "../pricing.js";
import { START_GROUPS, startGroupOf, type StartGroup } from "../wire/agentreadings.js";
import { seriesFilter, seriesReadingOf } from "./series.js";
import { localDayOf, medianOf } from "./stats.js";
import type { SeriesAbsent, SeriesPoint } from "./types.js";

/** Days back from now the headline is over. */
export const SETUP_COST_DAYS = 14;
/** Fewest sessions the headline is taken over (the before/after's own minimum per side). */
export const SETUP_COST_MIN_N = 10;

export interface SetupCost {
  /** Median over sessions of start × requests, in tokens. */
  tok: number;
  /** Median over priced sessions of start × requests × cache-read rate, USD at list price; absent when too few were priced. */
  usd?: number;
  /** Median first-request tokens and median requests over the same sessions (what the product is made of). */
  startTok: number;
  requests: number;
  /** Sessions behind `tok`; sessions behind `usd`. */
  n: number;
  nPriced: number;
  /** The models the sessions ran (normalised aliases, most sessions first). */
  models: string[];
  /** Share of the measured part characters per group, summed over the sessions; empty when no session measured its parts. */
  split: { group: StartGroup; label: string; share: number; chars: number }[];
  /** Sessions whose parts were measured (behind `split`). */
  nSplit: number;
  /** Window, epoch ms [from, to). */
  from: number;
  to: number;
}

/** USD per million cache-read tokens for a model on a day, or null when it has no list price. */
export function cacheReadRate(model: string | null | undefined, day?: string): number | null {
  const r = rateFor(model, day);
  if (!r) return null;
  return r.cacheRead ?? r.input * CACHE_READ_MULT;
}

export function setupCostOf(points: readonly SeriesPoint[], opts: { now: number; days?: number; repo?: string }): SetupCost | SeriesAbsent {
  const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? SETUP_COST_DAYS)));
  const to = opts.now;
  const from = addLocalDays(to, -days);
  const ps = seriesFilter(points, opts.repo === undefined ? {} : { repo: opts.repo })
    .filter((p) => p.t0 >= from && p.t0 < to && seriesReadingOf(p, "start") !== undefined && Number.isFinite(p.req) && p.req > 0);
  if (ps.length < SETUP_COST_MIN_N) {
    return { absent: `${ps.length} fresh interactive sessions with a first request in the last ${days} days; the setup cost needs at least ${SETUP_COST_MIN_N}.` };
  }
  const toks: number[] = [];
  const usds: number[] = [];
  const models = new Map<string, number>();
  const sums = new Map<StartGroup, number>();
  let nSplit = 0;
  for (const p of ps) {
    const t = p.start! * p.req;
    toks.push(t);
    const rate = cacheReadRate(p.model, localDayOf(p.t0));
    if (rate !== null) usds.push((t * rate) / 1e6);
    const m = normalizeModel(p.model) ?? p.model ?? "";
    if (m) models.set(m, (models.get(m) ?? 0) + 1);
    const parts = p.parts ? Object.entries(p.parts).filter(([, c]) => typeof c === "number" && Number.isFinite(c) && c > 0) : [];
    if (parts.length) {
      nSplit++;
      for (const [id, c] of parts) sums.set(startGroupOf(id), (sums.get(startGroupOf(id)) ?? 0) + (c as number));
    }
  }
  const whole = [...sums.values()].reduce((s, x) => s + x, 0);
  const split = whole > 0
    ? START_GROUPS.filter((g) => (sums.get(g.id) ?? 0) > 0).map((g) => ({ group: g.id, label: g.label, chars: sums.get(g.id)!, share: sums.get(g.id)! / whole }))
    : [];
  const usd = usds.length >= SETUP_COST_MIN_N ? medianOf(usds) : null;
  return {
    tok: medianOf(toks)!,
    ...(usd !== null ? { usd } : {}),
    startTok: medianOf(ps.map((p) => p.start!))!,
    requests: medianOf(ps.map((p) => p.req))!,
    n: ps.length,
    nPriced: usds.length,
    models: [...models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m),
    split,
    nSplit,
    from,
    to,
  };
}
