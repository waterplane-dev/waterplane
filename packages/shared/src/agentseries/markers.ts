/**
 * Markers the points themselves show — the competing explanations drawn on the
 * same axis as the readings: the model changed, a new CLI version took over,
 * the memory or skills listing a fresh session carries stepped. Plus
 * `collapseMarkers`, the ONE fold of same-kind markers on one local day
 * (the host's git markers go through it too).
 *
 * Words are neutral: a marker says what changed and by how much, never whether
 * that was good.
 */
import { hourKeyMs } from "../costwindow.js";
import { seriesReadingOf } from "./series.js";
import { localDayOf, medianOf } from "./stats.js";
import type { AgentMarker, SeriesPoint } from "./types.js";

/** A day-median of a listing's chars moving by at least this much is a marker. */
export const LISTING_STEP_CHARS = 1000;
/** Fewest sessions a day needs before its dominant model/CLI or listing median counts. */
export const MARKER_MIN_N = 3;

const dayStart = (day: string): number => hourKeyMs(`${day}T00`);
const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** The value held by more than half of `xs`, else null (a split day names no winner). */
function dominant(xs: readonly string[]): string | null {
  if (xs.length < MARKER_MIN_N) return null;
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  for (const [k, n] of c) if (n * 2 > xs.length) return k;
  return null;
}

/** Fold same-kind markers of one local day (and one repo) into one carrying `count`; sorted by time. */
export function collapseMarkers(markers: readonly AgentMarker[]): AgentMarker[] {
  const by = new Map<string, AgentMarker[]>();
  for (const m of markers) {
    if (!m || !Number.isFinite(m.t)) continue;
    const k = `${localDayOf(m.t)}|${m.kind}|${m.repo ?? ""}`;
    const list = by.get(k);
    if (list) list.push(m); else by.set(k, [m]);
  }
  const out: AgentMarker[] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.t - b.t);
    const total = list.reduce((s, m) => s + (m.count ?? 1), 0);
    if (total === 1) { out.push(list[0]!); continue; }
    const last = list[list.length - 1]!;
    const labels = [...new Set(list.map((m) => m.label))];
    out.push({
      ...last,
      t: list[0]!.t,
      count: total,
      detail: labels.slice(0, 5).join("; ") + (labels.length > 5 ? `; and ${labels.length - 5} more` : ""),
    });
  }
  return out.sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind));
}

const LISTINGS: { part: string; kind: "memory" | "skills"; words: string }[] = [
  { part: "memory", kind: "memory", words: "memory" },
  { part: "skills", kind: "skills", words: "skills listing" },
];

/**
 * Markers derived from the points: model, CLI version, memory and skills-listing steps.
 * `listings: false` leaves the last two out: memory is each project's own index and the skills
 * listing includes project skills, so a day median pooled over several repos moves when the repo
 * mix does, which would read as an instruction change. Pooled (no `repo`) callers pass it.
 */
export function derivedMarkers(points: readonly SeriesPoint[], opts: { repo?: string; listings?: boolean } = {}): AgentMarker[] {
  const byDay = new Map<string, SeriesPoint[]>();
  for (const p of points) {
    if (!p || !Number.isFinite(p.t0) || p.fresh !== true || p.sub === true) continue;
    if (opts.repo !== undefined && p.repo !== opts.repo) continue;
    const d = localDayOf(p.t0);
    const list = byDay.get(d);
    if (list) list.push(p); else byDay.set(d, [p]);
  }
  const days = [...byDay.keys()].sort();
  const repo = opts.repo !== undefined ? { repo: opts.repo } : {};
  const out: AgentMarker[] = [];

  let prevModel: string | null = null;
  const cliSeen = new Set<string>();
  const prevListing = new Map<string, number>();
  for (const day of days) {
    const ps = byDay.get(day)!;
    const t = dayStart(day);

    const model = dominant(ps.map((p) => p.model).filter((m): m is string => typeof m === "string" && m !== ""));
    if (model !== null) {
      if (prevModel !== null && model !== prevModel) out.push({ t, kind: "model", label: `model ${prevModel} to ${model}`, ...repo });
      prevModel = model;
    }

    const cli = dominant(ps.map((p) => p.cli).filter((c): c is string => typeof c === "string" && c !== ""));
    if (cli !== null && !cliSeen.has(cli)) {
      if (cliSeen.size > 0) out.push({ t, kind: "cli", label: `CLI ${cli}`, ...repo });
      cliSeen.add(cli);
    }

    const startSet = ps.filter((p) => seriesReadingOf(p, "start") !== undefined);
    for (const { part, kind, words } of opts.listings === false ? [] : LISTINGS) {
      const xs = startSet.map((p) => p.parts?.[part]).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      if (xs.length < MARKER_MIN_N) continue;
      const med = medianOf(xs)!;
      const prev = prevListing.get(part);
      if (prev !== undefined && Math.abs(med - prev) >= LISTING_STEP_CHARS) {
        const d = med - prev;
        out.push({ t, kind, label: `${words} ${d > 0 ? "+" : "−"}${fmt(Math.abs(d))} chars`, detail: `${fmt(prev)} to ${fmt(med)} chars, day median`, ...repo });
      }
      prevListing.set(part, med);
    }
  }
  return collapseMarkers(out);
}
