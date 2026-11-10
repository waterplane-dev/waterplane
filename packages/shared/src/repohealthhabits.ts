/**
 * Reading `plot.habits` — the git-only readings — off the engine's JSON.
 *
 * Split from `repohealthread.ts` (at its line cap) and bound by the same rule
 * its header states: the parser rebuilds from the fields it NAMES, so a field
 * nobody listed is dropped in silence. `test/repohealth.test.mjs` runs the
 * real engine and fails until every key path it emits is named here.
 *
 * OPTIONAL as a block (an engine older than the field sends none) and
 * all-or-nothing within it: a malformed block is dropped WHOLE rather than
 * drawn half-true. A list or series that says it is `absent` keeps only the
 * sentence; one that does not must carry every field of its shape.
 */
import type {
  RepoHealthHabitList,
  RepoHealthHabitSeries,
  RepoHealthPlotHabits,
  RepoHealthPoint,
} from "./repohealth.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function points(v: unknown): RepoHealthPoint[] | null {
  if (!Array.isArray(v)) return null;
  const out: RepoHealthPoint[] = [];
  for (const raw of v) {
    if (!isRec(raw) || !isStr(raw.day) || !isStr(raw.sha7)) return null;
    if (raw.v !== null && !isNum(raw.v)) return null;
    out.push({ day: raw.day, sha7: raw.sha7, v: raw.v as number | null });
  }
  return out;
}

/** An absent list is `{absent}`; a present one is rebuilt by `shape`. */
function list<T>(v: unknown, shape: (o: Rec) => T | null): RepoHealthHabitList<T> | null {
  if (!isRec(v)) return null;
  if (isStr(v.absent)) return { absent: v.absent };
  const t = shape(v);
  return t ? ({ ...t } as RepoHealthHabitList<T>) : null;
}

const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

export function readHabits(v: unknown): RepoHealthPlotHabits | null {
  if (!isRec(v)) return null;
  if (v.windowDays !== null && !isNum(v.windowDays)) return null;
  if (v.absent !== undefined && !isStr(v.absent)) return null;
  if (!Array.isArray(v.series)) return null;

  const series: RepoHealthHabitSeries[] = [];
  for (const raw of v.series) {
    if (!isRec(raw) || !isStr(raw.key) || !isStr(raw.label) || typeof raw.unit !== "string" || typeof raw.detail !== "string") return null;
    if (raw.last !== null && !isNum(raw.last)) return null;
    if (raw.absent !== undefined && !isStr(raw.absent)) return null;
    const pts = points(raw.points);
    if (!pts) return null;
    const s: RepoHealthHabitSeries = { key: raw.key, label: raw.label, unit: raw.unit, points: pts, last: raw.last as number | null, detail: raw.detail };
    if (isStr(raw.absent)) s.absent = raw.absent;
    series.push(s);
  }

  let weeks: RepoHealthPlotHabits["weeks"] = null;
  if (v.weeks !== null) {
    if (!Array.isArray(v.weeks)) return null;
    weeks = [];
    for (const w of v.weeks) {
      if (!isRec(w) || !isNum(w.added) || !isNum(w.deleted)) return null;
      weeks.push({ added: w.added, deleted: w.deleted });
    }
  }

  const hotspots = list(v.hotspots, (o) => {
    if (!Array.isArray(o.items)) return null;
    const items: { path: string; churn: number; loc: number; score: number }[] = [];
    for (const i of o.items) {
      if (!isRec(i) || !isStr(i.path) || !isNum(i.churn) || !isNum(i.loc) || !isNum(i.score)) return null;
      items.push({ path: i.path, churn: i.churn, loc: i.loc, score: i.score });
    }
    return { items };
  });
  const litter = list(v.litter, (o) => {
    if (o.scope !== "tracked" || !isNum(o.count) || !isNum(o.bytes) || !isRec(o.kinds) || !Array.isArray(o.items)) return null;
    const kinds: Record<string, number> = {};
    for (const [k, n] of Object.entries(o.kinds)) {
      if (!isNum(n)) return null;
      kinds[k] = n;
    }
    const items: { path: string; bytes: number; kind: string }[] = [];
    for (const i of o.items) {
      if (!isRec(i) || !isStr(i.path) || !isNum(i.bytes) || !isStr(i.kind)) return null;
      items.push({ path: i.path, bytes: i.bytes, kind: i.kind });
    }
    return { scope: "tracked" as const, count: o.count, bytes: o.bytes, kinds, items };
  });
  const docsDrift = list(v.docsDrift, (o) => {
    if (!isNum(o.docs) || !isNum(o.refs) || !isNum(o.broken) || !isNum(o.docsWithBroken) || !Array.isArray(o.items)) return null;
    const items: { path: string; broken: number; of: number; missing: string[] }[] = [];
    for (const i of o.items) {
      const missing = isRec(i) ? strs(i.missing) : null;
      if (!isRec(i) || !isStr(i.path) || !isNum(i.broken) || !isNum(i.of) || !missing) return null;
      items.push({ path: i.path, broken: i.broken, of: i.of, missing });
    }
    return { docs: o.docs, refs: o.refs, broken: o.broken, docsWithBroken: o.docsWithBroken, items };
  });
  if (!hotspots || !litter || !docsDrift) return null;

  const out: RepoHealthPlotHabits = {
    windowDays: v.windowDays as number | null,
    series,
    weeks,
    hotspots,
    litter,
    docsDrift,
  };
  if (isStr(v.absent)) out.absent = v.absent;
  return out;
}
