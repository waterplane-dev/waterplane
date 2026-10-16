// The 2026-10-16a definitions: a repo's say over the CENTRAL readings
// (`tools/repohealth/central.mjs`), escape hatches split into explained /
// unexplained / to-do (`metrics/hatches.mjs`), and re-touch counted only as
// REWORK (`metrics/retouch.mjs`, `git.mjs`'s `readHunks`).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CENTRAL_KEYS, centralFingerprint, declarationsByIndex, measureCentral, parseCentral,
} from "./repohealth/central.mjs";
import { OWN_FILE, parseDeclaration } from "./repohealth/own.mjs";
import { measureHatches } from "./repohealth/metrics/hatches.mjs";
import { measureRetouch, reworks } from "./repohealth/metrics/retouch.mjs";
import { readHunks } from "./repohealth/git.mjs";
import { configure } from "./repohealth/census.mjs";
import { PREREG } from "./repohealth/constants.mjs";
import { PACKS } from "./repohealth/packs/index.mjs";

const ENGINE = fileURLToPath(new URL("./repohealth.mjs", import.meta.url));
const node = process.execPath;

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "wp-central-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function git(dir, args, date) {
  const env = date ? { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : process.env;
  return execFileSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", ...args], { cwd: dir, encoding: "utf8", env });
}

// ── the declaration ────────────────────────────────────────────────────────

test("central: the five index entries, and nothing else, may be changed", () => {
  assert.deepEqual([...CENTRAL_KEYS], ["size", "retouch", "hatches", "context", "untested"]);
});

test("central: `why` is required, and every refusal is a sentence — the entry is ignored, never guessed", () => {
  const p = parseCentral({
    central: {
      size: { run: ["node", "p95.mjs"], why: "generated code is not ours", means: "hand-written p95" },
      context: { disable: true, why: "CLAUDE.md is generated" },
      retouch: { disable: true },
      hatches: { disable: true, run: ["x"], why: "both" },
      untested: { why: "says nothing" },
      nope: { disable: true, why: "x" },
    },
  });
  assert.deepEqual(Object.keys(p.entries).sort(), ["context", "size"]);
  assert.equal(p.entries.size.kind, "override");
  assert.deepEqual(p.entries.size.run, ["node", "p95.mjs"]);
  assert.equal(p.entries.context.kind, "disable");
  assert.equal(p.problems.length, 4);
  assert.ok(p.problems.some((s) => /"retouch" has no "why"/.test(s)));
  assert.ok(p.problems.some((s) => /"hatches" both disables and overrides/.test(s)));
  assert.ok(p.problems.some((s) => /"untested" neither disables/.test(s)));
  assert.ok(p.problems.some((s) => /"nope" is not a central reading/.test(s)));
  assert.equal(parseCentral({ readings: [] }), null, "no `central` key is no block at all");
  assert.match(parseCentral({ central: [] }).problems[0], /must be an object/);
});

test("central: a file with only `central` is not a broken own-readings declaration", () => {
  const d = parseDeclaration(JSON.stringify({ central: { context: { disable: true, why: "w" } } }));
  assert.equal(d.refused, undefined);
  assert.equal(d.none, true);
});

test("central: the fingerprint names what was APPLIED, stably — and is empty for nothing", () => {
  assert.equal(centralFingerprint({}, {}), "");
  const a = centralFingerprint({ context: { why: "w" } }, { size: { run: ["node", "a.mjs"] } });
  const b = centralFingerprint({ context: { why: "other words" } }, { size: { run: ["node", "a.mjs"], value: 9 } });
  assert.equal(a, b, "the why and the value are not the definition; the keys and the argv are");
  assert.notEqual(a, centralFingerprint({ context: {} }, { size: { run: ["node", "b.mjs"] } }), "a new command is a new definition");
  assert.notEqual(a, centralFingerprint({ context: {} }, {}), "dropping an override is a new definition");
});

