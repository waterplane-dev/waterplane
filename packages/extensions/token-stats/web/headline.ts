/**
 * The headline at the top of the Claude view: the last seven calendar days as ONE
 * number, the four kinds it is made of, the money each kind came to at list
 * prices, and one column per day — pure, so `node --test` runs it.
 *
 * **A total is never printed without its split.** 96% of every token on this
 * desktop is a cache read, so "12M tokens" alone is out by two orders of
 * magnitude on what anybody typed. The split rides in the same object as the
 * total, summed in the same pass, so the two cannot disagree.
 *
 * Seven CALENDAR days ending today, the same edges the `Week`/`30 days` chips
 * use (local midnight via `dayToMs`, the zone the host bucketed in). A day the
 * ledger does not list INSIDE the record is a measured zero (the scan walks every
 * log — `fillSeries`' argument); a day before the first recorded one is NOT, and
 * is `null`, never a zero column.
 */
import { type CostBreakdown, dayToMs, type TokenDay, type TokenTotals, tokenTotal } from "@waterplane/shared";

export const HEADLINE_DAYS = 7;

export interface HeadlineDay {
  /** `YYYY-MM-DD`, local. */
  day: string;
  /** Local midnight. */
  t: number;
  /** Tokens that day; `null` before the record begins (unknown, not zero). */
  tok: number | null;
  /** List-price dollars that day; `null` with `tok`. */
  usd: number | null;
}

export interface Headline {
  /** Sum of the four kinds over the span — `tokenTotal(split)`, never a second tally. */
  total: number;
  split: TokenTotals;
  cost: CostBreakdown;
  /** Oldest first, exactly `HEADLINE_DAYS` long. */
  days: HeadlineDay[];
  /** Days with any turn in them. */
  active: number;
  /** The busiest day's tokens, the sparkline's top. */
  peak: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The span's days, oldest first: today and the six before it, walked with
 *  `Date#setDate` so a DST weekend cannot drop or repeat a day. */
export function headlineSpan(now: number, n = HEADLINE_DAYS): { day: string; t: number }[] {
  const out: { day: string; t: number }[] = [];
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    out.push({ day: keyOf(d.getTime()), t: d.getTime() });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * `null` when the ledger has no days at all — the screen's `Empty` already says
 * that, and a headline of zero would claim a measured quiet week.
 */
export function headline(days: readonly TokenDay[], now: number, n = HEADLINE_DAYS): Headline | null {
  if (!days.length) return null;
  const first = dayToMs(days[0].day);
  const byDay = new Map(days.map((d) => [d.day, d]));
  const split: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 0 };
  const cost: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let active = 0;
  let peak = 0;
  const out: HeadlineDay[] = headlineSpan(now, n).map(({ day, t }) => {
    if (t < first) return { day, t, tok: null, usd: null };
    const d = byDay.get(day);
    if (!d) return { day, t, tok: 0, usd: 0 };
    split.input += d.input;
    split.output += d.output;
    split.cacheRead += d.cacheRead;
    split.cacheWrite += d.cacheWrite;
    split.cacheWrite1h += d.cacheWrite1h;
    split.turns += d.turns;
    cost.input += d.cost.input;
    cost.output += d.cost.output;
    cost.cacheRead += d.cost.cacheRead;
    cost.cacheWrite += d.cost.cacheWrite;
    cost.total += d.cost.total;
    const tok = tokenTotal(d);
    if (tok > 0) active++;
    if (tok > peak) peak = tok;
    return { day, t, tok, usd: d.cost.total };
  });
  return { total: tokenTotal(split), split, cost, days: out, active, peak };
}

/** The sentence under the number: what it covers, in words. */
export function headlineSpanWords(h: Headline): string {
  const known = h.days.filter((d) => d.tok != null).length;
  if (known < h.days.length) return `the ${known} day${known === 1 ? "" : "s"} on record, out of the last ${h.days.length}`;
  return `the last ${h.days.length} days, today included`;
}
