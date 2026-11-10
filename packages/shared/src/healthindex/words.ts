// healthindex/words: One wording of a move for the phone and VS Code. Barrel: ../healthindex.ts (read the header there).
import { HEALTH_ENTRIES, type HealthEntry, HEALTH_INDEX_MONTH_WEEKS, HEALTH_ALERT_WARN, type HealthIndexPoint } from "./types.js";
import { type HealthCapKind } from "./coverage.js";
import { type HealthMove } from "./move.js";
import { HEALTH_ENTRY_LABEL } from "./score.js";

const ENTRY_WORDS: Record<HealthEntry, [string, string]> = {
  size: ["files grew longer", "files got shorter"],
  retouch: ["more re-touched files", "fewer re-touched files"],
  hatches: ["more escape hatches", "fewer escape hatches"],
  context: ["CLAUDE.md + skill descriptions grew", "CLAUDE.md + skill descriptions shrank"],
  untested: ["more untested modules", "fewer untested modules"],
  dups: ["more duplicate code", "less duplicate code"],
  deadExports: ["more dead exports", "fewer dead exports"],
  cycles: ["more files in import cycles", "fewer files in import cycles"],
  cochange: ["changes touch more files at once", "changes touch fewer files at once"],
  fixAfterChange: ["more fixes after a change", "fewer fixes after a change"],
  // More is better here: the score FALLS when fewer commits change a test.
  testsWithCode: ["fewer commits changed a test", "more commits changed a test"],
};

/** A signed whole number with a real minus sign: `−4`, `+3`, `±0`. */
export function signedPoints(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "±0";
  return r < 0 ? `−${-r}` : `+${r}`;
}

export interface HealthWords {
  /** Short label for the repo row: `Health 94 −4`. */
  chip: string;
  /** `Health score 94 (−4 this week)`. */
  title: string;
  /** Names the (at most two) metrics — or the cap — that carried the move, plus a split-up note where a rise is mostly files multiplying; "" when none can be named. */
  body: string;
}

/**
 * When the latest measured week happened, worded against the week it is now:
 * `this week` only when they are the same ISO week — a week with no commit has
 * no point, so the newest one can be months old — else `in the week of <Monday>`.
 * `currentWeek` absent = the caller did not say, and the claim falls back to
 * naming the week (never a `this week` nobody checked).
 */
export function healthWeekWhen(week: string, currentWeek?: string | null): string {
  return currentWeek && week === currentWeek ? "this week" : `in the week of ${week}`;
}

/**
 * The notification and chip wording for a called move. `null` when there is
 * nothing to say (no move called, or no points) — a sentence is never written
 * around a null. `currentWeek` (the ISO week's Monday, `isoWeekOf(today)`)
 * decides whether the latest point may be called "this week".
 */
export function healthMoveWords(points: readonly HealthIndexPoint[], move: HealthMove, currentWeek?: string | null): HealthWords | null {
  const last = points[points.length - 1];
  if (!last || !move.kind || !move.horizon || move.delta === null) return null;
  const value = Math.round(last.index);
  const span = move.horizon === "week" ? 1 : HEALTH_INDEX_MONTH_WEEKS;
  const latest = currentWeek && last.week === currentWeek;
  const when = move.horizon === "week"
    ? healthWeekWhen(last.week, currentWeek)
    : latest ? "over four weeks" : `over the four weeks to ${last.week}`;
  // Each comparable week's move, split exactly. The entries' log contributions
  // sum to prev.mean·Δln(mean) (a geomean), so scaling them by (eˣ−1)/x makes
  // them sum to Δmean; what is left of Δindex is the cap tightening or easing.
  const sums: Partial<Record<HealthEntry, number>> = {};
  let capSum = 0;
  let capEntry: HealthEntry | null = null;
  let capFrom: HealthEntry | null = null;
  let capTo: HealthEntry | null = null;
  let capBiggest = 0;
  // The cap that moved the most, when it was a gate or coverage cap (P1 named only the worst entry).
  let capOther: string | null = null;
  for (let i = Math.max(1, points.length - span); i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    if (p.gap) continue;
    const x = Math.log(p.mean / prev.mean);
    const k = Math.abs(x) < 1e-12 ? 1 : Math.expm1(x) / x;
    for (const e of HEALTH_ENTRIES) {
      const c = p.contributions[e];
      if (c !== undefined) sums[e] = (sums[e] ?? 0) + c * k;
    }
    const cap = (p.index - prev.index) - (p.mean - prev.mean);
    capSum += cap;
    // An easing cap is the one the previous week had; a tightening one is this week's.
    const kind = capKindOf(cap > 0 ? prev : p);
    if (kind === "worst") {
      const by = cap > 0 ? prev.cappedBy : p.cappedBy;
      if (by && Math.abs(cap) > capBiggest) {
        capBiggest = Math.abs(cap);
        capEntry = by;
        capFrom = prev.cappedBy;
        capTo = p.cappedBy;
        capOther = null;
      }
    } else if (kind && Math.abs(cap) > capBiggest) {
      capBiggest = Math.abs(cap);
      capEntry = null;
      capOther = otherCapWords(kind, prev, p, cap > 0);
    }
  }
  const sign = move.kind === "drop" ? -1 : 1;
  const parts: { pts: number; words: string }[] = HEALTH_ENTRIES
    .filter((e) => (sums[e] ?? 0) * sign > 0)
    .map((e) => ({ pts: sums[e] ?? 0, words: ENTRY_WORDS[e][move.kind === "drop" ? 0 : 1] }));
  if (capEntry && capSum * sign > 0) {
    const label = HEALTH_ENTRY_LABEL[capEntry];
    const words = sign > 0
      ? capTo === capEntry ? `${label} holds the score down less` : `${label} no longer holds the score down`
      : capFrom === capEntry ? `${label} holds the score down more` : `${label} now holds the score down`;
    parts.push({ pts: capSum, words });
  } else if (capOther && capSum * sign > 0) {
    parts.push({ pts: capSum, words: capOther });
  }
  const top = parts
    .filter((x) => Math.round(x.pts) !== 0)
    .sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
    .slice(0, 2)
    .map((x) => `${x.words} (${signedPoints(x.pts)})`);
  const split = move.kind === "rise" ? splitNote(points, span, (sums.size ?? 0) + (capEntry === "size" ? capSum : 0), move.delta) : null;
  const verb = move.kind === "drop" ? "slipped" : "rose";
  const pts = Math.abs(Math.round(move.delta));
  const body = top.length
    ? `The score ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}: ${top.join(", ")}.`
    : `The score ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}.`;
  return {
    chip: `Health ${value} ${signedPoints(move.delta)}`,
    title: `Health score ${value} (${signedPoints(move.delta)} ${when})`,
    body: split ? `${body} ${split}` : body,
  };
}

