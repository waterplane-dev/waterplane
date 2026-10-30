/**
 * The shell pack: extensions, and nothing else.
 *
 * ── What this brings into view, including in this repo ─────────────────────
 *
 * Counted at HEAD with `git ls-tree -r --name-only`, outside the excluded
 * directories: `personal-podcast-news` 33 `.sh`, `trading` 15, waterplane 6,
 * `picture-app` 3, `Tiptoi` 2.
 *
 * waterplane is the one worth saying out loud, because it changes this repo's own
 * series. Its six scripts — `deploy/install-service.sh`,
 * `deploy/uninstall-service.sh`, `scripts/restart.sh`,
 * `scripts/sync-gemini-key.sh` and the two CLI stubs the e2e suite spawns —
 * were not source before this pack existed. Adding it makes the `shell` pack
 * active here, which moves the right half of `census.mjs`'s `VERSION` (the
 * hash of the active pack list) and adds six files to every source-population
 * count. That is a definition change, it is what the two-part version string
 * exists to make visible, and the committed fixture has to be regenerated in
 * the same commit that lands it. A reader who sees this repo's LOC step up on
 * one day will find the version string stepped with it on the same day.
 *
 * `.sh` and `.bash`. Not `.zsh`, `.fish` or an extensionless file with a
 * `#!/bin/sh` line: this tool selects on the path and never opens a file to
 * decide whether it is source, because that decision has to be reproducible
 * from a tree listing alone and cheap enough to run over every commit in a
 * history.
 *
 * ── What this pack does NOT detect, and why each is absent and not zero ────
 *
 *   - **Escape hatches.** No `hatchKinds` beyond what `common` contributes.
 *     Shell's are real — `set +e` turning error exit back off, `|| true`
 *     swallowing a failure, `# shellcheck disable=SCxxxx` — and none is here
 *     because none has been measured against its near-miss. `|| true` is the
 *     instructive one: in `scripts/` it is usually a deliberate "this step may
 *     legitimately find nothing", not a suppressed error, so a count of it
 *     would be a number whose meaning changes per line. A pattern this tool
 *     cannot defend is one it does not ship.
 *   - **Tests.** `testGlobs` is empty. A shell test suite is `bats`, or it is
 *     a script called `test.sh`, or it is the CI job — there is no convention
 *     to encode, and a glob guessed at would take real scripts out of the
 *     measured population.
 *   - **Which module a script names.** `mentions` and `keysFor` are `null`.
 *     A shell script names another file by running it, and the name it uses is
 *     whatever `$0`, `$PWD` and a variable expansion produce at run time.
 *     `untested` therefore skips these files rather than listing all of them.
 *   - **Duplicates and dead exports.** `analyzer()` returns `null` with a
 *     reason. There is no shell parser here, and the tool spawns nothing but
 *     `git` — `shellcheck` and `bash -n` are both a process.
 *   - **Dependencies.** A script has no manifest.
 */

export default Object.freeze({
  name: "shell",
  version: "1",

  /** Activates when the tree at HEAD carries one of these. See the header. */
  exts: Object.freeze([".sh", ".bash"]),

  excludeSuffixes: Object.freeze([]),

  /** See "What this pack does NOT detect". */
  testGlobs: Object.freeze([]),

  /** None. `common`'s `TODO` and `FIXME` are the only marks counted here. */
  hatchKinds: Object.freeze({}),

  // Declined, spelled as explicit nulls so a reader comparing packs can see
  // which capabilities this one refuses rather than wonder whether a key was
  // forgotten. `metrics/route.mjs` tests exactly this: a capability is a
  // function or it is absent.
  manifestPath: null,
  manifests: null,
  mentions: null,
  keysFor: null,
  imports: null,
  graphConfigPath: null,
  graphContext: null,
  graphImports: null,

  /**
   * No parser, and a sentence rather than a silence: `metrics/route.mjs` puts
   * `analyzerReason` in the row so `dups` and `deadExports` read as "nothing
   * opened these files" and never as zero.
   */
  analyzer() {
    return null;
  },

  /** The sentence `dups` and `deadExports` print when `analyzer()` is null. */
  analyzerReason: "no shell parser is available, so no shell script was read as code",
});
