// Repo health: the bundled engine in a worker (dist/healthworker.mjs), the fold into a HealthDoc,
// the HealthRun lifecycle, and the text guards that keep a process spawn out of every other bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DIST, SRC, data, tmp } from "./helpers.mjs";
import { gitOnlyProblems } from "../scripts/gitonly.mjs";

const WORKER = join(DIST, "healthworker.mjs");
const HAS_GIT = data.gitOnPath(process.env) !== null;
const noGit = HAS_GIT ? false : "git is not on PATH here, so no history can be read";

const PIN = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = (cwd, args, env = {}) => execFileSync("git", args, { cwd, env: { ...process.env, ...PIN, ...env }, stdio: ["ignore", "pipe", "pipe"] });

/** A repo of three first-parent commits on three days, touching a .ts file and CLAUDE.md. */
function repo3() {
  const r = tmp("hrepo");
  git(r, ["init", "-q", "-b", "main"]);
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(r, "a.ts"), Array.from({ length: i * 10 }, (_, j) => `export const v${j} = ${j};`).join("\n") + "\n");
    writeFileSync(join(r, "CLAUDE.md"), `# Rules\n${"x".repeat(i * 40)}\n`);
    git(r, ["add", "."]);
    const d = `2026-0${i}-0${i}T10:00:00Z`;
    git(r, ["commit", "-q", "-m", `c${i}`], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  }
  return r;
}

/** One step of the engine in a Worker, as HealthRun runs it. */
function step(name, root, dir) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, {
      argv: [name, "--root=" + root],
      env: { ...process.env, WATERPLANE_VSCODE_HEALTH_DIR: dir, GIT_CEILING_DIRECTORIES: join(root, "..") },
      stdout: true, stderr: true,
    });
    let stdout = "", stderr = "", code;
    w.on("message", (m) => {
      if (m.t === "out") stdout += m.s;
      else if (m.t === "err") stderr += m.s;
      else if (m.t === "exit" && code === undefined) code = m.code;
    });
    w.on("error", reject);
    w.on("exit", () => resolve({ stdout, stderr, code: code ?? null }));
  });
}

const fold = (folder, status, plot = null, update = null) => data.foldHealth({
  folder, status, plot, update, shallow: data.isShallow(folder), readAt: 1, stepMs: 180_000, seriesFile: "/s",
});

test("update → status → plot through the worker: rows in OUR dir, nothing in the repo, a drawable plot", { skip: noGit }, async () => {
  const r = repo3(), dir = tmp("hdir");
  const u = await step("update", r, dir);
  assert.equal(u.code, 0, u.stderr);
  assert.match(u.stdout, /repohealth: \+3 rows/);
  const file = join(dir, "repohealth.jsonl");
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3);
  assert.ok(!existsSync(join(r, ".waterplane")), "nothing is written into the measured folder");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: r }).toString(), "", "the working tree is untouched");

  const s = await step("status", r, dir);
  assert.equal(s.code, 0, s.stderr);
  const p = await step("plot", r, dir);
  assert.equal(p.code, 0, p.stderr);
  const { doc } = fold(r, s, p, { ...u, at: 2, ms: 3 });
  assert.equal(doc.series.rows, 3);
  assert.equal(doc.behind, 0);
  assert.equal(doc.head.sha.length, 40);
  assert.equal(doc.readError, null);
  assert.equal(doc.shallow, false);
  assert.ok(doc.plot.days >= 1);
  for (const sr of doc.plot.series) assert.equal(sr.points.length, doc.plot.days, sr.key);
  assert.equal(doc.last.ok, true);
  assert.equal(doc.last.added, 3);

  const before = readFileSync(file);
  const again = await step("update", r, dir);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /nothing new/);
  assert.deepEqual(readFileSync(file), before, "a second update appends nothing");
  assert.equal(fold(r, s, null, { ...again, at: 2, ms: 3 }).doc.last.added, 0);
});

test("a folder without .git: exit 1, the engine's sentence as readError, no series", { skip: noGit }, async () => {
  const d = tmp("hnogit");
  const s = await step("status", d, tmp("hdir"));
  assert.equal(s.code, 1);
  assert.match(s.stderr, /not a git repository/);
  const { doc } = fold(d, s);
  assert.match(doc.readError, /not a git repository/);
  assert.equal(doc.series, null);
  assert.equal(doc.plot, null);
  assert.equal(doc.shallow, null);
});

