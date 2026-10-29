// healthindex/repoindex: What `RepoTarget.healthIndex` carries, and the route's response DTO. Barrel: ../healthindex.ts (read the header there).
import { type HealthEntry, type HealthIndexSeries } from "./types.js";
import { type HealthCommitSeries } from "./commits.js";
import { type HealthMove } from "./move.js";
import { type HealthWords } from "./words.js";

export interface RepoHealthIndex {
  /** The latest headline score, 0–100. */
  value: number;
  /** The latest week's move in score points; null on a gap week or the first scored week. */
  deltaWeek: number | null;
  /** The latest week's Monday. */
  week: string;
  move: "drop" | "rise" | null;
  // The four below are OPTIONAL on purpose: the phone updates over the air,
  // so it can meet a host from before the absolute score. Absent = that host
  // did not say — never "not capped" or "no alert".
  /** The mean before the cap, so `healthCapWords` can be said from this summary alone. */
  mean?: number;
  /** The entry holding the score down when the cap set it, else null. */
  cappedBy?: HealthEntry | null;
  /** The worst alert level on the latest week; null when nothing is under the warn line. */
  alert?: "warn" | "severe" | null;
  /** That worst alert's sentence; null with it. */
  alertText?: string | null;
}

/** The wire summary for one repo, or null where there is no index (the field stays ABSENT, never 0). */
export function repoHealthIndexOf(series: HealthIndexSeries | null, move?: HealthMove | null): RepoHealthIndex | null {
  const pts = series?.points;
  const last = pts?.[pts.length - 1];
  if (!pts || !last) return null;
  const prev = pts[pts.length - 2];
  return {
    value: last.index,
    deltaWeek: last.lnLink !== null && prev ? last.index - prev.index : null,
    week: last.week,
    move: move?.kind ?? null,
    mean: last.mean,
    cappedBy: last.cappedBy,
    alert: last.alerts[0]?.level ?? null,
    alertText: last.alerts[0]?.text ?? null,
  };
}

/**
 * `GET /api/repos/:id/healthindex` — the whole scored series for the phone's
 * chart (the latest point carries the alerts and `cappedBy`), the called move
 * and its words. `series: null` + `reason` when there is no series file or no
 * scored week yet; never a made-up number.
 */
export interface HealthIndexResponse {
  series: HealthIndexSeries | null;
  move: HealthMove | null;
  words: HealthWords | null;
  /** ISO time of the last weekly refresh this host ran for the repo, if any. */
  lastRefresh: string | null;
  reason?: string;
  /** Context per request by ISO week (`healthspend.ts`); absent with no ledger (older host; VS Code before its first log scan). */
  spend?: import("../healthspend.js").HealthSpendWeek[];
  /** Scored commits, thinned. ABSENT only on an older host; null = no row scores (or no series). */
  commits?: HealthCommitSeries | null;
}
