// tools/repohealth/own.mjs: a repo's OWN readings — the declaration, running
// one, what counts as a value, and the engine carrying them beside (never
// inside) waterplane's readings.
//
// Every failure mode below must come out ABSENT with a sentence, never as 0:
// a zero is a reading, and a reading nobody took must not look like one.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OWN_FILE, OWN_MAX, gateOf, measureOwn, notRunOwn, parseDeclaration, parseReadingOutput, readingEnv, runReading,
} from "./repohealth/own.mjs";
import { ROW_KEYS } from "./repohealth/series.mjs";
import { measureReach, readsOf } from "./repohealth/reach.mjs";

const ENGINE = fileURLToPath(new URL("./repohealth.mjs", import.meta.url));
const node = process.execPath;
const decl = (run, extra = {}) => ({ key: "k", name: "K", means: "m", better: "higher", unit: "", run, ...extra });

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "wp-own-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── the declaration ────────────────────────────────────────────────────────

test("the file lives in the COMMITTED shared dir, not the gitignored state dir", () => {
  assert.equal(OWN_FILE, ".waterplane-shared/health.json");
});

test("a declaration that is not the shape is refused whole, in words", () => {
  assert.match(parseDeclaration("{nope").refused, /not JSON/);
  assert.match(parseDeclaration("{}").refused, /no "readings" list/);
  assert.match(parseDeclaration("[]").refused, /no "readings" list/);
});

test("an entry with a bad field stays a reading, ABSENT with the reason; no usable key is a problem sentence", () => {
  const d = parseDeclaration(JSON.stringify({
    readings: [
      { key: "ok", name: "Ok", means: "m", better: "lower", run: ["node", "x.mjs"] },
      { key: "bad", name: "Bad", means: "m", better: "sideways", run: "node x.mjs" },
      { key: "1nope", run: ["x"] },
      { key: "ok", name: "Dup", means: "m", better: "lower", run: ["x"] },
    ],
  }));
  assert.equal(d.readings.length, 2);
  assert.equal(d.readings[0].invalid, undefined);
  assert.match(d.readings[1].invalid, /"better" must be/);
  assert.match(d.readings[1].invalid, /"run" must be an argv list/, "a string is never handed to a shell");
  assert.equal(d.problems.length, 2);
  assert.match(d.problems[0], /no usable "key"/);
  assert.match(d.problems[1], /declared twice/);
});

