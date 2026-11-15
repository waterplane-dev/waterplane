import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_ENTRY, SLOW_FRESH_MS, cacheKeyOf, cacheRowOf, entryKey, failedWords, lostRuns, resourceOf, runningWords, shouldAutoStart, withCacheRow, withJob, withOwnResult, withRunLost,
} from "./slowJobsLogic.ts";

const NOW = 1_000_000_000;
const job = (o = {}) => ({ id: "r1", key: "setup.check:a", kind: "setup.check", repoId: "a", state: "running", startedAt: NOW - 5000, ...o });

test("keys: one per desktop, kind and repo", () => {
  assert.equal(entryKey("h1", "setup.check", "a"), "h1|setup.check:a");
  assert.equal(entryKey(null, "skills.uses", "a"), "local|skills.uses:a");
  assert.equal(cacheKeyOf("skills.recommend", "a"), "slowjob:skills.recommend:a");
});

test("a frame moves the run; done without a result asks for it over HTTP, once", () => {
  let { entry, fetch } = withJob(EMPTY_ENTRY, job(), NOW);
  assert.equal(entry.run.state, "running");
  assert.equal(fetch, false);
  ({ entry, fetch } = withJob(entry, job({ state: "done", finishedAt: NOW, hasResult: true }), NOW));
  assert.equal(fetch, true);
  assert.equal(entry.result, null);
  // The HTTP read carries the result: held, and no second fetch.
  ({ entry, fetch } = withJob(entry, job({ state: "done", finishedAt: NOW, hasResult: true, result: { ok: true } }), NOW));
  assert.deepEqual(entry.result, { ok: true });
  assert.equal(entry.resultRunId, "r1");
  assert.equal(entry.source, "live");
  assert.equal(entry.run.result, undefined, "the run is held without its result");
  assert.equal(withJob(entry, job({ state: "done", finishedAt: NOW, hasResult: true }), NOW).fetch, false);
});

test("a re-check keeps the last answer on screen; a failure never deletes it", () => {
  const held = withJob(EMPTY_ENTRY, job({ state: "done", finishedAt: NOW - 1000, hasResult: true, result: 1 }), NOW).entry;
  const again = withJob(held, job({ id: "r2", startedAt: NOW }), NOW).entry;
  assert.equal(again.result, 1);
  assert.equal(again.run.id, "r2");
  const failed = withJob(again, job({ id: "r2", startedAt: NOW, state: "failed", error: "Gave up after 10 min." }), NOW).entry;
  assert.equal(failed.result, 1);
  const r = resourceOf(failed, true, NOW);
  assert.equal(r.state, "fresh");
  assert.equal(r.error, "Gave up after 10 min.");
});

test("a frame for an older run than the one held is dropped (catch-up and live frames cross)", () => {
  const newer = withJob(EMPTY_ENTRY, job({ id: "r2", startedAt: NOW }), NOW).entry;
  const r = withJob(newer, job({ id: "r1", startedAt: NOW - 9000, state: "done", hasResult: true }), NOW);
  assert.equal(r.entry, newer);
  assert.equal(r.fetch, false);
});

test("an answer from a save is the newest result; the cache row round-trips under memory", () => {
  const own = withOwnResult(EMPTY_ENTRY, { x: 1 }, NOW);
  assert.equal(own.resultAt, NOW);
  assert.equal(own.resultRunId, null);
  const row = cacheRowOf(own);
  assert.deepEqual(row, { result: { x: 1 }, resultRunId: null, resultAt: NOW });
  const seeded = withCacheRow(EMPTY_ENTRY, row);
  assert.equal(seeded.source, "cache");
  assert.equal(withCacheRow(own, { result: 9, resultRunId: "old", resultAt: 1 }), own, "disk never overwrites memory");
  assert.equal(cacheRowOf(EMPTY_ENTRY), null);
});

test("the resource state says live, cached with age, loading, offline or error — never mixed", () => {
  const live = withOwnResult(EMPTY_ENTRY, 1, NOW);
  assert.deepEqual(resourceOf(live, true, NOW + 1000), { state: "fresh", age: null, error: null });
  assert.equal(resourceOf(live, true, NOW + SLOW_FRESH_MS).state, "cached");
  assert.equal(resourceOf(live, true, NOW + SLOW_FRESH_MS).age, SLOW_FRESH_MS);
  const disk = withCacheRow(EMPTY_ENTRY, { result: 1, resultRunId: null, resultAt: NOW - 10 });
  assert.equal(resourceOf(disk, false, NOW).state, "cached", "offline still shows the cached copy");
  assert.equal(resourceOf(EMPTY_ENTRY, false, NOW).state, "offline");
  assert.equal(resourceOf(withJob(EMPTY_ENTRY, job(), NOW).entry, true, NOW).state, "loading");
  assert.equal(resourceOf({ ...EMPTY_ENTRY, readError: "500" }, true, NOW).state, "error");
});

