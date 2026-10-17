/**
 * The demo's health index: a fictional series per demo repo, run through the
 * REAL `healthIndex()` / `assessHealthMove()` / `healthMoveWords()` so the
 * chip, the line and the bars are what a host would send. Deterministic: ten
 * weekly rows (a profile may ask for more) ending on the Monday of `now`'s week;
 * no clock, no randomness.
 */
import {
  assessHealthMove, healthIndex, healthIndexCommits, healthMoveWords, isoWeekOf, repoHealthIndexOf,
  type HealthIndexResponse, type HealthSeriesRow, type RepoHealthIndex,
} from "@waterplane/shared";

const DAY = 86_400_000;
const COMMITS_PER_WEEK = 4;
/** A stable fake 40-hex sha per demo commit. */
const demoSha = (n: number): string => ((n * 2654435761) >>> 0).toString(16).padStart(8, "0").repeat(5);
const WEEKS = 10;

/**
 * Per repo, first and last week: line-weighted mean file length, longest file,
 * re-touch rate, unexplained hatches per kLOC, CLAUDE.md chars (+ `desc` of skill
 * descriptions, 1,200 when absent), untested files (of `files`, 120 when absent).
 * `weeks` rows (10 when absent), over a tree of `loc` lines (40,000 when absent).
 *
 * todo-garden tells the alarm story: one file (`maxPath`) grows to 5,200 lines,
 * the other four entries stay near their good values, and the cap — not the
 * average — sets the score, with a severe alert naming the file. pocket-notes
 * is the other way round: every reading comes back under its good line.
 *
 * photo-shelf (scenario `repo-health`) is the shape of a real app vibe-coded for
 * eight months with no readings: from February to October one file climbs from
 * 1,020 to 8,397 lines, the tree from 13,000 to 80,000 lines and 146 source
 * files, the average line ends up in a 2,235-line file — and everything else
 * stays fine. The score starts near 100 and slides every week the file grows.
 */
type Pair = [number, number];
const PROFILES: Record<string, {
  lineMean: Pair; max: Pair; maxPath: string;
  retouch: Pair; hatches: Pair; md: Pair; untested: Pair;
  desc?: number; files?: Pair; loc?: Pair; weeks?: number;
}> = {
  "todo-garden": { lineMean: [420, 900], max: [1_300, 5_200], maxPath: "src/garden/planner.ts", retouch: [0.14, 0.22], hatches: [1.2, 2.4], md: [6_500, 7_800], untested: [20, 29] },
  "pocket-notes": { lineMean: [640, 430], max: [1_700, 980], maxPath: "src/notes/sync.ts", retouch: [0.3, 0.16], hatches: [4, 1.8], md: [11_000, 7_000], untested: [30, 22] },
  "photo-shelf": {
    lineMean: [420, 2_235], max: [1_020, 8_397], maxPath: "lib/services/sync_backend.dart",
    retouch: [0.06, 0.07], hatches: [0.3, 0.4], md: [3_800, 9_000], desc: 1_200, untested: [5, 25],
    files: [38, 146], loc: [13_000, 80_000], weeks: 35,
  },
};

function mondayOf(now: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;
}

function rowsFor(repoName: string, now: number): HealthSeriesRow[] | null {
  const p = PROFILES[repoName];
  if (!p) return null;
  const monday = mondayOf(now);
  const weeks = p.weeks ?? WEEKS;
  const rows: HealthSeriesRow[] = [];
  for (let w = 0; w < weeks; w++) {
    const t = w / (weeks - 1);
    const lerp = (a: Pair) => a[0] + (a[1] - a[0]) * t;
    const ts = monday - (weeks - 1 - w) * 7 * DAY + 2 * DAY;
    const loc = Math.round(p.loc ? lerp(p.loc) : 40_000);
    const files = Math.round(p.files ? lerp(p.files) : 120);
    // A few commits per week so the commits axis has something to draw: the
    // earlier ones wobble around the week's value, the LAST is the week's row
    // exactly, so the weekly series is unchanged.
    for (let c = COMMITS_PER_WEEK - 1; c >= 0; c--) {
      const k = c === 0 ? 1 : 1 + 0.06 * Math.sin(w * 7 + c * 3);
      rows.push({
        sha: demoSha(w * COMMITS_PER_WEEK + (COMMITS_PER_WEEK - 1 - c)),
        day: new Date(ts - c * DAY / 2).toISOString().slice(0, 10), ts: ts - c * DAY / 2, prereg: "demo-1",
        size: { value: { lineMean: lerp(p.lineMean) * k, max: lerp(p.max), maxPath: p.maxPath } },
        retouch: { value: { rate: lerp(p.retouch) * k } },
        hatches: { value: { a: Math.round(lerp(p.hatches) * (loc / 1000)) } },
        context: { value: { claudeMdChars: lerp(p.md), descChars: p.desc ?? 1_200 } },
        untested: { value: new Array(Math.round(lerp(p.untested))).fill("x") },
        classics: { value: { loc, files } },
      });
    }
  }
  return rows;
}

export function demoHealthIndex(repoName: string, now: number): HealthIndexResponse | null {
  const rows = rowsFor(repoName, now);
  if (!rows) return null;
  const series = healthIndex(rows, null);
  if (!series) return null;
  const move = assessHealthMove(series.points, { minWeeks: 4, minMonthWindows: 99 });
  return {
    series, move, words: healthMoveWords(series.points, move, isoWeekOf(new Date(now).toISOString().slice(0, 10))), lastRefresh: null,
    commits: healthIndexCommits(rows, null),
  };
}

/** What `RepoTarget.healthIndex` carries for a demo repo; undefined = no chip. */
export function demoRepoHealthIndex(repoName: string, now: number): RepoHealthIndex | undefined {
  const r = demoHealthIndex(repoName, now);
  return (r?.series && repoHealthIndexOf(r.series, r.move)) || undefined;
}
