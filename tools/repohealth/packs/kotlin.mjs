/**
 * The Kotlin pack: the facts about Kotlin and Gradle that this engine can read
 * without a parser, and a plain list of the ones it cannot.
 *
 * ── What this brings into view ──────────────────────────────────────────────
 *
 * Counted at HEAD with `git ls-tree -r --name-only`, outside the excluded
 * directories: `Tiptoi` 239 `.kt`, `TalkingPictures` 105, `drive-coach` 85,
 * `Bluetooth-wlaki-talki` 29, `child-paint` 10 — 468 files, plus the three
 * `.kts` Gradle scripts each Android project carries. Before this pack, four of
 * those five repos activated `common` alone: `SRC.exts` was empty, no file was
 * source, and every source-population metric reported absent with a reason.
 * That was the correct answer and it was also the whole codebase.
 *
 * `.kts` is claimed alongside `.kt`. A Gradle script is hand-written code that
 * decides how the app is assembled, it is re-touched like code, and it is the
 * file every dependency change lands in — leaving it out would make the
 * re-touch and co-change rows blind to the build.
 *
 * ── The escape hatches, and the near-misses each one had to survive ─────────
 *
 * `!!` is Kotlin's not-null assertion: a postfix operator that turns a compile-
 * time question into a runtime crash. It is the single most informative hatch
 * in this language and it is also the one a naive pattern gets wrong, because
 * two exclamation marks are also how English shouts. Measured over the five
 * repos, all 412 occurrences in `.kt` files are preceded by an identifier
 * character, `)` or `}` — never by a quote or a space — and are followed by
 * `.` (230), `,` (29), `)` (18), a space (8), `[` (1) or the end of the line
 * (the remainder). None of the 412 sits inside a string literal. So the
 * pattern requires an expression on the left and refuses a letter, digit or
 * quote on the right, which is what a postfix operator looks like and what
 * `"Wow!!"` does not. `!=` cannot match it at all — that is one `!`, and there
 * are 823 of those in the same files.
 *
 * `TODO()` is Kotlin's throwing stub, a real unimplemented branch rather than a
 * note. It is counted SEPARATELY from `common`'s `todo`, and a reader needs to
 * know that the two overlap by construction: `common`'s pattern is `\bTODO\b`,
 * which also matches the identifier in `TODO()`. So a Kotlin stub adds one to
 * `todo` and one to `ktTodoStub`. Neither count is wrong on its own — one is
 * "the word TODO appears", the other is "an unimplemented branch that throws" —
 * but they must never be summed. `common.mjs` is not this pack's to edit and a
 * silent subtraction here would make `ktTodoStub` unreadable on its own.
 * Measured in the fleet: 1 occurrence, in `Tiptoi`.
 *
 * `@Suppress` and `@SuppressLint` are two annotations and two kinds, not one.
 * `@Suppress\b` deliberately does not match `@SuppressLint`, because the word
 * boundary stops before `L` — which is correct, they turn off different tools —
 * and the consequence is that without a second kind the 14 `@SuppressLint`
 * annotations measured in the fleet (11 in `drive-coach`, 3 in
 * `Bluetooth-wlaki-talki`) would be invisible. A kind absent from this list can
 * never fire the "a new kind of escape hatch appeared" tripwire, so both are
 * declared, both at whatever count they stand at: 30 `@Suppress` and 14
 * `@SuppressLint` on the day this was written.
 *
 * Every kind name here is prefixed `kt`. `census.mjs` throws when two packs
 * claim one name, and the tripwire fires on the NAME, so a collision is a
 * count that belongs to neither pack.
 *
 * ── Why `**​/*Test.kt` is NOT a test glob ────────────────────────────────────
 *
 * The brief this pack was written from asked for three globs: Gradle's two
 * source sets and `**​/*Test.kt`. The third is left out, on a measurement.
 *
 * Across the five Kotlin repos the two source-set globs select 102 files and
 * every one of them is a test. `**​/*Test.kt` selects no file those two miss —
 * zero, in all five repos — and it additionally selects three files that are
 * MAIN source and not tests at all:
 * `app/src/main/java/de/hoh/tiptoi/domain/gme/GmeSelfTest.kt`, and
 * `.../domain/scene/SpotHitTest.kt` in both `Tiptoi` and `TalkingPictures`.
 * "Hit test" and "self test" are things a production class does. A test glob is
 * not a label: `source.mjs` uses it to take files OUT of the measured
 * population and `snapshot.mjs` uses it to put them INTO the corpus that
 * `untested` reads. Those three modules would stop being counted in `size`,
 * stop being candidates in `untested`, and start being read as evidence that
 * something else is covered. Adding a glob that finds nothing and mislabels
 * three real modules is a strictly worse reading, so it is not here.
 *
 * `**​/src/test/**​/*` and `**​/src/androidTest/**​/*` carry a trailing `/*`
 * because of how `source.mjs` compiles a glob: `**​/` crosses directories and
 * plain `*` does not, and a trailing `**` with no slash after it is two plain
 * stars. `**​/src/test/**` would match `src/test/Foo.kt` and miss
 * `src/test/java/com/example/FooTest.kt`, which is where every test in this
 * fleet actually lives.
 *
 * ── What this pack does NOT detect ──────────────────────────────────────────
 *
 *   - **Anything that needs a parser.** `analyzer()` returns `null` and
 *     `analyzerReason` says why: there is no Kotlin parser on this desktop and
 *     nothing here shells out to one, so `dups` and `deadExports` report
 *     `{value: null, reason}` over a Kotlin repo. Not zero duplicate pairs —
 *     nothing read the code.
 *   - **Dependencies.** `manifestPath` is `null`, so `deps` is absent rather
 *     than a number. A Gradle build file is a program: dependencies arrive
 *     through `implementation`, `api`, `ksp` and friends, through a version
 *     catalog in `gradle/libs.versions.toml`, through convention plugins, and
 *     through loops and `if`s in the script itself. Counting the
 *     `implementation` lines in `build.gradle.kts` would produce a number that
 *     is neither the declared nor the resolved dependency count, and `deps`
 *     would then mean one thing in a TypeScript repo and something else here.
 *     A catalog reader is writable later — `libs.versions.toml` has a flat
 *     `[libraries]` table — and it would be a separate, stated decision.
 *   - **A test that names its subject without importing it.** See `mentions`.
 *   - **`TODO` and `FIXME` comments.** Those are `common`'s.
 *   - **Java.** `.java` is not claimed. Three of these repos carry a handful of
 *     `.java` files and an accurate Java pack is not a Kotlin pack with a
 *     wider extension list.
 */

