/**
 * The health index on the phone: the launcher chip's words and the sheet
 * section's geometry and sentences, pure (`healthIndexWords.test.mjs`).
 *
 * `shared/healthindex.ts` is the one layer that takes a side (lower readings
 * raise the index) and owns the arithmetic and the called move. Nothing here
 * computes an index, a move or a percentile: it rounds what the wire carries,
 * turns it into pixels, and words it. Absent stays absent — `healthIndex`
 * missing from a RepoTarget draws NO chip, never `Health 0`.
 */
import type { HealthEntry, HealthIndexPoint, RepoHealthIndex } from "@waterplane/shared";

/** The five baskets in the order the index names them, with the plain names the phone shows. */
export const HEALTH_ENTRY_ORDER: readonly HealthEntry[] = ["size", "retouch", "hatches", "context", "untested"];
export const HEALTH_ENTRY_NAME: Record<HealthEntry, string> = {
  size: "File length",
  retouch: "Re-touched files",
  hatches: "Escape hatches",
  context: "CLAUDE.md + skills",
  untested: "Untested modules",
};

/**
 * Which plotted series each basket is drawn as — the engine's `ENTRY_OF_SERIES`
 * (`tools/repohealth/plot.mjs`), the tiles a repo's disable or override is
 * written on. `context` is two series and the index reads their sum.
 */
export const HEALTH_ENTRY_OF_SERIES: Readonly<Record<string, HealthEntry>> = {
  "size.p95": "size",
  "retouch.rate": "retouch",
  "hatches.perKloc": "hatches",
  "context.claudeMdChars": "context",
  "context.descChars": "context",
  "untested.count": "untested",
};

/**
 * What each basket COUNTS, what kind of number it is, and what it cannot see —
 * one clause each, for the agent the index prompts hand a repo to. Without it
 * an agent rediscovers by digging that `hatches` is a density (the count can
 * rise while it falls) and that `context` never sees a skill's body. Every
 * claim is the engine's (`tools/repohealth/metrics/*.mjs`) and the index's
 * (`shared/healthindex.ts`'s `healthEntryValues`); change them together.
 */
export const HEALTH_ENTRY_MEASURE: Record<HealthEntry, string> = {
  size: "a level: the 95th-percentile length in lines of the source files (tests excluded) — files held just under a length cap pin it at the cap, and one huge file barely moves it",
  retouch: "a rate over the last 14 days: the share of source-file edits that REWORK the previous edit of that file — change or remove lines it added, under 48 hours (or 2 commits) after it; an edit that only adds lines near the last one (an append to a registry) is reported apart and never counted — it reads the latest fortnight's work, not the tree",
  hatches: "a density: UNEXPLAINED escape hatches per 1,000 source lines — casts, lint and type-check disables that carry no reason on the line or in a comment directly above; the explained ones and TODO/FIXME marks are reported apart and never counted, and the count can rise while the density falls if the code grows faster",
  context: "an absolute size: the characters always loaded — CLAUDE.md plus every skill's description; skill bodies, loaded on demand, are not counted",
  untested: "a share: source modules no test imports (directly or through another module) or names by path, over all source files — imported is not covered, it says nothing about which branches ran",
};

/** A signed whole number with a real minus sign (`shared/healthindex.ts`'s `signedPoints`, restated so this file carries no value import). */
export function signedWhole(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "±0";
  return r < 0 ? `−${-r}` : `+${r}`;
}

export interface HealthChipView {
  /** `Health 97`. */
  label: string;
  /** The whole-number size of this week's change, no sign (the arrow carries it); null = no change to state. */
  delta: string | null;
  /** Which arrow glyph; null where there is no delta to state. */
  arrow: "up" | "down" | "flat" | null;
  /** `warn` = a called drop, `calm` = a called rise, null = neither. */
  tone: "warn" | "calm" | null;
  /** Long-press words. */
  title: string;
}

/**
 * When a measured week was, against the week it is now: `this week` only when
 * `week` IS the current ISO week (`currentWeek`, the caller's `isoWeekOf(today)`)
 * — a week with no commits has no point, so the latest one can be months old.
 * Absent `currentWeek` names the week: never a `this week` nobody checked.
 * `shared/healthindex.ts`'s `healthWeekWhen`, restated (no value imports here).
 */
