/**
 * Reading the CLI's own conversation jsonl: the two decoders both readers need.
 *
 * `limitlog.ts` asks that file what the account is doing; `ctxlog.ts` asks it
 * how full the context window has been. They walk it differently — one
 * backwards to the newest of two row kinds, one forwards and incrementally —
 * but they decode the SAME two fields off the same records, and they had a
 * byte-identical copy each. `ctxlog.ts`'s copy carried the argument for this
 * file in its own comment: *one of the two will move first and the other must
 * not quietly disagree.*
 */

/**
 * A record's `timestamp`, as epoch ms, or null when it has none we can read.
 *
 * Null rather than `Date.now()`: an undated row is not a row that happened now,
 * and a series that silently stamps unparseable records with the current clock
 * draws a cliff wherever the log format shifted.
 */
export function stamp(row: { timestamp?: unknown }): number | null {
  if (typeof row.timestamp !== "string") return null;
  const t = Date.parse(row.timestamp);
  return Number.isFinite(t) ? t : null;
}

/**
 * An instant that may be seconds or milliseconds, as ms.
 *
 * `resetsAt` is seconds in every row seen so far. Accepting ms too costs one
 * comparison and is what stops a unit change upstream from becoming a reset
 * 56 000 years out — a wall the app would then wait at for ever.
 */
export function toMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e11 ? v * 1000 : v;
}

/**
 * `YYYY-MM-DD` in the LOCAL zone — the day a rate is asked for.
 *
 * Local rather than the ISO string's prefix, and the same rule (and the same
 * reason) as `tokenstats.ts`'s `localHour`: slicing the ISO would file a 01:30
 * turn under the previous UTC day. It only ever decides which side of a rate
 * change a record falls on, so being off by a day is only visible on the day a
 * price moves — which is exactly the day it would be wrong on both screens in
 * different directions if they disagreed about the zone.
 */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