test("an empty git init says there are no commits yet", { skip: noGit }, async () => {
  const d = tmp("hempty");
  git(d, ["init", "-q"]);
  const s = await step("status", d, tmp("hdir"));
  assert.notEqual(s.code, 0);
  assert.match(fold(d, s).doc.readError, /no commits yet/);
});

test("a --root= that is not a directory is a sentence and exit 1, not a crashed worker", { skip: noGit }, async () => {
  const s = await step("status", join(tmp("hmissing"), "nope"), tmp("hdir"));
  assert.equal(s.code, 1);
  assert.match(s.stderr, /is not a directory/);
});

test("a series measured under two definitions is refused with exit 3 and the engine's words verbatim", { skip: noGit }, async () => {
  const r = repo3(), dir = tmp("hdir");
  assert.equal((await step("update", r, dir)).code, 0);
  const file = join(dir, "repohealth.jsonl");
  const first = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ ...first, prereg: "1999-01-01a" }) + "\n");
  git(r, ["commit", "-q", "--allow-empty", "-m", "c4"], { GIT_AUTHOR_DATE: "2026-04-04T10:00:00Z", GIT_COMMITTER_DATE: "2026-04-04T10:00:00Z" });
  const u = await step("update", r, dir);
  assert.equal(u.code, 3);
  const last = data.outcomeOf({ ...u, at: 1, ms: 1 }, 180_000);
  assert.equal(last.ok, false);
  assert.equal(last.refused.text, u.stderr, "verbatim");
  assert.match(last.refused.text, /refusing to append/);
  assert.match(last.refused.text, /healthworker\.mjs update --root=/, "the recut line names the bundled engine");
});

test("a timed-out or stopped update keeps its rows and says to refresh again", () => {
  const t = data.outcomeOf({ stdout: "", stderr: "", code: null, timedOut: true, at: 1, ms: 2 }, 180_000);
  assert.equal(t.error, "update ran past 180s and was stopped; rows measured so far were kept — refresh again to continue.");
  const c = data.outcomeOf({ stdout: "", stderr: "", code: null, cancelled: true, at: 1, ms: 2 }, 180_000);
  assert.match(c.error, /stopped before it finished; rows measured so far were kept/);
});

test("a failed plot beside a live status is plot: null with a sentence, the series intact", { skip: noGit }, async () => {
  const r = repo3(), dir = tmp("hdir");
  await step("update", r, dir);
  const s = await step("status", r, dir);
  const { doc } = fold(r, s, { stdout: "", stderr: "repohealth: boom\n", code: 1 });
  assert.equal(doc.series.rows, 3);
  assert.equal(doc.plot, null);
  assert.match(doc.plotError, /The chart could not be read: .*boom/);
  assert.equal(fold(r, s, null).doc.plotError, null, "a plot not read is not an error");
});

test("HealthRun: refresh fills the doc, read is cached, forget re-measures, a tiny cap stops update", { skip: noGit }, async () => {
  const r = repo3(), storage = tmp("hstore");
  const changes = [];
  const run = new data.HealthRun({
    workerFile: WORKER, storageDir: storage, stepMs: () => 120_000, extraPath: () => null,
    onChange: (f) => changes.push([f, run.state(f).run?.step ?? null]),
  });
  assert.deepEqual(run.state(r), { doc: null, run: null });
  const a = run.refresh(r), b = run.refresh(r);
  assert.equal(a, b, "single-flight per folder");
  await a;
  const st = run.state(r);
  assert.equal(st.run, null);
  assert.equal(st.doc.series.rows, 3);
  assert.ok(st.doc.plot);
  assert.equal(st.doc.last.ok, true);
  assert.equal(st.doc.seriesFile, join(storage, data.healthSlug(r), "repohealth.jsonl"));
  assert.ok(existsSync(st.doc.seriesFile));
  assert.ok(!existsSync(join(r, ".waterplane")));
  assert.deepEqual(changes.map((c) => c[1]).filter(Boolean), ["update", "status", "plot"]);

  const n = changes.length;
  await run.read(r);
  assert.equal(changes.length, n, "a read inside 60 s is served from cache");
  await run.read(r, { force: true });
  assert.ok(changes.length > n);

  await run.forget(r);
  assert.equal(run.state(r).doc.series.rows, 3);
  assert.equal(run.state(r).doc.last.added, 3, "forget deleted the series and measured it again");

  const tiny = new data.HealthRun({ workerFile: WORKER, storageDir: tmp("hstore2"), stepMs: () => 1, extraPath: () => null, onChange: () => {} });
  await tiny.refresh(r);
  assert.match(tiny.state(r).doc?.last?.error ?? "", /ran past 0s and was stopped/);
  tiny.dispose();
  run.dispose();
});