test("central: a disable applies on every commit; an override RUNS at HEAD only and is listed not-run elsewhere", () => {
  const text = JSON.stringify({
    central: {
      context: { disable: true, why: "generated" },
      size: { run: ["node", "p95.mjs"], why: "ours only" },
      retouch: { run: ["node", "r.mjs"], why: "rework only" },
    },
  });
  let calls = 0;
  const run = (_root, d) => {
    calls++;
    return d.run[1] === "p95.mjs" ? { value: 412 } : { value: 3 };
  };
  const off = measureCentral("/r", text, { atHead: false, run });
  assert.equal(calls, 0, "a backfilled commit runs nothing");
  assert.deepEqual(off.disabled, { context: { why: "generated" } });
  assert.equal(off.override, undefined);
  assert.deepEqual(off.notRun, ["retouch", "size"]);
  assert.equal(off.fp, centralFingerprint({ context: {} }, {}), "the fingerprint is of what was applied, not declared");

  const head = measureCentral("/r", text, { atHead: true, run });
  assert.equal(calls, 2);
  assert.equal(head.override.size.value, 412);
  assert.equal(head.override.retouch.value, null, "a rate over 1 is not a fraction — absent, never clipped");
  assert.match(head.override.retouch.reason, /fraction 0–1/);
  assert.notEqual(head.fp, off.fp, "the first measured override is a change of definition — the link into it is carried");
  assert.equal(measureCentral("/r", JSON.stringify({ readings: [] }), { atHead: true, run }), undefined);
  assert.equal(measureCentral("/r", null, { atHead: true, run }), undefined);
});

test("central: the declaration in force is read only where the file changed, and carried forward", () => {
  const commits = ["a", "b", "c", "d"].map((sha) => ({ sha }));
  const touches = new Map([["a", ["x.js"]], ["b", [OWN_FILE]], ["c", ["x.js"]], ["d", [OWN_FILE]]]);
  const reads = [];
  const fake = { readFileAt: (_r, sha) => (reads.push(sha), sha === "a" ? null : `text@${sha}`) };
  assert.deepEqual(declarationsByIndex("/r", { commits, touches }, fake), [null, "text@b", "text@b", "text@d"]);
  assert.deepEqual(reads, ["a", "b", "d"]);
});

test("central, end to end: disable and override land on the rows, the plot marks the series, and the fingerprint moves", (t) => {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "a.js"), "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "one"], "2026-01-01T12:00:00Z");
  mkdirSync(join(root, ".waterplane-shared"));
  writeFileSync(join(root, "p95.mjs"), "console.log(7);\n");
  writeFileSync(join(root, OWN_FILE), JSON.stringify({
    central: {
      context: { disable: true, why: "CLAUDE.md is generated here" },
      size: { run: ["node", "p95.mjs"], why: "only hand-written files", means: "p95 of ours" },
      bogus: { disable: true, why: "x" },
    },
  }));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "two"], "2026-01-09T12:00:00Z");

  execFileSync(node, [ENGINE, "update", `--root=${root}`], { encoding: "utf8" });
  const rows = readFileSync(join(root, ".waterplane", "repohealth.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows[0].central, undefined, "a commit that declared nothing carries no field");
  assert.deepEqual(rows[1].central.disabled, { context: { why: "CLAUDE.md is generated here" } });
  assert.equal(rows[1].central.override.size.value, 7);
  assert.ok(rows[1].central.fp.length > 0);
  assert.match(rows[1].central.problems[0], /"bogus" is not a central reading/);

  const plot = JSON.parse(execFileSync(node, [ENGINE, "plot", `--root=${root}`], { encoding: "utf8" }));
  const by = Object.fromEntries(plot.series.map((s) => [s.key, s]));
  assert.deepEqual(by["context.claudeMdChars"].variant, { kind: "disabled", why: "CLAUDE.md is generated here" });
  assert.deepEqual(by["context.descChars"].variant, { kind: "disabled", why: "CLAUDE.md is generated here" });
  const v = by["size.p95"].variant;
  assert.equal(v.kind, "override");
  assert.equal(v.last, 7);
  assert.equal(v.since, rows[1].day);
  assert.deepEqual(v.points.map((p) => p.v), [null, 7], "no history before the first measurement — a cut, never the central value");
  assert.equal(by["retouch.rate"].variant, undefined);
  assert.match(plot.central.problems[0], /bogus/);
  assert.equal(plot.own.declared, false, "a central-only file declares no own readings");
});

