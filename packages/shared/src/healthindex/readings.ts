// healthindex/readings: Rows to readings: ISO weeks, the per-entry values, the repo `central` override. Barrel: ../healthindex.ts (read the header there).
import { HEALTH_ENTRIES, HEALTH_OPTIONAL_ENTRIES, HEALTH_HIGHER_IS_BETTER, HEALTH_SCORE_FLOOR, type HealthEntry, HEALTH_CONTEXT_GOOD_SHARE, HEALTH_INDEX_DEFAULT_WARN_CHARS, HEALTH_NO_CLAUDE_MD, type HealthSeriesRow } from "./types.js";

const posFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const nonNegFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** `100 · min(1, good / value)`; a value at or under 0 is 100. */
export function healthScore(value: number, good: number): number {
  return value <= 0 ? 100 : 100 * Math.min(1, good / value);
}

/** `100 · min(1, value / good)`, floored at `HEALTH_SCORE_FLOOR`: for an entry where more is better. */
export function healthScoreAtLeast(value: number, good: number): number {
  return Math.max(HEALTH_SCORE_FLOOR, value >= good ? 100 : (100 * value) / good);
}

/** One entry's score against its good line, in the entry's own direction. */
export function healthEntryScore(entry: HealthEntry, value: number, good: number): number {
  return HEALTH_HIGHER_IS_BETTER.includes(entry) ? healthScoreAtLeast(value, good) : healthScore(value, good);
}

