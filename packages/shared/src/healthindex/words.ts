// healthindex/words: One wording of a move for the phone and VS Code. Barrel: ../healthindex.ts (read the header there).
import { HEALTH_ENTRIES, type HealthEntry, HEALTH_INDEX_MONTH_WEEKS, type HealthIndexPoint } from "./types.js";
import { type HealthMove } from "./move.js";

const ENTRY_WORDS: Record<HealthEntry, [string, string]> = {
  size: ["files grew longer", "files got shorter"],
  retouch: ["more re-touched files", "fewer re-touched files"],
  hatches: ["more escape hatches", "fewer escape hatches"],
  context: ["CLAUDE.md + skill descriptions grew", "CLAUDE.md + skill descriptions shrank"],
  untested: ["more untested modules", "fewer untested modules"],
};

/** A signed whole number with a real minus sign: `−4`, `+3`, `±0`. */
export function signedPoints(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "±0";
  return r < 0 ? `−${-r}` : `+${r}`;
}

export interface HealthWords {
  /** Short label for the repo row: `Health 94 −4`. */
  chip: string;
  /** `Health score 94 (−4 this week)`. */
  title: string;
  /** Names the (at most two) metrics that carried the move, or "" when none can be named. */
  body: string;
}

/**
 * When the latest measured week happened, worded against the week it is now:
 * `this week` only when they are the same ISO week — a week with no commit has
 * no point, so the newest one can be months old — else `in the week of <Monday>`.
 * `currentWeek` absent = the caller did not say, and the claim falls back to
 * naming the week (never a `this week` nobody checked).
 */
export function healthWeekWhen(week: string, currentWeek?: string | null): string {
  return currentWeek && week === currentWeek ? "this week" : `in the week of ${week}`;
}

/**
 * The notification and chip wording for a called move. `null` when there is
 * nothing to say (no move called, or no points) — a sentence is never written
 * around a null. `currentWeek` (the ISO week's Monday, `isoWeekOf(today)`)
 * decides whether the latest point may be called "this week".
 */
export function healthMoveWords(points: readonly HealthIndexPoint[], move: HealthMove, currentWeek?: string | null): HealthWords | null {
  const last = points[points.length - 1];
  if (!last || !move.kind || !move.horizon || move.delta === null) return null;
  const value = Math.round(last.index);
  const span = move.horizon === "week" ? 1 : HEALTH_INDEX_MONTH_WEEKS;
  const latest = currentWeek && last.week === currentWeek;
  const when = move.horizon === "week"
    ? healthWeekWhen(last.week, currentWeek)
    : latest ? "over four weeks" : `over the four weeks to ${last.week}`;
  const sums: Partial<Record<HealthEntry, number>> = {};
  for (const p of points.slice(-span)) {
    for (const e of HEALTH_ENTRIES) {
      const c = p.contributions[e];
      if (c !== undefined) sums[e] = (sums[e] ?? 0) + c;
    }
  }
  const sign = move.kind === "drop" ? -1 : 1;
  const top = HEALTH_ENTRIES
    .filter((e) => (sums[e] ?? 0) * sign > 0)
    .sort((a, b) => Math.abs(sums[b] ?? 0) - Math.abs(sums[a] ?? 0))
    .slice(0, 2)
    .map((e) => `${ENTRY_WORDS[e][move.kind === "drop" ? 0 : 1]} (${signedPoints(sums[e] ?? 0)})`);
  const verb = move.kind === "drop" ? "slipped" : "rose";
  const pts = Math.abs(Math.round(move.delta));
  const body = top.length
    ? `The score ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}: ${top.join(", ")}.`
    : `The score ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}.`;
  return {
    chip: `Health ${value} ${signedPoints(move.delta)}`,
    title: `Health score ${value} (${signedPoints(move.delta)} ${when})`,
    body,
  };
}

/** What `RepoTarget.healthIndex` carries. */
