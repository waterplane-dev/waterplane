// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).
import { pctOf, ordinal, nf } from "./repoHealthWordsFmt.ts";

/* ───────────────────────────────────────────────────────────────────────────
 * Region 2: the series as charts.
 *
 * Everything below is the wording around a drawn reading. The rule the top of
 * this file states gets HARDER here, not easier: a chart is where a verdict
 * hides best. A red band, an amber zone, a "worsening" caption, a slope arrow
 * coloured by direction — each is one attribute away, and none of them would
 * fail a test that lives in `tools/`. Rising LOC and rising escape hatches are
 * opposite news about the same repo; a colour would choose for the reader.
 * So: no status hue anywhere in region 2, the slope is a glyph in
 * `currentColor` with its own word beside it, and every sentence here goes
 * through the same ban as the ones above.
 * ─────────────────────────────────────────────────────────────────────────── */




/**
 * A value as this screen prints it, given the series' own unit.
 *
 * Three shapes, because the six series carry three kinds of magnitude: a count
 * of lines or chars (grouped, no decimals — `1,352`), a dimensionless rate
 * below 10 (`0.69`, because rounding it to `1` deletes the reading), and a
 * count with a unit after it. `fmtCount`'s `1.4k` is deliberately not used: a
 * p95 of 1,352 lines and one of 1,449 both print as `1.4k`, and the difference
 * is exactly what a tile exists to show.
 */
export function seriesValueWords(v: number | null | undefined, unit = ""): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const body = Number.isInteger(v) ? nf(v) : Math.abs(v) < 10 ? v.toFixed(2) : nf(v);
  return unit ? `${body} ${unit}` : body;
}

export interface ReadingWords {
  /** Percentile as a FRACTION in [0,1], straight off the wire. */
  rank: number | null;
  slope?: "rising" | "falling" | "flat" | null;
  /** Readings in the window — not calendar days. */
  n: number;
  from?: string | null;
  /** Present exactly when there is no rank. */
  reason?: string;
}

/**
 * Where a value sits in its own past, as the tool words it.
 *
 * Deliberately the same clause order as `rankPhrase` in
 * `tools/repohealth/events.mjs`, because this sentence and the narrative
 * further down the same screen are about the same number and a reader will
 * compare them. Both endpoints are named — the size of the window and the day
 * it opens — for the reason the whole file is arranged around: a position with
 * no stated basis is a number nobody can check.
 *
 * **A null rank returns the tool's own REASON and never a `0th percentile`.**
 * Those are opposite claims: one says the history is too short to place this
 * value, the other says it is the lowest ever recorded.
 */
export function rankSentence(r: ReadingWords | null | undefined): string | null {
  if (!r) return null;
  if (r.rank == null) return r.reason ?? `not enough history (${r.n} readings)`;
  const where = r.from ? ` back to ${r.from}` : "";
  const lean = r.slope ? `, ${r.slope}` : "";
  return `${ordinal(pctOf(r.rank))} percentile of the last ${nf(r.n)} readings${where}${lean}`;
}

/**
 * The rank as a CHIP beside the value — the same conversion `rankSentence`
 * makes (`pctOf` + `ordinal`, the one on this side), shortened to fit a value
 * row. **A null rank is `null` here, never a `0th`**: the tile then prints
 * `rankSentence`'s reason as a line, which is the only honest thing to say.
 */
export function rankChipWords(r: ReadingWords | null | undefined): string | null {
  if (!r || r.rank == null) return null;
  return `${ordinal(pctOf(r.rank))} percentile of ${nf(r.n)}`;
}

/**
 * **What each tile measures, in one plain line** — for the newcomer who has not
 * opened the `?`. A paraphrase of the hint's first sentence, never a second
 * explanation: the `?` stays the one place the method is argued. No verdict
 * either way (the ban in `repoHealthWords.test.mjs` runs over these too), and a
 * key the tool adds later simply has no line — absent, never a guess.
 */
export const KPI_MEANING: Readonly<Record<string, string>> = {
  "size.p95": "how long a large file runs — 95 in 100 source files are shorter",
  "retouch.rate": "the share of file edits that reworked lines the edit just before had added",
  "hatches.perKloc": "places a type or lint rule was switched off with no reason given, per 1,000 lines",
  "context.claudeMdChars": "what every turn in this repo re-sends before anyone types",
  "context.descChars": "the one-line skill descriptions that ride in every window",
  "context.skillCount": "how many skills the repo ships",
  "untested.count": "source modules no test names or reaches through imports",
  "graph.cycleFiles": "source modules that import each other in a circle, through any number of steps",
  "graph.fanOutP95": "how many of the repo's own modules a file imports — 95 in 100 files import fewer",
};

export function kpiMeaning(key: string): string | null {
  return KPI_MEANING[key] ?? null;
}

/**
 * Why a tile has a number and no curve, or nothing at all.
 *
 * Four absences, four sentences, because their next actions differ: the family
 * read nothing today (the metric's own reason, quoted), the history is too
 * short to draw, there is a value but no rank, and there is a rank but the
 * latest day has no value. A blank box would be one picture for all four.
 */
export function tileAbsentWords(a: {
  absent?: string;
  points?: number;
  readings?: number;
  minToDraw?: number;
}): string | null {
  if (a.absent) return `this reading was not taken on the latest day — ${a.absent}`;
  const readings = a.readings ?? 0;
  const min = a.minToDraw ?? 2;
  if (readings === 0) return "no reading in the whole series — nothing to draw.";
  if (readings < min) {
    return `${readings} reading${readings === 1 ? "" : "s"} in the series — a curve needs ${min}, so the figure stands alone.`;
  }
  return null;
}
