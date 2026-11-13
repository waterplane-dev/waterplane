/**
 * `seriesOf` — the agent readings per local day or ISO week.
 *
 * Which sessions each reading is over (`seriesReadingOf` is the ONE answer, the
 * before/after uses it too):
 * - `start`: fresh, interactive (not headless), not a subagent, with a first request;
 * - `subStart`: subagent logs with a first request;
 * - `look`: fresh, not a subagent, reached an edit (`look` present);
 * - `req`: fresh, not a subagent, committed.
 * A bucket with fewer than `SERIES_MIN_N` sessions for a reading has that reading
 * ABSENT with the sentence why — never a median of one or two.
 */
import { isoWeekOf } from "../healthindex.js";
import { localDayOf, medianOf } from "./stats.js";
import type { SeriesAbsent, SeriesBucket, SeriesOpts, SeriesPoint, SeriesReading, SeriesValue } from "./types.js";

/** Fewest sessions a bucket's median is taken over. */
export const SERIES_MIN_N = 5;

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const isFreshMain = (p: SeriesPoint): boolean => p.fresh === true && p.sub !== true;

/** The value `p` contributes to `reading`, or undefined when it is not one of that reading's sessions. */
export function seriesReadingOf(p: SeriesPoint, reading: SeriesReading): number | undefined {
  switch (reading) {
    case "start": return isFreshMain(p) && p.headless !== true && num(p.start) ? p.start : undefined;
    case "subStart": return p.sub === true && num(p.start) ? p.start : undefined;
    case "look": return isFreshMain(p) && num(p.look) ? p.look : undefined;
    case "req": return isFreshMain(p) && p.commit === true && num(p.req) ? p.req : undefined;
  }
}

// closed: SeriesReading is a parameter of these pure functions, never read off the wire
const READING_WORDS: Record<SeriesReading, string> = {
  start: "fresh interactive sessions with a first request",
  subStart: "subagent logs with a first request",
  look: "fresh sessions that reached an edit",
  req: "fresh sessions that committed",
};

/** The sentence for too few sessions behind a reading. */
export function seriesTooFewText(n: number, reading: SeriesReading | "part", min = SERIES_MIN_N): string {
  const what = reading === "part" ? "fresh interactive sessions that measured this part" : READING_WORDS[reading];
  return `${n} ${what} here; a median needs at least ${min}.`;
}

/** Points kept by the model/repo filters (a model filter drops points with no model id). */
export function seriesFilter(points: readonly SeriesPoint[], opts: { model?: string; repo?: string }): SeriesPoint[] {
  return points.filter((p) => p && Number.isFinite(p.t0)
    && (opts.repo === undefined || p.repo === opts.repo)
    && (opts.model === undefined || p.model === opts.model));
}

function valueOf(xs: number[], reading: SeriesReading | "part"): SeriesValue {
  if (xs.length < SERIES_MIN_N) return { absent: seriesTooFewText(xs.length, reading) } satisfies SeriesAbsent;
  return { median: medianOf(xs)!, n: xs.length };
}

function bucketOf(key: string, ps: readonly SeriesPoint[]): SeriesBucket {
  const vals = (r: SeriesReading): number[] => ps.map((p) => seriesReadingOf(p, r)).filter((x): x is number => x !== undefined);
  const startSet = ps.filter((p) => seriesReadingOf(p, "start") !== undefined);
  const parts: Record<string, SeriesValue> = {};
  const ids = [...new Set(startSet.flatMap((p) => Object.keys(p.parts ?? {})))].sort();
  for (const part of ids) {
    const xs = startSet.map((p) => p.parts?.[part]).filter(num);
    if (xs.length > 0) parts[part] = valueOf(xs, "part");
  }
  return {
    key,
    fresh: ps.filter(isFreshMain).length,
    start: valueOf(vals("start"), "start"),
    parts,
    look: valueOf(vals("look"), "look"),
    req: valueOf(vals("req"), "req"),
    subStart: valueOf(vals("subStart"), "subStart"),
  };
}

/** The bucket key of an instant: its local day, or the Monday of that day's ISO week. */
export function seriesBucketKey(t: number, grain: "day" | "week"): string | null {
  if (!Number.isFinite(t)) return null;
  const day = localDayOf(t);
  return grain === "day" ? day : isoWeekOf(day);
}

/** The readings per bucket, oldest first; only buckets holding at least one point. */
export function seriesOf(points: readonly SeriesPoint[], opts: SeriesOpts): SeriesBucket[] {
  const by = new Map<string, SeriesPoint[]>();
  for (const p of seriesFilter(points, opts)) {
    const k = seriesBucketKey(p.t0, opts.grain);
    if (!k) continue;
    const list = by.get(k);
    if (list) list.push(p); else by.set(k, [p]);
  }
  return [...by.keys()].sort().map((k) => bucketOf(k, by.get(k)!));
}
