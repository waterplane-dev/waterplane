/**
 * `setupPatternOf` + `setupPatternText` — the Agent readings headline's ONE pattern sentence
 * (R-metrics-070): the newest change marker that has a before/after on at least two readings
 * (`compareAround`, same band, same minimums), worded in neutral words.
 *
 *  - nothing outside its band ⇒ "no detectable change";
 *  - one reading outside ⇒ that reading, then the compared rest "within normal variation";
 *  - two or more ⇒ each with its direction, and where the directions match a known shape, the
 *    pattern it is ("the pattern of a trim that removed something agents used").
 *
 * Never "better" or "worse": fewer looks after a trim can mean the agents needed less or found
 * less, and the sentence says what moved, not which way is good. A pattern is a reading a person
 * acts on; nothing here applies anything.
 *
 * One model at a time: the window's most common model is compared (as the token-stats card does),
 * so a model change marker itself has no "before" and is skipped to the next older marker.
 */
import { addLocalDays } from "../calday.js";
import { compareAround } from "./compare.js";
import { seriesReadingOf } from "./series.js";
import { localDayOf } from "./stats.js";
import type { AgentMarker, CompareResult, SeriesAbsent, SeriesPoint, SeriesReading } from "./types.js";

/** The readings the pattern is read over, in sentence order. */
export const PATTERN_READINGS: readonly SeriesReading[] = ["start", "look", "req", "skills"];
/** Newest markers tried before the sentence is absent. */
export const PATTERN_MAX_MARKERS = 24;
/**
 * The smallest move worth naming: a ratio within 2% of 1 is read as within, however narrow its
 * day-shuffle band is. Start-context tokens barely vary session to session, so that band can be a
 * fraction of a percent wide, and a 0.5% shift would otherwise be "down 0%" and name a pattern.
 */
export const PATTERN_MIN_MOVE = 0.02;

// closed: SeriesReading is a parameter here, never read off the wire
const WORDS: Record<SeriesReading, string> = {
  start: "start context",
  look: "looks before the first edit",
  req: "requests",
  skills: "skill loads",
  subStart: "subagent start context",
};

export interface SetupPatternMove { reading: SeriesReading; dir: "up" | "down"; ratio: number }

export interface SetupPattern {
  marker: AgentMarker;
  /** The one model compared. */
  model?: string;
  /** Readings outside their band, in `PATTERN_READINGS` order. */
  moved: SetupPatternMove[];
  /** Readings inside their band. */
  within: SeriesReading[];
  /** Readings that could not be compared, with the sentence why. */
  uncompared: { reading: SeriesReading; why: string }[];
  /** The named shape when the directions match one; absent when none fits. */
  name?: string;
  /** Other changes inside the same window, which the before/after cannot tell apart from this one. */
  others: number;
  /** Days each side. */
  days: number;
}

/** The most common model among the window's fresh sessions (ties by id), or undefined. */
function windowModel(points: readonly SeriesPoint[], t: number, days: number, repo?: string): string | undefined {
  const lo = addLocalDays(t, -days);
  const hi = addLocalDays(t, days);
  const n = new Map<string, number>();
  for (const p of points) {
    if (!p || p.t0 < lo || p.t0 >= hi || p.fresh !== true || p.sub === true || !p.model) continue;
    if (repo !== undefined && p.repo !== repo) continue;
    if (seriesReadingOf(p, "start") === undefined && seriesReadingOf(p, "req") === undefined) continue;
    n.set(p.model, (n.get(p.model) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/** The named shape of a set of moves, or undefined when none fits. */
export function patternName(moved: readonly SetupPatternMove[]): string | undefined {
  const d = (r: SeriesReading) => moved.find((m) => m.reading === r)?.dir;
  const start = d("start");
  const work = [d("look"), d("req")];
  if (start === "down" && work.includes("up")) return "the pattern of a trim that removed something agents used";
  if (start === "down" && d("skills") === "up" && !work.includes("up")) return "the pattern of a trim whose detail agents now load as skills";
  if (start === "up" && work.includes("down") && !work.includes("up")) return "the pattern of an addition agents use in place of looking";
  if (start === undefined && work[0] !== undefined && work[0] === work[1]) return "the pattern of a change in the work itself rather than in what sessions start with";
  return undefined;
}

export function setupPatternOf(points: readonly SeriesPoint[], markers: readonly AgentMarker[], opts: { days?: number; repo?: string } = {}): SetupPattern | SeriesAbsent {
  const days = opts.days ?? 14;
  const newest = [...markers].filter((m) => m && Number.isFinite(m.t)).sort((a, b) => b.t - a.t).slice(0, PATTERN_MAX_MARKERS);
  if (newest.length === 0) return { absent: "No change is known on this repo yet, so there is no before and after to read." };
  for (const marker of newest) {
    const model = windowModel(points, marker.t, days, opts.repo);
    const moved: SetupPatternMove[] = [];
    const within: SeriesReading[] = [];
    const uncompared: { reading: SeriesReading; why: string }[] = [];
    for (const reading of PATTERN_READINGS) {
      const c: CompareResult | SeriesAbsent = compareAround(points, marker.t, {
        reading, days, ...(model !== undefined ? { model } : {}), ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
      });
      if ("absent" in c) uncompared.push({ reading, why: c.absent });
      else if (c.inside || Math.abs(c.ratio - 1) < PATTERN_MIN_MOVE) within.push(reading);
      else moved.push({ reading, dir: c.ratio > 1 ? "up" : "down", ratio: c.ratio });
    }
    if (moved.length + within.length < 2) continue;
    const name = moved.length >= 2 ? patternName(moved) : undefined;
    const lo = addLocalDays(marker.t, -days);
    const hi = addLocalDays(marker.t, days);
    const others = markers.filter((m) => m !== marker && m && m.t >= lo && m.t < hi).length;
    return { marker, ...(model !== undefined ? { model } : {}), moved, within, uncompared, ...(name ? { name } : {}), others, days };
  }
  return { absent: `None of the ${newest.length} newest changes has enough sessions on one model on both sides to compare two readings.` };
}

const pct = (ratio: number): string => `${Math.round(Math.abs(ratio - 1) * 100)}%`;
const moveWords = (m: SetupPatternMove): string => `${WORDS[m.reading]} ${m.dir} ${pct(m.ratio)}`;

/** The one sentence. Neutral: says what moved and how far, never which way is good. */
export function setupPatternText(p: SetupPattern): string {
  return `${patternBody(p)}${p.others > 0 ? ` ${p.others === 1 ? "One other change falls" : `${p.others} other changes fall`} in the same ${2 * p.days} days, and a before/after cannot tell them apart.` : ""}`;
}

function patternBody(p: SetupPattern): string {
  const where = `Around ${p.marker.label} (${localDayOf(p.marker.t)}${p.model ? `, ${p.model} sessions` : ""})`;
  if (p.moved.length === 0) return `${where}: no detectable change — ${p.within.map((r) => WORDS[r]).join(", ")} within normal variation.`;
  if (p.moved.length === 1) return `${where}: ${moveWords(p.moved[0]!)}, ${p.within.map((r) => WORDS[r]).join(", ")} within normal variation.`;
  const list = p.moved.map(moveWords).join(", ");
  return p.name ? `${where}: ${list} — ${p.name}.` : `${where}: ${list}; no pattern this panel knows fits.`;
}