export function weekWhenWords(week: string, currentWeek?: string | null): string {
  return currentWeek && week === currentWeek ? "this week" : `in the week of ${week}`;
}

/** The launcher chip, or null where the host sent no index. */
export function healthChip(hi: RepoHealthIndex | null | undefined, repoName: string, currentWeek?: string | null): HealthChipView | null {
  if (!hi || typeof hi.value !== "number" || !Number.isFinite(hi.value)) return null;
  const value = Math.round(hi.value);
  const d = hi.deltaWeek;
  const hasDelta = typeof d === "number" && Number.isFinite(d);
  const r = hasDelta ? Math.round(d) : 0;
  const arrow = !hasDelta ? null : r === 0 ? "flat" : r < 0 ? "down" : "up";
  const tone = hi.move === "drop" ? "warn" : hi.move === "rise" ? "calm" : null;
  const when = weekWhenWords(hi.week, currentWeek);
  const called = hi.move === "drop"
    ? " The latest week's move is unusual for this repo's own past: it slipped."
    : hi.move === "rise" ? " The latest week's move is unusual for this repo's own past: it rose." : "";
  return {
    label: `Health ${value}`,
    delta: hasDelta && r !== 0 ? String(Math.abs(r)) : hasDelta ? "0" : null,
    arrow,
    tone,
    title:
      `${repoName}: health index ${value}${hasDelta ? ` (${signedWhole(d)} ${when})` : ""}` +
      `${when === "this week" || !hasDelta ? `, week of ${hi.week}` : ""}. ` +
      `One number chained week over week from five readings of the repo; 100 is its first complete week, ` +
      `and it climbs when those readings shrink.${called} Tap to open the readings.`,
  };
}

/** What the repo did to the basket on a week: the entries it disabled, and the ones it overrode. */
export interface IndexBasket {
  disabled?: readonly HealthEntry[];
  overridden?: readonly HealthEntry[];
}

