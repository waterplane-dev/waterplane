/**
 * The whole health-index answer from a series file's text — what the host's
 * `GET /api/repos/:id/healthindex` serves (`healthwatch.ts` `respond()`) and
 * what the VS Code Health view derives from the series it already read. ONE
 * derivation, so the two surfaces cannot disagree on which rows score, when
 * there is no scored week, or whether the per-commit series is sent: the
 * extension's copy of this used to drop `commits` and the stale-engine reason.
 *
 * Pure. What each caller adds stays with it: the host's `lastRefresh` (it runs
 * a weekly clock; VS Code never does) and `spend` (off a token ledger). The
 * stale-engine sentence is the caller's too, because its remedy differs —
 * a command on the desktop, a re-measure in the extension.
 */
import {
  assessHealthMove, centralOf, HEALTH_ENTRIES, HEALTH_ENTRY_LABEL, healthEntryReadings, healthIndex, healthIndexCommits,
  healthMoveWords, healthWeeks, isoWeekOf,
  type HealthIndexResponse, type HealthSeriesRow,
} from "./healthindex.js";

/** One row per whole JSON line; a torn line is one missing reading, not a dead series. */
export function parseHealthRows(text: string): HealthSeriesRow[] {
  const rows: HealthSeriesRow[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const r: unknown = JSON.parse(l);
      if (r && typeof r === "object") rows.push(r as HealthSeriesRow);
    } catch { /* a torn line is one missing reading, not a dead series */ }
  }
  return rows;
}

/** Rows exist and size was measured, but none carries `lineMean`: an older engine wrote the series. */
export function isStaleEngineSeries(rows: readonly HealthSeriesRow[]): boolean {
  const measured = rows.filter((r) => r.size?.value && typeof r.size.value === "object");
  return measured.length > 0 && !measured.some((r) => typeof (r.size!.value as { lineMean?: unknown }).lineMean === "number");
}

const NO_SCORED_WEEK = "no week has every enabled reading yet, so there is no scored week";

/**
 * The no-score sentence, naming what the LATEST week lacks and the engine's own
 * reason for it — "no week has every reading" alone leaves the person to dig
 * out which one. Untested and hatches also lean on `classics`, so its reason
 * stands in where the entry's own row carries none.
 */
export function noScoredWeekWords(rows: readonly HealthSeriesRow[]): string {
  const last = healthWeeks(rows).at(-1)?.row;
  if (!last) return NO_SCORED_WEEK;
  const { values } = healthEntryReadings(last);
  const { disabled } = centralOf(last);
  const why = (r: unknown): string | null => {
    const w = (r as { reason?: unknown } | null | undefined)?.reason;
    return typeof w === "string" && w ? w : null;
  };
  const rec = last as unknown as Record<string, unknown>;
  const missing = HEALTH_ENTRIES.filter((e) => !disabled.includes(e) && values[e] === undefined).map((e) => {
    const reason = why(rec[e]) ?? (e === "untested" || e === "hatches" ? why(rec.classics) : null);
    return reason ? `${HEALTH_ENTRY_LABEL[e]} (${reason})` : HEALTH_ENTRY_LABEL[e];
  });
  return missing.length ? `${NO_SCORED_WEEK}: the latest week has no ${missing.join(", no ")}` : NO_SCORED_WEEK;
}

/** The response over `text` (null = no series file). `series: null` + a reason when there is no scored week — never a made-up number. */
export function healthIndexResponseOf(text: string | null, opts: {
  /** The context warn line the context entry is scored against. */
  warnChars: number | null;
  now: number;
  lastRefresh: string | null;
  /** The no-series sentence ("this repo has no…" / "this folder has no…"). */
  noSeries: string;
  /** The older-engine sentence, with the caller's own remedy. */
  staleEngine: string;
}): HealthIndexResponse {
  const none = { series: null, move: null, words: null, lastRefresh: opts.lastRefresh };
  // `commits: null` on every no-score answer: only an older host OMITS the key, and the x-axis row
  // reads the omission as "restart the desktop" — never true of a repo nobody has measured yet.
  if (text === null) return { ...none, reason: opts.noSeries, commits: null };
  const rows = parseHealthRows(text);
  const series = healthIndex(rows, opts.warnChars);
  if (!series) {
    const commits = healthIndexCommits(rows, opts.warnChars);
    // Size is scored on `lineMean` (engine 2026-10-17a on). Rows where size WAS measured
    // but none carries it are an older engine's series: name the fix, not the symptom.
    if (isStaleEngineSeries(rows)) return { ...none, reason: opts.staleEngine, commits };
    return { ...none, reason: noScoredWeekWords(rows), commits };
  }
  const move = assessHealthMove(series.points);
  return {
    series, move, lastRefresh: opts.lastRefresh,
    words: healthMoveWords(series.points, move, isoWeekOf(new Date(opts.now).toISOString().slice(0, 10))),
    commits: healthIndexCommits(rows, opts.warnChars),
  };
}
