/**
 * The pre-registered constants of the repo-health series.
 *
 * ── Why they are all in one frozen block ────────────────────────────────────
 *
 * This tool reconstructs a history. Every number it reports is a value read
 * against its own past, so a constant changed today silently rewrites what
 * every past day meant — the plot moves and nothing says why. That is the
 * failure mode this block exists to make loud: the constants live in one
 * place, the backfill they produced on the day they were chosen is committed
 * as `fixture.json`, and `tools/repohealth.test.mjs` re-derives the fixture's
 * rows and fails if they no longer reproduce. Changing a constant is then a
 * two-part commit — bump `PREREG_VERSION`, regenerate the fixture — and the
 * diff shows the history rewriting itself.
 *
 * Same argument `tools/claudemd.test.mjs` makes about a budget: a rule that is
 * only prose fails silently, weeks later, in a diff nobody reads as a change.
 *
 * ── Why there are no thresholds here ────────────────────────────────────────
 *
 * There is no "too big", no "too many", no grade. This repo went from 2.8k to
 * 143k lines in 95 days; any absolute number chosen in July is absurd in
 * September, and any number chosen today was chosen after seeing the plot it
 * is meant to judge. A value is therefore read two ways only: its percentile
 * rank within its own trailing window, and the sign of its trailing slope.
 * The constants below configure that reading. None of them encodes an opinion
 * about what a good value is.
 *
 * ── Why only the METHOD is here, and the repo's SHAPE is derived ────────────
 *
 * This block used to hold two different kinds of thing under one freeze.
 *
 * The first kind is the METHOD: the rank window, the minimum number of
 * readings, the slope flatness, the LOC convention, the re-touch clocks, the
 * batch cutoff, the LSH parameters, the day boundary. Every one of them is a
 * decision about HOW a value is read against its own past, every one is
 * identical in every repository, and every one is exactly what the paragraphs
 * above argue must be frozen, committed and versioned by hand.
 *
 * The second kind was this repo's SHAPE: `SRC_DIRS: ["packages/"]`,
 * `SRC_SUBPATH: "/src/"`, `SRC_EXT: [".ts", ".tsx"]`, a `HATCH_KINDS` table
 * full of TypeScript, `UNTESTED_TEST_GLOBS`, and an `AREA_SKILLS` table naming
 * `host`, `shared` and `web`. None of those is true anywhere
 * else. Of the thirteen repositories under `~/dev` that have any committed
 * files, `.ts`/`.tsx` appear in six; `.kt` in five and `.py` in four, and not
 * one of those nine carries a `packages/*​/src/` at all — two repos in the
 * whole fleet do. Pinning a false statement does not make it reliable; it
 * makes it look decided, which is worse, because the resulting zero is
 * indistinguishable from a measurement.
 *
 * So the shape moved out. It is derived, per repo, by `census.mjs` from the
 * language packs the tree at HEAD activates, and per snapshot by
 * `snapshot.mjs` for the parts that are facts about one commit's tree (source
 * groups, router areas). What remains here is the method alone.
 *
 * That split is the whole reason two repos' readings are the same KIND of
 * reading. They agree on the window, the minimum, the flatness and the day
 * boundary — so a rank of 0.9 means the same thing in both — and they differ
 * only in which files were read, which is a fact about the repos and not
 * about the measurement. Pin the shape instead and you measure the wrong
 * files with great precision; derive the method and you get two series that
 * are each internally consistent and cannot be put side by side.
 *
 * Both halves stay visible in one string. `census.mjs` builds
 * `<PREREG_VERSION>+<hash of the active packs>`, and that is what a row
 * records as `prereg`, so `series.mjs`'s mixed-version checks see an engine
 * bump (left half, everywhere at once) and a pack change (right half, only
 * where it applies) as the different events they are.
 */

