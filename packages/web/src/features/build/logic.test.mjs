/**
 * The build feature's words and lookup — the strings App carried inline, twice
 * for the queued-run receipt (the sheet's Run and the `shell` intent).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildBusyIn, buildLane, buildNameIn, buildQueueTitle, buildQueuedToast, buildRunToast } from "./logic.ts";

test("a settled run says so by name; anything else says nothing", () => {
  assert.equal(buildRunToast({ status: "done", name: "Debug APK" }), "build “Debug APK” done");
  assert.equal(buildRunToast({ status: "failed", name: "Debug APK" }), "build “Debug APK” failed");
  assert.equal(buildRunToast({ status: "running", name: "Debug APK" }), null);
});

test("the tap's receipt has both halves: queued offline, starting online", () => {
  assert.equal(buildQueuedToast(true, "x"), "queued — the build starts when the link is back");
  assert.equal(buildQueuedToast(false, "Release · flavour=free"), "starting “Release · flavour=free”…");
});

test("the queue row and its lane are named per repo", () => {
  assert.equal(buildLane("/r/a"), "build:/r/a");
  assert.equal(buildQueueTitle("Debug"), "build “Debug”");
});

test("a build's name comes off that repo's list, and falls back to its id — never empty", () => {
  const lists = new Map([["/r/a", [{ id: "dbg", name: "Debug APK" }]]]);
  assert.equal(buildNameIn(lists, "/r/a", "dbg"), "Debug APK");
  assert.equal(buildNameIn(lists, "/r/a", "gone"), "gone");
  assert.equal(buildNameIn(lists, "/r/b", "dbg"), "dbg");
});

test("the hammer spins for a live run, or the host's seed until a frame for that run lands", () => {
  const repo = { worktreePath: "/r" };
  const run = (runId, status, repoDir = "/r") => ({ runId, repoDir, status, name: runId });
  assert.deepEqual(buildBusyIn([run("a", "running")], repo), { name: "a" });
  assert.equal(buildBusyIn([run("a", "running", "/other")], repo), null);
  assert.equal(buildBusyIn([run("a", "done")], repo), null);
  const seeded = { ...repo, buildRunning: { runId: "b", name: "Release" } };
  assert.deepEqual(buildBusyIn([], seeded), { name: "Release" });
  assert.equal(buildBusyIn([run("b", "done")], seeded), null);
});

import { readFileSync } from "node:fs";

test("the sheet's schedule cue reads a ticking clock, never Date.now() at render (BLD-5)", () => {
  const src = readFileSync(new URL("./BuildButtonsSheet.tsx", import.meta.url), "utf8");
  assert.match(src, /useNow\(/);
  assert.doesNotMatch(src, /Date\.now\(\)/);
});
