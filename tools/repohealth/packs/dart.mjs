/**
 * The Dart pack: extensions, and nothing else.
 *
 * ── What a size-only pack is for ────────────────────────────────────────────
 *
 * A pack's smallest useful job is to say "these files are source". That alone
 * moves a repo from "every metric absent" to "the metrics that need no
 * language are present": `size` and its per-directory split, `retouch`,
 * `cochange`, the tape of largest files, and `common`'s `TODO`/`FIXME` counts,
 * all of which read a path, a commit list and a file's text and need no
 * parser and no import syntax.
 *
 * Counted at HEAD with `git ls-tree -r --name-only`, outside the excluded
 * directories: `picture-app` 67 `.dart` and `trading` 13. `picture-app` is the
 * repo this is for — before any pack claimed `.dart` or `.py` it activated
 * `common` alone, so its 67-file Flutter app and its 52-file Python backend
 * were together a tree in which `SRC.exts` was empty and every
 * source-population metric reported absent. It now has two packs, both
 * counted separately in the row, and a reader can see that the duplicate and
 * dead-export absences are about the Dart half.
 *
 * ── What this pack does NOT detect, and why each is absent and not zero ────
 *
 *   - **Escape hatches.** No `hatchKinds` beyond what `common` contributes.
 *     Dart's are real — `// ignore:` and `// ignore_for_file:` for the
 *     analyzer, `!` for the null assertion, `dynamic` for the untyped escape —
 *     and none is here, because a pattern this tool has not measured against
 *     the near-miss that inflates it is a number nobody can defend. `!` is the
 *     hard one: unlike Kotlin's `!!`, a single `!` is also logical negation
 *     and `!=`, so telling the assertion apart from the operator needs more
 *     than a lookbehind. The Kotlin pack's header shows what the evidence for
 *     one of these patterns has to look like; when somebody gathers it for
 *     Dart, the kinds belong here.
 *   - **Tests.** `testGlobs` is empty, so no `.dart` file is moved out of the
 *     measured population and into the test corpus. The convention is
 *     `test/**` and `*_test.dart`, and adding it is a change of what is
 *     measured in both directions at once — files leave `size` and arrive in
 *     `untested`'s evidence — which is not worth making while `mentions` is
 *     absent and nothing could use the corpus anyway. Until then every Dart
 *     file, test or not, is one module in the size rows — in a repo where
 *     this is the only pack with an opinion. `census.mjs` unions the test
 *     globs of every ACTIVE pack and `source.mjs` applies them to a PATH, not
 *     to a language, so a directory glob another pack contributes catches
 *     Dart too: `packs/typescript.mjs`'s `**​/test/**​/*` takes `trading`'s
 *     `mobile/test/widget/widget_test.dart` out of the measured population,
 *     because that repo has 155 JS/TS files and activates that pack.
 *     `picture-app`, whose nine `test/*_test.dart` files are the case this
 *     bullet is about, has none and is unaffected. Declining a convention
 *     here is therefore declining to state one, not a guarantee that no Dart
 *     file is ever read as a test.
 *   - **Which module a test names.** `mentions` and `keysFor` are `null`, so
 *     `untested` skips every Dart file rather than listing all of them. Dart's
 *     `import 'package:app/foo.dart'` and its relative `import '../foo.dart'`
 *     would map onto a path much the way TypeScript's do; the missing half is
 *     the `package:` prefix, which resolves through `pubspec.yaml`'s package
 *     name to `lib/`, and resolving it wrong marks the wrong modules covered.
 *   - **Duplicates and dead exports.** `analyzer()` returns `null` with a
 *     reason. There is no Dart parser here.
 *   - **Dependencies.** `manifestPath` is `null`: `pubspec.yaml` is not read.
 *     This was considered and declined on the file itself.
 *     `picture-app/pubspec.yaml` opens its `dependencies:` block with
 *     `flutter:` followed by an indented `sdk: flutter`, so the entries under
 *     that key are a mix of one-line version constraints and nested maps
 *     (`sdk:`, and elsewhere `git:` and `path:` blocks). Counting the keys at
 *     one indentation level is therefore a YAML reader — indentation-sensitive,
 *     with block scalars and comments to get right — and counting lines
 *     instead would return a number that is neither the dependency count nor
 *     anything else. `deps` means "declared dependencies" in the TypeScript
 *     and Python rows; it must not mean "lines that looked like one" here. A
 *     conservative reader is writable later: the shape to read is
 *     `dependencies:` and `dev_dependencies:` at column 0, their immediate
 *     children, and a `null` for any file that also carries
 *     `dependency_overrides:`.
 */

export default Object.freeze({
  name: "dart",
  version: "1",

  /** Activates when the tree at HEAD carries one of these. */
  exts: Object.freeze([".dart"]),

  /**
   * Generated Dart (`*.g.dart`, `*.freezed.dart`) is not excluded, because
   * neither appears in this fleet and a suffix rule that never fires is one
   * nobody can check. It would belong here, next to `packs/typescript.mjs`'s
   * `.d.ts`, on the day a repo commits one.
   */
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

  /**
   * No parser, and a sentence rather than a silence: `metrics/route.mjs` puts
   * `analyzerReason` in the row so `dups` and `deadExports` read as "nothing
   * opened these files" and never as zero.
   */
  analyzer() {
    return null;
  },

  /** The sentence `dups` and `deadExports` print when `analyzer()` is null. */
  analyzerReason: "no Dart parser is available, so no Dart file was read as code",
});
