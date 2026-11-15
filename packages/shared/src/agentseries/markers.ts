/**
 * Markers the points themselves show — the competing explanations drawn on the
 * same axis as the readings: the model changed, a new CLI version took over,
 * the memory or skills listing a fresh session carries stepped. Plus
 * `collapseMarkers`, the ONE fold of same-kind markers on one local day
 * (the host's git markers go through it too).
 *
 * A model change and a CLI version change on the same day, or on two neighbouring session
 * days where no session ran the new one of either beside the old one of the other, are ONE
 * `modelCli` marker naming both: no reading can separate them, and two marks would read as
 * two explanations.
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

/** The detail every `modelCli` marker carries, and the sentence a before/after around one adds. */
export const MODEL_CLI_TEXT =
  "The model and the CLI version changed together (the same day, or neighbouring days with no session that ran one change without the other): a before and after around this mark cannot tell which of the two moved a reading.";

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
  let prevCli: string | null = null;
  const prevListing = new Map<string, number>();
  // Model and CLI changes by session-day index, folded after the walk (`foldModelCli`).
  const modelAt: Change[] = [];
  const cliAt: Change[] = [];
  for (const [di, day] of days.entries()) {
    const ps = byDay.get(day)!;
    const t = dayStart(day);

    const model = dominant(ps.map((p) => p.model).filter((m): m is string => typeof m === "string" && m !== ""));
    if (model !== null) {
      if (prevModel !== null && model !== prevModel) modelAt.push({ i: di, t, from: prevModel, to: model, words: `model ${prevModel} to ${model}` });
      prevModel = model;
    }

    const cli = dominant(ps.map((p) => p.cli).filter((c): c is string => typeof c === "string" && c !== ""));
    if (cli !== null && !cliSeen.has(cli)) {
      if (cliSeen.size > 0 && prevCli !== null) cliAt.push({ i: di, t, from: prevCli, to: cli, words: `CLI ${cli}` });
      cliSeen.add(cli);
    }
    if (cli !== null) prevCli = cli;

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
  // Did any session on these days run one change without the other (new model on the old CLI, or the reverse)?
  const separable = (m: Change, c: Change): boolean => {
    for (let i = Math.min(m.i, c.i); i <= Math.max(m.i, c.i); i++) {
      for (const p of byDay.get(days[i]!)!) {
        if ((p.model === m.to && p.cli === c.from) || (p.model === m.from && p.cli === c.to)) return true;
      }
    }
    return false;
  };
  out.push(...foldModelCli(modelAt, cliAt, separable, repo));
  return collapseMarkers(out);
}

/** One model or CLI change: its index among the days with sessions, its day start, the values either side, its words. */
interface Change { i: number; t: number; from: string; to: string; words: string }

/**
 * Pair each model change with a CLI change into one `modelCli` marker at the earlier of the two:
 * on the same session day always, on the next or previous one only when `separable` finds no
 * session on those days that ran one change without the other. Nearest partner first; a change
 * with no partner stays its own `model` or `cli` marker.
 */
function foldModelCli(models: readonly Change[], clis: readonly Change[], separable: (m: Change, c: Change) => boolean, repo: { repo?: string }): AgentMarker[] {
  const out: AgentMarker[] = [];
  const used = new Set<number>();
  for (const m of models) {
    let best = -1;
    clis.forEach((c, j) => {
      const gap = Math.abs(c.i - m.i);
      if (used.has(j) || gap > 1 || (gap === 1 && separable(m, c))) return;
      if (best < 0 || gap < Math.abs(clis[best]!.i - m.i)) best = j;
    });
    if (best < 0) { out.push({ t: m.t, kind: "model", label: m.words, ...repo }); continue; }
    used.add(best);
    const c = clis[best]!;
    out.push({ t: Math.min(m.t, c.t), kind: "modelCli", label: `model + CLI: ${m.words}, ${c.words}`, detail: MODEL_CLI_TEXT, ...repo });
  }
  clis.forEach((c, j) => { if (!used.has(j)) out.push({ t: c.t, kind: "cli", label: c.words, ...repo }); });
  return out;
}
