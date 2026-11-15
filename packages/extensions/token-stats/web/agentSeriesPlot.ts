/**
 * "Agent readings over time" — geometry and sentences, pure (node-tested in `agentSeriesPlot.test.mjs`).
 *
 * The TOOL states (shared `agentseries/`: medians, the before/after and its day-shuffle band), this
 * file lays out pixels and words. Three rules live here:
 *  - A truncated series is never drawn as complete: when the host cut the oldest points (`cut` > 0),
 *    the axis starts at the first day every kind of log is complete (`coverFrom`) and says so.
 *  - A marker is a SHAPE and a WORD (its own row, labelled), never a colour alone, and the
 *    sentence for a before/after names no side: "outside normal week-to-week variation" /
 *    "within normal variation" / the reason there is none.
 *  - A reading with too few sessions is absent with its sentence, never a zero (`seriesTooFewText`).
 */
import {
  addLocalDays, AGENT_POINTS_CAP, localDaysBetween, AGENT_SUB_POINTS_CAP, fmtCount, fmtShare, seriesBucketKey, seriesReadingOf,
  START_GROUPS, startGroupOf,
  byModelCliText, COMPARE_MIN_DAYS, COMPARE_MIN_N, normalizeModel,
  type AgentMarker, type AgentMarkerKind, type AgentPoint, type ByModelAbsent, type ByModelResult, type CompareResult, type SeriesAbsent,
  type SeriesBucket, type SeriesLoadsValue, type SeriesReading, type SeriesValue,
} from "@waterplane/shared";

export type Grain = "day" | "week";

// ── The four readings ───────────────────────────────────────────────────────

export interface ReadingDef {
  id: SeriesReading;
  label: string;
  /** The unit after a number: "tokens" are formatted `fmtCount`, calls and requests plain. */
  unit: "tokens" | "calls" | "requests" | "loads";
  /** The sessions it is over, in words, under the chart. */
  over: string;
}

/** Display order: the two lead readings first. */
export const READINGS: readonly ReadingDef[] = [
  { id: "start", label: "Start context", unit: "tokens", over: "fresh interactive sessions, measured on the first request" },
  { id: "look", label: "Looks before first edit", unit: "calls", over: "fresh sessions that reached a file edit" },
  { id: "req", label: "Requests per committing session", unit: "requests", over: "fresh sessions that committed" },
  { id: "skills", label: "Skill loads per session", unit: "loads", over: "fresh sessions whose log counts skill calls" },
  { id: "subStart", label: "Subagent start", unit: "tokens", over: "subagent logs, measured on their first request" },
];

export const readingDef = (id: SeriesReading): ReadingDef => READINGS.find((r) => r.id === id) ?? READINGS[0]!;

export function fmtReading(def: ReadingDef, v: number): string {
  if (def.unit === "tokens") return `${fmtCount(v)} tokens`;
  // A mean of loads is mostly under one: 0.04 is not "0".
  if (def.unit === "loads" && v < 1) return `${v.toFixed(2)} ${def.unit}`;
  const s = v >= 10 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString();
  return `${s} ${def.unit}`;
}

// ── Models ──────────────────────────────────────────────────────────────────

export interface ModelCount { model: string; n: number }

/** The model ids in the sessions a reading is over (`seriesReadingOf`, the same answer the chart uses), most sessions first; `unnamed` counts those that record none. */
export function modelsIn(points: readonly AgentPoint[], reading: SeriesReading): { models: ModelCount[]; unnamed: number } {
  const c = new Map<string, number>();
  let unnamed = 0;
  for (const p of points) {
    if (seriesReadingOf(p, reading) === undefined) continue; // the sessions the reading is over, not every point of the kind
    if (!p.model) { unnamed++; continue; }
    c.set(p.model, (c.get(p.model) ?? 0) + 1);
  }
  const models = [...c].map(([model, n]) => ({ model, n })).sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));
  return { models, unnamed };
}

