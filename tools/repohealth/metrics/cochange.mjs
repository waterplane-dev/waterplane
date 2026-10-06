/**
 * Co-change: coupling measured by what it costs to make one change.
 *
 * ── The question this answers that a line count cannot ─────────────────────
 *
 * For each of the busiest files, when you touch it, how many OTHER files in
 * its own source group do you have to touch at the same time? That median is the
 * price of a change, and it is the number that tells a simplification apart
 * from a relocation — which is the failure this metric exists to catch.
 *
 * Both look identical in every size metric: lines move out of a big file, the
 * big file shrinks, the p95 improves, and the plot says the refactor worked. A
 * genuine simplification puts one concern in one place, so a later change to
 * that concern touches one file and the median falls. A relocation splits one
 * concern across two files that must now change together, so every later
 * change touches both and the median holds or grows. The only thing that
 * separates them is what the few weeks of commits AROUND a given day had to
 * touch, which is what this reads: each row is a reading of its own trailing
 * `COCHANGE_WINDOW_DAYS`, and the series is what makes the "next few weeks"
 * visible — the row two weeks after a refactor is the one that judges it.
 *
 * ── Why the window, and what it replaced ───────────────────────────────────
 *
 * This counted from the first commit of the repo to the commit being measured,
 * with no window at all, and the header above still claimed it read a few
 * weeks. The consequence was not subtle: the top-ten hotspot set was IDENTICAL
 * on every row from 2026-06-21 to 2026-09-19, and the medians moved by half a
 * file in three months. A file that was the busiest in the repo in June stays
 * in the ranking in September however long it has been untouched, because
 * nothing ever leaves a cumulative count. That is not a reading of coupling,
 * it is an average with a very long memory, and the one thing it cannot do is
 * change when the code does.
 *
 * So both halves are cut to the same trailing window: which files are
 * hotspots, and what a change to one of them costs. The window is
 * `COCHANGE_WINDOW_DAYS` — the same two weeks `RETOUCH_WINDOW_DAYS` uses, for
 * the same reason. This repo works in bursts (77 of these commits landed in 16
 * days, with a 57-day hole before them), and a quarter-long window averages a
 * burst away into the silence around it.
 *
 * A window with no non-batch source commit in it is `{value: null, reason}`.
 * Never an empty hotspot list and never a median of 0: "nothing had to change
 * together" and "nothing was measured" are opposite claims, and only the
 * second one is true of a quiet fortnight.
 *
 * ── Why every path is carried whole ────────────────────────────────────────
 *
 * `path` is always the full repo-relative path, here and in the ranking key.
 * `packages/host/src/api.ts` and `packages/web/src/api.ts` are BOTH in the
 * hotspot list at HEAD; a basename would print one row twice and silently drop
 * the other's median.
 *
 * ── Why the median and not the mean ────────────────────────────────────────
 *
 * One 30-file commit would otherwise define the number for a file that is
 * normally edited alone. The median asks what a typical change costs; the mean
 * asks how big the biggest day was, which is already answered by the batch
 * detection below.
 *
 * ── Why coupling stops at the group boundary ───────────────────────────────
 *
 * `PREREG.NEIGHBOURHOOD` is `"group"`: the neighbourhood of
 * `packages/web/src/App.tsx` is the source group `packages/web`. A commit
 * touching `shared` and `web` together is the build order of a monorepo — a
 * wire type changes, so both ends change — not evidence that two modules must
 * change together. Counting it would give every file in the repo a floor of
 * coupling it cannot do anything about, and the metric would then mostly
 * measure how many packages exist.
 *
 * The groups are not `packages/<x>` any more, and they are not typed out
 * anywhere: `snapshot.mjs` derives them from each commit's own tree and
 * argues the rule out there. On this repo the derivation reproduces
 * `packages/<x>` exactly; in a repo with one `src/` at the root it yields one
 * group, which is the true answer — there is no boundary there for coupling
 * to stop at. That is also why the snapshot is no longer unused here: which
 * groups exist is a fact about the tree at this sha, and it arrives with it.
 *
 * ── Which files are counted ────────────────────────────────────────────────
 *
 * Source only, by the effective config's definition — the same population
 * `size`, `hatches` and `dups` count, so "the busiest files" means the same
 * thing in every row. Unfiltered, four of the ten hotspots at HEAD are prose:
 * `docs/notes/web.md`, `docs/notes/host.md`, `CLAUDE.md` and
 * `.claude/skills/web/SKILL.md`. Those co-change with the code they
 * describe, which is a finding about writing habits, not about coupling
 * between modules.
 *
 * `groupOf` is total by the same argument the function it replaced was: a path
 * the group list does not cover gets its first segment rather than
 * `undefined`, because two `undefined`s compare equal and would silently
 * couple every stray path to every other one.
 *
 * ── Why batch commits are excluded entirely ────────────────────────────────
 *
 * **The batch flag is read as the commit recorded it and is never recomputed
 * on the source-filtered list.** It is defined on a commit's FULL file count:
 * a 160-file `git add` is one day of unrelated work whether or not 160 of
 * those files were TypeScript, and re-deriving it from the filtered list
 * silently drops this repo's 18 batch commits to 14. Where the line falls is
 * `BATCH_FILES`'s problem — a pinned judgment, not a boundary discovered in
 * the data — and nothing here second-guesses it.
 *
 * This is a shared working tree; the day often ends in one `git add`. 102 of
 * these 155 commits touch 1 to 10 files and eight touch over 100, and one of
 * those would contribute a co-change count in the dozens to every file it
 * contains. Unlike the re-touch metric, where those files really were edited
 * and so still count as a prior touch, here the batch commit is not evidence
 * of anything at all: it never says which of its files had to change with
 * which. So it is dropped from the hotspot ranking and from every median.
 *
 * ── Purity ─────────────────────────────────────────────────────────────────
 *
 * No git, no filesystem, no network, no model. Nothing past `index` is read,
 * so a row recomputed years later is the same row — a measurement that can see
 * its own future is not a measurement.
 */
