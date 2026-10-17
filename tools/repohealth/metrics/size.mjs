/**
 * How big the files are — as a distribution, plus the one file that is not in it.
 *
 * ── Why a p95 and a max and App.tsx, and not a mean ─────────────────────────
 *
 * A mean over this tree is a number about `App.tsx` and nothing else. At HEAD
 * it is 16,236 lines and the next file down is ~5,375: one file is three times
 * the runner-up and roughly a tenth of every source line in the repo. Any
 * summary statistic that lets it dissolve into the aggregate reports "the files
 * got slightly bigger" on the day something else tripled.
 *
 * So the distribution is read three ways at once. The p95 says what a large
 * file looks like when the outlier is not one of the 5% being ignored. The max
 * comes WITH ITS PATH, because "the biggest file grew 400 lines" is unreadable
 * without knowing whether it is the same file as yesterday — a new file taking
 * the crown and the old champion growing are opposite events with the same
 * number. And `appTsx` is broken out as its own field so the known monolith is
 * tracked by name: a series that only ever says "max: App.tsx" would otherwise
 * tell you nothing about the other 324 files, and one that only said "p95"
 * would never mention the monolith at all.
 *
 * The line-weighted mean, `lineMean`, is the one summary that does not ignore
 * the tail without being eaten by it: Σ loc² / Σ loc, "the length of the file
 * the average LINE lives in". A p95 never sees what the top 5% holds; this
 * does, so giants dominate it — which is the point, because most lines live in
 * them. And splitting one giant in two does not make it jump the way `max`
 * does: the lines move into two smaller files and the mean falls by what they
 * were actually worth. The health index reads it beside `max`.
 *
 * `appTsx` is `null`, never 0, at shas predating the file. A repo with no
 * `App.tsx` and a repo with an empty `App.tsx` are different repos.
 *
 * ── Purity ──────────────────────────────────────────────────────────────────
 *
 * No IO of any kind: `snapshot.files` already carries `loc` per file, computed
 * once per blob oid by the snapshot reader. That is what lets this be driven
 * from hand-built literals in the test with no repo on disk, and what lets a
 * row from a year ago be recomputed byte-identically today.
 */

/**
 * Named here rather than in `PREREG` because it is not a tuning knob: it is the
 * path of a file this metric reports on individually. If the monolith is ever
 * split, this field goes `null` and the p95/max pair carries the story on its
 * own — which is the outcome the metric exists to make visible.
 */
const APP_TSX = "packages/web/src/App.tsx";

/**
 * Nearest-rank p95 over LOC, ascending.
 *
 * Pinned as `ceil(0.95 * n)` into the 1-based sorted ascending list, which is
 * the classic nearest-rank definition: it always returns a value that an actual
 * file actually has (no interpolation between two files that do not exist), it
 * is tie-stable because equal LOCs are interchangeable, and it needs no special
 * case for small n — at n=1 it returns that file. The interpolating definitions
 * (`numpy`'s default, Excel's `PERCENTILE`) differ from this one by a few lines
 * on this tree, which is exactly the size of the differences this series is
 * meant to notice, so the choice is recorded rather than left to a library.
 *
 * @param {number[]} ascending  Sorted ascending. Not copied, not mutated.
 */
function nearestRankP95(ascending) {
  const rank = Math.ceil(0.95 * ascending.length);
  return ascending[Math.max(0, rank - 1)];
}

/**
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History} history
 * @param {number} index
 * @param {object} prereg
 * @returns {import("../types.mjs").Measured<{p95: number, max: number, maxPath: string, appTsx: number|null, nearMax: number, lineMean: number}>}
 */
export function measureSize(snapshot, history, index, prereg) {
  const files = snapshot.files ?? [];
  if (files.length === 0) return { value: null, reason: "no source files at this commit" };

  const ascending = files.map((f) => f.loc).sort((a, b) => a - b);

  // Ties on LOC are broken by path ascending so that two files of identical
  // size cannot make `maxPath` flip between runs — the fixture compares the
  // whole row, and a flapping path is a failure with no cause.
  let max = files[0];
  for (const f of files) {
    if (f.loc > max.loc || (f.loc === max.loc && f.path < max.path)) max = f;
  }

  const app = files.find((f) => f.path === APP_TSX);

  // How many files sit within `SIZE_NEAR_MAX_FRAC` of the largest one, the
  // largest included. A lint cap (`max-lines`) bends the top of the
  // distribution into a shelf: files are cut just under it, p95 barely moves,
  // and the pile under the cap is the queue of splits the next feature lands
  // on. One count shows the shelf where p95 and max cannot. Tile detail, never
  // an index input.
  const nearCut = max.loc * prereg.SIZE_NEAR_MAX_FRAC;
  let nearMax = 0;
  for (const f of files) if (f.loc >= nearCut) nearMax++;

  // Σ loc² / Σ loc. When every file is empty Σ loc is 0 and there is no line
  // to live in a file: 0, the same answer p95 and max give for an all-empty tree.
  let sumLoc = 0;
  let sumSq = 0;
  for (const f of files) {
    sumLoc += f.loc;
    sumSq += f.loc * f.loc;
  }

  return {
    value: {
      p95: nearestRankP95(ascending),
      max: max.loc,
      maxPath: max.path,
      appTsx: app ? app.loc : null,
      nearMax,
      lineMean: sumLoc === 0 ? 0 : Math.round(sumSq / sumLoc),
    },
  };
}
