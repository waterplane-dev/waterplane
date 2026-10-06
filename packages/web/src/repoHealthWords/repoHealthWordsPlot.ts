// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).
import { nf } from "./repoHealthWordsFmt.ts";
import { seriesValueWords } from "./repoHealthWordsRank.ts";

/** Month names for a tick label. Not `toLocaleDateString`: that gives a
 *  different string per device locale, and these three labels have to fit a
 *  measured box on a phone — a locale that spells out "September" overlaps its
 *  neighbour, silently, only on that phone. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * One x tick, from the day the tool measured.
 *
 * `2026-06-18` → `18 Jun`. No year, because the caption under the tiles names
 * both endpoints in full and a year on every tick is three characters spent
 * saying the same thing three times in a 40-px space. A day this cannot parse
 * comes back VERBATIM rather than as a blank or an invented date — the tool's
 * string is at least true.
 */
export function axisDayWords(day: string | null | undefined): string {
  if (!day) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return day;
  return `${Number(m[3])} ${MONTHS[mi]}`;
}

/**
 * What the crosshair says: which day, what it read, and the tree it read.
 *
 * The sha is in here because it is the whole difference between a chart and a
 * claim — every point on these curves is one commit, and a reading a person
 * can check out is a reading they can argue with. It is the same promise
 * `RepoHealthPoint.sha7`'s comment makes on the wire.
 *
 * A point whose value is null never reaches this function (the crosshair snaps
 * to readings, not to holes), but it is handled anyway and says so in words,
 * because the alternative on the day that invariant breaks is a `—` nobody can
 * distinguish from a rendering bug.
 */
export function pointReadoutWords(
  p: { day: string; sha7?: string; v: number | null } | null | undefined,
  unit = "",
): string | null {
  if (!p) return null;
  const val = p.v == null || !Number.isFinite(p.v) ? "no reading that day" : seriesValueWords(p.v, unit);
  return `${p.day} · ${val}${p.sha7 ? ` · ${p.sha7}` : ""}`;
}

/**
 * The stack's crosshair: the total FIRST, then what it is made of.
 *
 * That order is the chart's own claim — the top edge is the total and the
 * bands under it are its split — and a readout that listed the parts first
 * would be a second, different reading of the same mark. A part with no value
 * cannot happen here (a column missing any band is a hole in all of them, so
 * the crosshair never lands on one), and is printed as an absence rather than
 * skipped if it ever does: a sum with a silently missing term is the one
 * failure a stacked chart can have.
 */
export function stackReadoutWords(
  p: { day: string; sha7?: string } | null | undefined,
  parts: readonly { label: string; v: number | null }[],
  total: number | null,
  unit = "",
): string | null {
  if (!p) return null;
  const split = parts
    .map((b) => `${b.label} ${b.v == null || !Number.isFinite(b.v) ? "not read" : nf(b.v)}`)
    .join(", ");
  const head = total == null || !Number.isFinite(total) ? "no total that day" : `${seriesValueWords(total, unit)} in all`;
  return `${p.day} · ${head}${split ? ` — ${split}` : ""}${p.sha7 ? ` · ${p.sha7}` : ""}`;
}

/** The line where the crosshair's answer goes, before anything is touched.
 *  Present always, so dragging does not shuffle everything under it up and
 *  down, and worded as an invitation because on a phone there is no hover to
 *  discover it by accident. */
export function scrubHintWords(): string {
  return "drag across the curve for a day's reading";
}

/**
 * The x axis, said out loud, once, under the tiles.
 *
 * Not decoration: the axis is the reading INDEX and a reader will assume a
 * calendar unless told. This history has a 57-day hole in it, so the two read
 * completely differently — evenly spaced readings against two thirds of an
 * empty box — and the caption is the only thing that says which one is on
 * screen.
 */
export function plotAxisWords(days: number, from: string | null | undefined, to: string | null | undefined): string {
  const span = from && to ? `, ${from} to ${to}` : "";
  return (
    `Each tile plots ${nf(days)} day-reading${days === 1 ? "" : "s"}${span}, spaced by POSITION in the ` +
    "series and not by date — the history has gaps of weeks and a calendar axis would leave most of " +
    "every tile empty. The dates under a tile are the days AT those positions, so the middle label " +
    "is the middle reading and not the middle of the span. A day with no reading cuts the line " +
    "rather than joining across it. The figures up the left are that tile's own low and high, and " +
    "NO TILE STARTS AT ZERO: each is fitted to its own range, so heights are not comparable between " +
    "them and a curve filling its box is not a curve that grew from nothing. The stacked chart " +
    "further down is the exception and says so with a zero of its own. Drag across a curve to read " +
    "one day; touch it again to let go."
  );
}

/** What the window a rank is taken in actually is — the basis every percentile
 *  on this screen is a position within, named once under the tiles rather than
 *  repeated on each. Both numbers come off the wire. */
export function rankBasisWords(windowReadings: number, minReadings: number): string {
  return (
    `A rank is a position among the last ${nf(windowReadings)} readings of that series, and is withheld ` +
    `below ${nf(minReadings)} — the tool's own window, carried on the wire so nothing here writes it down.`
  );
}

/** The slope, as a word. The glyph beside it carries no colour: rising lines
 *  and rising hatches are opposite news, and a hue would decide which. */
export function slopeWords(slope: "rising" | "falling" | "flat" | null | undefined): string | null {
  return slope ?? null;
}

/**
 * The context-weight row's two figures, each named by its CLOCK.
 *
 * This is the one subject the two regions both measure, and they measure it at
 * different instants: the checklist reads the working tree as it is now, the
 * series reads the last commit that was measured. They are not reconciled and
 * must not be — an uncommitted CLAUDE.md edit showing up as a difference
 * between these two numbers is exactly what a reader wants to see, and
 * averaging them, preferring one, or hiding the gap would delete the only
 * signal that the tree has moved since the last reading.
 */
export function bothClocksWords(
  workingTree: number | null | undefined,
  measured: number | null | undefined,
  sha7: string | null | undefined,
): string | null {
  const now = workingTree != null && Number.isFinite(workingTree) ? seriesValueWords(workingTree) : null;
  const then = measured != null && Number.isFinite(measured) ? seriesValueWords(measured) : null;
  const at = `at ${sha7 ?? "the last reading"}`;
  if (now == null && then == null) return null;
  // The working-tree figure is not on the wire as a NUMBER today: the checklist
  // states it inside the row's own sentence, and prising a figure back out of
  // prose is a parser nobody would notice breaking. So the clause names where
  // that figure is rather than repeating it, and the day the report carries the
  // count, passing it here prints both side by side with no other change.
  if (now == null) {
    return `${then} ${at} — the sentence above is the same number in the working tree as it is now. Two clocks, left as they are.`;
  }
  if (then == null) return `${now} in the working tree — the series has no reading of it to sit beside.`;
  return `${now} in the working tree · ${then} ${at} — two clocks on one number, left as they are.`;
}