test("a screen starts a run itself only where allowed, never over a running one, never in a failure loop", () => {
  assert.equal(shouldAutoStart(EMPTY_ENTRY, NOW, false), false, "the paid call is a tap");
  assert.equal(shouldAutoStart(EMPTY_ENTRY, NOW, true), true);
  assert.equal(shouldAutoStart(withJob(EMPTY_ENTRY, job(), NOW).entry, NOW, true), false);
  const fresh = withOwnResult(EMPTY_ENTRY, 1, NOW);
  assert.equal(shouldAutoStart(fresh, NOW + 1000, true), false);
  assert.equal(shouldAutoStart(fresh, NOW + SLOW_FRESH_MS, true), true);
  const failed = withJob(EMPTY_ENTRY, job({ state: "failed", finishedAt: NOW }), NOW).entry;
  assert.equal(shouldAutoStart(failed, NOW + 1000, true), false);
  assert.equal(shouldAutoStart(failed, NOW + SLOW_FRESH_MS, true), true);
});

test("after a reconnect a run the host no longer lists was lost", () => {
  const running = withJob(EMPTY_ENTRY, job(), NOW).entry;
  const done = withJob(EMPTY_ENTRY, job({ id: "r9", state: "done" }), NOW).entry;
  assert.deepEqual(lostRuns([{ key: "a", e: running }, { key: "b", e: done }], []), ["a"]);
  assert.deepEqual(lostRuns([{ key: "a", e: running }], [job()]), []);
});

test("the running line says since when, how far only where counted, and that leaving is safe", () => {
  assert.match(runningWords("The setup check", job(), NOW), /^The setup check is running on the desktop, started under a minute ago\. It keeps going if you leave this screen/);
  assert.match(runningWords("X", job({ startedAt: NOW - 3 * 60_000, progress: { done: 1, total: 4 } }), NOW), /started 3 min ago · 25%\./);
  assert.match(failedWords("X", job({ state: "failed", error: "Gave up." }), true), /did not finish: Gave up\. The answer below is the last one that did\.$/);
});

test("a re-read of a run that finished BEFORE this phone's own answer never puts the older result back", () => {
  const held = withJob(EMPTY_ENTRY, job({ startedAt: NOW - 40_000, state: "done", finishedAt: NOW - 20_000, hasResult: true, result: { fixed: false } }), NOW).entry;
  const own = withOwnResult(held, { fixed: true }, NOW - 10_000);
  const again = withJob(own, job({ startedAt: NOW - 40_000, state: "done", finishedAt: NOW - 20_000, hasResult: true, result: { fixed: false } }), NOW);
  assert.deepEqual(again.entry.result, { fixed: true });
  assert.equal(again.entry.resultRunId, null);
  assert.equal(again.fetch, false);
  // A frame without the result does not ask for it either.
  assert.equal(withJob(own, job({ startedAt: NOW - 40_000, state: "done", finishedAt: NOW - 20_000, hasResult: true }), NOW).fetch, false);
  // A run that finishes AFTER the own answer is newer and does replace it.
  const newer = withJob(own, job({ id: "r2", startedAt: NOW - 5000, state: "done", finishedAt: NOW, hasResult: true, result: { fixed: "rechecked" } }), NOW);
  assert.deepEqual(newer.entry.result, { fixed: "rechecked" });
});

test("a run already going when this phone's own answer landed never puts its older read over it", () => {
  const running = withJob(EMPTY_ENTRY, job({ startedAt: NOW - 20_000 }), NOW).entry;
  const own = withOwnResult(running, { fixed: true }, NOW - 15_000);
  const done = withJob(own, job({ startedAt: NOW - 20_000, state: "done", finishedAt: NOW, hasResult: true, result: { fixed: false } }), NOW);
  assert.deepEqual(done.entry.result, { fixed: true });
  assert.equal(done.fetch, false);
  assert.equal(done.entry.run.state, "done");
});

test("a run held as running that the desktop no longer keeps is forgotten, and only that run", () => {
  const running = withJob(EMPTY_ENTRY, job(), NOW).entry;
  assert.equal(withRunLost(running, "r1").run, null);
  assert.equal(withRunLost(running, "other"), running);
  assert.equal(withRunLost(running, null), running);
  const done = withJob(EMPTY_ENTRY, job({ state: "done", finishedAt: NOW, hasResult: true, result: 1 }), NOW).entry;
  assert.equal(withRunLost(done, "r1"), done);
  assert.equal(shouldAutoStart(withRunLost(running, "r1"), NOW, true), true);
});
