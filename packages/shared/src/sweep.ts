/**
 * Clearing out old transport files — the rules, on both sides, once.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `.claude/outbox/` and `.claude/inbox/` are how work reaches a person and how
 * a photo reaches an agent (CLAUDE.md, "The phone↔repo transport"). Nothing has
 * ever removed anything from either. Measured on this desktop, across fourteen
 * repos: **6.8 GB** sitting in transport directories, 4.0 GB of it in ONE repo's
 * outbox across 31 files, another 2.4 GB in a second. The gallery's per-file
 * delete has existed the whole time and is the wrong instrument at that size —
 * 523 files in one inbox is not a list anybody taps through.
 *
 * ── The three rules everything here serves ──────────────────────────────────
 *
 *  1. **Nothing applies itself** (CLAUDE.md). This module PLANS and describes;
 *     it deletes nothing, decides nothing, and schedules nothing. There is no
 *     age past which a file goes away on its own, and adding one later would be
 *     a change of kind, not of degree: these directories hold the only copy of
 *     things nobody committed.
 *  2. **A count on a control is a filter** (CLAUDE.md). `sweepCounts` and
 *     `planSweep` are the SAME predicate (`olderThan`) — the chip that says
 *     "27 · 3.9 GB" opens exactly those 27, because a second copy of the edge
 *     is how a badge becomes a liar.
 *  3. **A count is not a decision; bytes are.** Every number here travels with
 *     its byte total. "27 files older than 30 days" does not tell you whether
 *     to care. "27 files, 3.9 GB" does, and in the measured case those 27 files
 *     were 97% of the repo's transport bytes.
 *
 * ── The one that is easy to get wrong ───────────────────────────────────────
 *
 * **The plan is the contract, not the age.** The caller sends back the exact
 * paths it showed a person, and those are what get deleted — never an age for
 * the host to re-cut. Re-deriving the cut at delete time is a race with every
 * agent running in that repo: a file written between the preview and the tap
 * would fall inside "older than 30 days" by the time the sweep ran only if the
 * clock moved, but one written BEFORE the preview and missed by a listing race
 * would be deleted without ever having been on screen. A person approved a
 * LIST. That list is the authority.
 *
 * Pure: no fs, no clock of its own (`now` is passed in), so both ends and
 * `packages/shared/test/sweep.test.mjs` run it identically.
 */

/**
 * The age ladder, as a person thinks about it.
 *
 * Deliberately coarse and deliberately NOT user-typed. A free-text "older
 * than N days" field is a more precise way to answer a question nobody asks
 * precisely, and it puts an arbitrary number in the sentence that says what is
 * about to be destroyed.
 */
export type SweepAge = "7d" | "30d" | "90d" | "365d";

/** Widest cut first — the order the chips are drawn in, and the order that
 *  makes the nesting visible (each one's set contains the next one's). */
export const SWEEP_AGES: readonly SweepAge[] = ["7d", "30d", "90d", "365d"];

export const SWEEP_AGE_MS: Record<SweepAge, number> = {
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
  "365d": 365 * 86_400_000,
};

/** Said in full wherever it is said — "30d" is a key, never a label. */
export const SWEEP_AGE_LABEL: Record<SweepAge, string> = {
  "7d": "older than a week",
  "30d": "older than 30 days",
  "90d": "older than 90 days",
  "365d": "older than a year",
};

/** Which transport directories a sweep is looking at. Separate because they
 *  are opposite directions and one of them is far more likely to hold the only
 *  copy of something: the outbox is what an agent WROTE (re-derivable by
 *  running the thing again), the inbox is what a phone UPLOADED (a photo that
 *  may exist nowhere else). The UI keeps them apart for that reason alone. */
export type SweepScope = "outbox" | "inbox";

export const SWEEP_SCOPE_LABEL: Record<SweepScope, string> = {
  outbox: "outbox — what agents wrote for you",
  inbox: "inbox — what this phone uploaded",
};

/** The minimum of a file row these rules need. The host's `FileEntry` is
 *  structurally this, so nothing converts. */
export interface SweepRow {
  name: string;
  /** Worktree-relative, forward slashes — and the ONLY identifier a delete
   *  takes. A name is not unique across the two transport directories. */
  relPath: string;
  size: number;
  mtime: number;
}

/** A count and the bytes behind it. Never one without the other. */
export interface SweepTally {
  count: number;
  bytes: number;
}

export interface SweepPlan extends SweepTally {
  /** Exactly the rows the cut selected, newest first. This is what gets sent
   *  back to delete — see the module note. */
  rows: SweepRow[];
  /** The whole directory, for the "n of N" the filter bar owes the reader. */
  total: SweepTally;
  /** The oldest selected row's mtime, or null when nothing was selected. Used
   *  to say how far back the cut actually reaches rather than how far back it
   *  was ALLOWED to reach — those differ whenever the oldest file is younger
   *  than the chip. */
  oldestMtime: number | null;
}

/**
 * Is this file older than the cut?
 *
 * The one predicate. `sweepCounts` counts with it and `planSweep` cuts with it,
 * so the chip and the list cannot disagree.
 *
 * **On `mtime` rather than birth time.** `FileEntry` carries both, and a
 * rewritten artifact is a file somebody is still producing — a build that
 * overwrites `report.html` every run has a fresh mtime and a months-old ctime,
 * and deleting it as "old" would be deleting today's output. Last-written is
 * the conservative direction for a destructive cut.
 */