/**
 * The day the constants below were chosen. Bump it in the same commit that
 * changes any value in `PREREG`, and regenerate `fixture.json` — the test
 * compares this against the fixture's own copy and says so when they drift.
 *
 * It is a date because definition changes are normally days apart, and a date
 * says when the history was last re-cut. Two in one day get a letter, as here:
 * the area table was re-shaped hours after it was first written, and what the
 * check needs is that the VALUE moved — a second "2026-09-21" would let a
 * regenerated fixture and a stale one compare equal, which is the one thing
 * this string exists to prevent.
 *
 * A row that GAINS A FIELD is the same kind of change and gets the same bump,
 * even though nothing in `PREREG` moved: the rows on disk are append-only, so
 * without one the series would hold old rows and new rows under one version
 * string, differing in what they carry and saying nothing about it —
 * `warnMixed` compares exactly this string, and it cannot warn about a mix it
 * cannot see. `context.skillCount` (2026-09-21d) is the first of those.
 *
 * `2026-09-21e` is the fifth same-day letter and the largest re-cut so far:
 * the repo-shaped keys left this block for the packs, the source extensions
 * widened past `.ts`/`.tsx`, and tree reads stopped being limited to six
 * pathspecs. It is also the last version that is this string ALONE — from
 * here a row records `census.mjs`'s `VERSION`, which is this plus a hash of
 * the packs that were active. A row carrying a bare `2026-09-21d` and a row
 * carrying `2026-09-21e+<hash>` are therefore visibly different vintages,
 * which is exactly what `warnMixed` is for.
 *
 * `2026-09-21f` is the sixth, and it is a row gaining values rather than a
 * constant moving: `metrics/context.mjs` stopped making `claudeMdChars` wait
 * for a `.claude/skills` directory, so the CLAUDE.md series reads in the
 * eight repos on this desktop that have the file and no skills, and
 * `descChars`/`skillCount` carry a `skillsReason` where they used to take the
 * whole row down with them. The pack halves moved in the same commit —
 * `common@2` (the excluded directories live there now, and vendored code is
 * on the list), `typescript@2` (the family's test conventions, not this
 * repo's) and `c@2` — so both halves of the string step together here, which
 * is the loudest a definition change can be.
 *
 * `2026-09-22a` is another row gaining a field, and nothing else:
 * `metrics/classics.mjs` now counts the same source lines a second way, by
 * file TYPE as well as by group. No existing number moves — a group's lines
 * are the same lines — but rows written before it carry no `types` at all,
 * and a plot cannot tell that apart from a tree with no source in it without
 * this bump saying which vintage a row is.
 *
 * `2026-10-15a` changes what `untested` MEANS, and both halves move. The
 * headline list is now the modules no test names AND none reaches through
 * imports; the named-only remainder travels beside it as `unnamed`
 * (`metrics/untested.mjs` argues the choice). The pack half moves with it:
 * `typescript@3` accepts every extension it claims in a reference — the
 * literal `tsx|ts|js` had silently stayed behind when `.mjs` became source —
 * and answers for an `index` under its directory; `python@2` and `kotlin@2`
 * gain `imports`. Every past row's `untested` is a different number under
 * this version, so a series on disk is re-measured, never continued.
 *
 * `2026-10-16a` moves two definitions at once, so the chain breaks once and
 * not twice. `hatches` now CLASSIFIES every occurrence — to-do, explained
 * (the reason on the same line or a comment line directly above), or
 * unexplained — and the index reads only the unexplained ones; the pack
 * halves move with it (`common@3`, `typescript@5`, `python@3`, `kotlin@3`
 * gain `hatchExplain`). `retouch` counts a pair only when the later commit
 * removes or changes a line the earlier one ADDED, so a registry that is only
 * ever appended to stops reading as churn (`metrics/retouch.mjs`). Rows also
 * gain tile detail — `size.nearMax`, `context.skillBodyChars`,
 * `retouch.appends`, `hatches.split` — and, where a repo declares one, a
 * `central` field naming which of these readings it disabled or overrode.
 *
 * `2026-10-17a` adds one field: `size.lineMean`, the line-weighted mean file
 * length (Σ loc² / Σ loc). The health index now reads it — the index became an
 * absolute score against fixed good values, and its size entry blends
 * `lineMean` with `max`. Nothing else moves, but rows written before it carry
 * no `lineMean`, so a series on disk is re-measured, never continued.
 *
 * `2026-10-30a` adds a row family, `graph`: the import graph between a tree's
 * own modules — files in import cycles, the largest cycle, fan-out p95 and
 * max (`metrics/graph.mjs`). Two plotted series read it and the health index
 * reads neither. The pack half moves with it (`typescript@7` gains
 * `graphImports`, which resolves `tsconfig` aliases and workspace packages).
 * No existing field moves, but rows written before it carry no `graph`, so a
 * series on disk is re-measured, never continued.
 */