// What counts as source is decided once — see source.mjs; which group a path
// is in is decided once, per snapshot — see snapshot.mjs.
import { groupOf } from "../snapshot.mjs";
import { isSource } from "../source.mjs";

const SECONDS_PER_DAY = 86400;

/**
 * The source paths a commit touched. `history.touches` is the authority; the
 * copy on the commit is the fallback so a hand-built literal in a test can
 * carry either one and mean the same thing.
 */
function filesOf(history, commit, prereg) {
  const all = history.touches?.get(commit.sha) ?? commit.filesTouched ?? [];
  return all.filter((path) => isSource(path, prereg));
}

/**
 * Same two-sources rule for the batch flag, read as recorded — see the header
 * on why it is never recomputed from the source-filtered list.
 */
function isBatch(history, commit) {
  return history.batch?.has(commit.sha) ?? commit.batch ?? false;
}

/** Count desc, then path asc — a total order, so the top-N cut is stable. */
function byCountThenPath(a, b) {
  if (b[1] !== a[1]) return b[1] - a[1];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** Median of a non-empty list of counts; the mean of the middle two when even. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {import("../types.mjs").Snapshot} snapshot  For `groups` alone: the
 *   boundary coupling is counted inside. Everything else here is historical.
 * @param {import("../types.mjs").History} history
 * @param {number} index  Position of the commit being measured in
 *   `history.commits` (first-parent, oldest first).
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").Measured<{hotspots: {path: string, median: number}[]}>}
 */
export function measureCochange(snapshot, history, index, prereg) {
  const commits = history?.commits ?? [];
  const here = commits[index];
  if (!here) return { value: null, reason: "no commit at index " + index };
  // An unrecognised scheme is an absence, not a silent fallback to one of
  // them: the number would look like a measurement and mean something else.
  if (prereg.NEIGHBOURHOOD !== "group") {
    return { value: null, reason: "unknown neighbourhood scheme " + prereg.NEIGHBOURHOOD };
  }
  // Same rule one level down. A snapshot with no group list is not a repo
  // with one group; it is a snapshot this code cannot read, and grouping
  // every path by its first segment instead would silently widen the
  // boundary and report a larger number as if it had been measured.
  const groups = snapshot?.groups;
  if (!Array.isArray(groups)) return { value: null, reason: "the snapshot carries no source groups" };

  // `>=` so a window boundary landing exactly on a commit includes it — the
  // same convention `retouch.mjs` uses, so the two windows never disagree by
  // one commit about the same fortnight.
  const windowStart = here.ts - prereg.COCHANGE_WINDOW_DAYS * SECONDS_PER_DAY;

  /** Touch lists of the non-batch commits inside the window, in order. */
  const kept = [];
  /** path -> how many of those commits touched it. */
  const counts = new Map();

  for (let i = 0; i <= index; i++) {
    const commit = commits[i];
    if (commit.ts < windowStart) continue;
    if (isBatch(history, commit)) continue;
    const files = filesOf(history, commit, prereg);
    if (files.length === 0) continue;
    kept.push(files);
    for (const path of files) counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return {
      value: null,
      reason: "no non-batch source touches in the trailing " + prereg.COCHANGE_WINDOW_DAYS + "d",
    };
  }

  const hotspots = [...counts.entries()]
    .sort(byCountThenPath)
    .slice(0, prereg.HOTSPOT_N)
    .map(([path]) => path);

  const rows = hotspots.map((path) => {
    const zone = groupOf(path, groups);
    const samples = [];
    for (const files of kept) {
      if (!files.includes(path)) continue;
      let n = 0;
      for (const other of files) {
        if (other !== path && groupOf(other, groups) === zone) n++;
      }
      samples.push(n);
    }
    // `samples` is non-empty: a path is only here because some kept commit
    // touched it. A commit that touched it alone contributes 0, which is the
    // truthful answer — the cheapest possible change.
    return { path, median: median(samples) };
  });

  // Sorted by PATH, deliberately not by median: the fixture is compared with
  // deepEqual, and an order that moves when a value moves would make every
  // reordering read as a change to all ten rows.
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { value: { hotspots: rows } };
}
