// A series the waterplane desktop app already measured in the folder (`.waterplane/repohealth*.jsonl`):
// which source is chosen, the scopes file, and that the extension only ever READS the folder's files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DIST, data, tmp } from "./helpers.mjs";

const WORKER = join(DIST, "healthworker.mjs");
const noGit = data.gitOnPath(process.env) !== null ? false : "git is not on PATH here";
const PIN = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd, args, env = {}) => execFileSync("git", args, { cwd, env: { ...process.env, ...PIN, ...env }, stdio: ["ignore", "pipe", "pipe"] });

/** Three first-parent commits on three days, all under `sub/`, so `sub` is a scope with its own history. */
function repoWithSub() {
  const r = tmp("hsrc");
  git(r, ["init", "-q", "-b", "main"]);
  mkdirSync(join(r, "sub"));
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(r, "sub", "a.ts"), Array.from({ length: i * 10 }, (_, j) => `export const v${j} = ${j};`).join("\n") + "\n");
    writeFileSync(join(r, "CLAUDE.md"), `# Rules\n${"x".repeat(i * 40)}\n`);
    git(r, ["add", "."]);
    const d = `2026-0${i}-0${i}T10:00:00Z`;
    git(r, ["commit", "-q", "-m", `c${i}`], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  }
  return r;
}

/** An engine step run the way the extension does, with extra argv and env (e.g. `--scope=`). */
function engine(args, dir) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { argv: args, env: { ...process.env, WATERPLANE_VSCODE_HEALTH_DIR: dir }, stdout: true, stderr: true });
    let code, err = "";
    w.on("message", (m) => { if (m.t === "err") err += m.s; if (m.t === "exit" && code === undefined) code = m.code; });
    w.on("error", reject);
    w.on("exit", () => resolve({ code: code ?? null, err }));
  });
}

const row = (ts, sha = "a".repeat(40)) => JSON.stringify({ sha, ts }) + "\n";
const put = (dir, name, text) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), text); return join(dir, name); };
/** Every file under `dir` with its size and mtime: equal before and after = nothing was written. */
const snapshot = (dir) => readdirSync(dir, { recursive: true }).sort().map((n) => { const s = statSync(join(dir, n)); return `${n}:${s.size}:${s.mtimeMs}`; });

test("chooseSource: the folder's series unless ours has a strictly newer last row; ours when the folder has none", () => {
  const f = tmp("hsrc-choose");
  const own = put(tmp("hsrc-own"), "repohealth.jsonl", row(100) + row(300));
  assert.deepEqual(data.chooseSource(f, own, null), { kind: "own", file: own, dir: null, scope: null }, "no folder series");
  const dir = join(f, ".waterplane");
  const theirs = put(dir, "repohealth.jsonl", row(100) + row(200));
  assert.equal(data.chooseSource(f, own, null).kind, "own", "ours is newer");
  put(dir, "repohealth.jsonl", row(300));
  assert.deepEqual(data.chooseSource(f, own, null), { kind: "repo", file: theirs, dir, scope: null }, "a tie goes to the folder's");
  put(dir, "repohealth.jsonl", row(900));
  assert.equal(data.chooseSource(f, own, null).kind, "repo", "theirs is newer");
  put(dir, "repohealth.jsonl", '{"sha":"x","ts":5}\n{"torn');
  assert.equal(data.chooseSource(f, own, null).kind, "repo", "an unreadable last row never demotes the folder's series");
  put(dir, "repohealth.jsonl", "");
  assert.equal(data.chooseSource(f, own, null).kind, "own", "an empty folder series is no series");
  assert.equal(data.chooseSource(f, join(tmp("hsrc-none"), "repohealth.jsonl"), null).kind, "own", "neither exists: ours, to be measured");
});

test("chooseSource: a folder series an older engine wrote yields to ours, even at the same or a newer commit", () => {
  const sized = (ts, value) => JSON.stringify({ sha: "a".repeat(40), ts, size: { value } }) + "\n";
  const f = tmp("hsrc-stale");
  const dir = join(f, ".waterplane");
  put(dir, "repohealth.jsonl", sized(300, { max: 9 }));
  const own = put(tmp("hsrc-stale-own"), "repohealth.jsonl", sized(300, { max: 9, lineMean: 4 }));
  assert.equal(data.chooseSource(f, own, null).kind, "own", "same commit: theirs scores nothing");
  put(dir, "repohealth.jsonl", sized(900, { max: 9 }));
  assert.equal(data.chooseSource(f, own, null).kind, "own", "theirs newer but stale");
  put(own.slice(0, -"/repohealth.jsonl".length), "repohealth.jsonl", sized(300, { max: 9 }));
  assert.equal(data.chooseSource(f, own, null).kind, "repo", "both stale: the ts rule decides");
  put(dir, "repohealth.jsonl", sized(300, { max: 9, lineMean: 4 }));
  put(own.slice(0, -"/repohealth.jsonl".length), "repohealth.jsonl", sized(300, { max: 9, lineMean: 4 }));
  assert.equal(data.chooseSource(f, own, null).kind, "repo", "both current: a tie still goes to the folder's");
});