test("HealthRun without git on PATH says so and spawns nothing", async () => {
  const saved = process.env.PATH;
  process.env.PATH = tmp("emptypath");
  try {
    const run = new data.HealthRun({ workerFile: WORKER, storageDir: tmp("hstore"), stepMs: () => 1000, extraPath: () => null, onChange: () => {} });
    await run.read("/nowhere");
    assert.deepEqual(run.state("/nowhere"), { doc: null, why: data.NO_GIT_WHY, run: null });
  } finally {
    process.env.PATH = saved;
  }
});

test("gitOnPath finds an executable git without running it; the git.path dir counts too", () => {
  const d = tmp("fakegit");
  const name = process.platform === "win32" ? "git.exe" : "git";
  writeFileSync(join(d, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(data.gitOnPath({ PATH: "" }, d), d);
  assert.equal(data.gitOnPath({ PATH: d }), d);
  assert.equal(data.gitOnPath({ PATH: tmp("nogit") }), null);
});

test("isShallow: a .git dir with shallow ⇒ true; a .git file (linked worktree) ⇒ null", () => {
  const a = tmp("shallow");
  mkdirSync(join(a, ".git"));
  assert.equal(data.isShallow(a), false);
  writeFileSync(join(a, ".git", "shallow"), "x\n");
  assert.equal(data.isShallow(a), true);
  const b = tmp("linked");
  writeFileSync(join(b, ".git"), "gitdir: /elsewhere\n");
  assert.equal(data.isShallow(b), null);
});

test("healthSlug is stable and filesystem-safe for spaces and unicode", () => {
  const base = tmp("slug");
  const d = join(base, "my repo ünï");
  mkdirSync(d);
  const s = data.healthSlug(d);
  assert.equal(s, data.healthSlug(d + "/"));
  assert.match(s, /^[0-9a-f]{16}-[A-Za-z0-9._-]+$/);
  assert.ok(s.endsWith("-my-repo--n-"), s);
  assert.notEqual(s, data.healthSlug(join(base, "other")));
});

test("only dist/healthworker.mjs can start a process, and the only program it names is git", () => {
  for (const f of ["extension.js", "scanworker.js", "webview.js"]) {
    assert.ok(!readFileSync(join(DIST, f), "utf8").includes("child_process"), `${f} has no child_process`);
  }
  const w = readFileSync(WORKER, "utf8");
  assert.ok(w.includes("child_process"));
  // The same check scripts/check-vsix.mjs runs on the packaged file: dev or minified, every
  // child_process call site's first argument is "git".
  assert.deepEqual(gitOnlyProblems(w), []);
  assert.ok(!/["']claude["']\s*,/.test(w), "no claude spawn ships");
  assert.ok(!w.includes(".claude/outbox/repohealth"), "narrate/html (they write the outbox) are shimmed out");
  assert.ok(w.includes("judge is not part of the extension"), "judge.mjs is the throwing shim");
  const run = readFileSync(join(SRC, "health", "healthrun.ts"), "utf8");
  assert.ok(!/narrate|judge/.test(run), "healthrun.ts names no paid or writing step");
});

test("a torn last row (a stopped append) is cut off before reading, said once, and measured again", { skip: noGit }, async () => {
  const r = repo3();
  const storage = tmp("htorn");
  const run = new data.HealthRun({ workerFile: WORKER, storageDir: storage, stepMs: () => 120_000, extraPath: () => null, onChange: () => {} });
  await run.refresh(r);
  const file = run.seriesFile(r);
  const whole = readFileSync(file, "utf8");
  const lines = whole.split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  // Cut the last row in half: no trailing newline, not JSON — what a terminate mid-append leaves.
  const head = lines.slice(0, -1).join("\n") + "\n";
  writeFileSync(file, head + lines[2].slice(0, Math.floor(lines[2].length / 2)));

  await run.read(r, { force: true });
  let doc = run.state(r).doc;
  assert.equal(doc.readError, null, "the engine read the file");
  assert.equal(doc.series.rows, 2, "rows = n - 1");
  assert.equal(doc.tailNote, data.TORN_TAIL_NOTE);
  assert.equal(readFileSync(file, "utf8"), head, "exactly the partial line was dropped");

  await run.refresh(r);
  doc = run.state(r).doc;
  assert.equal(doc.series.rows, 3, "the next update re-added it");
  assert.equal(doc.last.ok, true);
  assert.equal(doc.tailNote, null);
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 3);
  run.dispose();
});

test("mendSeriesTail: whole file untouched, a whole row missing its newline gets one, a lone torn line empties", () => {
  const d = tmp("mend");
  const f = join(d, "s.jsonl");
  assert.equal(data.mendSeriesTail(f), null, "no file");
  writeFileSync(f, '{"a":1}\n{"a":2}\n');
  assert.equal(data.mendSeriesTail(f), null);
  writeFileSync(f, '{"a":1}\n{"a":2}');
  assert.equal(data.mendSeriesTail(f), "newline");
  assert.equal(readFileSync(f, "utf8"), '{"a":1}\n{"a":2}\n');
  writeFileSync(f, '{"a":"unterminated');
  assert.equal(data.mendSeriesTail(f), "cut");
  assert.equal(readFileSync(f, "utf8"), "");
  // A torn row longer than one read chunk.
  writeFileSync(f, '{"a":1}\n{"b":"' + "x".repeat(200_000));
  assert.equal(data.mendSeriesTail(f), "cut");
  assert.equal(readFileSync(f, "utf8"), '{"a":1}\n');
});

test("the worker's env is a whitelist: PATH, HOME and friends, the health dir; never GIT_* or secrets", () => {
  const env = data.workerEnv({ PATH: "/bin", HOME: "/h", LANG: "C", GIT_DIR: "/elsewhere", ANTHROPIC_API_KEY: "k", Path: undefined }, "/store", "/git/bin");
  assert.deepEqual(env, { PATH: ["/git/bin", "/bin"].join(process.platform === "win32" ? ";" : ":"), HOME: "/h", LANG: "C", WATERPLANE_VSCODE_HEALTH_DIR: "/store" });
  assert.equal(data.workerEnv({ Path: "C:\\w", SystemRoot: "C:\\Windows" }, "/s", null).Path, "C:\\w", "Windows' PATH key kept as spelled");
  assert.equal(data.DEFAULT_HEALTH_SECONDS, 600);
});

test("gitOnlyProblems reads minified and namespace forms, and refuses anything but a git call", () => {
  assert.deepEqual(gitOnlyProblems('import{execFileSync as Ya,spawnSync as Ja}from"node:child_process";Ya("git",[]);Ja("git",["x"])'), []);
  assert.equal(gitOnlyProblems('import{execFileSync as Ya,spawnSync as Ja}from"node:child_process";Ya("git");Ja("claude")').length, 1);
  assert.equal(gitOnlyProblems('import{spawnSync as Ja}from"node:child_process";const s=Ja;s("sh")').length, 1, "passed as a value");
  assert.deepEqual(gitOnlyProblems('import*as cp from"node:child_process";cp.execFileSync("git")'), []);
  assert.equal(gitOnlyProblems('import*as cp from"node:child_process";cp.spawn("sh")').length, 1);
  assert.equal(gitOnlyProblems('const cp=require("child_process");cp.spawn("sh")').length, 1, "an unrecognised form fails");
  assert.deepEqual(gitOnlyProblems('import{execFileSync as Za}from"node:child_process";const r=/[A-Za-z_$]/;Za("git",[])'), [], "a regex range that spells the name is not a use");
  assert.equal(gitOnlyProblems('import{execFileSync as Za}from"node:child_process";const r=/[A-Za-z]/;x-Za("sh")').length, 1, "only the whole x-NAME-y range is exempt");
  assert.deepEqual(gitOnlyProblems('import{spawnSync as ts}from"node:child_process";const o={ts:1,b:2},p={a:1,ts:2},k=["ts"],m="@ts-ignore";ts("git",[])'), [],
    "a key, a string that is the name and \"@name-\" are not uses");
  assert.equal(gitOnlyProblems('import{spawnSync as ts}from"node:child_process";const o={ts:ts};o.ts("sh")').length, 1, "a key's VALUE still is");
});

test("cancel during a read also drops the refresh queued behind it", { skip: noGit }, async () => {
  const r = repo3();
  const steps = [];
  const run = new data.HealthRun({
    workerFile: WORKER, storageDir: tmp("hqueue"), stepMs: () => 120_000, extraPath: () => null,
    onChange: (f) => { const s = run.state(f).run?.step; if (s) steps.push(s); },
  });
  const read = run.read(r);
  const queued = run.refresh(r);
  run.cancel(r);
  await read;
  await queued;
  assert.ok(!steps.includes("update"), `no update ran: ${steps.join(",")}`);
  assert.equal(run.state(r).doc?.last ?? null, null);
  run.dispose();
});

test("a committed health.json's commands are NOT run here: own readings and overrides are absent with the reason, a disable is honoured", { skip: noGit }, async () => {
  const r = repo3();
  mkdirSync(join(r, ".waterplane-shared"));
  // Each command would leave a marker file in the repo if it ever ran.
  const mark = (f) => ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(f)}, '1'); console.log(5)`];
  writeFileSync(join(r, ".waterplane-shared", "health.json"), JSON.stringify({
    readings: [{ key: "own1", name: "Own one", means: "a thing this repo counts", better: "lower", run: mark("RAN-OWN") }],
    central: {
      size: { run: mark("RAN-OVERRIDE"), why: "we count p95 our way", means: "p95 over src only" },
      context: { disable: true, why: "CLAUDE.md is generated here" },
      bogus: { disable: true, why: "x" },
    },
  }));
  git(r, ["add", "."]);
  git(r, ["commit", "-q", "-m", "c4"], { GIT_AUTHOR_DATE: "2026-04-04T10:00:00Z", GIT_COMMITTER_DATE: "2026-04-04T10:00:00Z" });
  const dir = tmp("hdir");
  const u = await step("update", r, dir);
  assert.equal(u.code, 0, u.stderr);
  assert.ok(!existsSync(join(r, "RAN-OWN")) && !existsSync(join(r, "RAN-OVERRIDE")), "no repo command ran");
  const { doc } = fold(r, await step("status", r, dir), await step("plot", r, dir), { ...u, at: 2, ms: 3 });
  const plot = doc.plot;
  const own = plot.own.series.find((s) => s.key === "own1");
  assert.equal(own.last, null, "absent, never 0");
  assert.match(own.absent, new RegExp(data.NO_RUN));
  const size = plot.series.find((s) => s.key === "size.p95");
  assert.equal(size.variant.kind, "override");
  assert.equal(size.variant.last, null);
  assert.match(size.variant.absent, new RegExp(data.NO_RUN));
  assert.equal(size.last != null, true, "the central value is still measured beside it");
  assert.deepEqual(plot.series.filter((s) => s.variant?.kind === "disabled").map((s) => s.key).sort(), ["context.claudeMdChars", "context.descChars"]);
  assert.match(plot.central.problems.join(" "), /"bogus" is not a central reading/);
  assert.deepEqual(data.notRunHere(plot), { own: 1, overrides: [size.label] });
  const words = data.notRunWords(plot);
  assert.match(words, /1 reading of its own and its own version of /);
  assert.match(words, /starts only git, never code from the folder/);
  assert.match(words, /desktop app runs them/);
});

test("notRunWords is silent on a plot whose readings ran (the desktop's series) or that declares none", () => {
  assert.equal(data.notRunWords(null), null);
  assert.equal(data.notRunWords({ series: [], own: { file: "f", declared: true, series: [{ key: "a", absent: "exited 1" }] } }), null);
  assert.equal(data.notRunWords({ series: [{ label: "p95", variant: { kind: "override", absent: undefined } }] }), null);
});

test("ownMixedWords: our copy under an older definition names both and the forget button, never a command", () => {
  assert.equal(data.ownMixedWords([{ version: "a", rows: 3 }], "a"), null);
  assert.equal(data.ownMixedWords(null, "a"), null);
  const stale = data.ownMixedWords([{ version: "2026-10-12a", rows: 3 }], "2026-10-16a");
  assert.match(stale, /Every row in this extension's copy was measured under 2026-10-12a \(3 rows\), and the bundled engine now measures under 2026-10-16a/);
  for (const s of [stale, data.ownMixedWords([{ version: "a", rows: 3 }, { version: "b", rows: 1 }], "b")]) {
    assert.match(s, /Forget this series and measure again/);
    assert.doesNotMatch(s, /\brm\b|node /);
  }
});
