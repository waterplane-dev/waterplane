/**
 * The Dart pack: extensions, tests, the import graph and a token-level
 * analyzer.
 *
 * ── What a size-only pack was for, and why this is no longer one ────────────
 *
 * Version 1 said only "these files are source", which moved `picture-app`
 * (67 `.dart` files at the time, 60k lines of `lib/` since) from "every metric
 * absent" to "size, retouch, co-change and TODO counts present" — and left a
 * Health index of 100 over a tree in which no Dart file was checked for tests,
 * duplication or dead code. Absent metrics did not lower the score; they were
 * simply not in it.
 *
 * ── What this pack reads (version 2) ────────────────────────────────────────
 *
 *   - **Tests.** `test/**`, `integration_test/**` and `*_test.dart`. Dart has
 *     no mention rule worth the name (a test that writes a path as a string is
 *     rare; an `import` is how a test names code), so `mentions` IS `imports`,
 *     as it is for Python. Reach is transitive over `import`, `export` and
 *     `part`, so `untested` lists the Dart modules no test reaches.
 *   - **How a URI names a module.** `package:NAME/x.dart` is this project's
 *     only when NAME is a `pubspec.yaml` `name:` in the tree (`graphContext`
 *     reads them; the import graph gets the context explicitly). Resolving it
 *     any other way would mark `package:path/path.dart` as the local
 *     `lib/path.dart`. `untested` calls `imports(text, path, {requireDir})`
 *     with no context, so `imports` falls back to the context the last
 *     `graphContext` call built; `snapshot.mjs` always builds it first, one
 *     snapshot at a time. A generic hunk (pass `snapshot.graphContexts[owner]`
 *     as `opts.ctx`) is in `docs/analysis/health-metrics/P5-dart.md`.
 *   - **Generated code.** `*.g.dart`, `*.freezed.dart`, `*.mocks.dart`,
 *     `*.gr.dart` are outside the measured population like the TS pack's
 *     `.d.ts`. A `part 'x.g.dart'` is neither an edge nor a miss, and a
 *     library that lists one reports no dead exports (the generated file may
 *     be what names them).
 *   - **Duplicates and dead exports.** `lang/dart-*.mjs`: a tokenizer and a
 *     declaration scanner, no grammar. They claim less than a parser would;
 *     `lang/dart-analyze.mjs` lists what is left out of exports.
 *
 * ── What this pack does NOT detect, and why each is absent and not zero ────
 *
 *   - **Escape hatches.** No `hatchKinds` beyond what `common` contributes.
 *     Dart's are real — `// ignore:` and `// ignore_for_file:` for the
 *     analyzer, `!` for the null assertion, `dynamic` for the untyped escape —
 *     and none is here, because a pattern this tool has not measured against
 *     the near-miss that inflates it is a number nobody can defend. `!` is the
 *     hard one: unlike Kotlin's `!!`, a single `!` is also logical negation
 *     and `!=`.
 *   - **Dependencies.** `manifestPath` is `null`: `pubspec.yaml`'s
 *     `dependencies:` block mixes one-line constraints and nested maps
 *     (`sdk:`, `git:`, `path:`), so counting keys at one indent is a YAML
 *     reader. `deps` means "declared dependencies"; it must not mean "lines
 *     that looked like one". (The package name alone IS read, for the graph.)
 *   - **Part files by library name.** `part of foo.bar;` (a name, not a URI)
 *     names no file and is not followed; the library's own `part 'x.dart'`
 *     carries the edge.
 *   - **Tests that are not Dart.** A `test/` directory of another language is
 *     not this pack's corpus (its globs end in `.dart`); the TypeScript pack's
 *     `**​/test/**​/*` still takes every file type under a `test/` directory
 *     when that pack is active, which is the measured case of `trading`.
 */

import { GENERATED_SUFFIXES, buildContext, targetsOf } from "../lang/dart-resolve.mjs";
import { blocksOf, identsOf, parseOf } from "../lang/dart-analyze.mjs";

