/**
 * The demo's health index: a fictional series per demo repo, run through the
 * REAL `healthIndex()` / `assessHealthMove()` / `healthMoveWords()` so the
 * chip, the line and the bars are what a host would send. Deterministic: ten
 * weekly rows ending on the Monday of `now`'s week; no clock, no randomness.
 */
import {
  assessHealthMove, healthIndex, healthMoveWords, isoWeekOf, repoHealthIndexOf,
  type HealthIndexResponse, type HealthSeriesRow, type RepoHealthIndex,
} from "@waterplane/shared";

const DAY = 86_400_000;
const WEEKS = 10;

/** Per repo: p95 length, re-touch rate, hatches per kLOC share, CLAUDE.md chars, untested count, at the first and last week. */
const PROFILES: Record<string, { size: [number, number]; retouch: [number, number]; hatches: [number, number]; md: [number, number]; untested: [number, number] }> = {
  "todo-garden": { size: [210, 318], retouch: [0.22, 0.34], hatches: [8, 14], md: [14_000, 17_500], untested: [8, 12] },
  "pocket-notes": { size: [260, 205], retouch: [0.4, 0.27], hatches: [12, 7], md: [16_000, 13_000], untested: [14, 9] },
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
  const rows: HealthSeriesRow[] = [];
  for (let w = 0; w < WEEKS; w++) {
    const t = w / (WEEKS - 1);
    const lerp = (a: [number, number]) => a[0] + (a[1] - a[0]) * t;
    const ts = monday - (WEEKS - 1 - w) * 7 * DAY + 2 * DAY;
    const day = new Date(ts).toISOString().slice(0, 10);
    rows.push({
      day, ts, prereg: "demo-1",
      size: { value: { p95: lerp(p.size) } },
      retouch: { value: { rate: lerp(p.retouch) } },
      hatches: { value: { a: Math.round(lerp(p.hatches) * 40) } },
      context: { value: { claudeMdChars: lerp(p.md), descChars: 1_200 } },
      untested: { value: new Array(Math.round(lerp(p.untested))).fill("x") },
      classics: { value: { loc: 40_000, files: 120 } },
    });
  }
  return rows;
}

export function demoHealthIndex(repoName: string, now: number): HealthIndexResponse | null {
  const rows = rowsFor(repoName, now);
  if (!rows) return null;
  const series = healthIndex(rows, null);
  if (!series) return null;
  const move = assessHealthMove(series.points, { minWeeks: 4, minMonthWindows: 99 });
  return { series, move, words: healthMoveWords(series.points, move, isoWeekOf(new Date(now).toISOString().slice(0, 10))), lastRefresh: null };
}

/** What `RepoTarget.healthIndex` carries for a demo repo; undefined = no chip. */
export function demoRepoHealthIndex(repoName: string, now: number): RepoHealthIndex | undefined {
  const r = demoHealthIndex(repoName, now);
  return (r?.series && repoHealthIndexOf(r.series, r.move)) || undefined;
}