test("chooseSource: a scope is only ever the folder's, and falls back to the whole repo without a series", () => {
  const f = tmp("hsrc-legacy");
  const own = put(tmp("hsrc-own2"), "repohealth.jsonl", row(999));
  const dir = join(f, ".waterplane");
  const slug = data.seriesName("sub");
  assert.match(slug, /^repohealth\.sub-[0-9a-f]{4}\.jsonl$/);
  put(dir, slug, row(5));
  const s = data.chooseSource(f, own, "sub");
  assert.deepEqual(s, { kind: "repo", file: join(dir, slug), dir, scope: "sub" });
  assert.equal(data.chooseSource(f, own, "other").kind, "own", "a scope with no series falls back to the whole repo");
});

test("readScopes: absent or garbage is none; scopes without a series, unsafe ones and non-strings are dropped", () => {
  const f = tmp("hsrc-scopes");
  const dir = join(f, ".waterplane");
  assert.deepEqual(data.readScopes(f), [], "no file");
  put(dir, "repohealth-scopes.json", "{not json");
  assert.deepEqual(data.readScopes(f), [], "garbage");
  put(dir, "repohealth-scopes.json", JSON.stringify({ scopes: "packages/web" }));
  assert.deepEqual(data.readScopes(f), [], "wrong shape");
  put(dir, data.seriesName("packages/web"), row(1));
  put(dir, data.seriesName("packages/host"), "");
  put(dir, "repohealth-scopes.json", JSON.stringify({ scopes: ["packages/web", "packages/host", "packages/gone", "../etc", "/abs", 7, null, "packages/web/"] }));
  assert.deepEqual(data.readScopes(f), ["packages/web"], "only a scope with a non-empty series; deduped after normalising");
  put(dir, "repohealth-scopes.json", JSON.stringify(["packages/web"]));
  assert.deepEqual(data.readScopes(f), ["packages/web"], "a bare array is read too");
});

test("the folder's series is read, never written: status and plot only, no mend, update lands in our storage", { skip: noGit }, async () => {
  const r = repoWithSub();
  // The desktop app's series: measure the whole repo and the `sub` scope, then file them in the folder.
  const made = tmp("hsrc-made");
  assert.equal((await engine(["update", "--root=" + r], made)).code, 0);
  assert.equal((await engine(["update", "--root=" + r, "--scope=sub"], made)).code, 0);
  const state = join(r, ".waterplane");
  mkdirSync(state);
  cpSync(made, state, { recursive: true });
  writeFileSync(join(state, "repohealth-scopes.json"), JSON.stringify({ scopes: ["sub"] }));
  const ours = tmp("hsrc-store");
  const run = new data.HealthRun({ workerFile: WORKER, storageDir: ours, stepMs: () => 120_000, extraPath: () => null, onChange: () => {} });

  const file = join(state, "repohealth.jsonl");
  const intact = readFileSync(file, "utf8");
  const before = snapshot(state);
  await run.read(r);
  let doc = run.state(r).doc;
  assert.equal(doc.source, "repo");
  assert.equal(doc.seriesFile, file);
  assert.equal(doc.series.rows, 3, "read from the folder, nothing measured by us");
  assert.ok(doc.plot, "plot read it too");
  assert.deepEqual(doc.scopes, ["sub"]);
  assert.equal(doc.repoFile, file);
  assert.deepEqual(readdirSync(ours, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()), [], "no series of ours was created by a read");
  assert.deepEqual(snapshot(state), before, "the folder's state dir is byte- and mtime-identical after a read");

  await run.setScope(r, "sub");
  doc = run.state(r).doc;
  assert.equal(doc.scope, "sub");
  assert.equal(doc.source, "repo");
  assert.equal(doc.plot.scope, "sub", "plot ran with --scope");
  assert.equal(doc.series.rows, 3);
  assert.match(doc.seriesFile, /repohealth\.sub-[0-9a-f]{4}\.jsonl$/);
  assert.deepEqual(snapshot(state), before, "a scoped read writes nothing either");
  await run.setScope(r, "not-a-scope");
  assert.equal(run.state(r).doc.scope, null, "an unlisted scope is the whole repo");

  // A new commit makes the folder's series behind; a measure appends to OUR file only.
  writeFileSync(join(r, "sub", "b.ts"), "export const b = 1;\n");
  git(r, ["add", "."]);
  git(r, ["commit", "-q", "-m", "c4"], { GIT_AUTHOR_DATE: "2026-04-04T10:00:00Z", GIT_COMMITTER_DATE: "2026-04-04T10:00:00Z" });
  await run.refresh(r);
  assert.equal(statSync(file).size, intact.length, "the folder's file did not grow");
  assert.equal(readFileSync(file, "utf8"), intact);
  assert.deepEqual(snapshot(state), before, "update never touched the folder's state dir");
  const mine = run.seriesFile(r);
  assert.equal(readFileSync(mine, "utf8").split("\n").filter(Boolean).length, 4, "the measure went to our storage, whole history");
  doc = run.state(r).doc;
  assert.equal(doc.source, "own", "ours has the newer last row now");
  assert.equal(doc.series.rows, 4);
  assert.equal(doc.repoFile, file, "and the folder's is still named as the other source");
  assert.deepEqual(doc.scopes, ["sub"], "scopes stay offered");
  run.dispose();
});