// ── Coverage: a cut series says where it starts ─────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, "0");
export const dayKeyOfMs = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const noonOf = (key: string): number => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12).getTime();
};

export interface Cover {
  /** First bucket key the axis may start at (inclusive), or null for the whole history. */
  from: string | null;
  /** Points the host left off, 0 when none. */
  hidden: number;
  /** The sentence for the caption, or null when nothing is cut. */
  words: string | null;
}

/**
 * Where a cut series may start. The host drops the OLDEST points of each kind past its cap, so a
 * kind that hit its cap is complete only from the day after its oldest kept point; the axis starts
 * at the latest of those. A kind under its cap lost nothing.
 */
export function coverFrom(points: readonly AgentPoint[], cut: number): Cover {
  if (!(cut > 0)) return { from: null, hidden: 0, words: null };
  let oldestConv = Infinity;
  let oldestSub = Infinity;
  let nConv = 0;
  let nSub = 0;
  for (const p of points) {
    if (p.sub) { nSub++; oldestSub = Math.min(oldestSub, p.t0); } else { nConv++; oldestConv = Math.min(oldestConv, p.t0); }
  }
  const convCut = nConv >= AGENT_POINTS_CAP;
  const subCut = nSub >= AGENT_SUB_POINTS_CAP;
  const both = !convCut && !subCut; // a cut we cannot place: trust neither kind
  const edges = [
    ...(convCut || both ? [oldestConv] : []),
    ...(subCut || both ? [oldestSub] : []),
  ].filter(Number.isFinite);
  if (edges.length === 0) return { from: null, hidden: cut, words: `${cut.toLocaleString("en-US")} older sessions are not included.` };
  const from = dayKeyOfMs(addLocalDays(Math.max(...edges), 1));
  return {
    from, hidden: cut,
    words: `${cut.toLocaleString("en-US")} older sessions are not included, so the axis starts on ${from}, the first day every kind of log is complete. Pick one repo for its full history.`,
  };
}

/** Buckets from the cover's first key on; a week that began before it is partial and dropped. */
export function clipBuckets<T extends { key: string }>(buckets: readonly T[], from: string | null): T[] {
  return from === null ? [...buckets] : buckets.filter((b) => b.key >= from);
}

// ── The axis ────────────────────────────────────────────────────────────────

export interface Axis { keys: string[]; grain: Grain; index: Map<string, number> }

/** Every bucket key from the first to the last, calendar-continuous: a quiet day is a gap, not a missing column. */
export function axisOf(keys: readonly string[], grain: Grain): Axis {
  const sorted = [...keys].sort();
  const out: string[] = [];
  if (sorted.length > 0) {
    const last = sorted[sorted.length - 1]!;
    let t = noonOf(sorted[0]!);
    for (let guard = 0; guard < 4000; guard++) {
      const k = dayKeyOfMs(t);
      if (k > last) break;
      out.push(k);
      t = addLocalDays(t, grain === "day" ? 1 : 7);
    }
  }
  return { keys: out, grain, index: new Map(out.map((k, i) => [k, i])) };
}

/** Centre x of slot `i` of `n` between `left` and `right`. */
export const slotX = (i: number, n: number, left: number, right: number): number =>
  n <= 0 ? left : left + ((i + 0.5) / n) * (right - left);

/** A y axis from zero to a round maximum, with its labelled ticks. */
export function yScale(values: readonly (number | null)[], height: number, top: number): { max: number; y: (v: number) => number; ticks: number[] } {
  const hi = Math.max(0, ...values.filter((v): v is number => v !== null && Number.isFinite(v)));
  const mag = hi > 0 ? 10 ** Math.floor(Math.log10(hi)) : 1;
  const max = hi > 0 ? Math.ceil(hi / (mag / 2)) * (mag / 2) : 1;
  return { max, y: (v) => top + height - (Math.max(0, v) / max) * height, ticks: [0, max / 2, max] };
}