/** `A`, `A and B`, `A, B and C`. */
function listWords(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/**
 * Which readings the index is built from, when the repo changed the basket —
 * "built from 4 of waterplane's 5 readings; Untested modules is disabled here"
 * — or null when it is the engine's five as they are. One sentence for the
 * section caption and the prompts' head, so the two cannot count differently.
 */
export function indexBasketWords(basket: IndexBasket | null | undefined, product: string): string | null {
  const dis = HEALTH_ENTRY_ORDER.filter((e) => basket?.disabled?.includes(e));
  const ov = HEALTH_ENTRY_ORDER.filter((e) => basket?.overridden?.includes(e) && !dis.includes(e));
  if (!dis.length && !ov.length) return null;
  const n = HEALTH_ENTRY_ORDER.length - dis.length;
  const parts = [`Built from ${n} of ${product}'s ${HEALTH_ENTRY_ORDER.length} readings`];
  if (dis.length) parts.push(`${listWords(dis.map((e) => HEALTH_ENTRY_NAME[e]))} ${dis.length === 1 ? "is" : "are"} disabled here`);
  if (ov.length) parts.push(`${listWords(ov.map((e) => HEALTH_ENTRY_NAME[e]))} ${ov.length === 1 ? "reads" : "read"} this repo's own version`);
  return `${parts.join("; ")}.`;
}

/** The sentence under the section, naming the baseline week — and whose five
 *  readings it is built from (`product` is `BRAND.displayName`, passed in so
 *  this module stays free of value imports). With the repo's disables or
 *  overrides on the latest week, it says which readings it is built from, and
 *  drops the claim that it compares across repos as it stands. */
export function indexExplainWords(baselineWeek: string, product: string, basket?: IndexBasket | null): string {
  const changed = indexBasketWords(basket, product);
  if (!changed) {
    return `100 = baseline week ${baselineWeek}. Each week the index moves by the average change of ${product}'s five readings — never a repo's own, so it compares across repos: when they shrink it climbs, when they grow it drops.`;
  }
  return `100 = baseline week ${baselineWeek}. ${changed} Each week the index moves by the average change of the readings it is built from: when they shrink it climbs, when they grow it drops. Beside another repo's index it compares like with like only on the readings both read the same way.`;
}

/** What a week drawn off the line means. */
export function gapWords(count: number): string {
  return count === 1
    ? "One week is drawn apart from the line: the index was carried over it, not measured — put the line on it to read why."
    : `${count} weeks are drawn apart from the line: the index was carried over each, not measured — put the line on one to read why.`;
}

/** Why a week was carried, as the readout says it. */
export function carriedWords(gapReason: "prereg" | "central" | "nothing" | null | undefined): string {
  if (gapReason === "central") return "carried: this repo changed which readings it overrides or disables";
  if (gapReason === "prereg") return "carried: the engine's definitions changed, so the weeks either side are not comparable";
  return "carried: nothing comparable with the week before";
}

/** A link over weeks nobody measured (no commits): null for an ordinary week. */
export function linkSpanWords(spanDays: number | null | undefined): string | null {
  if (typeof spanDays !== "number" || !(spanDays > 7)) return null;
  return `one link over ${Math.round(spanDays / 7)} weeks with no measured week between`;
}

/** The latest week's move beside the big number, naming the week when it is not this one. */
export function weekChangeWords(delta: number | null, week?: string | null, currentWeek?: string | null): string {
  const when = week ? weekWhenWords(week, currentWeek) : "this week";
  if (delta === null || !Number.isFinite(delta)) return `no change to state ${when}`;
  return `${signedWhole(delta)} ${when}`;
}

/** `+12 since baseline`. */
export function sinceBaselineWords(index: number, base = 100): string {
  return `${signedWhole(index - base)} since baseline`;
}

/** `+18 vs week of 2026-06-22` — the week actually compared with, named; null = say nothing. */
export function indexVsWords(vs: { delta: number; then: { week: string } } | null | undefined): string | null {
  if (!vs || !Number.isFinite(vs.delta)) return null;
  return `${signedWhole(vs.delta)} vs week of ${vs.then.week}`;
}

const nfWhole = (n: number): string => Math.round(n).toLocaleString("en-US");

/** The tree's growth since the baseline week, so a move can be weighed against it; null without both readings. */
export function treeGrowthWords(
  base: { files: number; loc: number } | null | undefined,
  now: { files: number; loc: number } | null | undefined,
  baselineWeek: string,
): string | null {
  if (!base || !now || !(base.files > 0) || !(base.loc > 0)) return null;
  const pct = (a: number, b: number) => {
    const r = Math.round(((b - a) / a) * 100);
    return r === 0 ? "±0%" : r > 0 ? `+${r}%` : `−${-r}%`;
  };
  return `The tree: ${nfWhole(now.files)} source files and ${nfWhole(now.loc)} lines, against ${nfWhole(base.files)} and ${nfWhole(base.loc)} in the baseline week ${baselineWeek} (${pct(base.files, now.files)} files, ${pct(base.loc, now.loc)} lines).`;
}

/* ── the line ────────────────────────────────────────────────────────────── */

export interface IndexLineGeom {
  /** SVG path data, one `M…L…` per unbroken run. */
  d: string;
  /** Links spanning more than one week (`spanDays > 7`: weeks with no row
   *  between), one `M…L…` each — drawn dashed, never as a measured week. */
  dashed: string;
  /** Runs of a single point (a gap week with no neighbour), drawn as dots. */
  dots: { x: number; y: number }[];
  /** Every point's pixel position, for the crosshair. */
  pts: { i: number; x: number; y: number }[];
  endX: number;
  endY: number;
  /** y of the 100 line. */
  baseY: number;
  lo: number;
  hi: number;
  gaps: number;
}

/**
 * x = the week's position in the series (weeks with a row, not the calendar),
 * y fitted to the data AND the 100 baseline so the baseline is always on the
 * chart. A `gap` week starts a new run: the index was carried, not measured,
 * so no line joins it to the week before.
 */
export function indexLineGeom(
  points: readonly (Pick<HealthIndexPoint, "index" | "gap"> & { spanDays?: number | null })[],
  w: number,
  h: number,
): IndexLineGeom | null {
  const n = points.length;
  if (n < 1 || !(w > 0) || !(h > 0)) return null;
  let lo = 100;
  let hi = 100;
  for (const p of points) {
    if (!Number.isFinite(p.index)) return null;
    if (p.index < lo) lo = p.index;
    if (p.index > hi) hi = p.index;
  }
  const pad = hi === lo ? 1 : (hi - lo) * 0.08;
  const top = hi + pad;
  const bot = lo - pad;
  const px = (i: number) => (n === 1 ? w : (i / (n - 1)) * w);
  const py = (v: number) => (h - 0.5) - ((v - bot) / (top - bot)) * (h - 1);
  const runs: string[] = [];
  const dashed: string[] = [];
  const dots: { x: number; y: number }[] = [];
  const pts: { i: number; x: number; y: number }[] = points.map((p, i) => ({ i, x: px(i), y: py(p.index) }));
  // How point i is joined to i-1: not at all (a carried week, or the first),
  // dashed (a link over weeks with no row), or solid.
  const dashIn = points.map((p, i) => i > 0 && !p.gap && typeof p.spanDays === "number" && p.spanDays > 7);
  const solidIn = points.map((p, i) => i > 0 && !p.gap && !dashIn[i]);
  let gaps = 0;
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) runs.push(`M${run.map((k) => `${pts[k].x.toFixed(1)},${pts[k].y.toFixed(1)}`).join("L")}`);
    else if (run.length === 1) {
      // A lone point is a dot only when no dash reaches it either: on a dashed
      // link it is already on the line.
      const k = run[0];
      if (!dashIn[k] && !dashIn[k + 1]) dots.push({ x: pts[k].x, y: pts[k].y });
    }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    if (points[i].gap) gaps++;
    if (!solidIn[i]) flush();
    if (dashIn[i]) dashed.push(`M${pts[i - 1].x.toFixed(1)},${pts[i - 1].y.toFixed(1)}L${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`);
    run.push(i);
  }
  flush();
  const last = pts[pts.length - 1];
  return { d: runs.join(""), dashed: dashed.join(""), dots, pts, endX: last.x, endY: last.y, baseY: py(100), lo, hi, gaps };
}