/** `a/b/foo.dart` -> `foo.dart`. */
function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `a/b/foo.dart` -> `["a", "b"]`. */
function dirSegments(path) {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

/**
 * The resolver context of the last `graphContext` call. `untested`'s
 * `imports` call carries none; see the header. Null until a tree was read,
 * and then `package:` URIs are external: the side that lists a module as
 * untested rather than marking one reached on a guess.
 */
let lastCtx = null;

/**
 * The keys a file's directives name: the full tree path of each target. A
 * module answers to every directory suffix of its path (`keysFor`), so this
 * full path meets exactly one module in a single-package tree.
 */
function importKeys(text, path, opts) {
  const ctx = opts.ctx ?? lastCtx;
  const p = parseOf({ text, path });
  const out = new Set();
  for (const t of targetsOf(p.directives, path ?? "", ctx)) out.add(t.path);
  return out;
}

export default Object.freeze({
  name: "dart",
  // 2: `mentions`, `keysFor`, `imports`, the graph rule and an analyzer exist;
  //    tests and generated suffixes are declared.
  version: "2",

  /** Activates when the tree at HEAD carries one of these. */
  exts: Object.freeze([".dart"]),

  /** Generated Dart is not this project's code. */
  excludeSuffixes: GENERATED_SUFFIXES,

  /**
   * `flutter test` and `dart test` discover `test/**_test.dart`;
   * `integration_test/` is Flutter's.
   */
  testGlobs: Object.freeze(["**/test/**/*.dart", "**/integration_test/**/*.dart", "**/*_test.dart"]),

  /** None. `common`'s `TODO` and `FIXME` are the only marks counted here. */
  hatchKinds: Object.freeze({}),

  // Declined, spelled as explicit nulls so a reader comparing packs can see
  // which capabilities this one refuses.
  manifestPath: null,
  manifests: null,

  /** A test names a module by importing it: the same rule as `imports`. */
  mentions(text, path, opts = {}) {
    return importKeys(text, path, opts);
  },

  /** The edges `untested` follows: `import`, `export` and `part` targets. */
  imports(text, path, opts = {}) {
    return importKeys(text, path, opts);
  },

  /**
   * Every key the module at `path` answers to: each directory suffix joined to
   * the file name, extension kept, and the bare name for a root-level file
   * (an exact tree path, not a guess).
   */
  keysFor(path) {
    const name = basename(path);
    const dir = dirSegments(path);
    if (dir.length === 0) return [name];
    const keys = [];
    for (let i = 0; i < dir.length; i++) keys.push(dir.slice(i).join("/") + "/" + name);
    return keys;
  },

  /** Every `pubspec.yaml`: it names the packages whose `package:` URIs are ours. */
  graphConfigPath: "(^|/)pubspec\\.yaml$",

  graphContext(entries, textOf) {
    lastCtx = buildContext(entries, textOf);
    return lastCtx;
  },

  /**
   * One entry per directive target. Every candidate is a whole tree path
   * (`relative` is false), matched against `graphKeysFor` only: a relative
   * import is resolved here, not by suffix, so `lib/a/x.dart` never reaches
   * `vendor/lib/a/x.dart`. `null` when the lexer ended inside a string or
   * comment: the imports are then unknown, not fewer.
   */
  graphImports(file, ctx) {
    const p = parseOf(file);
    if (!p.ok) return null;
    return targetsOf(p.directives, file.path ?? "", ctx).map((t) => ({
      spec: t.spec,
      internal: true,
      candidates: [t.path],
    }));
  },

  graphKeysFor(path) {
    return [path];
  },

  /**
   * Tokenizer-based, always available (there is no install to miss).
   * @returns {{blocks: Function, idents: Function}}
   */
  analyzer() {
    return {
      blocks: (file, params) => blocksOf(file, params),
      idents: (file) => identsOf(file),
    };
  },

  /** Kept for a caller that asks; unused while `analyzer()` is non-null. */
  analyzerReason: "no Dart file was read as code",
});