/** Runs of consecutive drawn values; a null (absent) CUTS the line and is never drawn as zero. */
export function runsOf(values: readonly (number | null)[]): { i: number; v: number }[][] {
  const runs: { i: number; v: number }[][] = [];
  let cur: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) { if (cur.length) runs.push(cur); cur = []; } else cur.push({ i, v });
  });
  if (cur.length) runs.push(cur);
  return runs;
}

/** A bucket's value on the axis: its median, or null when absent. */
/** What a bucket holds for one reading: a median, or for skill loads the mean and share (`SeriesLoads`). */
export type PlotValue = SeriesValue | SeriesLoadsValue;
/** The figure a bucket draws: its median, or the skill-loads mean; null when absent. */
export const figureOrNull = (v: PlotValue | undefined): number | null =>
  (v && "median" in v ? v.median : v && "mean" in v ? v.mean : null);
/** The reason a bucket has no value, or null when it has one. */
export const absentWhy = (v: PlotValue | undefined): string | null => (v && "absent" in v ? v.absent : null);

/** The scrub line's figure for one bucket: "median …, n sessions", or for skill loads the mean, the share that loaded one and n. */
export function bucketFigureWords(def: ReadingDef, v: PlotValue | undefined): string | null {
  if (v && "mean" in v) return `mean ${fmtReading(def, v.mean)} per session, ${fmtShare(v.share)} loaded at least one, ${v.n} sessions`;
  if (v && "median" in v) return `median ${fmtReading(def, v.median)}, ${v.n} sessions`;
  return null;
}

/** The buckets laid on the axis, one value (or null) per slot. */
export function valuesOnAxis(axis: Axis, buckets: readonly SeriesBucket[], pick: (b: SeriesBucket) => PlotValue | undefined): (number | null)[] {
  const out: (number | null)[] = axis.keys.map(() => null);
  for (const b of buckets) {
    const i = axis.index.get(b.key);
    if (i !== undefined) out[i] = figureOrNull(pick(b));
  }
  return out;
}

/** True when no slot has a value: the chart is replaced by its reasons. */
export const allAbsent = (v: readonly (number | null)[]): boolean => v.every((x) => x === null);

/** Why a whole reading has nothing to draw: the first reason found, plus how many buckets share a kind of reason. */
export function absentSummary(buckets: readonly SeriesBucket[], pick: (b: SeriesBucket) => PlotValue | undefined): string | null {
  if (buckets.length === 0) return "No sessions in this selection.";
  let first: string | null = null;
  for (const b of buckets) {
    const w = absentWhy(pick(b));
    if (w === null) return null;
    first ??= w;
  }
  return first;
}

// ── Stacked start-context parts ─────────────────────────────────────────────

export interface PartBand { id: string; label: string; values: (number | null)[]; slot: number | null; /** The folded band's parts, by label. */ members?: string[] }

/**
 * The parts as stacked bands in the caller's order. The `keep` parts with the largest total wear a
 * palette slot; every other part is folded into ONE hueless band ("Smaller parts", last in the stack)
 * so the legend maps each colour to one thing. A part with no measured bucket at all is dropped; a
 * bucket where a part is absent stays a hole in THAT band only, and the folded band is a hole where
 * all of its parts are. The folded parts' own figures are in `partTwinWords`.
 */
