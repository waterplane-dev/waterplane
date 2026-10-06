/**
 * What counts as a source file — the one predicate every reader of a tree
 * filters against.
 *
 * ── Why this is decided once, and never re-derived by a reader ─────────────
 *
 * "What counts as a source file" is the single most load-bearing definition in
 * this tool: every size, hatch, duplicate and untested-module number is a count
 * over that set, so two modules disagreeing about it would produce two series
 * that both look plausible and cannot both be true. It is decided once, here,
 * against the effective config `census.mjs` builds, and every metric receives
 * the result of calling this rather than a tree to filter for itself.
 *
 * ── Why the filter is applied in JS and never handed to git ─────────────────
 *
 * `git ls-tree packages/*​/src/**​/*.ts` matches 32 files in this repo. The real
 * answer is 325. Git's default pathspec is fnmatch without globstar, so `**`
 * is just `*` and only one directory level below `src/` survives. Nothing
 * errors; the tool simply measures a tenth of the codebase and reports it with
 * the same confidence. So `git.mjs` fetches whole trees and the selection
 * happens here, where it is `String.prototype.endsWith` and can be read.
 *
 * ── Why a test file is not source ───────────────────────────────────────────
 *
 * Tests were already outside the measured population, and they were outside it
 * BY ACCIDENT: `SRC_EXT` was `[".ts", ".tsx"]` and every test in this repo is
 * an `.mjs`, so nothing had to decide anything. The packs claim the whole
 * JS/TS family, `.mjs` included, and that accident becomes a decision — at
 * HEAD, 160 `*.test.mjs` and 99 `scripts/e2e-*.mjs`, 259 files that would walk
 * into `size`, `hatches`, `dups`, `cochange` and `untested` all at once.
 *
 * Which would be wrong in each of them separately, not merely noisy. `untested`
 * would list test files as modules no test names. `dups` would pair the setup
 * boilerplate that every `scripts/e2e-*.mjs` shares by construction.
 * `hatches` would count the `eslint-disable` lines tests legitimately carry.
 * `cochange` would couple every module to its own test, which is the one pair
 * that tells you nothing. And the LOC total would stop being the size of the
 * thing being maintained.
 *
 * A test file is still READ — `snapshot.tests` carries the same corpus, from
 * the same globs, so `untested` can ask what the tests name and `deadExports`
 * can count a test as a user of an export. It is a population, not a filter
 * applied twice: the globs live in the packs, `census.mjs` unions them into
 * `SRC.testGlobs`, and both readers compile that one list.
 */

/**
 * A glob array -> its compiled regexes. Keyed by the frozen array the config
 * holds, so the whole backfill compiles each pattern once; a `WeakMap` because
 * the key is the config's own object and nothing should keep it alive.
 */
const GLOB_CACHE = new WeakMap();

/**
 * `**​/` crosses directories, `*` does not. Everything else is escaped.
 *
 * Compiled rather than hardcoded, so that editing a pack's `testGlobs`
 * actually changes what is measured — which is the whole point of the globs
 * being declared in one place.
 */
function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      re += "(?:[^/]+/)*";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$");
}

function globsOf(testGlobs) {
  let res = GLOB_CACHE.get(testGlobs);
  if (!res) GLOB_CACHE.set(testGlobs, (res = testGlobs.map(globToRegExp)));
  return res;
}

/**
 * True when any SEGMENT of `path` is one of `dirs`.
 *
 * A segment test and not a prefix test: `packages/web/dist/main.js` is build
 * output wherever `dist` sits in the path, and anchoring at the front would
 * catch only the ones at the repo root. `census.mjs` owns the list of names
 * and its reasoning; the predicate is here because this is where path
 * predicates live, and because three callers need it — the pack-activation
 * scan, `isSource`, and the manifest selection in `snapshot.mjs` — and a
 * second copy would be a second definition of what code belongs to this
 * project.
 *
 * @param {string} path
 * @param {readonly string[]} dirs
 */
export function inExcludedDir(path, dirs) {
  for (const seg of path.split("/")) if (dirs.includes(seg)) return true;
  return false;
}

/**
 * True for a path some active pack calls a test.
 *
 * `snapshot.mjs` uses it to collect the test corpus and `isSource` uses it to
 * keep that corpus out of the measured population — one definition, two
 * readers, so a file can never be both a module and the test that covers it.
 *
 * @param {string} path
 * @param {{SRC: {testGlobs: readonly string[]}}} prereg
 */
export function isTestPath(path, prereg) {
  return globsOf(prereg.SRC.testGlobs).some((re) => re.test(path));
}

/**
 * True for a path the effective config calls source. The whole definition.
 *
 * Four checks, in the order that rejects most cheaply first: the extension
 * must belong to an active pack, it must not be an excluded suffix (a `.d.ts`
 * describes code that lives elsewhere), no segment of the path may be an
 * excluded directory (build output and vendored code are not this project's),
 * and it must not be a test.
 *
 * In a repo no pack claims, `SRC.exts` is empty and this answers false for
 * every path. That is deliberate — see `census.mjs`. The metrics then report
 * absent with a reason, which is the true statement; a zero would not be.
 *
 * @param {string} path
 * @param {{SRC: {exts: readonly string[], excludeSuffixes: readonly string[],
 *           excludeDirs: readonly string[], testGlobs: readonly string[]}}} prereg
 */
export function isSource(path, prereg) {
  const src = prereg.SRC;
  if (!src.exts.some((e) => path.endsWith(e))) return false;
  if (src.excludeSuffixes.some((e) => path.endsWith(e))) return false;
  if (inExcludedDir(path, src.excludeDirs)) return false;
  return !isTestPath(path, prereg);
}
