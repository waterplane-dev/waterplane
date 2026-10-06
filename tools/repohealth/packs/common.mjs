/**
 * The language pack that is always on, and owns no language.
 *
 * ── Why a pack with no extensions exists at all ─────────────────────────────
 *
 * Every other pack claims a file family and activates when the tree at HEAD
 * carries one of its extensions. That rule alone gives a repo written in
 * something this engine has never heard of an EMPTY pack list, and an empty
 * pack list is a config with no hatch kinds in it — which is not "we found no
 * escape hatches", it is "the row has no `hatches` shape at all", and the
 * tripwire that fires when a new kind of hatch appears has nothing to compare
 * against. `common` is the floor that stops that: it is active in every repo,
 * including one whose whole source tree is invisible to every other pack.
 *
 * ── Why exactly TODO and FIXME ──────────────────────────────────────────────
 *
 * These two are the only marks in `PREREG.HATCH_KINDS` that are not a fact
 * about TypeScript. `: any`, `as any`, `as unknown as`, `@ts-ignore`,
 * `@ts-expect-error`, `@ts-nocheck` and `eslint-disable` all name a specific
 * compiler or linter; `TODO` and `FIXME` are written by hand in Kotlin, Python,
 * Dart, Swift, shell and prose, and they mean the same thing in all of them —
 * somebody left a rule turned off on purpose and said so. Counting them is the
 * one escape-hatch reading that survives translation, so it lives here and not
 * in a language's pack.
 *
 * They are counted exactly the way `hatches.mjs` counts everything: as
 * OCCURRENCES via `matchAll`, word-bounded, over the text of files some ACTIVE
 * pack calls source. In a repo where no pack claims the source extensions this
 * therefore reads over nothing, and `hatches` degrades to `{value: null,
 * reason}` rather than to two zeros — which is the whole point. A `todo: 0`
 * over 239 Kotlin files nothing could open is the exact wrong number this
 * split exists to prevent.
 *
 * ── What this pack does NOT detect ──────────────────────────────────────────
 *
 * Everything except those two marks:
 *
 *   - **No source extensions.** `exts` is empty on purpose. A pack that
 *     claimed, say, `.md` would silently make prose into measured code in
 *     every repo at once, and the size, duplicate and untested rows would all
 *     start counting it.
 *   - **No test convention.** `testGlobs` is empty. What a test file looks
 *     like is a language's and a toolchain's fact (`*.test.mjs`, `*_test.go`,
 *     `test_*.py`, `*Test.kt`), never a universal one.
 *   - **No analyzer.** There is no parser here, so `dups` and `deadExports`
 *     get nothing from this pack. In a repo where `common` is the only active
 *     pack those two metrics report absent with a reason, which is the honest
 *     answer: nothing read the code.
 *   - **No manifests.** A dependency manifest is a package manager's file, and
 *     no package manager is universal.
 *   - **No mention rule.** `mentions`/`keysFor` are how a test file names a
 *     module, which is an import syntax, which is a language.
 *
 * ── What it DOES own besides the two marks: the excluded directories ───────
 *
 * `excludeDirs` is here, and it is the third universal. "This directory holds
 * code somebody else wrote" is not a fact about a language: `node_modules`,
 * `vendor` and `third_party` mean the same thing in a TypeScript repo, a
 * Kotlin one and a C one, and so do `dist`, `build`, `out` and `target`.
 *
 * It lives in a PACK rather than in `census.mjs`, where it was a module
 * constant, for one reason: the pack list and its versions are hashed into the
 * right half of every row's version string, and a module constant is not. So
 * editing the list used to change what every repo measures — libvorbis leaving
 * Tiptoi's LOC total is a 61,782-line move — with the version string standing
 * still, which is exactly the mix `series.mjs`'s `warnMixed` compares that
 * string to catch and could not see. Here, a change to the list is a bump of
 * `common`'s version, `common` is active in every repo, and the hash moves
 * everywhere the list applies. That is the whole argument for the location.
 *
 * `census.mjs` reads it from the ALWAYS-ON packs and refuses a language pack
 * that declares one, because the list has to be known before the tree is
 * scanned — the scan is what decides which language packs are active — and a
 * list that arrived with activation could not have filtered the scan that
 * produced it.
 */