/* ── the bars ────────────────────────────────────────────────────────────── */

export interface ContribBar {
  key: HealthEntry;
  name: string;
  /** Log points; positive = the index rose because of this reading. */
  value: number;
  /** Left edge and width in px; the bar grows from `zeroX`. */
  x: number;
  w: number;
  side: "up" | "down" | "none";
  words: string;
}

/**
 * Diverging bars on ONE scale (the largest magnitude takes the half-width), in
 * the index's fixed order. An entry with no contribution this week is absent,
 * not a zero bar.
 */
export function contributionBars(
  contributions: Partial<Record<HealthEntry, number>>,
  width: number,
): { zeroX: number; bars: ContribBar[] } {
  const zeroX = width / 2;
  const present = HEALTH_ENTRY_ORDER.filter((k) => typeof contributions[k] === "number" && Number.isFinite(contributions[k]));
  let max = 0;
  for (const k of present) max = Math.max(max, Math.abs(contributions[k] as number));
  const half = Math.max(0, width / 2 - 1);
  const bars = present.map((key): ContribBar => {
    const value = contributions[key] as number;
    const len = max > 0 ? (Math.abs(value) / max) * half : 0;
    const side = Math.round(value * 10) === 0 ? "none" : value > 0 ? "up" : "down";
    return {
      key, name: HEALTH_ENTRY_NAME[key], value,
      x: value >= 0 ? zeroX : zeroX - len, w: len, side,
      words: `${HEALTH_ENTRY_NAME[key]} ${signedTenths(value)}`,
    };
  });
  return { zeroX, bars };
}

/** One decimal, real minus sign: `+1.4`, `−0.6`, `±0.0` (a bar of a point or two reads as 0 in whole numbers). */
export function signedTenths(n: number): string {
  const r = Math.round(n * 10) / 10;
  if (r === 0) return "±0.0";
  return r < 0 ? `−${(-r).toFixed(1)}` : `+${r.toFixed(1)}`;
}

export function barsCaptionWords(week: string): string {
  return `What moved the index in the week of ${week}, in index points. A bar to the right pushed the index up (that reading shrank); a bar to the left pulled it down (that reading grew).`;
}

/** The ask under the bars: names the week it sends, because the line can be on
 *  any one of them — and `this week` only when that week IS the current one. */
export function indexAskLabel(week: string, thisWeek: boolean): string {
  return thisWeek ? "ask what moved it this week" : `ask what moved it in the week of ${week}`;
}

/** The second ask: the whole line, not one week. */
export const INDEX_TREND_ASK_LABEL = "ask if it is getting healthier";