/**
 * One Kotlin import, and whether it ended in a wildcard.
 *
 * Group 1 is the dotted path; group 2 is present only for `import a.b.*`,
 * where group 1 captures the trailing dot and the star falls into group 2.
 * An `as` alias after the path is ignored — the alias is a local name, and a
 * local name is the bare-basename case this file's mention rule rejects.
 *
 * `m` so `^` means the start of a LINE. That flag is safe here: these regexes
 * are this module's own and are used with `matchAll` on a fresh literal, unlike
 * `hatchKinds`, which is regex SOURCE that `hatches.mjs` compiles itself with
 * `g` and nothing else.
 */
const KT_IMPORT = /^[ \t]*import[ \t]+([\w.]+)(\*)?/gm;

/** `a/b/Foo.kt` -> `Foo`. */
function basename(path) {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  return dot <= 0 ? file : file.slice(0, dot);
}

/** `a/b/Foo.kt` -> `["a", "b"]`. */
function dirSegments(path) {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

export default Object.freeze({
  name: "kotlin",
  // 2: `imports` exists — the same import statements `mentions` reads, as
  // the edges `untested` follows from a test to what it runs.
  // 3: `hatchExplain` exists — which escapes carry their reason, and the
  // throwing `TODO(` stub is a to-do, never an escape.
  version: "3",

  /** Activates when the tree at HEAD carries one of these. See the header. */
  exts: Object.freeze([".kt", ".kts"]),

  /** Nothing in this family is a generated mirror of code written elsewhere. */
  excludeSuffixes: Object.freeze([]),

  /**
   * Gradle's two test source sets, and only those. The header measures why
   * `**​/*Test.kt` is not a third.
   */
  testGlobs: Object.freeze(["**/src/test/**/*", "**/src/androidTest/**/*"]),

  /**
   * Regex SOURCE, compiled by `hatches.mjs` per call with `g` and no other
   * flag — so no `^`, which would mean the start of the whole file rather than
   * the start of a line, and no stored compiled regex, whose `lastIndex` would
   * carry between calls.
   *
   * The header argues each pattern and the near-miss it had to survive.
   */
  hatchKinds: Object.freeze({
    // A postfix operator: an expression on the left, never a letter, digit or
    // quote on the right. `"Wow!!"` fails the right-hand test; `!=` is one `!`.
    ktNotNull: "(?<=[\\w$)\\]}])!!(?![\\w$\"'])",
    // `\b` stops before `L`, so this is `@Suppress` and never `@SuppressLint`.
    ktSuppress: "@Suppress\\b",
    ktSuppressLint: "@SuppressLint\\b",
    // The throwing stub, not the comment. Overlaps `common`'s `todo` by
    // construction — see the header; the two are never summed.
    ktTodoStub: "\\bTODO\\s*\\(",
  }),

  /**
   * When an escape carries its reason — `packs/typescript.mjs` argues the two
   * places. Every Kotlin kind takes a trailing `//` comment or a comment line
   * directly above (`@Suppress("UNCHECKED_CAST") // the map is built two lines
   * up`). `ktTodoStub` is a TO-DO, like `common`'s `todo`: reported beside the
   * escapes, never counted as one, because a stub that throws is unfinished
   * work rather than a rule turned off.
   */
  hatchExplain: Object.freeze({
    commentLine: "^\\s*(?://|/\\*|\\*)",
    todo: Object.freeze(["ktTodoStub"]),
    after: Object.freeze({
      ktNotNull: "//\\s*[A-Za-z]{2}",
      ktSuppress: "//\\s*[A-Za-z]{2}",
      ktSuppressLint: "//\\s*[A-Za-z]{2}",
    }),
  }),

  // Declined, spelled as explicit nulls so a reader comparing packs can see
  // which capabilities this one refuses rather than wonder whether a key was
  // forgotten. The header says why for each.
  manifestPath: null,
  manifests: null,

  /**
   * Every `dir/name` key one Kotlin test file's text names, read from its
   * IMPORTS and from nothing else.
   *
   * ── Why an import, and why a directory segment is required ────────────────
   *
   * Kotlin's package declaration mirrors the directory it lives in, by the
   * convention every project in this fleet follows, so `import
   * de.hoh.tiptoi.domain.scene.SpotHit` and
   * `app/src/main/java/de/hoh/tiptoi/domain/scene/SpotHit.kt` are the same
   * statement written two ways. `keysFor` turns the file into the suffixes of
   * its own directory, this turns the import into `de/hoh/tiptoi/domain/scene/
   * SpotHit`, and they meet in the middle.
   *
   * The directory is REQUIRED, for the reason `packs/typescript.mjs` gives
   * under `UNTESTED_REQUIRE_DIR_SEGMENT`: a bare basename matched in both
   * directions at once, naming modules in other packages and naming strings
   * that were never paths. In Kotlin a bare class name is worse than in
   * TypeScript, not better — `Settings`, `Result`, `Page` and `Store` are each
   * a class in more than one of these repos, and a test that merely mentions
   * `Result` would mark a module of that name covered.
   *
   * ── What this therefore misses, and why that is the direction to miss in ──
   *
   * A Kotlin test in the SAME package as its subject does not import it.
   * `app/src/test/java/de/hoh/tiptoi/AtomicJsonStoreTest.kt` and
   * `AtomicJsonStore.kt` may sit in one package and never write the word
   * `import` about each other. Those modules are read as untested.
   *
   * That is a known over-report, and it is the survivable one. The alternative
   * — resolving a bare capitalised identifier against the test file's own
   * package directory — recovers the same-package case and buys with it a false
   * "tested" for every module whose name collides with a type the test merely
   * uses (`Result`, `Settings`, `Duration`). `untested` is a list a person
   * reads and checks; a module missing from that list is one nobody will ever
   * look at again. So this misses upward.
   *
   * Also not read: a wildcard `import a.b.*`, which names a package and not a
   * module; an import of a top-level function (`import a.b.doThing`), which
   * yields the key `a/b/doThing` and will not meet a file called `Util.kt`; and
   * a fully-qualified reference written inline without an import.
   *
   * @param {string} text  The test file's contents.
   * @param {string} path  Its repo-relative path. Unused — a Kotlin import is
   *   always absolute within the package tree, so there is no relative
   *   specifier to resolve against the importing file. Kept in the signature
   *   because `untested` calls every pack's `mentions` the same way.
   * @param {{requireDir?: boolean}} [opts]  `requireDir: false` restores the
   *   bare-name rule `PREREG.UNTESTED_REQUIRE_DIR_SEGMENT` switches off — the
   *   imported name alone. Kept exact so turning that constant off restores a
   *   definition that already existed and not a third one.
   * @returns {Set<string>}
   */
  mentions(text, path, opts = {}) {
    const requireDir = opts.requireDir !== false;
    const out = new Set();
    for (const m of text.matchAll(KT_IMPORT)) {
      if (m[2]) continue; // `import a.b.*` names a package, not a module.
      const segs = m[1].split(".").filter((s) => s.length > 0);
      if (segs.length === 0) continue;
      const name = segs.pop();
      if (!requireDir) {
        out.add(name);
        continue;
      }
      // No package part at all is the bare name — the case the rule rejects.
      if (segs.length) out.add(segs.join("/") + "/" + name);
    }
    return out;
  },

  /**
   * The edges `untested` follows. In this language a mention already IS an
   * import statement and nothing else, so the two capabilities are one rule:
   * called as a method, never detached.
   */
  imports(text, path, opts = {}) {
    return this.mentions(text, path, opts);
  },

  /**
   * Every `dir/name` key the module at `path` answers to: each non-empty suffix
   * of its own directory, joined to its basename.
   *
   * Suffixes, because an import carries the package and not the source root: a
   * file at `app/src/main/java/de/hoh/tiptoi/Foo.kt` is imported as
   * `de.hoh.tiptoi.Foo`, so the key that must match is the suffix
   * `de/hoh/tiptoi/Foo` and never the full path. Non-empty, because the empty
   * suffix is the bare basename the rule exists to reject — which also means a
   * `.kts` at the repo root answers to no key at all and is always listed as
   * untested, correctly: nothing imports a Gradle script.
   *
   * No `src` → `dist` mirror. That is the TypeScript pack's fact about tests
   * importing compiled output; a Kotlin test imports the same package the
   * source declares.
   *
   * @param {string} path
   * @returns {string[]}
   */
  keysFor(path) {
    const name = basename(path);
    const dir = dirSegments(path);
    const keys = [];
    for (let i = 0; i < dir.length; i++) keys.push(dir.slice(i).join("/") + "/" + name);
    return keys;
  },

  /**
   * No parser. `null` is the answer `dups` and `deadExports` need in order to
   * report absent-with-a-reason instead of zero over 468 files nothing opened.
   */
  analyzer() {
    return null;
  },

  /** The sentence `dups` and `deadExports` print when `analyzer()` is null. */
  analyzerReason: "no Kotlin parser is available, so no Kotlin file was read as code",
});