export const PREREG_VERSION = "2026-10-30a";

export const PREREG = Object.freeze({
  // ── what counts as source ────────────────────────────────────────────────
  //
  // Nothing. `SRC_DIRS`, `SRC_SUBPATH`, `SRC_EXT` and `SRC_EXCLUDE_SUFFIX`
  // were here and are now the active packs' business: extensions and excluded
  // suffixes come from `packs/*.mjs`, the union is built by `census.mjs` into
  // `SRC`, and `source.mjs` is still the one place the predicate is applied.
  // The argument that the filter runs in JS and is never handed to git as a
  // pathspec — a bare `packages/*​/src/**​/*.ts` matched 32 files against a
  // real 325, because git's default pathspec has no globstar — moved with it,
  // to `source.mjs`, where the code it is about now lives.

  /**
   * LOC of a blob = newline count, plus one when the final line is non-empty.
   * Equals `wc -l` for a file ending in a newline and, unlike `wc -l`, does
   * not lose the last line of one that does not. Pinned because the two
   * conventions differ by up to one line per file — 325 lines repo-wide, which
   * is the difference between two "measured" totals that disagree forever.
   */
  LOC_COUNTS_UNTERMINATED_LAST_LINE: true,

  // ── escape hatches ───────────────────────────────────────────────────────
  //
  // `HATCH_KINDS` was here. A hatch is a rule somebody turned off on purpose,
  // and which rules EXIST to turn off is a fact about a toolchain: `: any`,
  // `as unknown as`, `@ts-ignore` and `eslint-disable` name TypeScript and
  // ESLint and mean nothing in Kotlin. The patterns are in the packs
  // (`packs/typescript.mjs` for those, `packs/common.mjs` for `TODO` and
  // `FIXME`, which are written the same way everywhere); `census.mjs` merges
  // them, refusing a name claimed twice, and `hatches.mjs` still compiles a
  // fresh global regex per call for the reason it gives.
  //
  // How to count them is still method and is still pinned, in prose, here:
  // OCCURRENCES via `matchAll`, never matching lines, always word-bounded. The
  // three ways to count are not rounding errors of each other — `grep -c`
  // counts lines, and an unbounded `as any` counted "has any" and "was any" at
  // 32 substring hits against 8 real ones — and a series that silently
  // switches between them looks exactly like the codebase changing.

  // ── re-touch: the degradation signal ─────────────────────────────────────
  /**
   * A touch is a re-touch when the same file was touched within 48h OR within
   * the previous 2 commits that touched it. Two clocks because this repo works
   * in bursts: 77 of 157 commits landed in 16 days, so hours alone calls a
   * whole sprint one edit, and commit distance alone calls a fortnight's gap a
   * re-edit.
   */
  RETOUCH_HOURS: 48,
  RETOUCH_COMMITS: 2,
  /**
   * The rate is trailing over two weeks. A 60-day window would average the
   * 16-day burst that produced half this history into invisibility.
   */
  RETOUCH_WINDOW_DAYS: 14,
  /**
   * A batch commit's files really were edited that day, so it still counts as
   * a PRIOR touch — it is only excluded as the commit being classified.
   */
  RETOUCH_BATCH_AS_PRIOR: true,
  RETOUCH_OFFENDERS: 3,
  /**
   * A ceiling on the commit clock: a prior touch satisfies it only when it is
   * within `RETOUCH_COMMITS` commits AND this many days. The hours clock is
   * unaffected and still ORs in.
   *
   * It is a guard against an unbounded clock, not a fix for anything observed.
   * The commit clock's job is to catch a re-edit inside one working burst that
   * straddles 48 hours; a burst straddling two weeks is not a burst. This
   * history has a 57-day hole in it (2026-06-25 to 2026-08-16) and an
   * uncapped commit clock would happily fire across a gap like that, calling a
   * two-month sleep a re-edit.
   *
   * Measured, it currently binds nothing: of 499 classified pairs across the
   * 155 commits, 406 fire on the hours clock, 3 on the commit clock alone, and
   * all 3 are inside this ceiling. It is recorded here anyway, because a guard
   * that costs nothing until the work pattern changes is worth its line.
   *
   * It was added on a wrong diagnosis — four rows reading a re-touch rate of
   * exactly 1.000 were assumed to be the gap firing, and are in fact honest:
   * their priors are 0.2 to 8.0 hours old, same-morning follow-ups to two
   * large commits. Those rows are THIN, not wrong (denominators of 6 to 13,
   * because the two commits that would fill the window are batches). No
   * minimum-denominator constant was added to silence them: choosing a
   * threshold after seeing which rows it would remove is the exact move this
   * whole block exists to prevent. The narrative prints a rate next to its
   * denominator instead, so "1.00 of 6 touches" reads as what it is.
   */
  RETOUCH_COMMITS_MAX_DAYS: 14,

  // ── batching ─────────────────────────────────────────────────────────────
  /**
   * This is a SHARED WORKING TREE: several sessions edit at once and the day
   * ends in one `git add`. A 160-file commit is one day of unrelated work, not
   * 160 coupled modules; counting it as coupling would make the co-change
   * metric measure the author's committing habits instead of the code.
   *
   * An earlier draft of this comment claimed the distribution is bimodal and
   * that 40 therefore "sits in an empty gap". That is false and the correction
   * is worth keeping, because it is the kind of claim a pre-registered
   * constant is supposed to stop someone inventing. Measured over the 155
   * first-parent commits: 102 touch 1-10 files, 25 touch 11-20, 7 touch 21-30,
   * 2 touch 31-40, then 43, 46, 48, 50, 51, 57, 74, 81, 85, 94, and eight over
   * 100. There is exactly one gap, 34 to 43, and 40 is in it — but the tail
   * above is continuous, so this cutoff is a PINNED JUDGMENT, not a discovered
   * boundary. It is defensible and it is arbitrary; the fixture records which
   * judgment was made, which is the whole point of pinning it.
   */
  BATCH_FILES: 40,

  // ── co-change: coupling measured by what it costs ────────────────────────
  HOTSPOT_N: 10,
  /**
   * Co-change reads a trailing window, not the whole lifetime. Cumulative
   * from the first commit, the hotspot set froze — identical from 06-21 to
   * 09-19 — and the medians moved by half a file in three months, which is
   * not a reading, it is an average with a long memory. The same two weeks
   * `RETOUCH_WINDOW_DAYS` uses, for the same reason: this repo works in
   * bursts and a quarter-long window averages them away.
   */
  COCHANGE_WINDOW_DAYS: 14,
  /**
   * Co-change is counted within one SOURCE GROUP. A commit that touches
   * shared and web together is the build order of a monorepo, not evidence
   * that two modules must change together.
   *
   * The value was `"package"` and the groups were the literal `packages/<x>`.
   * That is a fact about one monorepo's directory names, so the boundary is
   * now derived per snapshot — `snapshot.mjs`'s `deriveGroups` argues out the
   * rule, and on this repo it reproduces `packages/<x>` exactly. What stays
   * pinned is the SCHEME: that coupling is counted inside a group and not
   * across the repo. `cochange.mjs` refuses a scheme it does not recognise
   * rather than falling back to one, because a number computed under a
   * different boundary looks like a measurement and means something else.
   */
  NEIGHBOURHOOD: "group",

  // ── duplicate blocks ─────────────────────────────────────────────────────
  /**
   * Near-exact clones only. String and numeric literals are normalised;
   * identifiers are NOT, so a renamed copy does not pair. That is deliberate:
   * "are these two blocks the same behaviour under different names" is a
   * judgment, and judgments cost tokens and live behind the `judge` command.
   * This series answers the cheap question and leaves the other one alone.
   *
   * Whole-file granularity is banned. At HEAD `activityRows.ts` (95k) and
   * `assessRows.ts` (88k) look like an obvious pair by name and size and share
   * 23 unique lines out of ~1,400 each; every `*Sheet.tsx` and every
   * `scripts/e2e-*.mjs` would pair on boilerplate.
   */
  DUP_MIN_LINES: 20,
  DUP_SHINGLE: 5,
  DUP_HASHES: 64,
  DUP_BANDS: 8,
  DUP_SIMILARITY: 0.8,
  DUP_NORMALISE: "literals-only",
  /**
   * An LSH bucket with more members than this is skipped. Insurance against a
   * near-empty signature collapsing into one bucket and emitting tens of
   * thousands of noise pairs; measured, it changes the answer on 0 of 155
   * shas. Registered here rather than left inline because a number that can
   * silently drop a pair is a definition, not an implementation detail — and
   * an unregistered one cannot be found by the reader who later wonders why a
   * pair they can see is not reported. The row records how many buckets it
   * skipped, so the drop is never invisible.
   */
  DUP_MAX_BUCKET: 40,
  /**
   * Blocks are walked into, not just taken at the top level. `App.tsx` is ONE
   * top-level block of 15,199 lines: a handler duplicated inside two
   * components is invisible to a top-level-only scan, which is most of what
   * an agent actually duplicates. Nested function-likes at or over
   * `DUP_MIN_LINES` are extracted too.
   */
  DUP_NESTED_BLOCKS: true,

  // ── tripwires: events, never plotted ─────────────────────────────────────
  LINES_TRIPWIRE: 2000,

  // ── size: tile detail ────────────────────────────────────────────────────
  /**
   * `size.nearMax` counts the files at or above this fraction of the largest
   * file's line count. Detail beside p95, never an index input — a shelf of
   * files cut just under a lint cap is what p95 and max both hide.
   */
  SIZE_NEAR_MAX_FRAC: 0.9,

  // ── how a value is read ──────────────────────────────────────────────────
  /**
   * Rank is the percentile of today's value among the trailing 60 days of the
   * same series. Under 14 points there is no rank — the reading says "not
   * enough history", never 0. A rank of 0 and an absence are opposite claims
   * and this repo's rule is that a heuristic degrades to absent, never to a
   * wrong number.
   */
  RANK_WINDOW_DAYS: 60,
  RANK_MIN_POINTS: 14,
  /**
   * Slope is OLS over the rank window, reported only as a sign. "Flat" when
   * the fitted change across the window is under 5% of the window median, so
   * the sign does not flip on noise every day and the narrative stays silent.
   */
  SLOPE_FLAT_FRAC: 0.05,

  // ── always-on context weight ─────────────────────────────────────────────
  //
  // `AREA_SKILLS` was here: a typed-out table of three routers, each with the
  // source prefix it covers and the skills outside its own name-prefix that it
  // routes to. The table's own comment argued at length that sub-skills must
  // be DERIVED and never listed, because a list is a second map that goes
  // stale silently — and then listed the routers. `snapshot.mjs` now derives
  // both levels by the same rule, from each commit's own tree, and the whole
  // argument moved there, beside the derivation it is now about.
  //
  // What is still pinned is that an area is measured by TWO numbers,
  // `expected` and `ceiling`, because either one alone is a lever: a split
  // lowers the first and cannot move the second, and only deleting prose moves
  // both. That is method, and `context.mjs` and `types.mjs` spell it out.
  /**
   * `visual-check` is written at runtime by `packages/host/src/visualskill.ts`
   * and is counted anyway. `claudemd.test.mjs` exempts it because that test
   * asks who authored a file; this metric asks what is loaded, and a generated
   * skill is loaded exactly like a written one. It is flagged `generated`.
   */
  COUNT_GENERATED_SKILLS: true,

  // ── untested modules ─────────────────────────────────────────────────────
  //
  // `UNTESTED_TEST_GLOBS` was here. What a test file is NAMED is a toolchain's
  // convention — `*.test.mjs`, `*_test.go`, `test_*.py`, `*Test.kt` — so the
  // globs are a pack's, `census.mjs` unions them into `SRC.testGlobs`, and
  // both readers compile that one list: `source.mjs` to keep tests out of the
  // measured population, `snapshot.mjs` to collect the corpus `untested`
  // reads. Likewise the form a mention takes (`NAME` plus any extension the
  // pack claims or a build emits — the host tests import `../dist/echo.js` —
  // or the closing quote of an extensionless specifier) and what an import
  // statement looks like, which are syntax and therefore a language's.
  //
  // What stays here is the rule that survives translation: a mention is a
  // PATH reference and never a bare identifier, because `git`, `api` and
  // `echo` are module basenames AND ordinary English in the prose of half
  // these files.
  /**
   * A mention must carry a DIRECTORY SEGMENT of the module's own path —
   * `web/src/link`, `dist/link`, `./link` — not merely its basename.
   *
   * Basename alone was wrong in both directions. It matched URL and path
   * strings that name no module at all (`"/api/repos"` marked `repos.ts`
   * tested, `".claude/outbox"` marked `outbox.ts`, `"packages/web"` marked
   * `capture/web.ts`), and it collided across packages: 28 basenames exist
   * more than once in this tree (`api`, `index` x3, `settings` x3), so one
   * test naming `git.js` marked every `git.ts` mentioned. Requiring a
   * directory segment costs nothing and removes both.
   */
  UNTESTED_REQUIRE_DIR_SEGMENT: true,

  // ── the import graph ─────────────────────────────────────────────────────
  /**
   * The share of a tree's own imports (relative, aliased, workspace, or a
   * bare name no manifest declares) that must resolve to a module before the
   * graph is reported at all. A missed edge is not a neutral error here: it
   * deletes a cycle and lowers a fan-out, so a tree the reader half-followed
   * reads as a tree with half the coupling. Below this, the row says which
   * specifiers it could not follow instead of printing a flattering number.
   * 0.9 leaves room for the odd generated module that is not committed.
   */
  GRAPH_MIN_RESOLVED: 0.9,

  // ── the day boundary ────────────────────────────────────────────────────
  // Not a constant: `git.mjs` takes a commit's day from the first 10 chars of
  // its own `%ci`, the author's offset at the time, and there is no other
  // option to select between. It is recorded here because it is a real
  // decision — never `new Date(ts)` against the machine's timezone, since 22
  // of 155 commits sit in the 22:00 hour and would migrate a day whenever the
  // tool runs somewhere else. A key nobody reads would only look pinned.

  // ── the token guard ──────────────────────────────────────────────────────
  /**
   * The cap on a judgment bundle, printed to the user BEFORE anything is
   * spent. Nothing else in this tool may cost a token: the whole series is git
   * plus regex plus local computation, and `judge.mjs` is the only module
   * permitted to spawn `claude` — asserted as a text check in the test,
   * because "we don't call a model here" is exactly the kind of rule that is
   * true until someone adds one import.
   */
  JUDGE_MAX_CHARS: 60000,
});
