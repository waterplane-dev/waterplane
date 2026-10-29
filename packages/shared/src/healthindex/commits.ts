// healthindex/commits: The same formula per ROW (thinned), for the phone's commits axis. Barrel: ../healthindex.ts (read the header there).
import { type HealthEntry, type HealthSeriesRow } from "./types.js";
import { isoWeekOf, centralOf } from "./readings.js";
import { healthRowScore } from "./score.js";

export interface HealthCommitPoint {
  sha7: string;
  day: string;
  ts: number;
  week: string;
  index: number;
  mean: number;
  cappedBy: HealthEntry | null;
  /** Prereg or central fingerprint differs from the previous scored row: do not join the line. */
  gap: boolean;
}

export interface HealthCommitSeries {
  points: HealthCommitPoint[];
  /** Scored rows before thinning. */
  total: number;
  thinned: boolean;
}

/** Thin to ~`max`: each ISO week's LAST point stays; `ceil(n/max)`-long runs keep their min and max index. At most 2*max + weeks. */
export function thinCommitPoints(points: readonly HealthCommitPoint[], max: number): HealthCommitPoint[] {
  if (points.length <= max) return [...points];
  const keep = new Set<number>();
  const lastOfWeek = new Map<string, number>();
  points.forEach((p, i) => lastOfWeek.set(p.week, i));
  for (const i of lastOfWeek.values()) keep.add(i);
  const run = Math.ceil(points.length / Math.max(1, max));
  for (let a = 0; a < points.length; a += run) {
    let lo = a, hi = a;
    const end = Math.min(points.length, a + run);
    for (let i = a; i < end; i++) {
      if (points[i].index < points[lo].index) lo = i;
      if (points[i].index > points[hi].index) hi = i;
    }
    keep.add(lo);
    keep.add(hi);
  }
  return [...keep].sort((x, y) => x - y).map((i) => points[i]);
}

/** Every scorable row as a commit point, thinned to about `max`; `null` when no row scores. */
export function healthIndexCommits(rows: readonly HealthSeriesRow[], contextWarnChars: number | null, max = 240): HealthCommitSeries | null {
  const sorted = rows.filter((r) => r && typeof r.ts === "number").sort((a, b) => a.ts - b.ts);
  const all: HealthCommitPoint[] = [];
  let prev: { prereg: string | null; central: string } | null = null;
  for (const row of sorted) {
    const week = isoWeekOf(row.day);
    const s = week ? healthRowScore(row, contextWarnChars) : null;
    if (!week || !s) continue;
    const prereg = typeof row.prereg === "string" ? row.prereg : null;
    const central = centralOf(row).fp;
    all.push({
      sha7: typeof row.sha === "string" ? row.sha.slice(0, 7) : "",
      day: row.day, ts: row.ts, week, index: s.index, mean: s.mean, cappedBy: s.cappedBy,
      gap: prev !== null && (prev.prereg !== prereg || prev.central !== central),
    });
    prev = { prereg, central };
  }
  if (all.length === 0) return null;
  const points = thinCommitPoints(all, max);
  return { points, total: all.length, thinned: points.length < all.length };
}

/** `absent` = an older host (no key), `none` = the host looked and nothing scores, else `present`. */
export function healthCommitsAvailability(view: { commits?: HealthCommitSeries | null } | null | undefined): "absent" | "none" | "present" {
  if (!view || view.commits === undefined) return "absent";
  return view.commits && view.commits.points.length > 0 ? "present" : "none";
}