export function partBands(axis: Axis, buckets: readonly SeriesBucket[], order: readonly { id: string; label: string }[], keep = 4): PartBand[] {
  const bands = order.map((o) => ({
    id: o.id, label: o.label,
    values: valuesOnAxis(axis, buckets, (b) => b.parts[o.id]),
  })).filter((b) => b.values.some((v) => v !== null));
  const totals = bands.map((b) => b.values.reduce<number>((s, v) => s + (v ?? 0), 0));
  const ranked = [...totals.keys()].sort((a, b) => totals[b]! - totals[a]!).slice(0, keep);
  const slotOf = new Map(ranked.map((bi, s) => [bi, s]));
  const kept: PartBand[] = bands.flatMap((b, i) => (slotOf.has(i) ? [{ ...b, slot: slotOf.get(i)! }] : []));
  const rest = bands.filter((_, i) => !slotOf.has(i));
  if (rest.length === 0) return kept;
  const folded = axis.keys.map((_, i) => {
    const xs = rest.map((b) => b.values[i]).filter((v): v is number => v !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  });
  return [...kept, { id: "rest", label: "Smaller parts", values: folded, slot: null, members: rest.map((b) => b.label) }];
}

/** A character count on an axis or in a line: whole below 1,000, else thousands with up to two decimals (2.5k, 1.25k). */
export function fmtKChars(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Math.abs(v) < 1000) return String(Math.round(v));
  return `${parseFloat((v / 1000).toFixed(2))}k`;
}

/** The text twin of the parts chart: every part's median characters in one bucket, each on its own, grouped by whose it is (shared `START_GROUPS`). */
export function partTwinWords(bucket: SeriesBucket | undefined, order: readonly { id: string; label: string }[]): string | null {
  if (!bucket) return null;
  const groups = START_GROUPS.flatMap((g) => {
    const xs = order.filter((o) => startGroupOf(o.id) === g.id).flatMap((o) => {
      const v = bucket.parts[o.id];
      return v && "median" in v ? [`${o.label} ${fmtKChars(v.median)}`] : [];
    });
    return xs.length ? [`${g.label}: ${xs.join(" · ")}`] : [];
  });
  return groups.length ? `${bucket.key}${bucket.key.length ? ": " : ""}${groups.join("; ")} characters (median per part)` : null;
}

/** The parts in display order for the stacked chart, each label led by its group, so the legend says whose a band is. */
export function groupedPartOrder(order: readonly { id: string; label: string }[]): { id: string; label: string }[] {
  const word = new Map(START_GROUPS.map((g) => [g.id, g.label]));
  return START_GROUPS.flatMap((g) => order.filter((o) => startGroupOf(o.id) === g.id))
    .map((o) => ({ id: o.id, label: `${word.get(startGroupOf(o.id))}: ${o.label}` }));
}

/** The slot under a pointer at `x`, clamped to the plot: a drag past either end stays on the end slot. -1 when there are no slots. */
export function slotAtX(x: number, n: number, left: number, right: number): number {
  if (n <= 0 || !(right > left)) return -1;
  return Math.min(n - 1, Math.max(0, Math.floor(((x - left) / (right - left)) * n)));
}

/** Longest span, in days, over which the Day grain is offered: past it a slot is under about 3 px on a phone. */
export const DAY_GRAIN_MAX_DAYS = 90;
/** True when the Day chip is usable for these points; a window too wide loses the chip rather than dimming it. */
export function dayGrainOffered(points: readonly { t0: number }[]): boolean {
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { if (p.t0 < lo) lo = p.t0; if (p.t0 > hi) hi = p.t0; }
  return !(hi > lo) || localDaysBetween(lo, hi) <= DAY_GRAIN_MAX_DAYS;
}

/** Marks closer than this fold into one, and one mark's tap target is this wide (px). */
export const MARK_GAP = 28;
/** One marker row's height (px): the platform touch minimum, so a tap beside a glyph lands on its own row, never the neighbour's. */
export const MARK_ROW_H = 44;

/** Stack tops per slot (VALUE space, bottom band first); a slot where every band is absent has top null. */
export function stackTops(bands: readonly PartBand[], n: number): { lo: number; hi: number }[][] {
  const cum = new Array<number>(n).fill(0);
  return bands.map((b) => b.values.map((v, i) => {
    const lo = cum[i]!;
    if (v === null) return { lo, hi: lo };
    cum[i] = lo + v;
    return { lo, hi: lo + v };
  }));
}

// ── Markers: a shape and a word, one row per kind ───────────────────────────

export type MarkerShape = "diamond" | "square" | "triangle" | "circle" | "plus" | "hexagon" | "flag" | "cross";

