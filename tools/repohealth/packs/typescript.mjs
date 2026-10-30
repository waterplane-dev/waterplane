/**
 * The TypeScript/JavaScript pack: everything the engine knows that is a fact
 * about this language family rather than about measurement.
 *
 * ── Why this is a pack and not a constant ───────────────────────────────────
 *
 * `constants.mjs` used to hold `SRC_EXT`, `SRC_EXCLUDE_SUFFIX`, `HATCH_KINDS`
 * and `UNTESTED_TEST_GLOBS` in the same frozen block as the rank window, the
 * LOC convention and the re-touch clocks. Those two halves are not the same
 * kind of thing. The window and the clocks are the METHOD: they are what makes
 * two readings comparable, and they are identical in every repo. `: any` and
 * `*.test.mjs` are a fact about one language. Leaving them pinned as
 * universals is what made a Kotlin repo's source invisible while the engine
 * reported its numbers with the same confidence.
 *
 * Measured over the thirteen repositories under `~/dev` that have any
 * committed files, counting tree entries at HEAD outside the excluded
 * directories: `.ts`/`.tsx` appear in six of them, `.kt` in five (239, 105,
 * 85, 29 and 10 files), `.py` in four (343, 297, 140 and 52) and `.dart` in
 * two (67 and 13). `Tiptoi` is the case that makes the point twice over: 239
 * Kotlin files and 140 Python files that no pack here can read, and 32 `.js`
 * files that activate this one — so it IS measured, and what it is measured on
 * is its web front end and nothing else. The row says which, because the
 * active pack travels with its file count.
 *
 * ── The extensions were widened, deliberately, and this changed the count ───
 *
 * `SRC_EXT` was `[".ts", ".tsx"]`. This pack claims the whole family —
 * `.ts .tsx .js .jsx .mjs .cjs .mts .cts` — because a pack is supposed to describe a
 * language, and a repo that is half `.mjs` is not half unmeasured. It is also
 * what brings two more of the fleet into view at all: `Tiptoi` (32 `.js`, no
 * TypeScript anywhere) and `webcam` (16) activate no pack under a `.ts`-only
 * definition and are read by this one. It is a CHANGE OF WHAT IS MEASURED and
 * it is stated here rather than discovered later: at waterplane's HEAD the old
 * definition selected 335 files (`packages/**​/src/**​/*.ts{,x}`); the new one,
 * after the test globs and the excluded directories below are taken out,
 * selects 374 — the same 335, none of them dropped, plus 39 that were
 * invisible: `tools/**` (25), `scripts/**` (8), four files under `packages/`
 * that sit outside a `src/`, and two at the repo root.
 * `tools/repohealth/` measuring itself is a consequence of that and is
 * the honest one: those files are source, they are written by the same agents,
 * and a tool that exempted itself from its own size and duplicate rows would
 * be reporting on a tree it had quietly cut a hole in.
 *
 * `.mts` and `.cts` were missing from that list until `typescript@6`, and the
 * hole was the size of a layer: every in-repo extension's host and shared code
 * is `.mts` (95 files, 29,415 lines at waterplane's HEAD on 2026-10-18,
 * among them the largest file in the tree at 5,790 lines). Size, hatches and
 * untested never saw any of it; a test importing `../shared/skill.mts` named
 * nothing. `.d.mts` / `.d.cts` are excluded beside `.d.ts`, and the test
 * suffixes gained the two extensions, for the same reasons the others have them.
 *
 * It also makes the test exclusion in `source.mjs` load-bearing for the first
 * time. Under `[".ts", ".tsx"]` every `*.test.mjs` and every
 * `scripts/e2e-*.mjs` was excluded by accident, because `.mjs` was not an
 * extension. At HEAD that is 160 test files and 99 e2e scripts — 259 files
 * that would otherwise walk straight into the measured set the moment `.mjs`
 * became source. `source.mjs` now excludes them on purpose, using the globs
 * below, and says so.
 *
 * ── The test globs were this repo's conventions, and are now the family's ──
 *
 * `["**​/*.test.mjs", "scripts/e2e-*.mjs"]` is how waterplane writes a test. It is
 * how almost nobody else does, and a pack is supposed to describe a language.
 * Counted at HEAD with `git ls-tree -r --name-only`, files ending
 * `.test.<ext>` or `.spec.<ext>` in this family: `FeedbackPlatform` 170,
 * `todolist` 36, `realestatecalc` 23, `personal-podcast-news` 9, `Tiptoi` and
 * `trading` 4 each, `webcam` 2 — and not one of them was a `.mjs`, so every
 * one was counted as a module of the project being measured.
 *
 * What that cost is visible in each row separately, which is the argument
 * `tools/repohealth/source.mjs` makes: a test inside the measured population
 * moves `size`, `hatches`, `dups`, `cochange` and `classics.files`, and
 * OUTSIDE the corpus it moves `untested`. `FeedbackPlatform` had both ends of
 * it at once — `classics.files` 660 with `apps/web/test` (99 files) and
 * `apps/web/e2e` (24) inside it, a `dups` pair whose two halves were two test
 * files agreeing on their setup boilerplate, and
 * `untested: {value: null, reason: "no tests at this commit"}` in a repo with
 * 170 of them.
 *
 * So the globs below are the family's three conventions — the `*.test.*` and
 * `*.spec.*` suffixes, and the directories a suite lives in — and waterplane's own
 * `scripts/e2e-*.mjs` is kept beside them. Taking both halves together, the
 * files this pack now calls tests: `FeedbackPlatform` 187 of 656 JS/TS files,
 * `todolist` 37 of 102, `realestatecalc` 24 of 436, `personal-podcast-news`
 * 10 of 127, `Tiptoi` 5 of 32, `trading` 4 of 155, `webcam` 2 of 16.
 *
 * In THIS repo the widening moves the source set by nothing at all: 391
 * source files before and 391 after, none gained and none lost, because every
 * test here was already a `*.test.mjs` or an e2e script and both were already
 * matched. What it does move is the corpus — `packages/host/test/**` was
 * already in it through `*.test.mjs`, and the directory glob adds the 18
 * non-`.mjs` files beside them: two `README.md`s, an `ExampleUnitTest.java`
 * that no pack reads, and 15 recorded-terminal fixtures. `untested` is unchanged
 * at 227 modules with them in the corpus, which is the check that mattered —
 * a fixture that happened to print a module's path would have marked that
 * module covered.
 *
 * ── What this pack does NOT detect ──────────────────────────────────────────
 *
 *   - **`TODO` and `FIXME`.** They are in `packs/common.mjs`, because they are
 *     written the same way in every language and counting them twice would
 *     collide on the kind name.
 *   - **Renamed clones.** The analyzer normalises string and numeric literals
 *     and NOT identifiers, so a copy under new names does not pair. That is
 *     `PREREG.DUP_NORMALISE`'s decision and the reasoning is there.
 *   - **Anything at all when `typescript` is not installed.** The parser is
 *     the compiler's own, loaded from the tree being measured. Where it is
 *     absent `analyzer()` returns `null`, `dups` and `deadExports` report
 *     `{value: null, reason}` and nothing reports a zero — see
 *     `lang/typescript-ast.mjs`.
 *   - **Coverage.** `mentions` answers whether a test NAMES a module and
 *     `imports` which modules a file LOADS; neither says which lines ran. `metrics/untested.mjs` argues that out at
 *     length and this pack only supplies the language half of it.
 *   - **Transitive or workspace dependency resolution.** `manifests` counts
 *     the keys declared in each `package.json` and resolves nothing: no lock
 *     file is read, no version is compared, a workspace link counts as a
 *     dependency like any other. (`graphImports` does map a workspace
 *     package's NAME to its directory — which module an import loads, never
 *     which version — through `lang/typescript-resolve.mjs`.)
 *   - **Any other JS-adjacent manifest.** `deno.json`, `jsr.json` and
 *     `bower.json` are not read; `tsconfig.json` is read for its `paths` and
 *     `baseUrl` only, by `graphContext`.
 */
