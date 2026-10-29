// healthindex/vs: "Vs N weeks ago": the one comparison line under the headline. Barrel: ../healthindex.ts (read the header there).
import { type HealthIndexPoint } from "./types.js";
import { DAY_MS } from "./readings.js";

/** How far back "vs 12 weeks ago" looks, in weeks. */
export const HEALTH_INDEX_VS_WEEKS = 12;

export interface HealthIndexVs {
  /** `now.index / then.index` — 1.05 is five percent healthier. */
  ratio: number;
  /** Score points between the two (`now − then`). */
  delta: number;
  then: HealthIndexPoint;
  now: HealthIndexPoint;
  /** Weeks actually between the two points — `weeks` asked or more, since a
   *  week nobody measured has no point. The UI names `then.week`. */
  weeks: number;
}

/**
 * "Vs 12 weeks ago": the score at `points[at]` (default the latest) against
 * the LATEST measured point at least `weeks` earlier — however much further
 * back that is, because a week with no commit has no row and the honest
 * comparison names the week it actually used (`then.week`, `weeks`). Null
 * only when no point sits that far back (a series younger than the horizon).
 *
 * Both ends are absolute scores, so the ratio is simply the two numbers —
 * including any prereg or `central` change between them (the point's `gap`
 * says one happened; the caller decides whether to say so).
 */
export function healthIndexVs(
  points: readonly HealthIndexPoint[],
  weeks: number = HEALTH_INDEX_VS_WEEKS,
  at: number = points.length - 1,
): HealthIndexVs | null {
  const now = points[at];
  if (!now || !(weeks > 0) || !Number.isFinite(now.index)) return null;
  const nowT = Date.parse(`${now.week}T00:00:00Z`);
  const target = nowT - weeks * 7 * DAY_MS;
  for (let i = at - 1; i >= 0; i--) {
    const t = Date.parse(`${points[i].week}T00:00:00Z`);
    if (t > target) continue;
    const then = points[i];
    if (!(then.index > 0)) return null;
    return {
      ratio: now.index / then.index,
      delta: now.index - then.index,
      then,
      now,
      weeks: Math.round((nowT - t) / (7 * DAY_MS)),
    };
  }
  return null;
}

