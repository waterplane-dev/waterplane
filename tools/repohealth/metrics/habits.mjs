/**
 * Habits: what the commit log alone says about how work lands. Git only, no
 * language knowledge beyond the one thing the packs already decide — which
 * paths are source and which are tests.
 *
 * ── The six readings, and the question each one answers ────────────────────
 *
 *   fix        Of the commits that touched source or tests, what share were a
 *              FIX or REVERT of files a different commit had changed in the
 *              seven days before. "Is the last thing I shipped holding?"
 *              Re-touch asks it per file; this asks it per commit and by what
 *              the author SAID, so the two disagree usefully.
 *   deletion   Lines deleted per line added over the window, with the four
 *              weeks it is made of. The owner's grooming signal: an agent
 *              rarely deletes unless asked, so a ratio that stays near zero
 *              is a repo that only grows.
 *   netNegative  The share of commits that delete more than they add.
 *   testsWithCode  Of the commits that touched source, the share that also
 *              touched a test file.
 *   commitSize p95 (nearest rank) of changed lines (added + deleted) per
 *              commit, with the median beside it.
 *   hotspots   The files where churn and size multiply — a LIST, like
 *              `untested`, because "src/a.ts, 4 changes, 2,100 lines" is
 *              something a person opens and "0.43" is not.
 *
 * ── The fix pattern ────────────────────────────────────────────────────────
 *
 * A commit is a fix when its SUBJECT, case-insensitively, starts with
 * `revert`, `fix`, `fixes`, `fixed`, `bugfix` or `hotfix` (as a word), or is a
 * Conventional-Commits subject whose type is `fix`/`revert`/`hotfix`
 * (`fix(web): …`, `fix!: …`). It is pinned in `FIX_SUBJECT` below, is a
 * message heuristic and nothing more: a repo that never writes "fix" reads 0
 * fixes, which is why `fixes` travels beside the rate and a window with no
 * fix-worded commit still reports the rate (0 of N) rather than an absence —
 * "nothing was labelled a fix" is a true statement about the window.
 *
 * ── Which commits are the subject, and which are only evidence ─────────────
 *
 * The same rule `retouch` argues out. A BATCH commit (`history.batch`, the
 * flag as recorded, never recomputed) is a day swept up by one `git add`, and
 * a MERGE (subject `Merge …`; first-parent history gives it the whole branch
 * as one diff) is a branch landing at once. Neither is a commit someone sized
 * or worded, so neither is counted in a per-commit share (fix, test, net
 * negative, size). Both still count as PRIOR touches for fix-after-change, and
 * both still count in the line TOTALS of the deletion ratio: those lines
 * really were added and deleted, and dropping them would make a repo that
 * grooms in one big commit look like one that never does.
 *
 * ── Line counts: renames are not deletions ─────────────────────────────────
 *
 * Added and deleted lines come from `git.readChurn`, which runs numstat with
 * `-M`. A pure move is `0 0`; a move with edits counts only the edit. The
 * history `lines` map (rename detection OFF, pinned for path fidelity) would
 * read a reorganisation as 100% deleted and 100% added. Paths inside the
 * packs' excluded directories (build output, vendored code) are dropped from
 * every count here: nobody grooms `node_modules`.
 *
 * ── Shallow clones and young repos ─────────────────────────────────────────
 *
 * In a shallow clone the boundary commit "adds" the whole tree, so any window
 * that reaches it would read a repo-sized addition as a day's work. The whole
 * family is absent when the history is shallow and the window (plus the
 * fix look-back) reaches the first commit it has. A repo that is genuinely
 * young reads normally: its root commit really did add everything.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * Per row: one scan of the commits in the trailing window plus the look-back,
 * found by walking back from `index` (not from 0, unlike `retouch`'s scan),
 * with a `Map` of last-touch times. No git, no blobs; `history.churn` is read
 * once per `update`.
 *
 * ── Purity ─────────────────────────────────────────────────────────────────
 *
 * The `History` and `Snapshot` handed in are the whole world, nothing past
 * `index` is read, and every sub-reading is `{value, reason}`: a reading that
 * cannot be taken is absent with the sentence that says why, never 0.
 */