import { NO_TYPESCRIPT, contentKey, identsOf, loadTypeScript, signedBlocks } from "../lang/typescript-ast.mjs";
import { RESOLVE_CONFIG_PATH, buildResolveContext, resolveSpecifier } from "../lang/typescript-resolve.mjs";

/**
 * The source extensions this pack claims. Module-level rather than written
 * inline in the export, because `PATH_REF` below is BUILT from it — see there.
 */
const EXTS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * What a build writes that a test may import IN PLACE of the source: the host
 * tests import `../dist/echo.js` about `src/echo.ts`. Declared beside `EXTS`
 * so that the extensions a reference may carry are `EXTS ∪ EMITS` — one
 * derivation, never a second list. Here `.js` is in both, and the set says so
 * once.
 */
const EMITS = Object.freeze([".js"]);

/** `[".ts", ".mjs"]` -> `mjs|ts`, longest first so an alternation can never
 *  settle on `ts` where `tsx` was written, and regex-escaped. */
function extAlternation(exts) {
  return [...new Set(exts.map((e) => e.replace(/^\./, "")))]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

/**
 * One path reference in a test's text: the directory part, then the basename,
 * then either an accepted extension or the closing quote of an extensionless
 * specifier.
 *
 * The accepted extensions are DERIVED, `EXTS ∪ EMITS`, never typed out. They
 * used to be the literal `tsx|ts|js`, written when the pack claimed `.ts` and
 * `.tsx` only; when `EXTS` widened to the whole JS family that literal did not
 * move, so every `.mjs` module a test imported by its file name —
 * `import … from "./repohealth/metrics/untested.mjs"` — was measured as
 * named by no test: 108 of 854 entries at the time it was found. Two lists that
 * must agree drift; one list and a derivation cannot.
 *
 * The lookbehind anchors the match at the start of the path — which is what
 * makes the directory part capturable, and, as a side effect, is the left
 * boundary that stops `smartpickstore.js` naming `store`. The `(?![\w])` after
 * the extension is the right boundary: without it `.js` matches inside
 * `.json`, and at HEAD `scripts/e2e-notifyprefs.mjs` reading `.waterplane/notify.json`
 * marked `packages/shared/src/wire/notify.ts` tested.
 */
const PATH_REF = new RegExp(
  "(?<![\\w$.\\-/])" +
    "((?:\\.{0,2}/)?(?:[\\w$.-]+/)*)" +
    "([\\w$-]+)" +
    `(?:\\.(${extAlternation([...EXTS, ...EMITS])})(?![\\w])|(?=["']))`,
  "g",
);

/**
 * The specifier of an IMPORT, as opposed to any path a file happens to spell:
 * `from "x"` (which covers `import … from` and `export … from`), a bare
 * `import "x"`, a dynamic `import("x")` and `require("x")`. Group 2 is the
 * specifier.
 *
 * `imports` reads this and `mentions` does not, and the difference is the
 * point: `packages/web/src/createOp.test.mjs` `readFileSync`s `./App.tsx`,
 * which NAMES App and runs none of it. Followed as an edge, that one string
 * would mark every module App imports as reached by a test.
 *
 * `import type … from` and `export type … from` are matched and then SKIPPED
 * (group 1): the compiler and node's type stripping erase them, so they load
 * nothing. Followed, they were the widest wrong edge in this tree —
 * `features/setup/logic.ts` type-imports `./store`, and through it one test
 * "reached" 361 modules for a week of the series. A named list whose every
 * member is `type` (`import { type A } from`) is still an edge: under
 * `verbatimModuleSyntax` it survives as `import {} from`, which runs the
 * module.
 */
const IMPORT_SPEC =
  /\b(?:import|export)\s+(type\s+)?[\w$*{}\s,]*?\bfrom\s*(["'])([^"'\n]+)\2|\b(?:import\s*\(\s*|import\s*|require\s*\(\s*)(["'])([^"'\n]+)\4/g;

/** `packages/web/src/foo/bar.tsx` -> `bar`. */
function basename(path) {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  return dot <= 0 ? file : file.slice(0, dot);
}

/** `packages/web/src/foo/bar.tsx` -> `["packages", "web", "src", "foo"]`. */
function dirSegments(path) {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

/**
 * The directory a reference points at, as segments.
 *
 * `base` is the directory of the file the reference was written in and is
 * consulted only for a reference that starts `./` or `../`; an absolute-
 * looking `/api/...` is treated as repo-relative, because in this corpus that
 * shape is a URL and not a path into the tree. `..` above the root clamps
 * rather than escaping, so a malformed reference degrades to a shorter path
 * and never to a key that could match anything.
 */
function resolveDir(dir, base) {
  const raw = dir.split("/").filter((s) => s.length > 0);
  const relative = raw[0] === "." || raw[0] === "..";
  const out = relative ? [...base] : [];
  for (const seg of raw) {
    if (seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out;
}

/**
 * The keys every `PATH_REF` in `text` names, added to `out`. `mentions` and
 * `imports` both end here, so a reference means the same key whichever of
 * them read it.
 */
function refKeys(text, base, requireDir, out) {
  for (const m of text.matchAll(PATH_REF)) {
    if (!requireDir) {
      if (m[3] || m[1]) out.add(m[2]);
      continue;
    }
    const dir = resolveDir(m[1], base);
    // No directory at all is the bare basename — the case the rule rejects.
    if (dir.length) out.add(dir.join("/") + "/" + m[2]);
  }
}

/**
 * A specifier naming something that is not a module of this family — a
 * stylesheet, an image, JSON, another framework's component file. It loads
 * bytes, not code this pack measures, so it is neither an edge nor a miss.
 */
const ASSET_SPEC = /\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|json|md|mdx|html?|txt|wasm|woff2?|ttf|otf|mp3|mp4|webm|wav|ya?ml|graphql|gql|vue|svelte|astro)(?:\?.*)?$/i;

/** A repo path's extension as this family writes it, declarations included. */
const CODE_EXT = new RegExp(`(?:\\.d)?\\.(?:${extAlternation([...EXTS, ...EMITS])})$`);

/**
 * The one key a resolved repo path answers to — its full `dir/name`, which is
 * always among `keysFor` of the module there (and of an `index` under it,
 * which answers to its directory). `null` for a file at the tree's root,
 * which `keysFor` offers no key for either.
 */
function pathKey(repoPath) {
  const bare = repoPath.replace(CODE_EXT, "");
  return bare.includes("/") ? bare : null;
}

/** Specifiers per blob, for `graphImports`: the regex pass is the cost. */
const SPECS_MEMO = new Map();
function specsOf(file) {
  const scan = () => {
    const out = [];
    for (const m of file.text.matchAll(IMPORT_SPEC)) {
      if (m[1]) continue; // `import type`: erased, loads nothing — the rule `imports` reads by.
      const spec = m[3] ?? m[5];
      if (!ASSET_SPEC.test(spec) && !out.includes(spec)) out.push(spec);
    }
    return out;
  };
  if (!file.oid) return scan();
  let specs = SPECS_MEMO.get(file.oid);
  if (!specs) SPECS_MEMO.set(file.oid, (specs = scan()));
  return specs;
}

export default Object.freeze({
  name: "typescript",
  // 2: the test globs stopped being this repo's conventions and became the
  // family's. See the header — it is a change of what is measured in every
  // JS/TS repo but this one.
  // 3: a mention may carry any extension the pack claims (`EXTS ∪ EMITS`),
  // a directory's `index` answers to the directory, and `imports` exists.
  // 4: `import type` / `export type` are not edges — they load nothing.
  // 5: `hatchExplain` exists — which escapes carry their reason (see below).
  // 6: `.mts` / `.cts` are source (and `.d.mts` / `.d.cts` are not) — see the header.
  // 7: `graphConfigPath`, `graphContext` and `graphImports` exist — the import
  //    graph, aliases and workspace packages resolved (`lang/typescript-resolve.mjs`).
  version: "7",

  /** Activates when the tree at HEAD carries one of these. See the header. */
  exts: EXTS,

  /** See `EMITS`. */
  emits: EMITS,

  /**
   * A `.d.ts` (or `.d.mts` / `.d.cts`) is a declaration emitted or hand-written to describe code that
   * lives somewhere else. Counting it as source double-counts every module it
   * describes and inflates the LOC total with lines nobody wrote by hand.
   */
  excludeSuffixes: Object.freeze([".d.ts", ".d.mts", ".d.cts"]),

  /**
   * What a test file looks like in this family — the family's conventions,
   * not one repo's. `**​/` crosses directories; `*` does not.
   *
   * Two readers, one definition. `source.mjs` uses it to keep tests OUT of the
   * measured population, and `snapshot.mjs` uses it to collect the corpus that
   * `mentions` then reads. Before the extensions widened these two uses could
   * not disagree, because `.mjs` was not source; now they must be the same
   * list, or a file would be both a module and the test that covers it.
   *
   * The list is written out one entry per shape because `globToRegExp` in
   * `source.mjs` supports `**​/` and `*` and nothing else — no braces — so
   * `*.test.{ts,tsx,js}` would compile to a pattern that matches a file
   * literally named that.
   *
   * They are unioned with every other active pack's and applied to a PATH,
   * never to a language: `census.mjs` merges the lists and `source.mjs` asks
   * only whether a path matches. So the directory globs below are this pack's
   * contribution to a mixed repo as well as to a JS one — `trading`'s
   * `mobile/test/widget/widget_test.dart` leaves the measured population
   * because that repo activates this pack, and `packs/dart.mjs`'s header says
   * so where it declines a Dart convention of its own.
   *
   * Three families of shape, and each is here because the family writes it:
   * the `*.test.*` and `*.spec.*` suffixes that every JS runner discovers by,
   * the directories that hold a suite (`test/`, `tests/`, `__tests__/`,
   * `e2e/`), and `scripts/e2e-*.mjs`, which is waterplane's own and stays because a
   * glob that finds nothing elsewhere costs nothing.
   */
  testGlobs: Object.freeze([
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.test.js",
    "**/*.test.jsx",
    "**/*.test.mjs",
    "**/*.test.cjs",
    "**/*.test.mts",
    "**/*.test.cts",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.spec.js",
    "**/*.spec.jsx",
    "**/*.spec.mjs",
    "**/*.spec.cjs",
    "**/*.spec.mts",
    "**/*.spec.cts",
    "**/test/**/*",
    "**/tests/**/*",
    "**/__tests__/**/*",
    "**/e2e/**/*",
    "scripts/e2e-*.mjs",
  ]),

  /**
   * The TypeScript half of the escape hatches, as regex SOURCE — compiled by
   * `hatches.mjs` per call, never stored compiled, because a module-level
   * global regex carries `lastIndex` between calls.
   *
   * Counted as OCCURRENCES (`matchAll`), not matching lines, and word-bounded.
   * Unbounded `as any` counts "has any" and "was any" in prose: at the time
   * this was measured that is 32 substring hits against 8 real ones. `grep -c`
   * counts lines, which is a third number again. The fixture is the authority
   * over all three.
   *
   * `tsIgnore` and `tsNocheck` were at zero when this list was written and are
   * kept in it on purpose: the "a new kind of escape hatch appeared" tripwire
   * needs a NAME to fire on, and a kind absent from this list can never fire.
   * `tsExpectError` was at 1, not 0 — `packages/web/src/hostUrl.ts:184`, a
   * deliberate variadic passthrough. Worth stating because the brief this was
   * written from asserted zero: a hand-counted baseline is exactly the kind of
   * number the fixture exists to replace.
   *
   * `todo` and `fixme` are NOT here. They are `common`'s, and `census.mjs`
   * refuses a merge in which two packs claim one kind name — the tripwire
   * fires on the name, so a shadowed kind is a tripwire that silently reports
   * somebody else's count.
   */
  hatchKinds: Object.freeze({
    colonAny: ":\\s*any\\b",
    asAny: "\\bas any\\b",
    asUnknownAs: "\\bas unknown as\\b",
    eslintDisable: "eslint-disable",
    tsIgnore: "@ts-ignore\\b",
    tsExpectError: "@ts-expect-error\\b",
    tsNocheck: "@ts-nocheck\\b",
  }),

  /**
   * When an escape carries its own reason — `hatches.mjs` reads this to split
   * every occurrence into EXPLAINED and UNEXPLAINED, and the health index
   * counts only the second.
   *
   * Two ways to be explained, and nothing else:
   *
   *   - **On the same line, after the mark** — `after[kind]`, regex SOURCE
   *     tested against the rest of the line past the match. ESLint has a
   *     syntax for it, ` -- why` after the rule list, and it is the only one
   *     accepted for `eslintDisable`: a rule NAME after the directive is not a
   *     reason, and `// eslint-disable-next-line react-hooks/exhaustive-deps`
   *     is exactly the bare form the reason is there to replace. The three
   *     `@ts-*` directives take any words after them (`@ts-expect-error the
   *     DOM lib lags`), which TypeScript itself allows. The code-shaped kinds
   *     (`: any`, `as any`, `as unknown as`) take a trailing comment.
   *   - **On the line directly above** — `commentLine`: a comment line with
   *     words in it that is not itself an escape. The line above a
   *     `// eslint-disable-next-line` is the natural place to say why, and
   *     a directive stacked on a directive explains nothing.
   */
  hatchExplain: Object.freeze({
    commentLine: "^\\s*(?://|/\\*|\\*)",
    after: Object.freeze({
      colonAny: "(?://|/\\*)\\s*[A-Za-z]{2}",
      asAny: "(?://|/\\*)\\s*[A-Za-z]{2}",
      asUnknownAs: "(?://|/\\*)\\s*[A-Za-z]{2}",
      eslintDisable: "\\s--\\s*[A-Za-z]{2}",
      tsIgnore: "^[\\s:—-]*[A-Za-z]{2}",
      tsExpectError: "^[\\s:—-]*[A-Za-z]{2}",
      tsNocheck: "^[\\s:—-]*[A-Za-z]{2}",
    }),
  }),

  /**
   * Which tree entries are dependency manifests, as regex SOURCE over the
   * repo-relative path.
   *
   * A `package.json` AT ANY DEPTH, generalised from the
   * `^packages/([^/]+)/package\.json$` that `snapshot.mjs` used to hardcode.
   * That pattern was a statement about one monorepo's layout: it found this
   * repo's four workspace manifests and would find nothing at all in a repo
   * that keeps its packages under `apps/` or `libs/`, or in a single-package
   * project whose only manifest is at the root — which the old pattern handled
   * only by naming `package.json` a second time, as a special case, in the
   * caller. Depth is not a property of a manifest.
   *
   * `snapshot.mjs` applies the shared excluded-directory check to the result,
   * so a committed `node_modules/*​/package.json` — or one under `vendor/` —
   * is not counted as this project's own declaration.
   */
  manifestPath: "(?:^|/)package\\.json$",

  /**
   * `{pkg, deps, devDeps}` per manifest, or `null` when the tree has none.
   *
   * `null` and `[]` are different claims and only `null` is honest here: "this
   * commit has no manifest" is not "this project depends on nothing", and
   * `classics.mjs` turns the absence into `deps: null` rather than a row of
   * zeros.
   *
   * `pkg` is the manifest's DIRECTORY, `"."` for one at the repo root. It used
   * to be the bare workspace name (`web`, and `root` for the root one), which
   * is a label that cannot survive two manifests of the same basename at
   * different depths — and which quietly assumed every manifest is exactly two
   * segments deep. A directory path is unique by construction.
   *
   * `deps` and `devDeps` are counted separately and never summed: a runtime
   * dependency ships and is in the attack surface, a dev dependency is a
   * build-time cost. Unparseable JSON counts as zero of each rather than
   * throwing — a malformed manifest at some historical sha must not take the
   * whole backfill down.
   *
   * @param {{path: string, oid: string}[]} entries  Already filtered to
   *   `manifestPath` and to paths no excluded directory contains.
   * @param {(entry: {path: string, oid: string}) => string} textOf
   */
  manifests(entries, textOf) {
    if (entries.length === 0) return null;
    return entries
      .map((e) => {
        const slash = e.path.lastIndexOf("/");
        const pkg = slash === -1 ? "." : e.path.slice(0, slash);
        let json = {};
        try {
          json = JSON.parse(textOf(e));
        } catch {
          json = {};
        }
        return {
          pkg,
          deps: Object.keys(json.dependencies ?? {}).length,
          devDeps: Object.keys(json.devDependencies ?? {}).length,
        };
      })
      .sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
  },

  /**
   * Every `dir/name` key one test file's text names.
   *
   * The corpus is tokenised ONCE into a Set and each candidate module then
   * asks the Set about the handful of keys its own path could answer to. The
   * obvious loop — one regex per candidate module over every test file, per
   * commit, over the whole history — is hundreds of gigabytes scanned to
   * answer a set-membership question.
   *
   * A reference is normalised against the file that wrote it, so `./x` and
   * `../dist/x.js` mean exactly one directory, and a leading `/` is treated as
   * repo-relative because in this corpus that shape is a URL.
   *
   * @param {string} text  The test file's contents.
   * @param {string} path  Its repo-relative path — relative specifiers resolve
   *   against this, which is what makes `./` references carry a directory at
   *   all and what stops `./api.js` in a web test naming the host's `api.ts`.
   * @param {{requireDir?: boolean}} [opts]  `requireDir: false` restores the
   *   bare-basename rule `PREREG.UNTESTED_REQUIRE_DIR_SEGMENT` switches off.
   *   Kept exact, so turning that constant off restores the previous
   *   definition and not a third one — a fallback that differs from what it
   *   replaces is a metric nobody can reproduce.
   * @returns {Set<string>}
   */
  mentions(text, path, opts = {}) {
    const out = new Set();
    refKeys(text, dirSegments(path ?? ""), opts.requireDir !== false, out);
    return out;
  },

  /**
   * Every `dir/name` key one file's IMPORTS name — the edges `untested`
   * follows from a test to what it runs, and from a module to what it runs.
   *
   * The same keys `mentions` produces, read off a narrower part of the text:
   * only the specifier of an import statement (`IMPORT_SPEC`), and only a
   * RELATIVE one. A bare specifier (`react`, `@waterplane/shared`) names a
   * package by its manifest name, and resolving that is a workspace lookup
   * this pack does not make — so such an import contributes no edge, which
   * leaves a module reached only that way on the list rather than marking it
   * reached on a guess.
   *
   * @param {string} text  The file's contents.
   * @param {string} path  Its repo-relative path.
   * @param {{requireDir?: boolean}} [opts]  As for `mentions`.
   * @returns {Set<string>}
   */
  imports(text, path, opts = {}) {
    const requireDir = opts.requireDir !== false;
    const base = dirSegments(path ?? "");
    const out = new Set();
    for (const m of text.matchAll(IMPORT_SPEC)) {
      if (m[1]) continue; // `import type` / `export type`: erased, loads nothing.
      const spec = m[3] ?? m[5];
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      // Re-quoted so the extensionless form meets the closing quote
      // `PATH_REF` looks for — the specifier is read by the one rule that
      // reads every other reference.
      refKeys(`"${spec}"`, base, requireDir, out);
    }
    return out;
  },

  /**
   * The config files `graphContext` reads — every `tsconfig*.json`,
   * `jsconfig*.json` and `package.json` — as regex source over a tree path.
   */
  graphConfigPath: RESOLVE_CONFIG_PATH,

  /** The resolver's data for one tree: aliases by scope, workspace packages. */
  graphContext(entries, textOf) {
    return buildResolveContext(entries, textOf);
  },

  /**
   * Every module one file LOADS, for `metrics/graph.mjs`: relative specifiers
   * as `imports` reads them, plus the ones `imports` leaves alone —
   * `tsconfig` aliases, workspace packages, `#` subpath imports, `baseUrl`.
   *
   * One entry per specifier: `candidates` are keys in the order the resolver
   * tries them (the first one that is a module is the edge), and `internal`
   * says a specifier that hits no module is a MISS — this project's code that
   * was not found — rather than a package from outside. An external package
   * and an asset produce no entry at all.
   *
   * @param {{path: string, oid?: string, text: string}} file
   * @param {object | null} ctx  What `graphContext` returned for this tree.
   * @returns {{spec: string, internal: boolean, candidates: string[]}[]}
   */
  graphImports(file, ctx) {
    const base = dirSegments(file.path ?? "");
    const out = [];
    for (const spec of specsOf(file)) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const keys = new Set();
        refKeys(`"${spec}"`, base, true, keys);
        if (keys.size) out.push({ spec, internal: true, candidates: [...keys] });
        continue;
      }
      const r = resolveSpecifier(spec, file.path ?? "", ctx);
      if (!r) continue;
      const candidates = r.candidates.filter((p) => !ASSET_SPEC.test(p)).map(pathKey).filter((k) => k !== null);
      if (r.candidates.length && !candidates.length && r.candidates.every((p) => ASSET_SPEC.test(p))) continue;
      out.push({ spec, internal: r.internal, candidates });
    }
    return out;
  },

  /**
   * Every `dir/name` key the module at `path` answers to: each non-empty
   * suffix of its own directory, and of its compiled mirror.
   *
   * Suffixes rather than the full path alone, because a test may name only
   * part of the path (`web/src/link`); non-empty, because the empty suffix is
   * the bare basename the rule exists to reject.
   *
   * The `src` → `dist` mirror is the TypeScript-specific half and is why this
   * function is in a pack: the host tests import compiled output, so
   * `packages/host/src/echo.ts` must also answer to `packages/host/dist/echo`.
   * The mirror is generated on the MODULE side rather than rewritten on the
   * mention side, so what a test actually wrote is never edited before it is
   * compared.
   *
   * An `index` module also answers to its DIRECTORY, because that is how the
   * family resolves `import … from "./features/backlog"`: to
   * `features/backlog/index.ts`. Without it every barrel is unreachable by the
   * one specifier that is written about it, and so is everything only the
   * barrel imports. The directory's own key still needs a directory segment
   * above it, so a top-level `foo/index.ts` answers to `foo/index` alone.
   *
   * @param {string} path
   * @returns {string[]}
   */
  keysFor(path) {
    const name = basename(path);
    const segs = dirSegments(path);
    const mirrors = segs.includes("src") ? [segs, segs.map((s) => (s === "src" ? "dist" : s))] : [segs];
    const keys = [];
    for (const dir of mirrors) {
      for (let i = 0; i < dir.length; i++) keys.push(dir.slice(i).join("/") + "/" + name);
      if (name === "index" && dir.length > 1) {
        const parent = dir.slice(0, -1);
        const self = dir[dir.length - 1];
        for (let i = 0; i < parent.length; i++) keys.push(parent.slice(i).join("/") + "/" + self);
      }
    }
    return keys;
  },

  /**
   * The parser `dups` and `deadExports` need, or `null` when it cannot be
   * loaded.
   *
   * `null` is not a failure path to be smoothed over: it is the reason those
   * two metrics can say "nothing read this code" instead of reporting zero
   * duplicate pairs over a tree no analyzer opened. `analyzerReason` is the
   * sentence that travels with the absence.
   *
   * The two memos inside `lang/typescript-ast.mjs` are keyed by blob oid,
   * which names the same bytes forever, so `blocks` and `idents` may be called
   * once per file per commit without re-parsing anything.
   *
   * @returns {{blocks: Function, idents: Function} | null}
   */
  analyzer() {
    const ts = loadTypeScript();
    if (!ts) return null;
    return {
      /**
       * Signed duplicate-candidate blocks of one source file.
       * @param {{oid: string, path: string, text: string}} file
       * @param {{minLines: number, shingle: number, hashes: number, nested: boolean}} params
       */
      blocks: (file, params) => signedBlocks(ts, file.oid, file.path, file.text, params),
      /**
       * `{exports, identifiers}` of one file. A test file has no blob oid in
       * the snapshot, so its text hashes to a content key instead — same memo,
       * same guarantee that a key names one set of bytes.
       * @param {{oid?: string, path: string, text: string}} file
       */
      idents: (file) => identsOf(ts, file.oid ?? contentKey(file.text), file.path, file.text),
    };
  },

  /** The sentence `dups` and `deadExports` print when `analyzer()` is null. */
  analyzerReason: NO_TYPESCRIPT,
});
