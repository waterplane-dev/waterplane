/**
 * The Python pack's reader: what `lang/python-ast.mjs` and `python-resolve.mjs`
 * hand to `dups`, `deadExports` and the import graph. Hand-written literals and
 * small fixture trees; no repo, no git, no python3.
 *
 * The negatives are the point: each "dead" case below is a name Python reaches
 * without anyone writing it (a decorator, `__all__`, `__getattr__`, a string),
 * and each graph case is an import that must NOT become an edge or a guess.
 */
import test from "node:test";
import assert from "node:assert/strict";

import python from "./repohealth/packs/python.mjs";
import { lex } from "./repohealth/lang/python-ast.mjs";
import { measureDeadExports } from "./repohealth/metrics/deadexports.mjs";
import { measureDups } from "./repohealth/metrics/dups.mjs";
import { measureGraph } from "./repohealth/metrics/graph.mjs";

const PREREG = Object.freeze({
  PACKS: [{ name: "python", pack: python, files: 1 }],
  GRAPH_MIN_RESOLVED: 0.9,
  DUP_MIN_LINES: 6,
  DUP_SHINGLE: 5,
  DUP_HASHES: 64,
  DUP_BANDS: 8,
  DUP_SIMILARITY: 0.8,
  DUP_MAX_BUCKET: 40,
  DUP_NESTED_BLOCKS: true,
});

let n = 0;
const file = (path, text = "") => ({ path, oid: `py:${++n}`, text, loc: text.split("\n").length });
const exportsOf = (text, path = "pkg/mod.py") => python.analyzer().idents(file(path, text)).exports;

test("python analyzer: exists, and is never absent for want of an interpreter", () => {
  assert.ok(python.analyzer(), "a pure lexer, so no python3 is needed");
  assert.equal(typeof python.analyzerReason, "string");
});

test("lexer: strings, comments, brackets and continuations do not leak names or lines", () => {
  const src = [
    "x = '''doc with def fake(): and import nothing",
    "more'''  # comment def hidden",
    's = r"\\d" ; y = f"{a}"',
    "z = (1,",
    "     2)",
    "w = 1 + \\",
    "    2",
    "def real(): pass",
  ].join("\n");
  const lines = lex(src);
  assert.equal(lines.length, 5);
  const ids = python.analyzer().idents(file("a.py", src)).identifiers;
  assert.ok(ids.has("real") && ids.has("a"));
  assert.ok(!ids.has("fake") && !ids.has("hidden") && !ids.has("nothing"));
});

test("lexer: an unterminated string or bracket is unknown, not a short file", () => {
  assert.equal(lex("x = 'abc\ny = 2\n"), null);
  assert.equal(lex("x = (1,\n2\n"), null);
  const a = python.analyzer().idents(file("a.py", "def f(:\n  x = 'oops\n"));
  assert.deepEqual(a.exports, [], "claims no exports rather than all of them");
  assert.equal(a.identifiers.size, 0);
  assert.equal(python.graphImports(file("a.py", "import b\nx = (\n"), null), null, "imports unknown, not []");
});

test("exports: top-level def and class, not methods, not private, not tests", () => {
  const src = "def pub(): pass\nasync def apub(): pass\nclass Pub:\n    def method(self): pass\ndef _priv(): pass\ndef test_x(): pass\nclass TestY: pass\n";
  assert.deepEqual(exportsOf(src), ["pub", "apub", "Pub"]);
});

test("exports: what Python reaches by a name nobody writes is not offered as dead", () => {
  assert.deepEqual(exportsOf('@app.get("/x")\ndef route(): pass\n'), [], "a registering decorator");
  assert.deepEqual(exportsOf("@click.command()\ndef cli_cmd(): pass\n"), []);
  assert.deepEqual(exportsOf("@dataclass\nclass Row: pass\n"), ["Row"], "a decorator that registers nothing");
  assert.deepEqual(exportsOf('__all__ = ["pub"]\ndef pub(): pass\ndef other(): pass\n'), ["other"], "__all__ is the declared API");
  assert.deepEqual(exportsOf("def __getattr__(name): ...\ndef lazy(): pass\n"), [], "a lazy module offers no fixed names");
  assert.deepEqual(exportsOf("def main(): pass\ndef upgrade(): pass\ndef get_app(): pass\n"), [], "entry points");
  assert.deepEqual(exportsOf("def setup_thing(): pass\n", "setup.py"), [], "a script offers nothing");
});

test("dead exports: a string naming it, an f-string and a re-export all count as use", () => {
  const files = [
    file("pkg/mod.py", "def by_string(): pass\ndef by_fstring(): pass\ndef reexported(): pass\ndef truly_dead(): pass\n"),
    file("pkg/__init__.py", "from .mod import reexported\n"),
    file("pkg/use.py", 'x = getattr(m, "by_string")\ny = f"{by_fstring(1)}"\n'),
  ];
  const got = measureDeadExports({ files, tests: [] }, null, 0, PREREG).value;
  assert.deepEqual(got, ["pkg/mod.py#truly_dead"]);
});

test("dead exports: a test that names it is a user", () => {
  const files = [file("pkg/mod.py", "def only_tested(): pass\n")];
  const tests = [{ path: "tests/test_mod.py", text: "from pkg.mod import only_tested\n" }];
  assert.deepEqual(measureDeadExports({ files, tests }, null, 0, PREREG).value, []);
});

