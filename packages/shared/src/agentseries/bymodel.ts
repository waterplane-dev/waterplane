/**
 * `compareByModel` — real work split by the model a session ran on, over one window of days
 * (R-metrics-072): the reading's pooled median (the mean, for skill loads) on model A's sessions
 * beside model B's, with the SAME day-shuffle band the before/after draws (`dayShuffleBand`):
 * whole day blocks (a day both models ran is one block per model) are shuffled between the two
 * models, so a person who alternates models by day for a week reads A's days against B's days and
 * whether the gap is inside what day-to-day variation alone makes.
 *
 * Minimums are the before/after's (`COMPARE_MIN_N` sessions on `COMPARE_MIN_DAYS` days, per model):
 * under them the comparison is ABSENT with the sentence why, never a number from three sessions.
 * The common state is one model only (main sessions are 95%+ on one model at a time); that is its
 * own absence (`kind: "oneModel"`) so the screen can say it plainly.
 *
 * Model and CLI: when every session of one model ran a CLI version none of the other's did, the
 * two changed together and nothing here can tell which moved a reading (`cliTogether`, worded by
 * `byModelCliText`). Nothing here judges: `inside` is data.
 */
import { addLocalDays } from "../calday.js";
import { COMPARE_MIN_DAYS, COMPARE_MIN_N, dayShuffleBand } from "./compare.js";
import { seriesFilter, seriesReadingOf } from "./series.js";
import { localDayOf, medianOf } from "./stats.js";
import type { SeriesPoint, SeriesReading } from "./types.js";

/** Days the comparison looks back by default. */
export const BY_MODEL_DEFAULT_DAYS = 14;
/** The windows a person can choose. */
export const BY_MODEL_WINDOWS: readonly number[] = [7, 14, 28];
/** The readings compared by model, in sentence order (the setup panel's four). */
export const BY_MODEL_READINGS: readonly SeriesReading[] = ["start", "look", "req", "skills"];

export interface ByModelOpts {
  reading: SeriesReading;
  /** The window's end, epoch ms (the caller's clock; nothing here reads one). */
  now: number;
  /** Days back from `now` (default `BY_MODEL_DEFAULT_DAYS`). */
  days?: number;
  repo?: string;
}

export interface ModelCount { model: string; n: number; days: number }

export interface ByModelSide extends ModelCount {
  /** The pooled median of the side's sessions (the mean, for `skills`). */
  value: number;
  /** `skills` only: the share of the side's sessions that loaded at least one. */
  share?: number;
  /** CLI versions the side's sessions ran, sorted; absent when any session does not say. */
  clis?: string[];
}

export interface ByModelResult {
  reading: SeriesReading;
  days: number;
  /** The model with more sessions in the window (ties by id). */
  a: ByModelSide;
  b: ByModelSide;
  /** b / a. */
  ratio: number;
  band: [number, number];
  inside: boolean;
  /** `value`s are means (skill loads). */
  mean?: true;
  /** Every session of one model ran a CLI version none of the other's ran: the two cannot be separated. */
  cliTogether?: true;
  /** Further models in the window that were not compared (fewer sessions, or a third model), most first. */
  others: ModelCount[];
  /** Sessions of the reading that record no model and are left out. */
  unnamed: number;
}

export interface ByModelAbsent {
  absent: string;
  /** `none`: no sessions; `oneModel`: one model only; `tooFew`: several, but under two have enough. */
  kind: "none" | "oneModel" | "tooFew";
  models: ModelCount[];
  unnamed: number;
}

const plural = (n: number, w: string): string => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

function sideOf(model: string, vals: number[], days: number, clis: string[] | undefined, mean: boolean): ByModelSide {
  const value = mean ? vals.reduce((s, x) => s + x, 0) / vals.length : medianOf(vals)!;
  return {
    model, n: vals.length, days, value,
    ...(mean ? { share: vals.filter((x) => x > 0).length / vals.length } : {}),
    ...(clis ? { clis } : {}),
  };
}