/** The Monday (UTC) of the ISO week holding `day` (`YYYY-MM-DD`), or null for a malformed day. */
export function isoWeekOf(day: string): string | null {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return null;
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

/** The last row (greatest `ts`) of each ISO week, oldest week first. */
export function healthWeeks(rows: readonly HealthSeriesRow[]): { week: string; row: HealthSeriesRow }[] {
  const byWeek = new Map<string, HealthSeriesRow>();
  for (const r of rows) {
    if (!r || typeof r.ts !== "number") continue;
    const week = isoWeekOf(r.day);
    if (!week) continue;
    const prev = byWeek.get(week);
    if (!prev || r.ts >= prev.ts) byWeek.set(week, r);
  }
  return [...byWeek.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([week, row]) => ({ week, row }));
}

/** The good line of the context entry for a repo's warn line (null = the default). */
export function healthContextGood(contextWarnChars: number | null): number {
  return HEALTH_CONTEXT_GOOD_SHARE * (posFinite(contextWarnChars) ? contextWarnChars : HEALTH_INDEX_DEFAULT_WARN_CHARS);
}

/** One week's readings: the five values (size's is `lineMean`), plus size's longest file. */
export interface HealthEntryReadings {
  values: Partial<Record<HealthEntry, number>>;
  /** An optional entry (`HEALTH_OPTIONAL_ENTRIES`) the row carries but could not read, with the engine's reason: UNKNOWN that week. */
  absent?: Partial<Record<HealthEntry, string>>;
  /** Optional entries the row has no field for at all (an engine that never took the reading): not applicable on that row. */
  unrecorded?: HealthEntry[];
  /** The longest file, read beside `lineMean`; absent where size is. */
  max?: { value: number; path: string | null };
}

/**
 * One week's values, raw (no epsilon, no floor — `min(1, good/value)` is
 * finite for any value ≥ 0); an entry is absent where its reading is.
 *
 * - `size` is `lineMean` and needs `max` beside it; either missing ⇒ absent.
 * - `untested` is a SHARE: `untested.count / classics.files` — the source-file
 *   count of the same tree, which counts test files too, so the share is a
 *   floor. A share and not the count, so a repo that grows does not read as
 *   slipping just for having more modules.
 * - `hatches` is UNEXPLAINED escapes per kLOC where the row classified them
 *   (engine 2026-10-16a on); every occurrence on an older row.
 * - `context` is `claudeMdChars + descChars`; `descChars` null (no counted
 *   skills) counts as 0 descriptions.
 */
export function healthEntryReadings(row: HealthSeriesRow): HealthEntryReadings {
  const values: Partial<Record<HealthEntry, number>> = {};
  let max: HealthEntryReadings["max"];
  const sz = row.size?.value;
  // `max` is read on its own: an override REPLACES lineMean and keeps the
  // engine's max, so it must not depend on the engine's lineMean being there.
  // Where `max` is absent size is absent on BOTH paths (an override cannot
  // invent the longest file); where only lineMean is absent, size is absent
  // without an override and the override's value stands with the engine's max.
  // A `max` left without a size value is dropped at the end.
  if (sz && nonNegFinite(sz.max)) {
    max = { value: sz.max, path: typeof sz.maxPath === "string" && sz.maxPath ? sz.maxPath : null };
  }
  if (sz && nonNegFinite(sz.lineMean) && max) values.size = sz.lineMean;

  const rate = row.retouch?.value?.rate;
  if (nonNegFinite(rate)) values.retouch = rate;

  const h = row.hatches as { value?: Record<string, unknown> | null; split?: { unexplained?: unknown } } | null | undefined;
  const loc = row.classics?.value?.loc;
  if (h?.value && typeof h.value === "object" && posFinite(loc)) {
    let total = 0;
    let ok = true;
    if (h.split && typeof h.split === "object") {
      if (nonNegFinite(h.split.unexplained)) total = h.split.unexplained;
      else ok = false;
    } else {
      for (const v of Object.values(h.value)) {
        if (!nonNegFinite(v)) { ok = false; break; }
        total += v;
      }
    }
    if (ok) values.hatches = total / (loc / 1000);
  }

  const ctx = row.context?.value;
  const md = ctx?.claudeMdChars;
  const desc = ctx?.descChars;
  // No CLAUDE.md is nothing the repo loads every turn: 0, on the engine's exact words (its skills go unmeasured then).
  if (!ctx && row.context?.reason === HEALTH_NO_CLAUDE_MD) values.context = 0;
  else if (nonNegFinite(md) && (desc === null || desc === undefined || nonNegFinite(desc))) values.context = md + (typeof desc === "number" ? desc : 0);

  const list = row.untested?.value;
  const files = row.classics?.value?.files;
  if (Array.isArray(list) && posFinite(files) && list.length <= files) {
    values.untested = list.length / files;
  }

  const opt = optionalReadings(row);
  Object.assign(values, opt.values);
  const absent = opt.absent;

  // The repo's own say (`central`): a disabled entry is not in the basket at
  // all; an override REPLACES the engine's value (for size, `lineMean` — the
  // longest file stays measured), and a failed override is absent — never the
  // engine's number standing in for the repo's.
  const c = centralOf(row);
  for (const e of c.disabled) {
    delete values[e];
    delete absent[e];
    if (e === "size") max = undefined;
  }
  for (const e of c.overridden) {
    delete values[e];
    delete absent[e];
    const v = row.central?.override?.[e]?.value;
    if (!nonNegFinite(v)) {
      // A core entry absent leaves the week unscored; an optional one is unknown, said so.
      if (HEALTH_OPTIONAL_ENTRIES.includes(e)) absent[e] = "the repo's own command for it gave no usable value";
      continue;
    }
    if (e === "size" && !max) continue;
    values[e] = v;
  }
  if (values.size === undefined) max = undefined;
  // A disabled or overridden entry is the repo's say, never "unrecorded".
  const unrecorded = opt.unrecorded.filter((e) => !c.disabled.includes(e) && !c.overridden.includes(e));
  const out: HealthEntryReadings = max ? { values, max } : { values };
  if (Object.keys(absent).length) out.absent = absent;
  if (unrecorded.length) out.unrecorded = unrecorded;
  return out;
}

/** The engine's reason, cut to one readable clause (a graph reason can name many files). */
const REASON_MAX = 160;
function reasonOf(m: { reason?: unknown } | null | undefined, fallback: string): string {
  const r = typeof m?.reason === "string" && m.reason.trim() ? m.reason.trim() : fallback;
  return r.length > REASON_MAX ? `${r.slice(0, REASON_MAX - 1).trimEnd()}…` : r;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

type Field = { value?: unknown; reason?: unknown } | null | undefined;

/**
 * The six entries P2 added, read off fields the engine already writes
 * (calibration: `docs/analysis/health-metrics/P2.md`). Each comes out as a
 * value, an absence with the engine's own reason (UNKNOWN that week), or
 * unrecorded (the row has no field: an engine that never took it).
 *
 * - `dups`: `dups.pairsPerKloc` — the engine divides by the lines its analyzer
 *   READ, so code nobody parsed does not dilute it.
 * - `deadExports`: the list's length per 1,000 source lines (`classics.loc`).
 *   The list is whole (never capped). The denominator is every source line,
 *   so a language with no parser reads LOW here — bounded by coverage: past a
 *   fifth of unread files the entry is unknown anyway.
 * - `cycles`: `graph.cycleFiles / graph.files` — a share, so growth alone
 *   does not move it.
 * - `cochange`: the median, over the hotspot files, of each one's median
 *   co-changed files in its group — what a typical change to a busy file costs.
 * - `fixAfterChange`, `testsWithCode`: `habits.value.fix.rate` and
 *   `habits.value.testsWithCode.rate`, each its own `{value, reason}`.
 */
function optionalReadings(row: HealthSeriesRow): { values: Partial<Record<HealthEntry, number>>; absent: Partial<Record<HealthEntry, string>>; unrecorded: HealthEntry[] } {
  const values: Partial<Record<HealthEntry, number>> = {};
  const absent: Partial<Record<HealthEntry, string>> = {};
  const unrecorded: HealthEntry[] = [];
  const odd = "the reading came back in a shape this version cannot read";
  const take = (e: HealthEntry, field: Field, read: (v: object) => number | null): void => {
    if (field === undefined) { unrecorded.push(e); return; }
    const v = field?.value;
    if (v === null || v === undefined || typeof v !== "object") {
      absent[e] = v === null || v === undefined ? reasonOf(field, "not read at this commit") : odd;
      return;
    }
    const n = read(v);
    if (n === null || !nonNegFinite(n)) absent[e] = odd;
    else values[e] = n;
  };
  take("dups", row.dups, (v) => {
    const p = (v as { pairsPerKloc?: unknown }).pairsPerKloc;
    return nonNegFinite(p) ? p : null;
  });
  const loc = row.classics?.value?.loc;
  take("deadExports", row.deadExports, (v) => (Array.isArray(v) && posFinite(loc) ? v.length / (loc / 1000) : null));
  if (Array.isArray(row.deadExports?.value) && !posFinite(loc)) absent.deadExports = "no source line count at this commit to divide by";
  take("cycles", row.graph, (v) => {
    const g = v as { files?: unknown; cycleFiles?: unknown };
    return posFinite(g.files) && nonNegFinite(g.cycleFiles) && g.cycleFiles <= g.files ? g.cycleFiles / g.files : null;
  });
  take("cochange", row.cochange, (v) => {
    const hs = (v as { hotspots?: unknown }).hotspots;
    if (!Array.isArray(hs) || hs.length === 0) return null;
    const meds: number[] = [];
    for (const h of hs) {
      const m = (h as { median?: unknown } | null)?.median;
      if (!nonNegFinite(m)) return null;
      meds.push(m);
    }
    return median(meds);
  });
  // `habits` is one family with a `{value, reason}` per sub-reading; a family-wide absence is each one's.
  const habits = row.habits;
  const sub = (k: "fix" | "testsWithCode"): Field => {
    if (habits === undefined) return undefined;
    if (!habits?.value || typeof habits.value !== "object") return { value: null, reason: habits?.reason };
    const s = (habits.value as Record<string, unknown>)[k];
    return s && typeof s === "object" ? (s as Field) : { value: null, reason: odd };
  };
  const rateOf = (v: object): number | null => {
    const r = (v as { rate?: unknown }).rate;
    return nonNegFinite(r) && r <= 1 ? r : null;
  };
  take("fixAfterChange", sub("fix"), rateOf);
  take("testsWithCode", sub("testsWithCode"), rateOf);
  return { values, absent, unrecorded };
}

/** The values alone — `healthEntryReadings(row).values`. The warn line is not read here any more (scores read it). */
export function healthEntryValues(row: HealthSeriesRow, _contextWarnChars?: number | null): Partial<Record<HealthEntry, number>> {
  return healthEntryReadings(row).values;
}

const isEntry = (k: string): k is HealthEntry => (HEALTH_ENTRIES as readonly string[]).includes(k);

/**
 * What the repo applied on this row: its fingerprint and which entries it
 * disabled or overrode. An entry both disabled and overridden reads disabled
 * (the engine never writes both; a hand-edited row must not count twice).
 */
export function centralOf(row: HealthSeriesRow): { fp: string; disabled: HealthEntry[]; overridden: HealthEntry[] } {
  const c = row.central;
  if (!c || typeof c !== "object") return { fp: "", disabled: [], overridden: [] };
  const fp = typeof c.fp === "string" ? c.fp : "";
  const keysOf = (o: unknown): HealthEntry[] =>
    o && typeof o === "object" ? Object.keys(o).filter(isEntry) : [];
  const disabled = HEALTH_ENTRIES.filter((e) => keysOf(c.disabled).includes(e));
  const overridden = HEALTH_ENTRIES.filter((e) => keysOf(c.override).includes(e) && !disabled.includes(e));
  return { fp, disabled, overridden };
}

export const DAY_MS = 86_400_000;

export function treeOf(row: HealthSeriesRow): { files: number; loc: number } | null {
  const v = row.classics?.value;
  return v && nonNegFinite(v.files) && nonNegFinite(v.loc) ? { files: v.files, loc: v.loc } : null;
}