export default Object.freeze({
  name: "common",
  // 2: `excludeDirs` moved here from `census.mjs` and gained the vendored-code
  // names. See the header, and `packs/index.mjs` on what a version bump costs.
  version: "2",

  /**
   * Active in every repo, whatever it is written in — the one pack that does
   * not wait to see an extension it recognises. `census.mjs` reads this.
   */
  always: true,

  exts: Object.freeze([]),
  excludeSuffixes: Object.freeze([]),
  testGlobs: Object.freeze([]),

  /**
   * Directory names whose contents are never this project's own code. A path
   * is excluded when any SEGMENT matches — `inExcludedDir` in `source.mjs` is
   * the predicate, and this is the list it is given everywhere.
   *
   * The first nine are the set `packages/host/src/repos.ts` skips when it
   * walks `~/dev` looking for repositories, minus the four that cannot arise
   * here: `.git` is not in a tree listing by construction, and `.next`,
   * `.turbo` and `.cache` are tool-specific CACHES that no repo in this fleet
   * commits. That last exemption is a standing rule and not an oversight — a
   * cache nobody checks in is a name that can never fire, and a rule that
   * never fires is one nobody can check — so `.gradle` and `.dart_tool` are
   * declined here for the same reason, though five Android repos and two
   * Flutter ones sit next door.
   *
   * The vendored names are the ones that DO fire. Measured with
   * `git ls-tree -r --name-only HEAD` over the fourteen repositories under
   * `~/dev` that have committed files, taking every directory segment: the
   * only one of these that appears anywhere is `third_party`, in `Tiptoi`,
   * where it holds 71 of that repo's 74 C files — 61,782 lines of libvorbis
   * and libogg against 308 lines of Tiptoi's own C. Before it was on this
   * list, Tiptoi's `size.maxPath` was
   * `app/src/main/cpp/third_party/libvorbis/lib/books/coupled/res_books_stereo.h`
   * at 15,782 lines, its p95 was 1254, and 16 of the 50 largest files in the
   * tape were somebody else's library wearing Tiptoi's name.
   *
   *   - `third_party`, `thirdparty`, `3rdparty` are one concept in three
   *     spellings (AOSP and Chromium write the first, other toolchains the
   *     other two). A spelling must not decide whether a vendored library is
   *     measured as the repo's own, so all three are here even though two of
   *     them fire nowhere today.
   *   - `external` is the CMake and git-submodule convention for the same
   *     thing. It is the one ambiguous name on this list — a repo could
   *     plausibly name its own boundary layer `src/external/` — and it is
   *     included anyway, on the same footing as `out`, `build` and `target`,
   *     which are already here and collide with a plausible source directory
   *     just as readily. Nothing in this fleet has one; the day something
   *     does, this comment is where the argument gets reopened.
   *   - `Pods` is CocoaPods' checked-in dependency tree, and checking it in is
   *     common practice rather than an accident. It earns its place because
   *     `packs/c.mjs` claims `.h`: every pod ships headers, so a committed
   *     `Pods/` would be read as the repo's own C exactly the way libvorbis
   *     was.
   *
   * Declined, and why:
   *
   *   - `vendored` — `vendor` is the convention (Go, PHP, Bundler) and is
   *     already here; `vendored` is a word, not a directory any toolchain
   *     produces.
   *   - `generated` — the real question on this list, and the answer is no.
   *     Every other name says who OWNS the code: it has an upstream, it is
   *     maintained elsewhere, and measuring it says nothing about this repo.
   *     `generated` says who WROTE it. Checked-in generated code is code this
   *     repo ships, reviews and has to keep buildable, and a `generated/` tree
   *     usually mirrors nothing else in the tree — so unlike
   *     `packs/typescript.mjs`'s `.d.ts`, excluding it would not be undoing a
   *     double count, it would be hiding a real one. It also fires nowhere in
   *     this fleet. A single generated FILE is a different matter and is
   *     handled where it is generated: see `packs/c.mjs`.
   */
  excludeDirs: Object.freeze([
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    "third_party",
    "thirdparty",
    "3rdparty",
    "external",
    "Pods",
  ]),

  /**
   * Regex SOURCE, not compiled patterns, and word-bounded — the same contract
   * `PREREG.HATCH_KINDS` held: `hatches.mjs` compiles a fresh global regex per
   * call, because a module-level global carries `lastIndex` between calls and
   * that is the classic way to get a count that depends on what was measured
   * before it. Unbounded, `TODO` would also count `TODOS` and `todo` inside an
   * identifier.
   */
  hatchKinds: Object.freeze({
    todo: "\\bTODO\\b",
    fixme: "\\bFIXME\\b",
  }),

  // See "What this pack does NOT detect". Spelled as explicit nulls rather
  // than left off the object, so a reader comparing two packs side by side can
  // see which capabilities this one declines instead of wondering whether the
  // key was forgotten.
  manifestPath: null,
  manifests: null,
  mentions: null,
  keysFor: null,
  analyzer: null,
  analyzerReason: null,
});