// ── escape hatches: explained, unexplained, to-do ─────────────────────────

const snapOf = (path, text) => ({ sha: "x", files: [{ path, oid: "o", text, loc: text.split("\n").length }] });
const cfgFor = (names) => configure("/x", { listHeadPaths: () => [] }, PACKS.filter((p) => p.always || names.includes(p.name)));
const NO_HISTORY = { commits: [], touches: new Map(), batch: new Set() };

test("hatches (typescript): a reason after the mark or a comment directly above explains it; a rule name does not", () => {
  // `configure` only activates a pack whose extension it SEES, so the tree
  // has one file of it.
  const cfg = configure("/x", { listHeadPaths: () => ["a.ts"] });
  const text = [
    "// eslint-disable-next-line react-hooks/exhaustive-deps",
    "a();",
    "// eslint-disable-next-line react-hooks/exhaustive-deps -- the ref is stable",
    "b();",
    "// the callback identity is pinned by the parent",
    "// eslint-disable-next-line no-console",
    "c();",
    "// eslint-disable-next-line no-console",
    "// eslint-disable-next-line no-alert",
    "const x = y as any;",
    "const z = w as any; // the lib's type is wrong upstream",
    "// @ts-expect-error the DOM lib lags behind",
    "// @ts-expect-error",
    "// TODO: tidy",
  ].join("\n");
  const m = measureHatches(snapOf("src/a.ts", text), NO_HISTORY, 0, cfg);
  assert.equal(m.value.eslintDisable, 5, "the total keeps its meaning");
  // Explained: the ` -- why` one, and the one under a prose comment. Bare:
  // the first, the one under code, and the one under another directive.
  assert.deepEqual(m.split.byKind.eslintDisable, { explained: 2, unexplained: 3 }, "a directive stacked on a directive explains nothing");
  assert.deepEqual(m.split.byKind.asAny, { explained: 1, unexplained: 1 });
  assert.deepEqual(m.split.byKind.tsExpectError, { explained: 1, unexplained: 1 });
  assert.equal(m.split.todo, 1, "a TODO is reported apart, never an escape");
  assert.equal(m.split.explained + m.split.unexplained + m.split.todo, Object.values(m.value).reduce((a, b) => a + b, 0));
});

test("hatches (python): a rule code is not a reason; words after it are", () => {
  const cfg = configure("/x", { listHeadPaths: () => ["a.py"] });
  const text = [
    "import os  # noqa: F401",
    "import re  # noqa: F401 -- re-exported for the plugin API",
    "x = f()  # type: ignore[attr-defined]",
    "y = g()  # type: ignore  # the stub is missing this overload",
    "try:",
    "    pass",
    "# a crash here must never take the daemon down",
    "except:",
    "    pass",
  ].join("\n");
  const m = measureHatches(snapOf("a.py", text), NO_HISTORY, 0, cfg);
  assert.deepEqual(m.split.byKind.pyNoqa, { explained: 1, unexplained: 1 });
  assert.deepEqual(m.split.byKind.pyTypeIgnore, { explained: 1, unexplained: 1 });
  assert.deepEqual(m.split.byKind.pyBareExcept, { explained: 1, unexplained: 0 }, "the line of a bare except is the one the match ENDS on");
});

test("hatches (kotlin): a trailing comment explains; the throwing TODO( stub is a to-do", () => {
  const cfg = configure("/x", { listHeadPaths: () => ["A.kt"] });
  const text = [
    "val a = b!!",
    "val c = d!! // set in onCreate, before any caller",
    '@Suppress("UNCHECKED_CAST")',
    "fun f(): Nothing = TODO(\"later\")",
  ].join("\n");
  const m = measureHatches(snapOf("A.kt", text), NO_HISTORY, 0, cfg);
  assert.deepEqual(m.split.byKind.ktNotNull, { explained: 1, unexplained: 1 });
  assert.deepEqual(m.split.byKind.ktSuppress, { explained: 0, unexplained: 1 });
  assert.equal(m.split.byKind.ktTodoStub, undefined);
  assert.equal(m.split.todo, 1, "`TODO(` is both kotlin's stub and common's TODO — one to-do, not two");
});

