// Slow jobs (`slowjobs.ts`): a read kept past the screen that asked. Pinned here: a running key is
// JOINED (the work never runs twice — the recommend spender relies on it), a settled run is kept for
// a while then forgotten, a failure is a sentence, a give-up bound fails the run and drops its late
// answer, frames never carry the result, and a quiet (old-route) run stays off the wire until a
// loud start joins it.
import test from "node:test";
import assert from "node:assert/strict";

const { SlowJobs, slowJobKey } = await import("../dist/slowjobs.js");
const { usesSettled, usesProgress } = await import("../dist/routes/apijobs.js");

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const clock = (t0 = 1_000_000) => { let t = t0; const now = () => t; now.add = (ms) => { t += ms; }; return now; };

test("a start on a running key joins it: one run, one promise, joins counted", async () => {
  const frames = [];
  const jobs = new SlowJobs({ onChange: (j) => frames.push(j), now: clock() });
  const d = deferred();
  let runs = 0;
  const spec = { kind: "skills.recommend", repoId: "r1", run: () => { runs++; return d.p; } };
  const a = jobs.start(spec);
  const b = jobs.start(spec);
  assert.equal(a.joined, false);
  assert.equal(b.joined, true);
  assert.equal(b.job.id, a.job.id);
  assert.equal(b.job.joins, 1);
  d.resolve({ ok: true });
  assert.deepEqual(await a.promise, { ok: true });
  assert.deepEqual(await b.promise, { ok: true });
  assert.equal(runs, 1, "the work ran once");
  const got = jobs.get("skills.recommend", "r1");
  assert.equal(got.state, "done");
  assert.deepEqual(got.result, { ok: true });
  assert.equal(got.hasResult, true);
  assert.deepEqual(frames.map((f) => f.state), ["running", "done"]);
  assert.ok(frames.every((f) => !("result" in f)), "a frame never carries the result");
});

test("a different repo or args key is a different job", () => {
  const jobs = new SlowJobs({ now: clock() });
  const never = () => new Promise(() => {});
  const a = jobs.start({ kind: "setup.check", repoId: "r1", run: never });
  const b = jobs.start({ kind: "setup.check", repoId: "r2", run: never });
  const c = jobs.start({ kind: "setup.check", repoId: "r1", argsKey: "x", run: never });
  assert.equal(new Set([a.job.id, b.job.id, c.job.id]).size, 3);
  assert.equal(slowJobKey("setup.check", "r1", "x"), "setup.check:r1:x");
  assert.equal(jobs.list().length, 3);
});

test("a settled run is kept for keepMs, then forgotten; a start after settling runs again", async () => {
  const now = clock();
  const jobs = new SlowJobs({ now, keepMs: 60_000 });
  let n = 0;
  const spec = { kind: "skills.inventory", repoId: "r1", run: async () => ++n };
  const first = jobs.start(spec);
  await first.promise;
  now.add(59_000);
  assert.equal(jobs.get("skills.inventory", "r1").result, 1, "kept inside the window");
  assert.equal(jobs.getById(first.job.id).result, 1);
  now.add(2_000);
  assert.equal(jobs.get("skills.inventory", "r1"), null, "forgotten past it");
  assert.equal(jobs.getById(first.job.id), null);
  const second = jobs.start(spec);
  assert.equal(second.joined, false);
  assert.equal(await second.promise, 2, "a new start is a new run");
});

test("a restart replaces the kept run: the old id is gone, the key reads the new one", async () => {
  const jobs = new SlowJobs({ now: clock() });
  const spec = { kind: "setup.check", repoId: "r1", run: async () => "x" };
  const a = jobs.start(spec); await a.promise;
  const b = jobs.start(spec);
  assert.notEqual(a.job.id, b.job.id);
  assert.equal(jobs.getById(a.job.id), null);
  await b.promise;
  assert.equal(jobs.get("setup.check", "r1").id, b.job.id);
});

test("the settled count is bounded: oldest settled goes first, a running one never", async () => {
  const now = clock();
  const jobs = new SlowJobs({ now, keepMax: 2 });
  const running = jobs.start({ kind: "skills.uses", repoId: "busy", run: () => new Promise(() => {}) });
  for (const id of ["a", "b", "c"]) { await jobs.start({ kind: "setup.check", repoId: id, run: async () => id }).promise; now.add(10); }
  assert.equal(jobs.get("setup.check", "a"), null, "the oldest settled was evicted");
  assert.ok(jobs.get("setup.check", "b"));
  assert.ok(jobs.get("setup.check", "c"));
  assert.equal(jobs.getById(running.job.id).state, "running");
});

test("a failure is a state with a sentence; the promise rejects; the next start runs again", async () => {
  const frames = [];
  const jobs = new SlowJobs({ onChange: (j) => frames.push(j), now: clock() });
  const a = jobs.start({ kind: "skills.recommend", repoId: "r1", run: async () => { throw new Error("halted"); } });
  await assert.rejects(a.promise, /halted/);
  const got = jobs.get("skills.recommend", "r1");
  assert.equal(got.state, "failed");
  assert.equal(got.error, "halted");
  assert.equal(got.result, undefined);
  assert.equal(frames.at(-1).state, "failed");
  const b = jobs.start({ kind: "skills.recommend", repoId: "r1", run: async () => "ok" });
  assert.equal(b.joined, false, "a failed run is not joined");
  assert.equal(await b.promise, "ok");
});