export function compareByModel(points: readonly SeriesPoint[], opts: ByModelOpts): ByModelResult | ByModelAbsent {
  const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? BY_MODEL_DEFAULT_DAYS)));
  const lo = Number.isFinite(opts.now) ? addLocalDays(opts.now, -days) : NaN;
  const inWin = seriesFilter(points, opts.repo !== undefined ? { repo: opts.repo } : {})
    .filter((p) => p.t0 >= lo && p.t0 <= opts.now && seriesReadingOf(p, opts.reading) !== undefined);
  const unnamed = inWin.filter((p) => !p.model).length;

  const by = new Map<string, { vals: number[]; days: Map<string, number[]>; clis: Set<string>; cliMissing: boolean }>();
  for (const p of inWin) {
    if (!p.model) continue;
    const g = by.get(p.model) ?? { vals: [], days: new Map<string, number[]>(), clis: new Set<string>(), cliMissing: false };
    const v = seriesReadingOf(p, opts.reading)!;
    g.vals.push(v);
    const day = localDayOf(p.t0);
    const d = g.days.get(day);
    if (d) d.push(v); else g.days.set(day, [v]);
    if (p.cli) g.clis.add(p.cli); else g.cliMissing = true;
    by.set(p.model, g);
  }
  const models: ModelCount[] = [...by].map(([model, g]) => ({ model, n: g.vals.length, days: g.days.size }))
    .sort((x, y) => y.n - x.n || x.model.localeCompare(y.model));
  const absent = (kind: ByModelAbsent["kind"], why: string): ByModelAbsent => ({ absent: why, kind, models, unnamed });
  const last = `the last ${plural(days, "day")}`;

  if (models.length === 0) return absent("none", `No sessions for this reading in ${last} record their model.`);
  if (models.length === 1) {
    const m = models[0]!;
    return absent("oneModel", `Only one model ran these sessions in ${last}: ${m.model} (${plural(m.n, "session")} on ${plural(m.days, "day")}). There is nothing to compare it with.`);
  }
  const enough = models.filter((m) => m.n >= COMPARE_MIN_N && m.days >= COMPARE_MIN_DAYS);
  if (enough.length < 2) {
    const list = models.slice(0, 3).map((m) => `${m.model} ${plural(m.n, "session")} on ${plural(m.days, "day")}`).join(", ");
    return absent("tooFew", `${list}; comparing two models needs at least ${COMPARE_MIN_N} sessions on ${COMPARE_MIN_DAYS} days for each.`);
  }
  const [ma, mb] = enough as [ModelCount, ModelCount];
  const ga = by.get(ma.model)!;
  const gb = by.get(mb.model)!;
  const mean = opts.reading === "skills";
  const blocks = [
    ...[...ga.days.keys()].sort().map((k) => ({ first: true, vals: ga.days.get(k)! })),
    ...[...gb.days.keys()].sort().map((k) => ({ first: false, vals: gb.days.get(k)! })),
  ];
  const shuffled = dayShuffleBand(blocks, mean, `on ${ma.model}`);
  if ("absent" in shuffled) return absent("tooFew", shuffled.absent);
  const { seen, band } = shuffled;
  const clisOf = (g: typeof ga): string[] | undefined => (g.cliMissing ? undefined : [...g.clis].sort());
  const ca = clisOf(ga);
  const cb = clisOf(gb);
  const cliTogether = ca !== undefined && cb !== undefined && !ca.some((v) => cb.includes(v));
  return {
    reading: opts.reading, days,
    a: sideOf(ma.model, ga.vals, ma.days, ca, mean),
    b: sideOf(mb.model, gb.vals, mb.days, cb, mean),
    ratio: seen.ratio, band, inside: seen.ratio >= band[0] && seen.ratio <= band[1],
    ...(mean ? { mean: true as const } : {}),
    ...(cliTogether ? { cliTogether: true as const } : {}),
    others: models.filter((m) => m !== ma && m !== mb),
    unnamed,
  };
}

/** Every `BY_MODEL_READINGS` reading compared by model over one window. */
export function compareByModelAll(points: readonly SeriesPoint[], opts: Omit<ByModelOpts, "reading">): { reading: SeriesReading; r: ByModelResult | ByModelAbsent }[] {
  return BY_MODEL_READINGS.map((reading) => ({ reading, r: compareByModel(points, { ...opts, reading }) }));
}

/** The one sentence where model and CLI changed together (a by-model comparison's own MODEL_CLI_TEXT). */
export function byModelCliText(r: Pick<ByModelResult, "a" | "b">): string {
  const v = (s: ByModelSide): string => (s.clis && s.clis.length ? s.clis.join(", ") : "an unrecorded version");
  return `Every ${r.a.model} session here ran CLI ${v(r.a)}, every ${r.b.model} session CLI ${v(r.b)}: the model and the CLI version changed together, so this cannot tell which of the two moved a reading.`;
}

/** The `?` line for the usual state, one model only: how to get a comparison on real work. */
export const BY_MODEL_ALTERNATE_TEXT =
  "To compare two models on real work, alternate them by day for a week or two (one model all of Monday, the other all of Tuesday, and so on); this view then reads one model's days against the other's.";
