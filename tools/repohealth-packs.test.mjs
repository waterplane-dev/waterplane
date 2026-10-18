/**
 * The language packs, checked against the near-misses that would inflate them.
 *
 * ── Why this file exists next to `tools/repohealth.test.mjs` ───────────────
 *
 * That file guards the SERIES: a committed fixture is re-derived so that a
 * change in how a number is computed shows up as the past moving. It needs a
 * repo, a git history and 22 trees to do it.
 *
 * A pack is a different kind of thing and breaks in a different way. Its
 * failure is not "the past moved", it is "the pattern matched something that
 * is not a hatch", or "a test file was read as naming a module it does not
 * name" — and both of those are invisible in a fixture, because the fixture is
 * whatever the pattern produced on the day it was written. A regex that counts
 * `"Wow!!"` as a Kotlin not-null assertion produces a stable, reproducible,
 * wrong number forever.
 *
 * So everything here is a hand-written literal: no repo, no git, no fixture,
 * no filesystem. A snippet that must match, and beside it the snippet that
 * must not. The negative half is the point — a pattern nobody tried to break
 * is a pattern that has not been tested — and the negatives are the shapes
 * measured in the fleet, not invented ones: `!=` against Kotlin's `!!`
 * (823 occurrences against 412), `except Foo:` against Python's bare handler
 * (1,365 against 6).
 *
 * ── The third thing under guard: an absence that reads as a zero ───────────
 *
 * A pack that cannot do something must say so. `metrics/route.mjs` tests a
 * capability by `typeof === "function"` and prints `analyzerReason` when a
 * parser is absent, so a pack that spelled a declined capability as `0`,
 * `false` or `undefined` would flow through the same branches and arrive in a
 * row as a confident nothing. The last group of tests asserts the shape:
 * declined is `null`, and an absent analyzer carries a sentence.
 *
 * Nothing here asserts that a count is low, that an absence needs filling,
 * or that one pack is better than another. The tool reads; it does not judge.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PACKS } from "./repohealth/packs/index.mjs";
import { configure } from "./repohealth/census.mjs";
import { isSource, isTestPath } from "./repohealth/source.mjs";
import common from "./repohealth/packs/common.mjs";
import kotlin from "./repohealth/packs/kotlin.mjs";
import python from "./repohealth/packs/python.mjs";
import dart from "./repohealth/packs/dart.mjs";
import shell from "./repohealth/packs/shell.mjs";
import c from "./repohealth/packs/c.mjs";
import typescript from "./repohealth/packs/typescript.mjs";
import { measureUntested } from "./repohealth/metrics/untested.mjs";
import { SERIES, listMoves } from "./repohealth/readings.mjs";

/**
 * A hatch kind's pattern, compiled the way `hatches.mjs` compiles it: fresh,
 * global, and with no other flag. Fresh because a shared global regex carries
 * `lastIndex` between calls; with no `m` because that is what the metric does,
 * so a pattern that only works multiline here would count nothing there.
 */
