/**
 * The C pack: extensions, and nothing else.
 *
 * ── What this brings into view ─────────────────────────────────────────────
 *
 * Counted at HEAD with `git ls-tree -r --name-only`: `Tiptoi` 49 `.h` and 25
 * `.c`, and `picture-app` 5 `.h`. Tiptoi is the repo this is for. It is four
 * codebases in one tree — 239 Kotlin files, 140 Python, 74 C, 32 JavaScript —
 * and under a `.ts`-only definition the engine measured the 32 and reported
 * its numbers with no sign that the other 453 files existed. With four packs
 * active the row carries a file count per pack, so the reading says which
 * third of the repo it covers.
 *
 * Of those 74 C files, THREE are Tiptoi's: `app/src/main/cpp/vorbis_encode.c`,
 * its header, and `vorbis_jni.c`, 308 lines between them. The other 71 sit
 * under `app/src/main/cpp/third_party/` and are libvorbis and libogg, 61,782
 * lines — so the numbers above are what the extension count says and the
 * measured population is 3. `packs/common.mjs` excludes the directory and
 * carries the argument; this pack claims the extensions and the two are
 * different questions, which is why `census.mjs` publishes both counts.
 *
 * `.h` and `.c`, and not `.cpp`, `.cc`, `.hpp` or `.m`. C++ is a different
 * language with a different parser and different escape hatches, and claiming
 * its extensions here would put `picture-app`'s four `.cpp` files under a pack
 * whose name says something untrue about them. A `.h` is counted as source
 * rather than excluded the way `packs/typescript.mjs` excludes `.d.ts`,
 * because a C header is not a generated description of code that lives
 * elsewhere: it is hand-written, it carries macros and static inline
 * functions, and in Tiptoi it is 49 files against 25 `.c` — excluding it would
 * hide two thirds of the C in the repo.
 *
 * ── The one generated header, and why the other four stay ─────────────────
 *
 * `picture-app` activates this pack on five `.h` files and none of them is C
 * anybody wrote for that project: `windows/flutter/generated_plugin_registrant.h`
 * and four headers under `windows/runner/`, all of them produced by
 * `flutter create`. Exactly one is excluded, by suffix:
 * `generated_plugin_registrant.h` opens "Generated file. Do not edit." and is
 * rewritten from the plugin list on every build, which is the `.d.ts` case
 * `packs/typescript.mjs` argues — a file that describes code living elsewhere
 * and that nobody maintains.
 *
 * The four `windows/runner/` headers are not excluded, and the difference is
 * not tidiness. They are scaffold: generated ONCE, committed, and edited from
 * then on — `win32_window.h` is where a Flutter app's window behaviour is
 * changed and `resource.h` carries its icon ids. Code a person can edit and
 * must keep building is code the repo maintains, whatever wrote the first
 * draft, and the whole point of these lists is to drop what has an upstream
 * owner rather than what had a generator. That also settles the directory
 * question: `windows/flutter` and `windows/runner` are not on
 * `packs/common.mjs`'s excluded list, because `windows` and `runner` are
 * ordinary words that name real source directories elsewhere, and a whole
 * platform target is not vendored code.
 *
 * ── What this pack does NOT detect, and why each is absent and not zero ────
 *
 *   - **Escape hatches.** No `hatchKinds` beyond what `common` contributes.
 *     C's are real — a cast to `void *`, `#pragma GCC diagnostic ignored`,
 *     `(void)unused`, a `goto` out of an error path — and none is here because
 *     none has been measured against the near-miss that would inflate it. A
 *     cast is the instructive one: `(int)` is a cast, `(int)` is also how a
 *     prototype and a call are written, and telling them apart is the parser
 *     this pack does not have.
 *   - **Tests.** `testGlobs` is empty. C has no test-file convention to
 *     encode: a suite is a `tests/` directory, or a `_test.c` suffix, or a
 *     separate build target, and a glob guessed at would take real modules out
 *     of the measured population.
 *   - **Which module a test names.** `mentions` and `keysFor` are `null`. A
 *     `#include "foo.h"` does map onto a path, but it resolves through the
 *     include path the build sets — `-I` flags in a `Makefile.am`, which is
 *     where Tiptoi's live — so the same text names different files in
 *     different targets. `untested` therefore skips these files rather than
 *     listing all of them or matching the wrong ones.
 *   - **Duplicates and dead exports.** `analyzer()` returns `null` with a
 *     reason. There is no C parser here, and reaching one means a process.
 *   - **Dependencies.** C has no dependency manifest in this fleet. Tiptoi's
 *     C builds with autotools; `configure.ac` is a program.
 */

export default Object.freeze({
  name: "c",
  // 2: one generated header is excluded by suffix. See the header.
  version: "2",

  /** Activates when the tree at HEAD carries one of these. See the header. */
  exts: Object.freeze([".h", ".c"]),

  /**
   * `isSource` tests `path.endsWith`, so the leading slash is what keeps this
   * a whole filename and not a suffix that would also drop a hand-written
   * `my_generated_plugin_registrant.h`. One entry, one file in this fleet,
   * and it fires — see the header on why the four scaffold headers beside it
   * do not.
   */
  excludeSuffixes: Object.freeze(["/generated_plugin_registrant.h"]),

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
  graphKeysFor: null,

  /**
   * No parser, and a sentence rather than a silence: `metrics/route.mjs` puts
   * `analyzerReason` in the row so `dups` and `deadExports` read as "nothing
   * opened these files" and never as zero.
   */
  analyzer() {
    return null;
  },

  /** The sentence `dups` and `deadExports` print when `analyzer()` is null. */
  analyzerReason: "no C parser is available, so no C source or header was read as code",
});