test("a torn last row in the folder's file is left exactly as it is", { skip: noGit }, async () => {
  const r = repoWithSub();
  const made = tmp("hsrc-torn-made");
  assert.equal((await engine(["update", "--root=" + r], made)).code, 0);
  const state = join(r, ".waterplane");
  mkdirSync(state);
  const torn = readFileSync(join(made, "repohealth.jsonl"), "utf8") + '{"sha":"cut';
  writeFileSync(join(state, "repohealth.jsonl"), torn);
  const run = new data.HealthRun({ workerFile: WORKER, storageDir: tmp("hsrc-torn-store"), stepMs: () => 120_000, extraPath: () => null, onChange: () => {} });
  await run.read(r);
  assert.equal(run.state(r).doc.source, "repo");
  assert.equal(run.state(r).doc.tailNote, null, "no mend, so no mend note");
  assert.equal(readFileSync(join(state, "repohealth.jsonl"), "utf8"), torn);
  run.dispose();
});

test("workerEnv sets READ_FROM only when asked, and the shim honours it before the health dir", () => {
  assert.equal(data.workerEnv({ PATH: "/bin" }, "/store", null).WATERPLANE_VSCODE_HEALTH_READ_FROM, undefined);
  assert.equal(data.workerEnv({ PATH: "/bin" }, "/store", null, "/f/.waterplane").WATERPLANE_VSCODE_HEALTH_READ_FROM, "/f/.waterplane");
});

test("the source and measure sentences name where the series is and that the extension never writes it", () => {
  const base = { series: { lastDay: "2026-10-01" }, scope: null, repoFile: null, seriesFile: "/g/health/abc/repohealth.jsonl" };
  const repo = data.sourceWords({ ...base, source: "repo", seriesFile: "/f/.waterplane/repohealth.jsonl", repoFile: "/f/.waterplane/repohealth.jsonl" });
  assert.match(repo, /Read from this folder's \.waterplane\/repohealth\.jsonl, the series measured by the waterplane desktop app \(last row 2026-10-01\)\. The extension never writes it\./);
  assert.match(data.sourceWords({ ...base, source: "repo", scope: "packages/web", seriesFile: "/f/.waterplane/repohealth.packages-web-1a2b.jsonl" }), /the series for packages\/web/);
  assert.match(data.sourceWords({ ...base, source: "own" }), /kept in this extension's own storage, at \/g\/health/);
  assert.match(data.sourceWords({ ...base, source: "own", repoFile: "/f/.waterplane/repohealth.jsonl" }), /only reads, never writes/);
  assert.equal(data.measureWords({ repoFile: null }), null);
  assert.match(data.measureWords({ repoFile: "/f/.waterplane/repohealth.jsonl" }), /writes only this extension's own copy/);
});

test("repoMixedWords: names the versions, points at the desktop app, never prints a command or promises a refusal", () => {
  assert.equal(data.repoMixedWords([{ version: "a", rows: 3 }], "a"), null);
  assert.equal(data.repoMixedWords(null, "a"), null);
  for (const s of [
    data.repoMixedWords([{ version: "a", rows: 3 }, { version: "b", rows: 1 }], "b"),
    data.repoMixedWords([{ version: "a", rows: 1 }], "b"),
  ]) {
    assert.match(s, /Re-cut it from the waterplane desktop app/);
    assert.doesNotMatch(s, /\brm\b|node |refresh will refuse/);
  }
});