test("a gate is checked like any other field: a refused gate means the reading is not run, and is carried as refused", () => {
  assert.equal(gateOf(undefined, "higher"), undefined);
  assert.deepEqual(gateOf({ fails: "below", at: 60 }, "higher"), { fails: "below", at: 60 });
  assert.deepEqual(gateOf({ fails: "above", at: 3 }, "lower"), { fails: "above", at: 3 });
  assert.match(gateOf({ fails: "above", at: 60 }, "higher").invalid, /fails on the worse side/, "a gate failing when the reading improves is a typo");
  assert.match(gateOf({ fails: "under", at: 1 }, "lower").invalid, /"fails" must be/);
  assert.match(gateOf({ fails: "below", at: "60" }, "higher").invalid, /"at" must be a number/);
  assert.match(gateOf(60, "higher").invalid, /must be \{/);
  const d = parseDeclaration(JSON.stringify({
    readings: [
      { key: "g", name: "G", means: "m", better: "higher", unit: "%", run: ["x"], gate: { fails: "below", at: 60 } },
      { key: "h", name: "H", means: "m", better: "higher", run: ["x"], gate: { fails: "above", at: 60 } },
      { key: "n", name: "N", means: "m", better: "higher", run: ["x"] },
    ],
  }));
  assert.deepEqual(d.readings[0].gate, { fails: "below", at: 60 });
  assert.equal(d.readings[0].invalid, undefined);
  assert.match(d.readings[1].invalid, /"gate" fails "above"/);
  assert.ok(d.readings[1].gate.invalid, "carried, so the index counts it UNKNOWN rather than dropping it");
  assert.equal("gate" in d.readings[2], false);
});

test("reach: which index dimensions each source pack reads, from the same tests the metrics apply", () => {
  const fn = () => {};
  assert.deepEqual(readsOf({ hatchKinds: { a: "x" }, mentions: fn, keysFor: fn }), ["hatches", "untested"]);
  assert.deepEqual(readsOf({ hatchKinds: {}, mentions: null, keysFor: null }), [], "Dart today: TODO counts only, no test rule");
  assert.deepEqual(readsOf({ hatchKinds: {}, mentions: fn, keysFor: null }), [], "untested needs BOTH rules");
  // P2: dups/deadExports need a parser that LOADS; cycles the three graph rules.
  const parser = () => ({ blocks: fn, idents: fn });
  assert.deepEqual(readsOf({ analyzer: parser }), ["deadExports", "dups"]);
  assert.deepEqual(readsOf({ analyzer: () => null }), [], "typescript not installed: the analyzer is null, so nothing was parsed");
  assert.deepEqual(readsOf({ analyzer: () => { throw new Error("x"); } }), [], "a throw is cannot");
  assert.deepEqual(readsOf({ analyzer: null }), []);
  assert.deepEqual(readsOf({ graphImports: fn, keysFor: fn, graphKeysFor: fn }), ["cycles"]);
  assert.deepEqual(readsOf({ graphImports: fn, keysFor: fn, graphKeysFor: null }), [], "graph.mjs needs all three");
  const r = measureReach({ PACKS: [
    { name: "typescript", files: 10, pack: { exts: [".ts"], hatchKinds: { a: "x" }, mentions: fn, keysFor: fn } },
    { name: "common", files: 0, pack: { exts: [], hatchKinds: { todo: "x" } } },
    { name: "dart", files: 30, pack: { exts: [".dart"], hatchKinds: {}, mentions: null, keysFor: null } },
  ] });
  assert.deepEqual(r, { value: { packs: [
    { name: "dart", files: 30, reads: [] },
    { name: "typescript", files: 10, reads: ["hatches", "untested"] },
  ] } }, "common holds no file and is left out; sorted by name");
});

// ── what counts as a value ────────────────────────────────────────────────

test("stdout must be ONE JSON number or {value: n}; anything else is absent with a reason", () => {
  assert.deepEqual(parseReadingOutput("7\n"), { value: 7 });
  assert.deepEqual(parseReadingOutput('{"value": 2.5}'), { value: 2.5 });
  assert.deepEqual(parseReadingOutput("0"), { value: 0 }, "a printed zero IS a reading");
  for (const bad of ["", "seven", "1 2", "[3]", '"3"', '{"value":"3"}', "null", '{"v":3}']) {
    const r = parseReadingOutput(bad);
    assert.equal(r.value, null, `${JSON.stringify(bad)} is not a value`);
    assert.ok(r.reason, "and it says why");
  }
});

// ── running one ───────────────────────────────────────────────────────────

test("a reading runs with no shell, cwd = the root, and its number is the value", (t) => {
  const root = tmp(t);
  writeFileSync(join(root, "n.txt"), "42");
  // Relative to cwd: proves the reading ran IN the root.
  assert.deepEqual(runReading(root, decl([node, "-e", "process.stdout.write(require('fs').readFileSync('n.txt','utf8'))"])), { value: 42 });
  // No shell: a metacharacter is an argument, not an operator.
  const r = runReading(root, decl([node, "-e", "console.log(JSON.stringify(process.argv.slice(1).length))", "; echo 9"]));
  assert.deepEqual(r, { value: 1 });
});

test("a non-zero exit is absent and quotes the last stderr line", (t) => {
  const r = runReading(tmp(t), decl([node, "-e", "console.log(5); console.error('catalog not built'); process.exit(2)"]));
  assert.equal(r.value, null, "a number printed before failing is not a reading");
  assert.equal(r.reason, "exited 2: catalog not built");
});

test("a reading that hangs is stopped at the timeout and is absent", (t) => {
  const r = runReading(tmp(t), decl([node, "-e", "setTimeout(() => {}, 60000)"]), { timeoutMs: 300 });
  assert.equal(r.value, null);
  assert.match(r.reason, /did not finish within/);
});

test("a program that does not exist, and output past the cap, are absent", (t) => {
  const root = tmp(t);
  const missing = runReading(root, decl(["wp-no-such-program-xyz"]));
  assert.equal(missing.value, null);
  assert.match(missing.reason, /could not start wp-no-such-program-xyz/);
  const flood = runReading(root, decl([node, "-e", "process.stdout.write('1'.repeat(200000))"]));
  assert.equal(flood.value, null);
  assert.match(flood.reason, /more than/);
});

test("the environment carries what starts a program, never the daemon's own secrets", () => {
  const env = readingEnv({ PATH: "/bin", HOME: "/h", GEMINI_API_KEY: "s", WATERPLANE_TOKEN: "t", ANTHROPIC_API_KEY: "a" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

test("measureOwn: nothing declared is no field; past the cap is listed, not run", (t) => {
  const root = tmp(t);
  assert.equal(measureOwn(root, "HEAD", { readFileAt: () => null }), undefined);
  const many = Array.from({ length: OWN_MAX + 1 }, (_, i) => decl([node, "-e", `console.log(${i})`], { key: `r${i}` }));
  const own = measureOwn(root, "HEAD", { readFileAt: () => JSON.stringify({ readings: many }) });
  assert.equal(own.file, OWN_FILE);
  assert.equal(own.readings.length, OWN_MAX + 1);
  assert.equal(own.readings[0].value, 0);
  assert.equal(own.readings[OWN_MAX - 1].value, OWN_MAX - 1);
  assert.equal(own.readings[OWN_MAX].value, null);
  assert.match(own.readings[OWN_MAX].reason, /past the first 8/);
  const refused = measureOwn(root, "HEAD", { readFileAt: () => "{" });
  assert.match(refused.refused, /not JSON/);
});

test("a dropped entry that asked for a gate is counted, and unapproved commands still carry the declared gates", (t) => {
  const root = tmp(t);
  const text = JSON.stringify({ readings: [
    { key: "3bad", gate: { fails: "below", at: 1 }, run: ["x"] },
    { key: "no", name: "No", means: "m", better: "lower", run: ["x"] },
    { key: "p", name: "Parity", means: "m", better: "higher", unit: "%", run: ["node", "-e", "console.log(1)"], gate: { fails: "below", at: 60 } },
  ] });
  const git = { readFileAt: () => text };
  assert.equal(parseDeclaration(text).unreadGates, 1);
  assert.equal(measureOwn(root, "HEAD", git).unreadGates, 1);
  const own = notRunOwn(root, "HEAD", git);
  assert.match(own.notRun, /not approved/);
  assert.equal(own.unreadGates, 1);
  assert.equal(own.readings, undefined, "nothing was run, so nothing is a reading");
  assert.deepEqual(own.gates.map((g) => [g.key, g.value, g.gate]), [["p", null, { fails: "below", at: 60 }]]);
  assert.equal(notRunOwn(root, "HEAD", { readFileAt: () => null }), undefined);
  assert.match(notRunOwn(root, "HEAD", { readFileAt: () => "{" }).refused, /not JSON/);
});

// ── the engine, end to end ────────────────────────────────────────────────

function git(dir, args, date) {
  const env = date ? { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : process.env;
  return execFileSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", ...args], { cwd: dir, encoding: "utf8", env });
}

test("the engine stores own readings on the HEAD row only, and plot draws them as the repo's, apart from waterplane's", (t) => {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "a.js"), "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "one"], "2026-01-01T12:00:00Z");
  mkdirSync(join(root, ".waterplane-shared"));
  writeFileSync(join(root, "count.mjs"), "console.log(3);\n");
  writeFileSync(join(root, OWN_FILE), JSON.stringify({
    readings: [
      { key: "three", name: "Three", means: "Always three.", better: "higher", unit: "x", run: ["node", "count.mjs"], gate: { fails: "below", at: 5 } },
      { key: "broken", name: "Broken", means: "Prints words.", better: "lower", run: ["node", "-e", "console.log('hi')"] },
    ],
  }));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "two"], "2026-01-02T12:00:00Z");

  execFileSync(node, [ENGINE, "update", `--root=${root}`], { encoding: "utf8" });
  const lines = execFileSync("cat", [join(root, ".waterplane", "repohealth.jsonl")], { encoding: "utf8" }).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].own, undefined, "a backfilled commit runs nothing");
  assert.deepEqual(lines[1].own.readings.map((r) => [r.key, r.value]), [["three", 3], ["broken", null]]);
  assert.match(lines[1].own.readings[1].reason, /not one JSON number/);
  assert.deepEqual(lines[1].own.readings[0].gate, { fails: "below", at: 5 }, "the gate rides with its reading");
  assert.ok(Array.isArray(lines[1].reach?.value?.packs), "every row says what the packs could read");
  // Beside the measurements, never one of them: the contract's keys are unchanged.
  assert.deepEqual(Object.keys(lines[1]).filter((k) => k !== "own"), [...ROW_KEYS]);
  const jsFiles = (l) => l.reach.value.packs.reduce((n, p) => n + p.files, 0);
  assert.ok(jsFiles(lines[0]) >= 1 && jsFiles(lines[1]) >= 1, "reach counts the commit's own source files");

  const plot = JSON.parse(execFileSync(node, [ENGINE, "plot", `--root=${root}`], { encoding: "utf8" }));
  assert.ok(plot.series.length > 0);
  assert.ok(plot.series.every((s) => s.source === "central"));
  assert.ok(!plot.series.some((s) => s.key === "three"), "an own reading is never one of waterplane's");
  assert.equal(plot.own.file, OWN_FILE);
  assert.equal(plot.own.declared, true);
  const [three, broken] = plot.own.series;
  assert.equal(three.source, "repo");
  assert.equal(three.means, "Always three.");
  assert.equal(three.better, "higher");
  assert.equal(three.last, 3);
  assert.deepEqual(three.gate, { fails: "below", at: 5 }, "plot carries the declaration; the index judges it");
  assert.equal(broken.gate, undefined);
  assert.deepEqual(three.points.map((p) => p.v), [null, 3], "history starts when the reading appears — a hole before, never a 0");
  assert.equal(broken.last, null);
  assert.match(broken.absent, /not one JSON number/);
});

test("plot says when a repo declares nothing — and a scope carries no own readings at all", (t) => {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "a.js"), "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "one"]);
  execFileSync(node, [ENGINE, "update", `--root=${root}`], { encoding: "utf8" });
  const plot = JSON.parse(execFileSync(node, [ENGINE, "plot", `--root=${root}`], { encoding: "utf8" }));
  assert.deepEqual(plot.own, { file: OWN_FILE, declared: false, series: [] });
  execFileSync(node, [ENGINE, "update", `--root=${root}`, "--scope=sub"], { encoding: "utf8" });
  const scoped = JSON.parse(execFileSync(node, [ENGINE, "plot", `--root=${root}`, "--scope=sub"], { encoding: "utf8" }));
  assert.equal("own" in scoped, false);
});

