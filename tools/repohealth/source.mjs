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
 *           excludeDirs: readonly string[], testGlobs: readonly string[],
 *           generated?: readonly {re: RegExp, on: boolean}[], generatedRoot?: string}}} prereg
 */
export function isSource(path, prereg) {
  const src = prereg.SRC;
  if (!src.exts.some((e) => path.endsWith(e))) return false;
  if (src.excludeSuffixes.some((e) => path.endsWith(e))) return false;
  if (inExcludedDir(path, src.excludeDirs)) return false;
  if (isGenerated(path, src.generated, src.generatedRoot)) return false;
  return !isTestPath(path, prereg);
}

/**
 * ── Why a repo can mark a file generated, and why it is read from HEAD ─────
 *
 * `excludeDirs` catches build output by where it lives. It cannot catch a
 * bundle that is COMMITTED on purpose under a directory with an ordinary name:
 * garmin-monorepo vendors a 36,776-line esbuild bundle at
 * `shared/garmin-shared/sdk-mcp/server.mjs` so its MCP server runs without an
 * `npm install`, and that one file was the repo's "longest file", its severe
 * size finding and most of its average-line figure. Nobody edits it; it is not
 * code this repo maintains.
 *
 * The repo already has a standard place to say so: `linguist-generated` and
 * `linguist-vendored` in `.gitattributes`, which GitHub reads for the same
 * reason. Honouring them adds no configuration of our own, and a file marked
 * there is out of GitHub's language stats too.
 *
 * Only the ROOT `.gitattributes` at HEAD is read, once per run, and applied to
 * every commit's tree. HEAD and not each commit's own copy: marking a file
 * generated is a correction of what it always was, so a recut should clean the
 * whole history, including the commits from before anyone wrote the line —
 * and a pattern for a path that no longer exists still matches it in the
 * commits where it did. Nested `.gitattributes` files are not read; the root
 * one is where a repo-wide statement like this belongs.
 *
 * The rules travel in the version string (`census.mjs`), so marking a file
 * moves it and `refuseMixedPrereg` asks for a recut instead of splicing two
 * definitions into one series. A repo with no such lines keeps its string.
 */

/** The two attributes that take a path out of the measured population. */
const GENERATED_ATTRS = Object.freeze(["linguist-generated", "linguist-vendored"]);

/**
 * One gitattributes pattern -> a regex over a repo-relative path, with git's
 * wildmatch rules: a pattern with no slash matches a basename at any depth, a
 * slash anchors it at the root, `*` and `?` stop at `/`, `**` crosses it.
 * Returns null for a pattern that can match no file (a trailing `/` names a
 * directory, and attributes never apply to one).
 */
function attrPatternToRegExp(pattern) {
  if (pattern.endsWith("/")) return null;
  let p = pattern;
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = anchored ? "^" : "^(?:.*/)?";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*" && (i === 0 || p[i - 1] === "/") && (p[i + 2] === "/" || i + 2 === p.length)) {
      // `**/` = any number of directories, `/**` at the end = everything below.
      re += i + 2 === p.length ? ".*" : "(?:.*/)?";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = p.indexOf("]", i + 2);
      if (end < 0) {
        re += "\\[";
      } else {
        let body = p.slice(i + 1, end);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        re += "[" + body.replace(/\\/g, "\\\\") + "]";
        i = end;
      }
    } else if (c === "\\" && i + 1 < p.length) {
      re += p[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$");
}

/**
 * The lines of a `.gitattributes` text that set, unset or clear one of
 * `GENERATED_ATTRS`, in file order — later lines win, as in git.
 *
 * `linguist-generated` and `linguist-generated=true` set it; `-linguist-...`,
 * `!linguist-...` and `=false` clear it. Comments, blank lines, `[attr]` macro
 * definitions and quoted patterns are skipped: the quoted form exists for
 * paths with spaces, and a skipped rule leaves a file measured, which is the
 * old behaviour and never a wrong exclusion.
 *
 * @param {string | null} text
 * @returns {readonly {src: string, re: RegExp, on: boolean}[]}
 */
export function parseGeneratedAttrs(text) {
  const rules = [];
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[attr]") || line.startsWith('"')) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    let on = null;
    for (const a of attrs) {
      const neg = a.startsWith("-") || a.startsWith("!");
      const [name, value] = (neg ? a.slice(1) : a).split("=", 2);
      if (!GENERATED_ATTRS.includes(name)) continue;
      on = !neg && value !== "false";
    }
    if (on === null) continue;
    const re = attrPatternToRegExp(pattern);
    if (re) rules.push(Object.freeze({ src: `${pattern} ${on ? "on" : "off"}`, re, on }));
  }
  return Object.freeze(rules);
}

/**
 * True when the last rule matching `root + path` turned a generated attribute
 * on. `root` is the scope prefix: the rules are written against the repo
 * root, and a scoped census hands this function paths re-rooted at the scope.
 *
 * @param {string} path
 * @param {readonly {re: RegExp, on: boolean}[] | undefined} rules
 * @param {string} [root]  `""`, or the scope with a trailing slash
 */
export function isGenerated(path, rules, root = "") {
  if (!rules?.length) return false;
  const full = root + path;
  let on = false;
  for (const r of rules) if (r.re.test(full)) on = r.on;
  return on;
}