test("hatches: a pack without hatchExplain explains nothing — every escape counts, as before", () => {
  const cfg = cfgFor([]);
  assert.deepEqual(Object.keys(cfg.HATCH_EXPLAIN), ["fixme", "todo"]);
  assert.ok(Object.values(cfg.HATCH_EXPLAIN).every((e) => e.todo));
  assert.equal(PREREG.SIZE_NEAR_MAX_FRAC, 0.9);
});

// ── re-touch: rework, never an append ─────────────────────────────────────

test("rework: the later commit must remove or change a line the earlier one ADDED", () => {
  const hunks = new Map([
    ["a", new Map([["reg.ts", { add: [10, 3], del: [] }]])],
    ["b", new Map([["reg.ts", { add: [13, 2], del: [] }]])], // append below a's lines
    ["c", new Map([["reg.ts", { add: [11, 1], del: [11, 1] }]])], // changes one of a's lines
  ]);
  assert.equal(reworks(hunks, "a", "b", "reg.ts"), false, "a pure append is not rework");
  assert.equal(reworks(hunks, "a", "c", "reg.ts"), true);
  assert.equal(reworks(hunks, "a", "c", "other.ts"), false, "no ranges, no rework (a binary file)");
});

test("retouch counts rework only, carries the appends, and is absent without line-level history", () => {
  const cfg = configure("/x", { listHeadPaths: () => ["a.ts"] });
  const t0 = 1_800_000_000;
  const commits = [
    { sha: "a", ts: t0, filesTouched: ["src/reg.ts", "src/x.ts"] },
    { sha: "b", ts: t0 + 3600, filesTouched: ["src/reg.ts"] },
    { sha: "c", ts: t0 + 7200, filesTouched: ["src/x.ts"] },
  ];
  const history = {
    commits,
    touches: new Map(commits.map((c) => [c.sha, c.filesTouched])),
    batch: new Set(),
    hunks: new Map([
      ["a", new Map([["src/reg.ts", { add: [1, 5], del: [] }], ["src/x.ts", { add: [1, 4], del: [] }]])],
      ["b", new Map([["src/reg.ts", { add: [6, 2], del: [] }]])],
      ["c", new Map([["src/x.ts", { add: [2, 1], del: [2, 1] }]])],
    ]),
  };
  const v = measureRetouch({}, history, 2, cfg).value;
  assert.equal(v.touches, 4);
  assert.equal(v.retouches, 1, "x.ts was reworked; reg.ts was only appended to");
  assert.equal(v.appends, 1);
  assert.deepEqual(v.offenders, [{ path: "src/x.ts", n: 1 }]);
  const none = measureRetouch({}, { ...history, hunks: undefined }, 2, cfg);
  assert.equal(none.value, null);
  assert.match(none.reason, /rework cannot be told from an append/);
});

test("readHunks: a real repo's post-image adds and pre-image dels, an append told apart from a change", (t) => {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "r.ts"), "a\nb\nc\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "one"]);
  writeFileSync(join(root, "r.ts"), "a\nb\nc\nd\n");
  git(root, ["commit", "-qam", "append"]);
  writeFileSync(join(root, "r.ts"), "a\nB\nc\nd\n");
  git(root, ["commit", "-qam", "change"]);
  const shas = git(root, ["rev-list", "--reverse", "HEAD"]).trim().split("\n");
  const h = readHunks(root);
  assert.deepEqual(h.get(shas[0]).get("r.ts"), { add: [1, 3], del: [] });
  assert.deepEqual(h.get(shas[1]).get("r.ts"), { add: [4, 1], del: [] });
  assert.deepEqual(h.get(shas[2]).get("r.ts"), { add: [2, 1], del: [2, 1] });
  assert.equal(reworks(h, shas[0], shas[1], "r.ts"), false);
  assert.equal(reworks(h, shas[1], shas[2], "r.ts"), false, "the change hit line 2, which the append did not add");
  assert.equal(reworks(h, shas[0], shas[2], "r.ts"), true);
});
