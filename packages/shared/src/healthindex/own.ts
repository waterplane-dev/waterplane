// healthindex/own: The repo's own readings that declare a TARGET, read off a row for the score. Barrel: ../healthindex.ts (read the header there).
/**
 * **A repo's own reading joins the score only where the repo says what good is.**
 *
 * A repo declares its own readings in its committed `health.json` (engine
 * `tools/repohealth/own.mjs`). Without a target such a reading is a series the
 * repo keeps about itself: drawn on the phone, never in the score — the index
 * has no good line to judge it against, and inventing one would be the index
 * taking a side the repo never took. With `"target": n` the repo has taken
 * that side itself, so the reading is scored like one of waterplane's entries
 * (owner, R-metrics-066):
 *
 * - **The same curve, in the reading's own direction** (`healthDirScore`):
 *   `better: "lower"` scores `100 · min(1, target / value)`, `"higher"`
 *   `100 · min(1, value / target)` floored at 1 — exactly what an entry in that
 *   direction gets. The target is the repo's opinion, attributed to it.
 * - **It joins the mean, the worst-entry cap and coverage like an entry.** A
 *   targeted reading with no value (it failed, timed out, was not approved to
 *   run, or its declaration was refused) is UNKNOWN with the reason — one more
 *   applicable dimension nobody measured, never 0 and never 100.
 * - **Ids are `own:<key>`**, so a repo key named `size` can never stand in for
 *   waterplane's size entry (gates are `gate:<key>` for the same reason).
 * - **The basket moved, so the week is a gap.** Which own targets apply, and
 *   each target's value and direction, are in the coverage fingerprint: the
 *   week a target is declared, changed or dropped is a `coverage` gap, its
 *   score shown as measured but never linked to the week before.
 * - **Not comparable across repos.** A score that counts a repo's own readings
 *   is partly the repo's own yardstick; the phone says so beside the score.
 * - **No alerts.** An own reading under the warn line holds the score down
 *   through the worst-entry cap, which names it; the alert list stays
 *   waterplane's own readings.
 */
import { type HealthOwnId, type HealthSeriesRow } from "./types.js";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One own reading that declared a target, as this row carries it. */
export interface HealthOwnTarget {
  id: HealthOwnId;
  key: string;
  name: string;
  unit: string;
  /** Null where the declaration's direction or target could not be read (then `why` is set). */
  better: "lower" | "higher" | null;
  target: number | null;
  /** Null = no reading on this row (`why` says why). */
  value: number | null;
  /** Why it cannot be scored; absent = it can. */
  why?: string;
}

/** How a coverage line names an own reading. */
export const healthOwnLabel = (name: string): string => `the repo's own "${name}"`;

/** `own:<key>`. */
export const healthOwnId = (key: string): HealthOwnId => `own:${key}`;

/**
 * The row's own readings that declare a target, in declaration order. [] where
 * the row carries no `own`, or the declaration was refused whole (that is one
 * UNKNOWN gate already, `healthGatesOf`: what it declared cannot be known). A
 * row measured with the repo's commands unapproved (`own.notRun`) carries each
 * targeted reading in `own.gates` with no value: unknown, never scored. Each
 * dropped entry that asked for a target (`own.unreadTargets`) is one more
 * unknown.
 */
export function healthOwnTargetsOf(row: HealthSeriesRow): HealthOwnTarget[] {
  const own = row.own;
  if (!own || typeof own !== "object" || typeof own.refused === "string") return [];
  const list = Array.isArray(own.readings) ? own.readings : Array.isArray(own.gates) ? own.gates : [];
  const out: HealthOwnTarget[] = [];
  for (const raw of list as unknown[]) {
    const r = raw as { key?: unknown; name?: unknown; unit?: unknown; better?: unknown; target?: unknown; value?: unknown; reason?: unknown } | null;
    if (!r || typeof r.key !== "string" || r.target === undefined || r.target === null) continue;
    // A reading of THIS DESKTOP never counts in a score that reads the same on every desktop (R-metrics-069).
    if ((r as { backfill?: unknown }).backfill === false) continue;
    const name = typeof r.name === "string" && r.name ? r.name : r.key;
    const unit = typeof r.unit === "string" ? r.unit : "";
    const better = r.better === "lower" || r.better === "higher" ? r.better : null;
    const t = r.target as unknown;
    const target = isNum(t) && t > 0 ? t : null;
    const value = isNum(r.value) ? r.value : null;
    const reason = typeof r.reason === "string" && r.reason ? r.reason : null;
    const one: HealthOwnTarget = { id: healthOwnId(r.key), key: r.key, name, unit, better, target, value };
    if (target === null) {
      const inv = t && typeof t === "object" ? (t as { invalid?: unknown }).invalid : undefined;
      one.why = typeof inv === "string" && inv ? inv : "its target could not be read";
    } else if (better === null) {
      one.why = `its direction ("better") could not be read`;
    } else if (value === null) {
      one.why = `no reading${reason ? ` (${reason})` : ""}`;
    }
    out.push(one);
  }
  if (isNum(own.unreadTargets) && own.unreadTargets > 0) {
    const n = Math.floor(own.unreadTargets);
    out.push({
      // A key no declaration can have (`own.mjs` keys start with a letter), so it never meets a real one.
      id: healthOwnId("-unread"), key: "-unread", name: "unreadable entries", unit: "", better: null, target: null, value: null,
      why: `${n} declared ${n === 1 ? "reading with a target has" : "readings with a target have"} no usable key and could not be read`,
    });
  }
  return out;
}