test("a HEAD row measured with --no-own is re-measured, and rewritten in place, once the commands are approved", (t) => {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "a.js"), "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "one"], "2026-01-01T12:00:00Z");
  mkdirSync(join(root, ".waterplane-shared"));
  writeFileSync(join(root, "count.mjs"), "console.log(3);\n");
  writeFileSync(join(root, OWN_FILE), JSON.stringify({
    readings: [{ key: "three", name: "Three", means: "Always three.", better: "higher", unit: "x", run: ["node", "count.mjs"], gate: { fails: "below", at: 5 } }],
  }));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "two"], "2026-01-02T12:00:00Z");

  const series = join(root, ".waterplane", "repohealth.jsonl");
  const read = () => readFileSync(series, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  execFileSync(node, [ENGINE, "update", `--root=${root}`, "--no-own"], { encoding: "utf8" });
  assert.equal(read()[1].own.readings, undefined, "nothing of the repo's ran before approval");
  assert.deepEqual(read()[1].own.gates.map((g) => [g.key, g.value]), [["three", null]], "but the declared gate rides in, unknown, never a silent pass");
  assert.ok(read()[1].own.notRun);
  const first = read()[0];

  execFileSync(node, [ENGINE, "update", `--root=${root}`], { encoding: "utf8" });
  const lines = read();
  assert.equal(lines.length, 2, "rewritten in place, not appended");
  assert.deepEqual(lines[1].own.readings.map((r) => [r.key, r.value]), [["three", 3]]);
  assert.equal(lines[1].own.notRun, undefined);
  assert.deepEqual(lines[0], first, "the other rows are untouched");

  execFileSync(node, [ENGINE, "update", `--root=${root}`, "--no-own"], { encoding: "utf8" });
  assert.deepEqual(read()[1].own.readings.map((r) => r.value), [3], "a later --no-own run does not strip it");
});

test("reach counts each commit's OWN files: a week from before a language arrived says it held none", (t) => {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "a.js"), "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "one"], "2026-01-01T12:00:00Z");
  for (const n of ["x", "y", "z"]) writeFileSync(join(root, `${n}.py`), `${n} = 1\n`);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "two"], "2026-01-02T12:00:00Z");
  execFileSync(node, [ENGINE, "update", `--root=${root}`], { encoding: "utf8" });
  const lines = readFileSync(join(root, ".waterplane", "repohealth.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const filesOf = (row, name) => row.reach.value.packs.find((p) => p.name === name)?.files;
  assert.equal(filesOf(lines[1], "python"), 3);
  assert.equal(filesOf(lines[0], "python"), 0, "no Python in the first commit's tree, though HEAD has three");
});