import { isSource, isTestPath, inExcludedDir } from "../source.mjs";
import { nearestRankP95 } from "./size.mjs";

const DAY = 86400;
const WEEKS = 4;

/** See the header: the pinned meaning of "this commit is a fix". */
export const FIX_SUBJECT =
  /^\s*(?:(?:revert|fix|fixes|fixed|bugfix|hotfix)\b|[a-z]+(?:\([^)]*\))?!?:\s*(?:revert|fix|hotfix)\b)/i;

/** A merge commit, by git's own default subject. */
const MERGE_SUBJECT = /^Merge\b/;

/**
 * Per-path class, kept for the life of the process per `SRC` object: a path's
 * class never changes within one configuration, and the scan below asks it of
 * every path of every commit in the window for every row (measured: this was
 * most of the per-row cost).
 * @type {WeakMap<object, Map<string, 0|1|2>>}  0 other, 1 source, 2 test
 */
const CLASS = new WeakMap();
function classOf(path, prereg) {
  let m = CLASS.get(prereg.SRC);
  if (!m) CLASS.set(prereg.SRC, (m = new Map()));
  let c = m.get(path);
  if (c === undefined) {
    c = isSource(path, prereg) ? 1 : isTestPath(path, prereg) && !inExcludedDir(path, prereg.SRC.excludeDirs) ? 2 : 0;
    m.set(path, c);
  }
  return c;
}

const none = (reason) => ({ value: null, reason });

/** Nearest-rank median over an ascending list, same convention as the p95. */
function nearestRankMedian(ascending) {
  return ascending[Math.max(0, Math.ceil(0.5 * ascending.length) - 1)];
}

/** Count desc, then path asc — a total order so the fixture can be compared. */
function byScoreThenPath(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History & {churn?: Map<string, Map<string, {add: number, del: number}>>, shallow?: boolean}} history
 * @param {number} index
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").Measured<object>}
 */
