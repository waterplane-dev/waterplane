/**
 * What one request carried, per ISO week, for one repo — the line drawn beside
 * the health score.
 *
 * Context per request, not dollars per request: a week's price per request is
 * mostly WHICH MODEL ran (opus is several times sonnet) and how long the
 * sessions ran, neither of which is a fact about the repo. The context one
 * request re-sends is closer to what the readings can move, and it costs twice:
 * in money and in the wait before the first token. Of the readings only
 * CLAUDE.md + skill descriptions rides in EVERY request; the others reach it
 * only when the agent reads those files, so the line is context, never proof.
 *
 * A ratio of SUMS (`perRequest.ts`'s rule): a week's tokens ÷ a week's requests,
 * never a mean of daily ratios. Folded off the token ledger's `byRepo` day rows,
 * which go back only as far as the CLI's logs on this desktop — a week with no
 * row is ABSENT, never zero.
 */
import { isoWeekOf } from "./healthindex.js";

export interface HealthSpendWeek {
  /** The ISO week's Monday, `YYYY-MM-DD` (UTC) — `HealthIndexPoint.week`'s key. */
  week: string;
  /** Every request the repo's conversations made that week, subagents included. */
  requests: number;
  /** Input + cache read + cache write over those requests: the context they sent. */
  ctxTok: number;
}

/** The slice of a `TokenDay` this fold reads. */
export interface HealthSpendDay {
  day: string;
  byRepo?: readonly { repo: string; turns: number; ctxTok?: number }[];
}

/**
 * One row per ISO week in which `repos` (any of the keys, e.g. a path and its
 * realpath) made a request with a context count, oldest first. Empty when the
 * ledger carries no `ctxTok` (an older host) or the repo never ran here.
 */
export function healthSpendWeeks(days: readonly HealthSpendDay[], repos: readonly string[]): HealthSpendWeek[] {
  const keys = new Set(repos);
  const weeks = new Map<string, HealthSpendWeek>();
  for (const d of days) {
    const week = isoWeekOf(d.day);
    if (!week) continue;
    for (const r of d.byRepo ?? []) {
      if (!keys.has(r.repo) || typeof r.ctxTok !== "number" || !(r.turns > 0)) continue;
      const w = weeks.get(week) ?? weeks.set(week, { week, requests: 0, ctxTok: 0 }).get(week)!;
      w.requests += r.turns;
      w.ctxTok += r.ctxTok;
    }
  }
  return [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));
}


/** One week of a repo's ledger rows, with the money the health line leaves out. */
export interface RepoSpendWeek {
  requests: number;
  pricedRequests: number;
  usd: number;
  /** Absent when any of the week's rows lacked a context count (an older ledger). */
  ctxTok?: number;
}

/**
 * The agent readings' spend row: `repos`' ledger rows by ISO week (week →
 * figures), money included. A week with no row is absent from the map — the
 * caller says so, never a zero.
 */
export function repoSpendByWeek(
  days: readonly { day: string; byRepo?: readonly { repo: string; turns: number; pricedTurns: number; usd: number; ctxTok?: number }[] }[],
  repos: readonly string[],
): Record<string, RepoSpendWeek> {
  const keys = new Set(repos);
  const out: Record<string, RepoSpendWeek & { noCtx?: true }> = {};
  for (const d of days) {
    const week = isoWeekOf(d.day);
    if (!week) continue;
    for (const r of d.byRepo ?? []) {
      if (!keys.has(r.repo) || !(r.turns > 0)) continue;
      const w = (out[week] ??= { requests: 0, pricedRequests: 0, usd: 0, ctxTok: 0 });
      w.requests += r.turns;
      w.pricedRequests += r.pricedTurns;
      w.usd += r.usd;
      if (typeof r.ctxTok === "number" && !w.noCtx) w.ctxTok = (w.ctxTok ?? 0) + r.ctxTok;
      else { w.noCtx = true; delete w.ctxTok; }
    }
  }
  for (const w of Object.values(out)) delete w.noCtx;
  return out;
}