test("the give-up bound fails the run in words, and its late answer is dropped", async () => {
  const jobs = new SlowJobs({ now: clock() });
  const d = deferred();
  const a = jobs.start({ kind: "skills.uses", repoId: "r1", run: () => d.p, timeoutMs: 20 });
  await assert.rejects(a.promise, /Gave up/);
  assert.equal(jobs.get("skills.uses", "r1").state, "failed");
  d.resolve("late");
  await new Promise((r) => setImmediate(r));
  assert.equal(jobs.get("skills.uses", "r1").state, "failed", "a late answer never turns a given-up run done");
});

test("progress is throttled per run; the state change after it is not", async () => {
  const frames = [];
  const now = clock();
  const jobs = new SlowJobs({ onChange: (j) => frames.push(j), now, progressEveryMs: 500 });
  const d = deferred();
  let report;
  jobs.start({ kind: "skills.uses", repoId: "r1", run: (r) => { report = r; return d.p; } });
  await new Promise((r) => setImmediate(r));
  report(1, 10); report(2, 10); now.add(600); report(3, 10); report(99, 10);
  const prog = frames.filter((f) => f.progress).map((f) => f.progress.done);
  assert.deepEqual(prog, [1, 3], "two frames, the rest throttled");
  assert.deepEqual(jobs.get("skills.uses", "r1").progress, { done: 10, total: 10 }, "the latest reading is kept, clamped");
  d.resolve("x"); await new Promise((r) => setImmediate(r));
  assert.equal(frames.at(-1).state, "done");
});

test("a quiet run (old route) emits nothing until a loud start joins it", async () => {
  const frames = [];
  const jobs = new SlowJobs({ onChange: (j) => frames.push(j), now: clock() });
  const d = deferred();
  const spec = { kind: "setup.check", repoId: "r1", run: () => d.p };
  jobs.start({ ...spec, quiet: true });
  jobs.start({ ...spec, quiet: true });
  assert.equal(frames.length, 0);
  const loud = jobs.start(spec);
  assert.equal(loud.joined, true);
  assert.deepEqual(frames.map((f) => f.state), ["running"]);
  d.resolve("x"); await loud.promise;
  assert.deepEqual(frames.map((f) => f.state), ["running", "done"]);
});

test("a throwing broadcast never fails the work", async () => {
  const jobs = new SlowJobs({ onChange: () => { throw new Error("socket gone"); }, now: clock() });
  assert.equal(await jobs.start({ kind: "setup.check", repoId: "r1", run: async () => 7 }).promise, 7);
});

test("skills.uses waits while either count is still reading, and sums their progress", () => {
  const doc = (u) => ({ usage: { since30: 0, ...u } });
  assert.equal(usesSettled(doc({ state: "ready" })), true);
  assert.equal(usesSettled(doc({ state: "counting", done: 1, total: 4 })), false);
  assert.equal(usesSettled(doc({ state: "ready", refreshing: true })), false);
  assert.equal(usesSettled(doc({ state: "ready", allRepos: { state: "counting" } })), false);
  assert.equal(usesSettled(doc({ state: "absent", allRepos: { state: "ready" } })), true);
  assert.deepEqual(usesProgress(doc({ state: "counting", done: 1, total: 4, allRepos: { state: "counting", done: 2, total: 6 } })), { done: 3, total: 10 });
  assert.equal(usesProgress(doc({ state: "counting", done: 0, total: 0 })), null, "no size said ⇒ no progress, never 0 of 0");
});

test("forget drops settled runs of one kind (one repo, or all), never a running one", async () => {
  const jobs = new SlowJobs({ now: clock() });
  const ok = () => Promise.resolve({ ok: true });
  const a = jobs.start({ kind: "setup.check", repoId: "r1", run: ok });
  const b = jobs.start({ kind: "setup.check", repoId: "r2", run: ok });
  const c = jobs.start({ kind: "skills.inventory", repoId: "r1", run: ok });
  const live = jobs.start({ kind: "setup.check", repoId: "r3", run: () => new Promise(() => {}) });
  await Promise.all([a.promise, b.promise, c.promise]);
  assert.equal(jobs.forget("setup.check", "r1"), 1);
  assert.equal(jobs.get("setup.check", "r1"), null);
  assert.equal(jobs.getById(a.job.id), null);
  assert.ok(jobs.get("setup.check", "r2"), "another repo's run stays");
  assert.ok(jobs.get("skills.inventory", "r1"), "another kind stays");
  assert.equal(jobs.forget("setup.check"), 1, "no repo: every settled run of the kind");
  assert.equal(jobs.get("setup.check", "r2"), null);
  assert.equal(jobs.get("setup.check", "r3").state, "running", "a running run is left alone");
  assert.equal(jobs.getById(live.job.id).state, "running");
});
