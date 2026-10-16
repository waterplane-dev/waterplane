/**
 * The health index for the Health view — the same chained weekly number the phone draws above the
 * readings (`shared/healthindex.ts`), derived here from the series file the view already read.
 * Mirrors the host's `healthwatch.ts` `respond()` minus everything that host does on a clock:
 * there is no weekly refresh, no push and no stored notification mark here, so `lastRefresh` is
 * always null. PURE apart from reading the one file.
 *
 * The context entry's floor is the default warn line (`DEFAULT_CONTEXT_LIMITS`), as the
 * Always-on view weighs it; the desktop app uses the repo's own line where one was set there.
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_CONTEXT_LIMITS, assessHealthMove, healthIndex, healthMoveWords, isoWeekOf,
  type HealthIndexResponse, type HealthSeriesRow,
} from "@waterplane/shared";

/** One row per whole JSON line; a torn line is one missing reading, not a dead series. */
export function parseHealthRows(text: string): HealthSeriesRow[] {
  const rows: HealthSeriesRow[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const r: unknown = JSON.parse(l);
      if (r && typeof r === "object") rows.push(r as HealthSeriesRow);
    } catch { /* skip */ }
  }
  return rows;
}

/** The index over a series' text. `series: null` + a reason when there is no baseline — never a made-up 100. */
export function healthIndexOf(text: string | null, now: number, warnChars: number = DEFAULT_CONTEXT_LIMITS.maxChars): HealthIndexResponse {
  const none = { series: null, move: null, words: null, lastRefresh: null };
  if (text === null) return { ...none, reason: "this folder has no repo-health series yet" };
  const series = healthIndex(parseHealthRows(text), warnChars);
  if (!series) return { ...none, reason: "no week has every enabled reading yet, so there is no baseline" };
  const move = assessHealthMove(series.points);
  return { series, move, words: healthMoveWords(series.points, move, isoWeekOf(new Date(now).toISOString().slice(0, 10))), lastRefresh: null };
}

/** `healthIndexOf` over a file; an unreadable file is a sentence, never an index. */
export function healthIndexOfFile(file: string, now: number): HealthIndexResponse {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return healthIndexOf(null, now);
    return { series: null, move: null, words: null, lastRefresh: null, reason: "the series file could not be read" };
  }
  return healthIndexOf(text, now);
}
