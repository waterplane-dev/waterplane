/**
 * The build prune, offered by hand — the cut that is not an age.
 *
 * ── Why an age chip is the wrong instrument for a pile of builds ────────────
 *
 * `sweep.ts` cuts on how OLD a file is, which is the right question for a
 * transport directory in general and the wrong one for the thing that actually
 * fills it. Measured on this desktop: `picture-app/.claude/outbox` held 4.5 GB,
 * 33 of its 38 files APKs across 13 build families; `Tiptoi` held 2.5 GB, with
 * `tiptoi-debug-dirty.apk` alone a family of **72**. What a person wants there
 * is not "older than 30 days" — it is "I keep the newest few of each thing, and
 * the rest are builds I have already replaced".
 *
 * The age chip catches those files too, and catches them BLINDLY: 30 days over
 * picture-app selects 28 of 38 without knowing that some of those 28 are the
 * newest copy of a variant nothing has rebuilt since. This cut knows.
 *
 * ── Why it is `pruneVictims`, and not a second rule ─────────────────────────
 *
 * `artifacts.ts` already answers "is this an older build of the same thing?" —
 * `familyKey` is the phone's de-duplication rule AND the desktop's automatic
 * prune, deliberately one function so the two cannot disagree. This is the
 * third reader of that same question, so it is the same function again, called
 * with every row as "produced" and nothing protected: a by-hand prune has no
 * run to protect.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 *
 *  - **It is never combined with an age.** Two predicates feeding one number is
 *    two copies of the edge, which is what CLAUDE.md's "a count on a control is
 *    a filter" forbids. The chip rows are mutually exclusive: picking a keep-N
 *    clears the age, and picking an age clears the keep-N.
 *  - **It is outbox-only.** An inbox holds photos, whose names are all-variable
 *    (`1000074170.jpg`), so `familyKey` falls back to the exact path and
 *    nothing ever supersedes anything — every photo would be its own family of
 *    one, every cut empty. Offering a control that can only ever select nothing
 *    is worse than not offering it.
 *  - **It applies itself to nothing.** Like `sweep.ts`: it plans, the plan's
 *    own rows are what get POSTed, and a person taps twice.
 *
 * Pure — no fs, no clock at all (unlike `sweep.ts`, this cut does not depend on
 * "now", only on the order the files were written). `shared/test/sweepfamilies.test.mjs`.
 */
import { familyKey, pruneVictims } from "./artifacts.js";
import { fmtBytes, tally, type SweepPlan, type SweepRow, type SweepTally } from "./sweep.js";

/**
 * How many of each family stay.
 *
 * Deliberately a short ladder and deliberately NOT user-typed, for
 * `SWEEP_AGES`' reason: a free-text N is a more precise way to answer a
 * question nobody asks precisely, and it puts an arbitrary number into the
 * sentence describing a delete. One, three, five: "only the current one", "the
 * default the automatic prune uses", "a bit of headroom".
 */
export type FamilyKeep = 1 | 3 | 5;

/** Widest cut first — the order the chips are drawn in, and the order that
 *  makes the nesting visible (keep-1's victims contain keep-3's, which contain
 *  keep-5's). */
export const FAMILY_KEEPS: readonly FamilyKeep[] = [1, 3, 5];

/** Said in full wherever it is said — "3" is a key, never a label. */
export const FAMILY_KEEP_LABEL: Record<FamilyKeep, string> = {
  1: "keep only the newest of each",
  3: "keep the newest 3 of each",
  5: "keep the newest 5 of each",
};

/**
 * How many distinct things this directory holds builds OF.
 *
 * Printed beside every count here, because "14 of 38 files" is unreadable on
 * its own: it could be one family of 38 or 19 families of two, and those are
 * completely different decisions. "14 of 38, across 13 build families" is the
 * sentence that says what kind of directory you are looking at.
 */
export function familyCount(rows: readonly SweepRow[]): number {
  const keys = new Set<string>();
  for (const r of rows) keys.add(familyKey(r.relPath));
  return keys.size;
}

/**
 * The cut, as a plan a person can be shown and then approve verbatim.
 *
 * `pruneVictims` takes `produced` (which families to consider) and `protect`
 * (paths the run itself just wrote). Here every row is produced — a by-hand
 * prune considers every family present — and NOTHING is protected, because
 * there is no run whose output must survive its own cleanup. The newest `keep`
 * of each family is already safe: that is `pruneVictims`' own rule, not
 * something this function adds.
 */
export function planFamilySweep(rows: readonly SweepRow[], keep: FamilyKeep): SweepPlan {
  const byPath = new Map<string, SweepRow>();
  for (const r of rows) byPath.set(r.relPath, r);
  const victims = pruneVictims(
    rows.map((r) => ({ relPath: r.relPath, mtime: r.mtime })),
    rows.map((r) => r.relPath),
    keep,
    [],
  );
  const hit = victims
    .map((v) => byPath.get(v.relPath))
    .filter((r): r is SweepRow => !!r)
    // Newest first, matching every other file listing in this app — the reader
    // is checking "is anything here I still want".
    .sort((a, b) => b.mtime - a.mtime);
  const t = tally(hit);
  return {
    rows: hit,
    count: t.count,
    bytes: t.bytes,
    total: tally(rows),
    oldestMtime: hit.length ? Math.min(...hit.map((r) => r.mtime)) : null,
  };
}

/**
 * What each chip says — every keep-N, counted over the same rows.
 *
 * The same function the chip's tap uses (`planFamilySweep`), for
 * `sweepCounts`' reason: a second copy of the edge is how a badge becomes a
 * liar. The ladder nests, so the numbers descend left to right.
 */
export function familyCounts(rows: readonly SweepRow[]): Record<FamilyKeep, SweepTally> {
  const out = {} as Record<FamilyKeep, SweepTally>;
  for (const keep of FAMILY_KEEPS) {
    const plan = planFamilySweep(rows, keep);
    out[keep] = { count: plan.count, bytes: plan.bytes };
  }
  return out;
}

/**
 * The sentence under the button: what STAYS, and across how many families.
 *
 * `sweepKeepText`'s job, worded for this cut — a destructive control that only
 * describes what it destroys leaves the reader to derive the complement, which
 * is the half they care about.
 */
export function familyKeepText(plan: SweepPlan, keep: FamilyKeep, families: number): string {
  const keptCount = plan.total.count - plan.count;
  const keptBytes = plan.total.bytes - plan.bytes;
  const fam = `${families} build ${families === 1 ? "family" : "families"}`;
  if (!plan.total.count) return "Nothing here.";
  if (!plan.count) {
    return `Nothing here is superseded — every one of the ${plan.total.count} files is among the newest ${keep} of its family (${fam}).`;
  }
  return `${keptCount} file${keptCount === 1 ? "" : "s"} stay (${fmtBytes(keptBytes)}) — the newest ${keep} of each of ${fam}.`;
}

/** What the primary button says. `sweepButtonText`'s rule — the whole decision
 *  restated — with the word that says WHY these and not others. */
export function familyButtonText(plan: SweepPlan): string {
  if (!plan.count) return "Nothing superseded";
  return `Delete ${plan.count} superseded build${plan.count === 1 ? "" : "s"} · ${fmtBytes(plan.bytes)}`;
}