const body = (name, extra = "") =>
  [`def ${name}(items, limit):`, "    out = []", "    for item in items:", "        if item.ok and item.size < limit:", `            out.append(item.name + ${extra || "'x'"})`, "        else:", "            out.append(None)", "    return out", ""].join("\n");

test("dups: a copied function pairs; a renamed literal still does; a different shape does not", () => {
  const files = [
    file("a.py", body("collect_a", "'-a'")),
    file("b.py", body("collect_a", "'-b' ")),
    file("c.py", ["def other(x):", "    total = 0", "    while x:", "        total += x % 10", "        x //= 10", "    print(total)", "    return total", ""].join("\n")),
  ];
  const got = measureDups({ files }, null, 0, PREREG).value;
  assert.equal(got.pairs.length, 1);
  assert.deepEqual([got.pairs[0].a.split("#")[0], got.pairs[0].b.split("#")[0]].sort(), ["a.py", "b.py"]);
});

test("dups: below the line floor nothing is a block; comments and docstrings do not pad one", () => {
  const files = [file("a.py", "def tiny(x):\n    return x\n"), file("b.py", "def tiny(x):\n    return x\n")];
  assert.deepEqual(measureDups({ files }, null, 0, PREREG).value.pairs, []);
});

// ── the import graph ──

const GRAPH = (files) => {
  const ctx = python.graphContext(files.map((f) => ({ path: f.path })));
  return measureGraph({ files, graphContexts: { python: ctx } }, null, 0, PREREG);
};
const importsOfFile = (tree, path) => {
  const ctx = python.graphContext(Object.keys(tree).map((p) => ({ path: p })));
  return python.graphImports({ path, text: tree[path] }, ctx);
};
const targets = (tree, path) => importsOfFile(tree, path).map((i) => i.candidates[0] ?? `MISS:${i.spec}`);

test("graph: absolute, relative and package imports resolve to the module they load", () => {
  const tree = {
    "app/__init__.py": "",
    "app/main.py": "import app.db.session\nfrom app import util\nfrom . import db\nfrom .db.models import Base\nfrom ..outside import x\nimport os, numpy as np\n",
    "app/util.py": "",
    "app/db/__init__.py": "",
    "app/db/session.py": "",
    "app/db/models.py": "",
  };
  assert.deepEqual(targets(tree, "app/main.py"), [
    "app/db/session",
    "app/util",
    "app/db/__init__",
    "app/db/models",
    "MISS:..outside",
  ]);
});

test("graph: src layouts, scripts beside their modules, and tree-wide unique names", () => {
  const tree = {
    "svc/src/pkg/__init__.py": "",
    "svc/src/pkg/core.py": "import pkg.helpers\n",
    "svc/src/pkg/helpers.py": "",
    "svc/tools/run.py": "import report\nimport pkg.core\n",
    "svc/tools/report.py": "",
  };
  assert.deepEqual(targets(tree, "svc/src/pkg/core.py"), ["svc/src/pkg/helpers"]);
  assert.deepEqual(targets(tree, "svc/tools/run.py"), ["svc/tools/report", "svc/src/pkg/core"]);
});

test("graph: what is not this tree's is external; what is ambiguous or missing is a miss, never a guess", () => {
  const tree = {
    "a/x/util.py": "",
    "b/y/util.py": "",
    "main.py": "import json\nimport requests\nimport util\nimport main.nothing\n",
  };
  const got = importsOfFile(tree, "main.py");
  assert.deepEqual(got.map((i) => [i.spec, i.candidates.length]), [["util", 0], ["main.nothing", 0]], "json and requests are no entry at all");
});

test("graph: TYPE_CHECKING imports and imports inside a function load nothing", () => {
  const tree = {
    "p/__init__.py": "",
    "p/a.py": "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from p import b\n\ndef f():\n    from p import c\n    return c\n",
    "p/b.py": "",
    "p/c.py": "",
  };
  assert.deepEqual(targets(tree, "p/a.py"), []);
});

test("graph: a deliberate lazy import does not make a cycle; a module-level one does", () => {
  const lazy = GRAPH([file("p/__init__.py"), file("p/a.py", "import p.b\n"), file("p/b.py", "def f():\n    import p.a\n")]).value;
  assert.equal(lazy.cycleCount, 0);
  const eager = GRAPH([file("p/__init__.py"), file("p/a.py", "import p.b\n"), file("p/b.py", "import p.a\n")]).value;
  assert.deepEqual(eager.cycles, [{ size: 2, files: ["p/a.py", "p/b.py"] }]);
  assert.equal(eager.edges, 2);
});

test("graph: a package and a module of one name keep separate keys; a test target is no node", () => {
  assert.deepEqual(python.graphKeysFor("p/q/__init__.py"), ["p/q/__init__"]);
  assert.deepEqual(python.graphKeysFor("p/q.py"), ["p/q"]);
  const tree = { "p/__init__.py": "", "p/a.py": "from p import test_q\n", "p/test_q.py": "" };
  assert.deepEqual(importsOfFile(tree, "p/a.py"), [], "test_q is a test file here: neither edge nor miss");
});

test("graph: too many unresolved own-imports is an absence naming them", () => {
  const files = [file("p/__init__.py"), file("p/a.py", "import p.n1\nimport p.n2\nimport p.n3\n")];
  const got = GRAPH(files);
  assert.equal(got.value, null);
  assert.match(got.reason, /resolved/);
});