function hatchCount(pack, kind, text) {
  const src = pack.hatchKinds[kind];
  assert.ok(src, `${pack.name} has no hatch kind "${kind}"`);
  let n = 0;
  for (const _ of text.matchAll(new RegExp(src, "g"))) n++;
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// Kotlin: the escape hatches.
// ───────────────────────────────────────────────────────────────────────────

test("kotlin: !! counts the not-null assertion in every shape the fleet writes", () => {
  // The five right-hand shapes measured across the five Kotlin repos, plus the
  // end of a line, which is the rest of them.
  const src = [
    "val a = user!!.name",
    "send(payload!!, retry)",
    "log(state.value!!)",
    "val x = raw.rateLh!! * 1.25",
    "val first = items!![0]",
    "return cached!!",
  ].join("\n");
  assert.equal(hatchCount(kotlin, "ktNotNull", src), 6);
});

test("kotlin: !! does not fire inside a string, on !=, or on a lone !", () => {
  const src = [
    'toast("Saved!!")', //            an exclamation at the end of a literal
    'label = "Careful!!"',
    "if (a != b) return", //          one `!`, not two
    "if (a !== b) return", //         not Kotlin, and still not two
    "check(!ready)", //               logical negation
    "val ok = !!", //                 nothing on the left: not a postfix use
  ].join("\n");
  assert.equal(hatchCount(kotlin, "ktNotNull", src), 0);
});

test("kotlin: @Suppress and @SuppressLint are two kinds and never each other", () => {
  const src = ['@Suppress("UNCHECKED_CAST")', "@SuppressLint(\"MissingPermission\")", "@Suppress"].join("\n");
  assert.equal(hatchCount(kotlin, "ktSuppress", src), 2);
  assert.equal(hatchCount(kotlin, "ktSuppressLint", src), 1);
  // The word boundary is what keeps them apart; a reader must be able to
  // trust that the two counts never double-count one annotation.
  assert.equal(hatchCount(kotlin, "ktSuppress", "@SuppressLint(\"NewApi\")"), 0);
});

test("kotlin: TODO() is the throwing stub, not the comment", () => {
  assert.equal(hatchCount(kotlin, "ktTodoStub", "fun render(): Unit = TODO()"), 1);
  assert.equal(hatchCount(kotlin, "ktTodoStub", "fun render(): Unit = TODO(\"later\")"), 1);
  assert.equal(hatchCount(kotlin, "ktTodoStub", "// TODO: handle the empty case"), 0);
  assert.equal(hatchCount(kotlin, "ktTodoStub", "val todos = listOf(1)"), 0);

  // And the overlap with `common` is real and deliberate — a stub adds one to
  // each kind. Asserted so that nobody "fixes" it into a silent subtraction:
  // the two kinds mean different things and are never summed.
  const stub = "fun render(): Unit = TODO()";
  assert.equal(hatchCount(common, "todo", stub), 1);
  assert.equal(hatchCount(kotlin, "ktTodoStub", stub), 1);
});

// ───────────────────────────────────────────────────────────────────────────
// Kotlin: which module a test names.
// ───────────────────────────────────────────────────────────────────────────

test("kotlin: an import resolves to the key the module answers to", () => {
  const module = "app/src/main/java/de/hoh/tiptoi/domain/scene/SpotHit.kt";
  const testFile = "app/src/test/java/de/hoh/tiptoi/SpotHitTest.kt";
  const text = ["package de.hoh.tiptoi", "", "import de.hoh.tiptoi.domain.scene.SpotHit", "import org.junit.Test"].join(
    "\n",
  );

  const named = kotlin.mentions(text, testFile);
  const keys = kotlin.keysFor(module);
  assert.ok(
    keys.some((k) => named.has(k)),
    `no key of ${module} is in ${[...named].join(", ")}`,
  );
  // The specific key the two meet on, so a change to either side that happens
  // to keep them meeting on a different one is visible.
  assert.ok(named.has("de/hoh/tiptoi/domain/scene/SpotHit"));
});

test("kotlin: a bare class name names nothing", () => {
  // The same test file, using the class after a wildcard import. The rule
  // `packs/typescript.mjs` argues for under UNTESTED_REQUIRE_DIR_SEGMENT:
  // `Result`, `Settings` and `Page` are each a class in more than one of these
  // repos, and a bare name would mark all of them covered at once.
  const text = ["import de.hoh.tiptoi.domain.scene.*", "", "class T { fun a() { SpotHit(1, 2) } }"].join("\n");
  const named = kotlin.mentions(text, "app/src/test/java/de/hoh/tiptoi/SpotHitTest.kt");
  assert.equal(named.has("SpotHit"), false);
  assert.deepEqual([...named], [], "a wildcard import names a package, not a module");
});

test("kotlin: an import with no package part is rejected, and so is a rootless module", () => {
  assert.deepEqual([...kotlin.mentions("import Foo", "app/src/test/T.kt")], []);
  // The other end of the same rule: a file at the repo root has no directory
  // segment, so it answers to no key and can never be matched by a bare name.
  assert.deepEqual(kotlin.keysFor("build.gradle.kts"), []);
});

test("kotlin: keysFor offers every suffix, because an import carries the package and not the source root", () => {
  assert.deepEqual(kotlin.keysFor("app/src/main/java/de/hoh/Foo.kt"), [
    "app/src/main/java/de/hoh/Foo",
    "src/main/java/de/hoh/Foo",
    "main/java/de/hoh/Foo",
    "java/de/hoh/Foo",
    "de/hoh/Foo",
    "hoh/Foo",
  ]);
});

// ───────────────────────────────────────────────────────────────────────────
// Python: the escape hatches.
// ───────────────────────────────────────────────────────────────────────────

test("python: the two written suppressions count in their bracketed forms too", () => {
  const src = [
    "x = cast(int, y)  # type: ignore",
    "z = f()  # type: ignore[arg-type]",
    "import config  # noqa: E402",
    "from x import y  # noqa",
  ].join("\n");
  assert.equal(hatchCount(python, "pyTypeIgnore", src), 2);
  assert.equal(hatchCount(python, "pyNoqa", src), 2);
});

test("python: a suppression must be written as a comment", () => {
  const src = ['MODE = "type: ignore"', "noqa = compute()", "def noqa_rule(): pass"].join("\n");
  assert.equal(hatchCount(python, "pyTypeIgnore", src), 0);
  assert.equal(hatchCount(python, "pyNoqa", src), 0);
});

test("python: a bare except: counts and except Foo: does not", () => {
  const src = [
    "try:",
    "    risky()",
    "except:",
    "    pass",
    "try:",
    "    risky()",
    "except ValueError:",
    "    pass",
    "try:",
    "    risky()",
    "except (KeyError, IndexError) as exc:",
    "    pass",
    "try:",
    "    risky()",
    "except :", //                     a space before the colon is still bare
    "    pass",
  ].join("\n");
  assert.equal(hatchCount(python, "pyBareExcept", src), 2);

  // The dominant near-miss, on its own: 1,365 of these in the fleet against 6
  // real bare handlers, so a pattern that caught them would be off by 200x.
  assert.equal(hatchCount(python, "pyBareExcept", "except FileNotFoundError:"), 0);
  // Anchored to the start of a LINE, and with `g` and no `m` — which is how
  // `hatches.mjs` compiles it — so the anchor has to be the newline itself.
  assert.equal(hatchCount(python, "pyBareExcept", "    handler = self.except_map\n"), 0);
});

test("python: Any counts at an annotation position and not as the English word", () => {
  const src = [
    "def load(raw: Any) -> Any:",
    "    ...",
    "value: Any = None",
    "def keep(a: int, b: Any, c: str) -> None:",
  ].join("\n");
  // `raw: Any`, `-> Any`, `value: Any`, `b: Any`. `-> None` is not one.
  assert.equal(hatchCount(python, "pyAny", src), 4);

  const prose = [
    "# Anything that fails here is retried.",
    '"""Anyone may call this."""',
    "from typing import Any, Dict", //  the import itself declares nothing
    "many = Anywhere()",
  ].join("\n");
  assert.equal(hatchCount(python, "pyAny", prose), 0);

  // The stated undercount, asserted so it stays a decision rather than a
  // surprise: the container form is not reached, because the only way to
  // reach it is a comma or a bracket before `Any`, and a comma also matches
  // the `from typing import Dict, Any` line above, which declares nothing.
  // 210 occurrences in the fleet are outside this pattern on purpose.
  assert.equal(hatchCount(python, "pyAny", "payload: Dict[str, Any] = {}"), 0);
  assert.equal(hatchCount(python, "pyAny", "items: list[Any] = []"), 0);
});

// ───────────────────────────────────────────────────────────────────────────
// Python: which module a test names.
// ───────────────────────────────────────────────────────────────────────────

test("python: a from-import resolves to the key the module answers to", () => {
  const module = "service/tiptoi_service/main.py";
  const text = ["from __future__ import annotations", "", "from tiptoi_service.main import is_open_path"].join("\n");

  const named = python.mentions(text, "service/tests/test_api.py");
  assert.ok(named.has("tiptoi_service/main"));
  assert.ok(
    python.keysFor(module).some((k) => named.has(k)),
    `no key of ${module} is in ${[...named].join(", ")}`,
  );
});

test("python: import a.b names a/b, and a single segment names nothing", () => {
  const named = python.mentions(["import db.session as _ses", "import config", "import os, sys"].join("\n"), "tests/t.py");
  assert.ok(named.has("db/session"));
  // `import config` is the bare-basename case the directory rule rejects — and
  // the other end agrees: a root-level `config.py` answers to no key either.
  assert.equal(named.has("config"), false);
  assert.deepEqual(python.keysFor("config.py"), []);
});

test("python: a from-import also offers the submodule key, because the syntax does not say which it is", () => {
  const named = python.mentions("from db.models import Base", "tests/t.py");
  assert.ok(named.has("db/models"), "db/models.py");
  assert.ok(named.has("db/models/Base"), "db/models/Base.py");
});

test("python: a relative import resolves against the file that wrote it", () => {
  const named = python.mentions("from .store import Thing\nfrom ..app import boot", "service/tests/test_store.py");
  assert.ok(named.has("service/tests/store"), [...named].join(", "));
  assert.ok(named.has("service/app"), [...named].join(", "));
  // And never the same name under somebody else's directory.
  assert.equal(named.has("store"), false);
});

test("python: a trailing comment on an import does not mint a module key", () => {
  const named = python.mentions("from isolation import apply_settings  # noqa: E402", "tests/test_auth.py");
  assert.ok(named.has("isolation/apply_settings"));
  assert.equal(named.has("isolation/noqa"), false);
  assert.equal(named.has("isolation/E402"), false);
});

// ───────────────────────────────────────────────────────────────────────────
// Python: the two manifests it will read, and the shapes it refuses.
// ───────────────────────────────────────────────────────────────────────────

/** `manifests` takes tree entries and a text reader; neither needs a repo. */
function manifestsOf(files) {
  const entries = Object.keys(files).map((path) => ({ path, oid: path }));
  return python.manifests(entries, (e) => files[e.path]);
}

test("python: requirements lines are counted, and directives and comments are not", () => {
  const rows = manifestsOf({
    "requirements.txt": [
      "# --- Core ---",
      "httpx>=0.27.2",
      "uvicorn[standard]>=0.30.0",
      "",
      "-r base.txt", //            a directive: counting it double-counts a file
      "-e .",
      "--index-url https://example.invalid/simple",
      "sqlalchemy>=2.0.30",
    ].join("\n"),
  });
  assert.deepEqual(rows, [{ pkg: "requirements.txt", deps: 3, devDeps: 0 }]);
});

test("python: a dev requirements file fills devDeps, and both zeros are real readings", () => {
  const rows = manifestsOf({
    "service/requirements.txt": "fastapi>=0.115\nhttpx>=0.28\n",
    "service/requirements-dev.txt": "-r requirements.txt\npytest==8.3.4\nhttpx==0.28.1\n",
  });
  assert.deepEqual(rows, [
    { pkg: "service/requirements-dev.txt", deps: 0, devDeps: 2 },
    { pkg: "service/requirements.txt", deps: 2, devDeps: 0 },
  ]);
  // `pkg` is the PATH and not the directory: these two sit in one directory
  // and a directory label would collapse them into two rows nobody can tell
  // apart.
  assert.equal(new Set(rows.map((r) => r.pkg)).size, rows.length);
});

test("python: pyproject reads [project] dependencies and nothing else in the file", () => {
  const rows = manifestsOf({
    "backend/pyproject.toml": [
      "[build-system]",
      'requires = ["setuptools>=68.0", "wheel"]', //  a different table
      "",
      "[project]",
      'name = "x"',
      "dependencies = [",
      '    "fastapi>=0.115,<1",',
      '    "lxml>=5.0,<7",  # a trailing comment inside the array',
      '    "httpx>=0.27,<1",',
      "]",
      "",
      "[project.optional-dependencies]", //           an extra is not a dev dep
      'claude = ["anthropic>=0.116,<1"]',
    ].join("\n"),
  });
  assert.deepEqual(rows, [{ pkg: "backend/pyproject.toml", deps: 3, devDeps: 0 }]);
});

test("python: a pyproject shape this reader does not recognise contributes no row", () => {
  // `dynamic` says the list is computed at build time and is not in this file.
  assert.equal(
    manifestsOf({ "pyproject.toml": '[project]\nname = "x"\ndynamic = ["dependencies"]\n' }),
    null,
  );
  // No `[project]` table at all: a build-tool-only or Poetry-only file.
  assert.equal(manifestsOf({ "pyproject.toml": '[tool.poetry]\nname = "x"\n' }), null);
  // A `[project]` that genuinely declares none is 0, which is a reading.
  assert.deepEqual(manifestsOf({ "pyproject.toml": '[project]\nname = "x"\n' }), [
    { pkg: "pyproject.toml", deps: 0, devDeps: 0 },
  ]);
});

test("python: no manifest in the tree is null, never a row of zeros", () => {
  assert.equal(python.manifests([], () => ""), null);
});

// ───────────────────────────────────────────────────────────────────────────
// Absence: a declined capability must not read as a zero.
// ───────────────────────────────────────────────────────────────────────────

const SIZE_ONLY = [dart, shell, c];
const ALL_NEW = [kotlin, python, dart, shell, c];

test("a pack with no parser says so, and the sentence is not empty", () => {
  for (const pack of ALL_NEW) {
    // `metrics/route.mjs` calls `analyzer()` once per pack and prints
    // `analyzerReason` when it returns null. A pack that spelled this as
    // `false` or left the key off would be indistinguishable from a parser
    // that loaded and found nothing.
    assert.equal(typeof pack.analyzer, "function", `${pack.name}.analyzer`);
    assert.equal(pack.analyzer(), null, `${pack.name}.analyzer()`);
    assert.equal(typeof pack.analyzerReason, "string", `${pack.name}.analyzerReason`);
    assert.ok(pack.analyzerReason.length > 0, `${pack.name}.analyzerReason is empty`);
  }
});

test("a declined capability is null — never undefined, 0 or false", () => {
  for (const pack of SIZE_ONLY) {
    for (const cap of ["manifestPath", "manifests", "mentions", "keysFor", "imports"]) {
      assert.equal(pack[cap], null, `${pack.name}.${cap} must be an explicit null`);
      // `route.mjs` tests a capability with `typeof === "function"`, so the
      // one thing that must never be true is that this looks callable.
      assert.notEqual(typeof pack[cap], "function", `${pack.name}.${cap}`);
    }
  }
  for (const pack of [kotlin, python]) {
    assert.equal(typeof pack.mentions, "function", `${pack.name}.mentions`);
    assert.equal(typeof pack.keysFor, "function", `${pack.name}.keysFor`);
    assert.equal(typeof pack.imports, "function", `${pack.name}.imports`);
  }
  // Kotlin declines dependencies; Python supplies them.
  assert.equal(kotlin.manifestPath, null);
  assert.equal(kotlin.manifests, null);
  assert.equal(typeof python.manifests, "function");
});

test("a size-only pack claims extensions and adds no hatch kind", () => {
  for (const pack of SIZE_ONLY) {
    assert.ok(pack.exts.length > 0, `${pack.name} claims no extension`);
    assert.deepEqual(pack.hatchKinds, {}, `${pack.name} declares a hatch kind`);
    assert.deepEqual(pack.testGlobs, [], `${pack.name} declares a test glob`);
  }
});

test("every hatch pattern compiles the way hatches.mjs compiles it", () => {
  for (const pack of PACKS) {
    for (const [kind, src] of Object.entries(pack.hatchKinds ?? {})) {
      assert.doesNotThrow(() => new RegExp(src, "g"), `${pack.name}.${kind}`);
      // `^` would mean the start of the whole file, not of a line: the metric
      // compiles with `g` and no `m`, so an anchored pattern silently counts
      // at most one occurrence per file.
      assert.equal(src.startsWith("^"), false, `${pack.name}.${kind} anchors with ^`);
    }
  }
});

test("no two packs claim one hatch kind name", () => {
  // `census.mjs` throws on a collision at configure time, which is the
  // load-bearing check. This one fails in the registry instead of in a repo,
  // so the message names the pack rather than the tree that happened to
  // activate both.
  const owner = new Map();
  for (const pack of PACKS) {
    for (const kind of Object.keys(pack.hatchKinds ?? {})) {
      assert.equal(owner.get(kind), undefined, `"${kind}" is claimed by ${owner.get(kind)} and ${pack.name}`);
      owner.set(kind, pack.name);
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// The census over a tree that is one language.
// ───────────────────────────────────────────────────────────────────────────

/** A `git` stand-in: `configure` asks it for one thing and spawns nothing. */
function treeOf(paths) {
  return { listHeadPaths: () => paths };
}

test("a tree of only .kt files activates kotlin and common, and nothing else", () => {
  const cfg = configure(
    "/nowhere",
    treeOf([
      "app/src/main/java/de/hoh/app/Main.kt",
      "app/src/main/java/de/hoh/app/Store.kt",
      "app/src/test/java/de/hoh/app/StoreTest.kt",
      "README.md",
      "app/src/main/res/layout/main.xml",
    ]),
  );

  assert.deepEqual(
    cfg.PACKS.map((p) => p.name),
    ["common", "kotlin"],
  );
  // `common` claims no extension, so nothing activated it — `always` did.
  assert.deepEqual(
    cfg.PACKS.map((p) => p.extFiles),
    [0, 3],
  );
  // And the denominator is the MEASURED population: the third `.kt` is under
  // Gradle's test source set, so it activated the pack and is not one of the
  // files any metric read. `metrics/route.mjs` prints this number beside an
  // absence, which is why the two counts are not allowed to be one.
  assert.deepEqual(
    cfg.PACKS.map((p) => p.files),
    [0, 2],
  );

  // The unions are Kotlin's and the floor's, and carry no other language's.
  assert.deepEqual(cfg.SRC.exts, [".kt", ".kts"]);
  assert.deepEqual(cfg.SRC.testGlobs, ["**/src/androidTest/**/*", "**/src/test/**/*"]);
  assert.deepEqual(Object.keys(cfg.HATCH_KINDS).sort(), [
    "fixme",
    "ktNotNull",
    "ktSuppress",
    "ktSuppressLint",
    "ktTodoStub",
    "todo",
  ]);
  for (const ts of ["colonAny", "asAny", "eslintDisable"]) {
    assert.equal(ts in cfg.HATCH_KINDS, false, `${ts} leaked into a Kotlin-only tree`);
  }
});

test("the version string moves with the active pack list and not with the tree", () => {
  const kt = configure("/nowhere", treeOf(["a/Main.kt"])).VERSION;
  const ktAgain = configure("/nowhere", treeOf(["a/Main.kt", "b/Other.kt", "c/Third.kt"])).VERSION;
  const ktAndPy = configure("/nowhere", treeOf(["a/Main.kt", "a/run.py"])).VERSION;

  // Same packs, different trees: the same version. A row's reproducibility
  // comes from its sha, not from the version string, so the hash must not
  // move because somebody committed another file.
  assert.equal(kt, ktAgain);
  // A pack activating IS a definition change, and the string has to say so.
  assert.notEqual(kt, ktAndPy);
});

test("a tree no pack claims still has a hatch shape, and no source extensions", () => {
  // The designed degradation: `common` alone. Every source-population metric
  // then reports absent with a reason, and none of them reports 0.
  const cfg = configure("/nowhere", treeOf(["main.rs", "Cargo.toml", "README.md"]));
  assert.deepEqual(
    cfg.PACKS.map((p) => p.name),
    ["common"],
  );
  assert.deepEqual(cfg.SRC.exts, []);
  assert.deepEqual(Object.keys(cfg.HATCH_KINDS).sort(), ["fixme", "todo"]);
});

// ───────────────────────────────────────────────────────────────────────────
// What is source: the two ways a file that is not this project's own code
// used to be counted as it.
// ───────────────────────────────────────────────────────────────────────────

test("a test file is a test in every shape the family writes, not just this repo's", () => {
  // The globs used to be `*.test.mjs` and `scripts/e2e-*.mjs` — how waterplane
  // writes a test and how almost nobody else does. Every shape below was
  // measured in the fleet as a file that was being counted as a module of
  // the project: 170 in `FeedbackPlatform` alone. A test inside the measured
  // population moves `size`, `hatches`, `dups`, `cochange` and
  // `classics.files`; outside the corpus it moves `untested`. Literals, so
  // the assertion is about the definition and not about a tree.
  const cfg = configure("/nowhere", treeOf(["src/app.ts"]));

  for (const path of [
    "apps/web/src/api.test.ts",
    "apps/web/src/Button.test.tsx",
    "packages/ai/src/rank.spec.ts",
    "packages/ai/src/rank.spec.js",
    "lib/util.test.js",
    "lib/util.test.mjs",
    "lib/util.test.cjs",
    "apps/web/test/api-lookup.test.ts",
    "apps/web/test/helpers.ts",
    "packages/x/tests/deep/nested/case.ts",
    "src/__tests__/reducer.ts",
    "apps/web/e2e/checkout.spec.ts",
    "apps/web/e2e/fixtures/user.ts",
    "scripts/e2e-search.mjs",
  ]) {
    assert.equal(isTestPath(path, cfg), true, `${path} is a test file in this family`);
    assert.equal(isSource(path, cfg), false, `${path} must not be in the measured population`);
  }

  // The near-misses, which matter as much: a module is not a test because the
  // word appears in it, and a directory is not a suite because its name
  // starts with one. `latest/` and `contest.ts` are the shapes a `**/test*`
  // or an unanchored match would swallow.
  for (const path of [
    "src/testing.ts",
    "src/contest.ts",
    "src/latest/index.ts",
    "src/attest.spec.helper.ts",
    "src/protest.ts",
  ]) {
    assert.equal(isTestPath(path, cfg), false, `${path} is not a test file`);
    assert.equal(isSource(path, cfg), true, `${path} is a module and must be measured`);
  }
});

test("typescript: .mts and .cts are source; their declarations and tests are not", () => {
  // The hole this pins: until typescript@6 the pack claimed `.mjs` and `.cjs`
  // but not their TypeScript twins, so every in-repo extension's host code —
  // 95 files, the largest file in the tree among them — was measured by
  // nothing. Literals, like the test above.
  const cfg = configure("/nowhere", treeOf(["packages/extensions/demo/host/index.mts"]));
  for (const path of ["packages/extensions/demo/host/index.mts", "packages/extensions/demo/shared/wire.mts", "src/legacy/config.cts"]) {
    assert.equal(isSource(path, cfg), true, `${path} is a module and must be measured`);
  }
  for (const path of ["packages/extensions/demo/cli/strength.d.mts", "src/types.d.cts", "src/sock.test.mts", "src/sock.spec.cts"]) {
    assert.equal(isSource(path, cfg), false, `${path} must not be in the measured population`);
  }
  assert.equal(isTestPath("src/sock.test.mts", cfg), true);
  assert.equal(isTestPath("src/sock.spec.cts", cfg), true);
});

test("vendored code is not this project's code, whatever the tree calls the directory", () => {
  // Measured on `Tiptoi`: 71 of its 74 C files are under
  // `app/src/main/cpp/third_party/`, 61,782 lines of libvorbis and libogg
  // against 308 lines of its own C. Before the name was on the list its
  // largest file, its p95 and a third of its tape were somebody else's
  // library. The check is on literals and on the real `configure`, so it is
  // the shipped list under test and not a copy of one.
  const cfg = configure("/nowhere", treeOf(["app/src/main/cpp/tiptoi.c", "src/app.ts"]));

  for (const path of [
    "app/src/main/cpp/third_party/libvorbis/lib/books/coupled/res_books_stereo.h",
    "app/src/main/cpp/third_party/libogg/src/framing.c",
    "vendor/lib/x.ts",
    "thirdparty/zlib/zlib.h",
    "3rdparty/json/json.h",
    "external/googletest/include/gtest.h",
    "ios/Pods/Firebase/Core.h",
    "node_modules/left-pad/index.js",
    "packages/web/dist/main.js",
  ]) {
    assert.equal(isSource(path, cfg), false, `${path} is not this project's own code`);
  }

  // And the segment test is a segment test: a directory whose name merely
  // contains an excluded one is the project's.
  for (const path of ["app/src/main/cpp/tiptoi.c", "src/vendors/stripe.ts", "src/external-api/client.ts"]) {
    assert.equal(isSource(path, cfg), true, `${path} is this project's own code`);
  }
});

test("only an always-on pack may say what is vendored", () => {
  // The list has to be applied to the tree scan that decides which language
  // packs are active, so a pack that must be activated first cannot
  // contribute to it — the activation pass and the source pass would then
  // disagree about which files are vendored. The refusal is how that stays
  // true rather than being remembered.
  const rogue = { ...kotlin, always: false, excludeDirs: Object.freeze(["thirdparty"]) };
  assert.throws(() => configure("/nowhere", treeOf(["a/Main.kt"]), [common, rogue]), /excludeDirs/);
});

// ───────────────────────────────────────────────────────────────────────────
// Which modules a test names, and which it reaches.
// ───────────────────────────────────────────────────────────────────────────

test("typescript: a reference may carry every extension the pack claims, not a second list of them", () => {
  // The bug this pins: the accepted extensions were the literal `tsx|ts|js`
  // after `exts` had widened to the whole family, so a `.mjs` module imported
  // by its file name read as named by no test. Driven off `exts` itself, so a
  // pack that claims another extension tomorrow is covered by this line.
  for (const ext of [...typescript.exts, ...typescript.emits]) {
    const named = typescript.mentions(`import { x } from "./metrics/untested${ext}";`, "tools/repohealth.test.mjs");
    assert.ok(named.has("tools/metrics/untested"), `${ext}: ${[...named].join(", ")}`);
  }
  // And the right-hand boundary still holds for the longer alternatives.
  assert.deepEqual([...typescript.mentions('"./a/notify.json"', "x/t.test.mjs")], []);
  assert.deepEqual([...typescript.mentions('"./a/b.mjson"', "x/t.test.mjs")], []);
});

test("typescript: imports reads import specifiers, never a path a file merely spells", () => {
  const text = [
    'import { a } from "./a.ts";',
    'export * from "../lib/b.js";',
    'import "./side";',
    'const c = await import("./lazy/c.tsx");',
    'const d = require("./d.cjs");',
    'import React from "react";',
    'import { q } from "@waterplane/shared";',
    'const src = readFileSync("./App.tsx", "utf8");',
  ].join("\n");
  const got = [...typescript.imports(text, "pkg/src/x.test.mjs")].sort();
  assert.deepEqual(got, ["pkg/lib/b", "pkg/src/a", "pkg/src/d", "pkg/src/lazy/c", "pkg/src/side"]);
  // The same text NAMES App: `mentions` is the wider rule on purpose.
  assert.ok(typescript.mentions(text, "pkg/src/x.test.mjs").has("pkg/src/App"));
});

test("typescript: a type-only import loads nothing, so it is no edge", () => {
  const text = [
    'import type { SetupAim } from "./store";',
    'export type { Row } from "./rows.ts";',
    'import type {\n  A,\n  B,\n} from "./multi";',
    // Survives as `import {} from` under verbatimModuleSyntax, which runs it.
    'import { type Kept } from "./kept.ts";',
    'import { live, type T } from "./live.ts";',
  ].join("\n");
  assert.deepEqual([...typescript.imports(text, "web/src/setup/logic.ts")].sort(), ["web/src/setup/kept", "web/src/setup/live"]);
});

test("typescript: an index answers to its directory, because that is how the family resolves it", () => {
  const keys = typescript.keysFor("packages/web/src/features/backlog/index.ts");
  assert.ok(keys.includes("features/backlog"));
  assert.ok(keys.includes("packages/web/dist/features/backlog"), "and under the compiled mirror");
  assert.ok(!keys.includes("backlog"), "never as a bare name");
  assert.deepEqual(typescript.keysFor("foo/index.ts"), ["foo/index"]);
});

test("python and kotlin: an import IS a mention, so the two rules agree", () => {
  const py = "from service.store import Thing\nimport db.session";
  assert.deepEqual([...python.imports(py, "tests/t.py")], [...python.mentions(py, "tests/t.py")]);
  const kt = "import de.hoh.tiptoi.Foo";
  assert.deepEqual([...kotlin.imports(kt, "app/src/test/T.kt")], [...kotlin.mentions(kt, "app/src/test/T.kt")]);
});

/** A prereg holding one pack, the shape `measureUntested` reads. */
const TS_ONLY = Object.freeze({ PACKS: [{ name: "typescript", pack: typescript }], UNTESTED_REQUIRE_DIR_SEGMENT: true });
const file = (path, text = "") => ({ path, oid: `oid:${path}:${text.length}`, text, loc: 1 });

test("untested: the headline is what no test reaches; the reached-but-unnamed travel beside it", () => {
  const snap = {
    files: [
      file("src/logic.ts", 'import { s } from "./slice.ts";'),
      file("src/slice.ts", 'import { d } from "./deep";'),
      file("src/deep.ts"),
      file("src/App.tsx", 'import { g } from "./glue.ts";'),
      file("src/glue.ts"),
      file("src/alone.ts"),
    ],
    tests: [
      { path: "src/logic.test.mjs", text: 'import { f } from "./logic.ts";' },
      // Named as text, never imported: App is named, and nothing App imports
      // is reached through it.
      { path: "src/shape.test.mjs", text: 'const t = readFileSync("./App.tsx", "utf8");' },
    ],
  };
  const got = measureUntested(snap, null, 0, TS_ONLY);
  assert.deepEqual(got.value, ["src/alone.ts", "src/glue.ts"]);
  assert.deepEqual(got.unnamed, ["src/deep.ts", "src/slice.ts"]);
});

test("untested: a pack with no import rule is read on naming alone, never guessed reached", () => {
  const noImports = Object.freeze({ ...typescript, imports: null });
  const prereg = { PACKS: [{ name: "typescript", pack: noImports }], UNTESTED_REQUIRE_DIR_SEGMENT: true };
  const snap = {
    files: [file("src/logic.ts", 'import { s } from "./slice.ts";'), file("src/slice.ts")],
    tests: [{ path: "src/logic.test.mjs", text: 'import { f } from "./logic.ts";' }],
  };
  const got = measureUntested(snap, null, 0, prereg);
  assert.deepEqual(got.value, ["src/slice.ts"]);
  assert.deepEqual(got.unnamed, []);
});

test("untested: what moved the list is counted from the two rows, and says what a row cannot tell", () => {
  const then = { day: "2026-06-18", untested: { value: ["a.ts", "b.ts"], unnamed: ["c.ts"] }, classics: { value: { files: 4 } } };
  const now = { day: "2026-10-15", untested: { value: ["a.ts", "c.ts", "n.ts"], unnamed: [] }, classics: { value: { files: 5 } } };
  // c.ts was reached then and is not now: the one transition. n.ts is new to
  // the list and that row never saw it. b.ts left — reached since, or gone.
  assert.deepEqual(listMoves(then, now), { joined: 2, lost: 1, left: 1 });
  // A row written before `unnamed` existed has no count to offer.
  assert.equal(listMoves({ untested: { value: ["a.ts"] } }, now), null);

  const s = SERIES.find((d) => d.key === "untested.count");
  const detail = s.detail(now, null, then);
  assert.match(detail, /^ 3 of 5 modules in the tree\./, "the level keeps its denominator first");
  assert.match(detail, /A further 0 are reached/);
  assert.match(detail, /Since 2026-06-18: 2 joined the list \(1 of them reached by a test on that day\) and 1 left it/);
  assert.doesNotMatch(s.detail(now, null, now), /Since/, "a row compared with itself says nothing moved, by saying nothing");
});