/** Which cap set a point; an older point without `capKind` knew only the worst-entry cap. */
function capKindOf(p: HealthIndexPoint): HealthCapKind | null {
  if (p.capKind !== undefined) return p.capKind;
  return p.cappedBy ? "worst" : null;
}

const failingGates = (p: HealthIndexPoint): string[] =>
  (p.coverage?.gates ?? []).filter((g) => g.state === "fail").map((g) => `"${g.name}"`);
const names = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * The cause of a cap residual that is not the worst entry: a gate that flipped
 * or the share of dimensions measured. `easing` = the cap let go (the previous
 * week's cap), else it tightened (this week's).
 */
function otherCapWords(kind: Exclude<HealthCapKind, "worst">, prev: HealthIndexPoint, p: HealthIndexPoint, easing: boolean): string {
  if (kind === "gate") {
    if (easing) {
      const was = failingGates(prev);
      const still = failingGates(p);
      const passed = was.filter((g) => !still.includes(g));
      return passed.length
        ? `${passed.length === 1 ? "gate" : "gates"} ${names(passed)} ${passed.length === 1 ? "passes" : "pass"} again and no longer ${passed.length === 1 ? "holds" : "hold"} the score under ${HEALTH_ALERT_WARN}`
        : `a failing gate no longer holds the score under ${HEALTH_ALERT_WARN}`;
    }
    const now = failingGates(p);
    const was = failingGates(prev);
    const fresh = now.filter((g) => !was.includes(g));
    const named = fresh.length ? fresh : now;
    return named.length
      ? `${named.length === 1 ? "gate" : "gates"} ${names(named)} ${fresh.length ? (named.length === 1 ? "now fails" : "now fail") : (named.length === 1 ? "fails" : "fail")} and ${named.length === 1 ? "holds" : "hold"} the score under ${HEALTH_ALERT_WARN}`
      : `a failing gate holds the score under ${HEALTH_ALERT_WARN}`;
  }
  const c = (easing ? prev : p).coverage;
  const share = c ? ` (${c.measured} of ${c.applicable} measured)` : "";
  return easing
    ? `the share of dimensions measured no longer holds the score down${share}`
    : `too few dimensions measured hold the score down${share}`;
}

const commas = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A rise is "mostly files split up" when file length carried at least half of it and the tree gained this share of files. */
const HEALTH_SPLIT_FILES_RATIO = 1.5;

/**
 * The note for a rise carried by file length while the files multiplied and
 * the code did not shrink — the signature of splitting, which the score
 * rewards whether or not the design got better. Null where the tree was not
 * measured at either end, or the rise was not mostly file length.
 */
function splitNote(points: readonly HealthIndexPoint[], span: number, sizePts: number, delta: number): string | null {
  if (!(delta > 0) || sizePts < delta / 2) return null;
  const from = points[Math.max(0, points.length - span - 1)]?.tree;
  const to = points[points.length - 1]?.tree;
  if (!from || !to || from.files <= 0 || from.loc <= 0) return null;
  if (to.files < from.files * HEALTH_SPLIT_FILES_RATIO || to.loc < from.loc * 0.9) return null;
  return `Mostly files split up: ${commas(from.files)} → ${commas(to.files)} source files while the code went from ${commas(from.loc)} to ${commas(to.loc)} lines. The score cannot tell whether the design got better.`;
}

/** What `RepoTarget.healthIndex` carries. */
