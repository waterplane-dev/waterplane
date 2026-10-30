/**
 * The ONE span every section under the sticky bar follows (2026-10-15).
 *
 * The screen used to run about eight time frames at once — a fixed seven-day
 * headline, the Totals box's live-window chips, the Over time box's calendar
 * chips and week stepper, a rolling 7-vs-7 per-request table, and an all-time
 * costliest list and clock — each honest on its own and, together, a screen
 * whose numbers could not be read against each other. The owner asked for one
 * filter that reaches everything; the live limit bars and the week's hour chart
 * above it are the one exception, because they are always NOW.
 *
 * A span is a LIVE rate-limit window (stepped back with `back`) or a run of
 * CALENDAR days ending today, or all time. Pure and node-tested
 * (`span.test.mjs`); the body does the reads.
 */
import {
  addCost, addTotals, type CostBreakdown, type TokenDay, type TokenGroup, type TokenHour, type TokenHourSlot,
  fmtCount, type TokenTotals, undatedSince, undatedText, undatedWhy, zeroCost, zeroTotals,
} from "@waterplane/shared";
import { TREND_DAYS } from "./constants.ts";
import { foldModels, type LiveWindowId, type WindowCut } from "./usageCut.ts";

export type SpanId = LiveWindowId | "30" | "90" | "all";

/** What is picked: `back` counts whole windows before the one running now, and is 0 for a calendar span. */
export interface SpanSel {
  id: SpanId;
  back: number;
}

export const SPANS: readonly { id: SpanId; label: string; days?: number }[] = [
  { id: "session", label: "5h session" },
  { id: "week", label: "Limit week" },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "all", label: "All time" },
];

/** The host's cost window folds at most this many days (`COST_WINDOW_MAX_MS`); a longer span has no repo split. */
export const COST_WINDOW_DAYS = 35;

export function isLiveSpan(id: SpanId): id is LiveWindowId {
  return id === "session" || id === "week";
}

export function spanDayCount(id: SpanId): number | null {
  return SPANS.find((s) => s.id === id)?.days ?? null;
}

/** A local instant's `YYYY-MM-DD`, the key `TokenDay.day` is written in. */
export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local midnight `n - 1` days before `now`'s day: where "the last n days" starts, today counted as one. */
export function calendarFrom(n: number, now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (n - 1)).getTime();
}

/**
 * The instants a span covers, `[from, to)`, or null for all time.
 *
 * A live span is its CUT's (`fromHour` is the hour edge the cut actually starts on, stated by
 * `cutSpan`), ending at its reset or now, whichever is first. A calendar span starts at local
 * midnight and runs to now. A live span with no cut has no instants — the caller falls back.
 */
export function spanRange(sel: SpanSel, cut: WindowCut | null, now: number): { from: number; to: number } | null {
  if (isLiveSpan(sel.id)) return cut ? { from: cut.fromHour, to: Math.min(cut.resetAt, now) } : null;
  const n = spanDayCount(sel.id);
  return n ? { from: calendarFrom(n, now), to: now } : null;
}

/**
 * The day rows a span touches. CALENDAR days, never "the last n rows": `days` holds only days
 * with a turn in them, so a slice of the last 30 rows was the last 30 ACTIVE days — weeks more
 * than the label said whenever there were days off. A live window's first and last day are
 * counted whole; the caller says so.
 */
export function spanDays(days: readonly TokenDay[], range: { from: number; to: number } | null): TokenDay[] {
  if (!range) return [...days];
  const lo = dayKeyOf(range.from);
  const hi = dayKeyOf(Math.max(range.from, range.to - 1));
  return days.filter((d) => d.day >= lo && d.day <= hi);
}

/** The hour rows inside `[from, to)`, by each bucket's own top-of-hour. */
export function spanHours(hours: readonly TokenHour[], range: { from: number; to: number } | null, hourToMs: (h: string) => number): TokenHour[] {
  if (!range) return [...hours];
  return hours.filter((h) => {
    const t = hourToMs(h.hour);
    return t >= range.from && t < range.to;
  });
}

/** Whether the kept hour record reaches back to the span's start — the hour charts and the clock are cut only then. */
export function hoursCover(hoursFrom: number | null | undefined, range: { from: number } | null): boolean {
  if (hoursFrom == null) return false;
  return range != null && hoursFrom <= range.from;
}

/** A run of days' totals, money and model split — the Totals box under a calendar span. */
export interface DaysCut {
  totals: TokenTotals;
  cost: CostBreakdown;
  models: TokenGroup[];
  /** False when no day in the run carries a model split (an older host's scan). */
  modelSplit: boolean;
  days: TokenDay[];
}

export function daysCut(days: readonly TokenDay[], all: TokenGroup[]): DaysCut {
  const totals = days.reduce<TokenTotals>((acc, d) => addTotals(acc, d), zeroTotals());
  const cost = days.reduce<CostBreakdown>((acc, d) => addCost(acc, d.cost), zeroCost());
  const modelSplit = days.some((d) => Array.isArray(d.byModel));
  return { totals, cost, models: modelSplit ? foldModels(days, all) : [], modelSplit, days: [...days] };
}

/**
 * Hours folded onto the clock face: 24 slots, every one drawn (an hour nobody worked is a
 * reading). The slot is the bucket key's own hour, the same local zone the host wrote it in.
 */
export function clockOf(hours: readonly TokenHour[]): TokenHourSlot[] {
  const slots: TokenHourSlot[] = Array.from({ length: 24 }, (_, hour) => ({ hour, ...zeroTotals(), cost: zeroCost() }));
  for (const h of hours) {
    const n = Number(h.hour.slice(11, 13));
    if (!Number.isInteger(n) || n < 0 || n > 23) continue;
    addTotals(slots[n], h);
    addCost(slots[n].cost, h.cost);
  }
  return slots;
}

/** The undated fields a span cut reads (`TokenStatsDoc.undated`/`undatedUntil`/`undatedLogs`). */
export type UndatedFields = { undated?: number; undatedUntil?: number; undatedLogs?: Array<[number, number]> };

/**
 * The sentence a calendar span prints INSTEAD of its sum of days, or null to draw it: the ledger
 * holds records it could not date, in no day, and one of them could fall in `[from, …)` unless
 * every log holding one was last written before `from` (shared `undatedSince`). A sum of days
 * there is a floor that looks exact — the live window's cut refuses the same way.
 */
export function spanUndatedText(doc: UndatedFields | null | undefined, from: number): string | null {
  return undatedText(undatedSince(doc, from));
}

/**
 * Under ALL TIME the hero is `doc.totals`, which holds the records with no date, while the daily
 * bars and the running total sum `doc.days`, which hold none of them — so the line ends below the
 * hero. The split is said, never left for a reader to notice (a total is never printed without
 * it). Null when nothing is undated, on an older host, or when the field is not a count.
 */
export function allTimeUndatedText(doc: UndatedFields | null | undefined): string | null {
  const n = doc?.undated;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  const one = n === 1;
  return `${fmtCount(n)} record${one ? " has" : "s have"} no date: ${one ? "it is" : "they are"} in the total above but in no day, so the days here add up to less than the total.`;
}

/**
 * The 7-day mean without the points whose seven days an undated record could fall in — CUT,
 * never drawn short. A point at local midnight `t` averages the `TREND_DAYS` days ending on it.
 */
export function trendWithoutUndated<P extends { t: number }>(points: readonly P[], doc: UndatedFields | null | undefined): P[] {
  return points.filter((p) => {
    const d = new Date(p.t);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (TREND_DAYS - 1)).getTime();
    return !undatedWhy(undatedSince(doc, start));
  });
}