export function olderThan(mtime: number, age: SweepAge, now: number): boolean {
  return now - mtime > SWEEP_AGE_MS[age];
}

/** Sum a set of rows. Split out because "the whole directory" and "the cut"
 *  are the same arithmetic and the filter bar shows them side by side. */
export function tally(rows: readonly SweepRow[]): SweepTally {
  let bytes = 0;
  for (const r of rows) bytes += r.size;
  return { count: rows.length, bytes };
}

/**
 * What each chip says — every age, counted over the same rows.
 *
 * **The buckets NEST and that is the point.** Anything older than a year is
 * also older than 30 days, so the numbers descend across the ladder and a
 * person can read the ladder as "how aggressive do I want to be". Disjoint bins
 * ("between 30 and 90 days") answer a question nobody has when the goal is
 * reclaiming space.
 */
export function sweepCounts(rows: readonly SweepRow[], now: number): Record<SweepAge, SweepTally> {
  const out = {} as Record<SweepAge, SweepTally>;
  for (const age of SWEEP_AGES) out[age] = { count: 0, bytes: 0 };
  for (const r of rows) {
    for (const age of SWEEP_AGES) {
      if (olderThan(r.mtime, age, now)) {
        out[age].count++;
        out[age].bytes += r.size;
      }
    }
  }
  return out;
}

/**
 * The cut, as a plan a person can be shown and then approve verbatim.
 *
 * Newest first, matching every other file listing in this app — the reader is
 * checking "is anything here I still want", and the things they still want are
 * the recent ones, so those are the rows that must not need scrolling to.
 */
export function planSweep(rows: readonly SweepRow[], age: SweepAge, now: number): SweepPlan {
  const hit = rows.filter((r) => olderThan(r.mtime, age, now)).sort((a, b) => b.mtime - a.mtime);
  const t = tally(hit);
  return {
    rows: hit,
    count: t.count,
    bytes: t.bytes,
    total: tally(rows),
    oldestMtime: hit.length ? Math.min(...hit.map((r) => r.mtime)) : null,
  };
}

/** Bytes as a person reads them. Own function rather than the web's `format.ts`
 *  because the HOST says these sentences too (an op's ack), and a sweep that
 *  reports "3906823168" has not reported anything. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  // Three significant figures under 10, one decimal under 100, none above —
  // `tokens.ts`' `fmtCount` rule, for its reason: trailing precision on a
  // number nobody will act on to that precision is noise in a sentence whose
  // whole job is to be read at a glance.
  const s = v < 10 ? v.toFixed(1) : Math.round(v).toString();
  return `${s} ${units[i]}`;
}

/**
 * What the primary button says — **the whole decision, restated**
 * (`SendSheet`'s rule, and this is a destructive one, so it matters more).
 *
 * Never "Delete" alone: the count and the bytes are the two facts that make it
 * a decision, and the age is what the reader picked and may have forgotten
 * picking by the time they reach the button.
 */
export function sweepButtonText(plan: SweepPlan): string {
  if (!plan.count) return "Nothing to delete";
  return `Delete ${plan.count} file${plan.count === 1 ? "" : "s"} · ${fmtBytes(plan.bytes)}`;
}

/** The sentence under it: what is being kept, said explicitly. A destructive
 *  control that only describes what it destroys leaves the reader to work out
 *  the complement, which is the half they actually care about. */
export function sweepKeepText(plan: SweepPlan, age: SweepAge): string {
  const keptCount = plan.total.count - plan.count;
  const keptBytes = plan.total.bytes - plan.bytes;
  if (!plan.total.count) return "Nothing here.";
  if (!plan.count) {
    return `Nothing here is ${SWEEP_AGE_LABEL[age]} — all ${plan.total.count} files stay (${fmtBytes(plan.total.bytes)}).`;
  }
  if (!keptCount) {
    return `Everything here is ${SWEEP_AGE_LABEL[age]}. Nothing would be kept.`;
  }
  return `${keptCount} newer file${keptCount === 1 ? "" : "s"} stay (${fmtBytes(keptBytes)}).`;
}

/** What a sweep DID, as one sentence. */
export interface SweepResult {
  deleted: number;
  bytes: number;
  /** Paths that were not there any more — an agent or another device got there
   *  first. Not a failure: the outcome asked for is the outcome reached. */
  missing: string[];
  /** Paths the host refused or could not remove. A failure, and named, because
   *  a sweep that says "done" over files still on disk is the one lie this
   *  feature could tell that costs real bytes. */
  failed: string[];
}

export function sweepResultText(r: SweepResult): string {
  const parts: string[] = [];
  parts.push(r.deleted
    ? `Deleted ${r.deleted} file${r.deleted === 1 ? "" : "s"} · ${fmtBytes(r.bytes)}.`
    : "Deleted nothing.");
  // Said apart from the failures on purpose: "already gone" is the sweep
  // succeeding through a different route, and folding it into a failure count
  // would teach the reader to distrust a clean run.
  if (r.missing.length) parts.push(`${r.missing.length} already gone.`);
  if (r.failed.length) parts.push(`${r.failed.length} could not be removed — still on disk.`);
  return parts.join(" ");
}