export const MARKER_KINDS: readonly { kind: AgentMarkerKind; word: string; shape: MarkerShape }[] = [
  { kind: "instructions", word: "Instructions", shape: "triangle" },
  { kind: "memory", word: "Memory", shape: "circle" },
  { kind: "skills", word: "Skills listing", shape: "plus" },
  { kind: "switch", word: "Skills switch", shape: "hexagon" },
  { kind: "tag", word: "Tag", shape: "flag" },
  { kind: "model", word: "Model", shape: "diamond" },
  { kind: "cli", word: "CLI version", shape: "square" },
  { kind: "modelCli", word: "Model + CLI", shape: "cross" },
];

export const markerKind = (k: AgentMarkerKind): { kind: AgentMarkerKind; word: string; shape: MarkerShape } =>
  MARKER_KINDS.find((m) => m.kind === k) ?? { kind: k, word: String(k), shape: "circle" };

/** SVG path of a shape centred on (cx, cy) with radius r. */
export function shapePath(shape: MarkerShape, cx: number, cy: number, r: number): string {
  const f = (n: number): string => (Math.round(n * 10) / 10).toString();
  switch (shape) {
    case "diamond": return `M${f(cx)} ${f(cy - r)}L${f(cx + r)} ${f(cy)}L${f(cx)} ${f(cy + r)}L${f(cx - r)} ${f(cy)}Z`;
    case "square": return `M${f(cx - r)} ${f(cy - r)}H${f(cx + r)}V${f(cy + r)}H${f(cx - r)}Z`;
    case "triangle": return `M${f(cx)} ${f(cy - r)}L${f(cx + r)} ${f(cy + r)}L${f(cx - r)} ${f(cy + r)}Z`;
    case "circle": return `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
    case "plus": { const a = r * 0.4; return `M${f(cx - a)} ${f(cy - r)}H${f(cx + a)}V${f(cy - a)}H${f(cx + r)}V${f(cy + a)}H${f(cx + a)}V${f(cy + r)}H${f(cx - a)}V${f(cy + a)}H${f(cx - r)}V${f(cy - a)}H${f(cx - a)}Z`; }
    case "hexagon": { const h = r * 0.87; return `M${f(cx - r)} ${f(cy)}L${f(cx - r / 2)} ${f(cy - h)}L${f(cx + r / 2)} ${f(cy - h)}L${f(cx + r)} ${f(cy)}L${f(cx + r / 2)} ${f(cy + h)}L${f(cx - r / 2)} ${f(cy + h)}Z`; }
    case "cross": { const a = r * 0.3; return `M${f(cx - r)} ${f(cy - r + a)}L${f(cx - r + a)} ${f(cy - r)}L${f(cx)} ${f(cy - a)}L${f(cx + r - a)} ${f(cy - r)}L${f(cx + r)} ${f(cy - r + a)}L${f(cx + a)} ${f(cy)}L${f(cx + r)} ${f(cy + r - a)}L${f(cx + r - a)} ${f(cy + r)}L${f(cx)} ${f(cy + a)}L${f(cx - r + a)} ${f(cy + r)}L${f(cx - r)} ${f(cy + r - a)}L${f(cx - a)} ${f(cy)}Z`; }
    case "flag": return `M${f(cx - r)} ${f(cy - r)}H${f(cx + r)}L${f(cx + r * 0.3)} ${f(cy)}L${f(cx + r)} ${f(cy + r)}H${f(cx - r)}Z`;
  }
}

export interface PlacedMarker {
  kind: AgentMarkerKind;
  /** Row index in `rows`. */
  row: number;
  x: number;
  /** The markers drawn as this one (same kind, closer than the gap), earliest first. */
  markers: AgentMarker[];
  /** Changes in it: the sum of each marker's own `count`. */
  count: number;
}

export interface MarkerLayout { rows: AgentMarkerKind[]; placed: PlacedMarker[]; outside: number }

/**
 * Markers onto the axis. One ROW per kind present (the row's word and shape are the legend), so two
 * kinds never overlap. Within a row, markers on one bucket or closer than `minGap` px fold into one
 * carrying the count, so a burst of commits is one mark that says how many. A marker whose bucket
 * is off the axis (before its first day, after its last, or clipped by the cover) is counted in
 * `outside`, never pinned to an edge.
 */
export function placeMarkers(markers: readonly AgentMarker[], axis: Axis, left: number, right: number, minGap = 14): MarkerLayout {
  let outside = 0;
  const by = new Map<AgentMarkerKind, { x: number; m: AgentMarker }[]>();
  for (const m of markers) {
    const key = seriesBucketKey(m.t, axis.grain);
    const i = key === null ? undefined : axis.index.get(key);
    if (i === undefined) { outside++; continue; }
    const list = by.get(m.kind) ?? [];
    list.push({ x: slotX(i, axis.keys.length, left, right), m });
    by.set(m.kind, list);
  }
  const rows = MARKER_KINDS.map((k) => k.kind).filter((k) => by.has(k));
  const placed: PlacedMarker[] = [];
  rows.forEach((kind, row) => {
    const list = by.get(kind)!.sort((a, b) => a.x - b.x || a.m.t - b.m.t);
    let cur: PlacedMarker | null = null;
    for (const { x, m } of list) {
      if (cur && x - cur.x < minGap) { cur.markers.push(m); cur.count += m.count ?? 1; continue; }
      cur = { kind, row, x, markers: [m], count: m.count ?? 1 };
      placed.push(cur);
    }
  });
  return { rows, placed, outside };
}

/** The line a tapped marker answers with: what it is, when, how many, and the detail it carries. */
export function markerWords(p: PlacedMarker): string {
  const k = markerKind(p.kind);
  const first = p.markers[0]!;
  const day = dayKeyOfMs(first.t);
  if (p.markers.length === 1 && p.count === 1) return `${k.word}, ${day}: ${first.label}${first.detail ? ` (${first.detail})` : ""}.`;
  const labels = [...new Set(p.markers.map((m) => m.label))];
  return `${k.word}, from ${day}: ${p.count} changes. ${labels.slice(0, 4).join("; ")}${labels.length > 4 ? `; and ${labels.length - 4} more` : ""}.`;
}

/** One folded change as a pick: its day and what it was. */
export function markerPickLabel(m: AgentMarker): string {
  return `${dayKeyOfMs(m.t)} ${m.label}`;
}

/** The sentence under a before/after that is centred on one change of a folded mark, so no change is silently skipped. */
export function foldedCompareWords(p: PlacedMarker, at: AgentMarker, days = 14): string | null {
  if (p.markers.length < 2) return null;
  const others = p.markers.filter((m) => m !== at && m.t > at.t && m.t < addLocalDays(at.t, days)).length;
  return `This mark folds ${p.markers.length} changes; the comparison is centred on ${dayKeyOfMs(at.t)}.`
    + `${others > 0 ? ` ${others} of the others fall inside its ${days} days after.` : ""} Pick another change above to compare around it.`;
}

// ── Before / after around a marker ──────────────────────────────────────────

const ratioText = (r: number): string => `×${(Math.round(r * 100) / 100).toString()}`;

/**
 * The compare result in words, neutral by construction: it names the two medians, the ratio, the band
 * that day-to-day variation alone makes, and whether the ratio lies in it. An absent result is its reason.
 */
export function compareWords(def: ReadingDef, r: CompareResult | SeriesAbsent, days = 14): string {
  if ("absent" in r) return r.absent;
  const verdict = r.inside ? "within normal variation" : "outside normal week-to-week variation";
  const model = r.model ? ` on ${r.model}` : "";
  const stat = r.mean ? " (means: most sessions load no skill, so a median would be 0)" : "";
  return `${def.label}${model}${stat}, ${days} days before: ${fmtReading(def, r.before)} (${r.nBefore} sessions on ${r.daysBefore} days). `
    + `${days} days after: ${fmtReading(def, r.after)} (${r.nAfter} sessions on ${r.daysAfter} days). `
    + `Ratio ${ratioText(r.ratio)}; shuffling whole days between the two sides gives ${ratioText(r.band[0])} to ${ratioText(r.band[1])}, so this is ${verdict}.`;
}

/** The shaded outline of the band on a ratio scale, as a sentence for the caption. */
export const COMPARE_NOTE =
  "A before and after is a comparison, not a cause: other things changed in the same weeks, and a model change moves these more than an instruction edit does.";

/** A ratio axis for one comparison: the band as a shaded span, the measured ratio as a tick, ×1 as the "no change" rule. */
export function ratioScale(ratio: number, band: readonly [number, number], width: number): { x: (r: number) => number; band: [number, number]; ratio: number; one: number; ticks: { r: number; x: number }[] } {
  const lo = Math.min(band[0], ratio, 1) * 0.9;
  const hi = Math.max(band[1], ratio, 1) * 1.1;
  const x = (r: number): number => ((r - lo) / (hi - lo)) * width;
  const ticks = [lo, 1, hi].map((r) => ({ r: Math.round(r * 100) / 100, x: x(r) }));
  return { x, band: [x(band[0]), x(band[1])], ratio: x(ratio), one: x(1), ticks };
}

// ── By model (R-metrics-072): one model's days against another's, same band ────────────────

/** A model id as the chips name it. */
export const modelName = (id: string): string => normalizeModel(id) ?? id;

/** One side's figure: the median (the mean and the share for skill loads), over how many sessions on how many days. */
export function byModelSideWords(def: ReadingDef, r: ByModelResult, side: "a" | "b"): string {
  const s = r[side];
  const fig = r.mean && s.share !== undefined ? `${fmtReading(def, s.value)} mean, ${fmtShare(s.share)} loaded one` : fmtReading(def, s.value);
  return `${modelName(s.model)}: ${fig} (${s.n.toLocaleString("en-US")} sessions on ${s.days} days)`;
}

/** The comparison as one sentence naming no side as better: the ratio, the band, and which it is. */
export function byModelWords(r: ByModelResult | ByModelAbsent): string {
  if ("absent" in r) return r.absent;
  const verdict = r.inside ? "within normal day-to-day variation" : "outside normal day-to-day variation";
  return `${modelName(r.b.model)} against ${modelName(r.a.model)}: ratio ${ratioText(r.ratio)}; shuffling whole days between the two models gives ${ratioText(r.band[0])} to ${ratioText(r.band[1])}, so this is ${verdict}.`;
}

/** The extra lines a comparison carries: model + CLI together, models left out, sessions with no model. */
export function byModelNotes(r: ByModelResult): string[] {
  const out: string[] = [];
  if (r.cliTogether) out.push(byModelCliText(r));
  if (r.others.length) out.push(`Also in these days, not compared: ${r.others.map((m) => `${modelName(m.model)} (${m.n} sessions)`).join(", ")}.`);
  if (r.unnamed) out.push(`${r.unnamed.toLocaleString("en-US")} sessions do not record their model and are left out.`);
  return out;
}

/** The `?` behind the by-model view: what it compares, how, and how to get a comparison at all. */
export function byModelHelp(alternate: string): string {
  return "Each reading over the chosen days, split by the model the session ran on: the two models with the most sessions, side by side. "
    + "The band is the same as the before and after: whole days are shuffled between the two models, and the measured ratio is read against what that shuffle alone produces. "
    + `Each model needs at least ${COMPARE_MIN_N} sessions on ${COMPARE_MIN_DAYS} days, or the comparison is left out with the reason. `
    + `Main sessions usually run one model at a time, so most windows hold only one. ${alternate} `
    + "It compares what happened on those days, not a cause: the work on one model's days can differ from the other's.";
}