export function measureHabits(snapshot, history, index, prereg) {
  const commits = history?.commits ?? [];
  const here = commits[index];
  if (!here) return none("no commit at index " + index);
  if (!history.churn) return none("no rename-aware line counts were read");

  const windowSecs = prereg.HABITS_WINDOW_DAYS * DAY;
  const fixSecs = prereg.FIX_AFTER_DAYS * DAY;
  const windowStart = here.ts - windowSecs;

  if (history.shallow && commits[0] && commits[0].ts >= windowStart - fixSecs) {
    return none(
      "shallow clone: the history it holds starts at " + commits[0].day +
        ", inside the " + prereg.HABITS_WINDOW_DAYS + "-day window, and that first commit adds the whole tree",
    );
  }

  // First in-window commit, and the first commit of the fix look-back.
  let lo = index;
  while (lo > 0 && commits[lo - 1].ts >= windowStart) lo--;
  let pre = lo;
  while (pre > 0 && commits[pre - 1].ts >= windowStart - fixSecs) pre--;

  const src = prereg.SRC;
  const dirs = src.excludeDirs;
  const pathsOf = (c) => history.touches?.get(c.sha) ?? c.filesTouched ?? [];
  const isBatch = (c) => history.batch?.has(c.sha) ?? c.batch ?? false;
  const isMerge = (c) => MERGE_SUBJECT.test(c.subject ?? "");
  const hasSrc = src.exts.length > 0;
  const hasTests = src.testGlobs.length > 0;

  // ── fix-after-change, tests-with-code: path-level, per subject commit ────
  const lastTouch = new Map();
  let subjects = 0; // subject commits touching source or tests
  let fixes = 0;
  let fixesAfter = 0;
  let srcCommits = 0;
  let withTests = 0;
  for (let i = pre; i <= index; i++) {
    const c = commits[i];
    const all = pathsOf(c);
    const files = hasSrc ? all.filter((p) => classOf(p, prereg) !== 0) : [];
    if (i >= lo && !isBatch(c) && !isMerge(c)) {
      if (files.length) {
        subjects++;
        if (FIX_SUBJECT.test(c.subject ?? "")) {
          fixes++;
          if (files.some((p) => {
            const t = lastTouch.get(p);
            return t !== undefined && Math.abs(c.ts - t) <= fixSecs;
          })) fixesAfter++;
        }
        if (all.some((p) => classOf(p, prereg) === 1)) {
          srcCommits++;
          if (all.some((p) => classOf(p, prereg) === 2)) withTests++;
        }
      }
    }
    // Prior-touch bookkeeping runs for every commit, batch and merge included.
    for (const p of files) lastTouch.set(p, c.ts);
  }

  // ── line-level: totals over everything, per-commit stats over subjects ───
  let added = 0;
  let deleted = 0;
  const weeks = Array.from({ length: WEEKS }, () => ({ added: 0, deleted: 0 }));
  const sizes = [];
  let negative = 0;
  /** path -> churn (added + deleted) over subject commits. */
  const churnOf = new Map();
  for (let i = lo; i <= index; i++) {
    const c = commits[i];
    const files = history.churn.get(c.sha);
    if (!files) continue;
    let a = 0;
    let d = 0;
    for (const [p, v] of files) {
      if (inExcludedDir(p, dirs)) continue;
      a += v.add;
      d += v.del;
    }
    const wk = Math.min(WEEKS - 1, Math.max(0, Math.floor((here.ts - c.ts) / (7 * DAY))));
    weeks[WEEKS - 1 - wk].added += a;
    weeks[WEEKS - 1 - wk].deleted += d;
    added += a;
    deleted += d;
    if (isBatch(c) || isMerge(c) || a + d === 0) continue;
    sizes.push(a + d);
    if (d > a) negative++;
    for (const [p, v] of files) {
      if (inExcludedDir(p, dirs)) continue;
      churnOf.set(p, (churnOf.get(p) ?? 0) + v.add + v.del);
    }
  }
  sizes.sort((x, y) => x - y);

  const noSource = "no active language pack recognises source files in this tree";

  const fix = !hasSrc
    ? none(noSource)
    : subjects === 0
      ? none("no non-batch commit touched source or test files in the trailing " + prereg.HABITS_WINDOW_DAYS + "d")
      : { value: { rate: fixesAfter / subjects, commits: subjects, fixes, fixesAfter } };

  const deletion = added === 0
    ? none("no lines were added in the trailing " + prereg.HABITS_WINDOW_DAYS + "d, so there is nothing to compare deletions with")
    : { value: { ratio: deleted / added, added, deleted, weeks } };

  const netNegative = sizes.length === 0
    ? none("no non-batch, non-merge commit changed a line in the trailing " + prereg.HABITS_WINDOW_DAYS + "d")
    : { value: { share: negative / sizes.length, commits: sizes.length, negative } };

  const commitSize = sizes.length === 0
    ? none("no non-batch, non-merge commit changed a line in the trailing " + prereg.HABITS_WINDOW_DAYS + "d")
    : { value: { p95: nearestRankP95(sizes), median: nearestRankMedian(sizes), commits: sizes.length } };

  const testsWithCode = !hasSrc
    ? none(noSource)
    : !hasTests
      ? none("no active language pack recognises test files in this tree")
      : srcCommits === 0
        ? none("no non-batch commit touched source files in the trailing " + prereg.HABITS_WINDOW_DAYS + "d")
        : { value: { rate: withTests / srcCommits, commits: srcCommits, withTests } };

  // ── hotspots: churn x size, source files that still exist at this sha ────
  let hotspots;
  const files = snapshot?.files ?? [];
  if (!files.length) {
    hotspots = none(noSource);
  } else {
    const locOf = new Map(files.map((f) => [f.path, f.loc]));
    const ranked = [];
    for (const [path, churn] of churnOf) {
      const loc = locOf.get(path);
      if (loc === undefined) continue;
      ranked.push({ path, churn, loc, score: churn * loc });
    }
    ranked.sort(byScoreThenPath);
    hotspots = ranked.length === 0
      ? none("no source file that exists now changed in the trailing " + prereg.HABITS_WINDOW_DAYS + "d")
      : { value: { items: ranked.slice(0, prereg.HABITS_LIST_N) } };
  }

  // Key order is fixed and load-bearing: the row is compared to a fixture.
  return {
    value: {
      windowDays: prereg.HABITS_WINDOW_DAYS,
      fix,
      deletion,
      netNegative,
      testsWithCode,
      commitSize,
      hotspots,
    },
  };
}
