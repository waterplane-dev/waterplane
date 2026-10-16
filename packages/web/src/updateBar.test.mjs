import test from "node:test";
import assert from "node:assert/strict";

import { updateBarView, RESULT_FRESH_MS } from "./updateBar.ts";

const NOW = 1_700_000_000_000;
const base = { available: false, running: false };

test("nothing to act on — no bar at all", () => {
  assert.equal(updateBarView({ ...base, current: "2.1.267" }, "", NOW).show, false);
  assert.equal(updateBarView(null, "", NOW).show, false);
});

test("an available update shows, and the × hides exactly it", () => {
  const u = { ...base, available: true, current: "2.1.236", latest: "2.1.267" };
  const { show, sig } = updateBarView(u, "", NOW);
  assert.equal(show, true);
  assert.equal(updateBarView(u, sig, NOW).show, false);
});

/* The reported bug: the bar that says what the upgrade DID swallowed the tap,
   because a dismissal only counted while `available` was still true. */
test("the × works on the 'Updated: …' bar", () => {
  const u = {
    ...base, current: "2.1.267", latest: "2.1.267",
    lastResult: { ok: true, message: "updated to 2.1.267", at: NOW - 1000 },
  };
  const { show, sig, recentResult } = updateBarView(u, "", NOW);
  assert.equal(show, true);
  assert.equal(recentResult, true);
  assert.equal(updateBarView(u, sig, NOW).show, false);
});

test("the × works on a failed upgrade, and on a standing error", () => {
  const failed = {
    ...base, current: "2.1.236", latest: "2.1.267",
    lastResult: { ok: false, message: "upgrade failed", at: NOW - 1000 },
  };
  assert.equal(updateBarView(failed, updateBarView(failed, "", NOW).sig, NOW).show, false);

  const errored = { ...base, current: "2.1.236", lastError: "brew not found" };
  assert.equal(updateBarView(errored, updateBarView(errored, "", NOW).sig, NOW).show, false);
});

test("a dismissal never hides the NEXT release, result or error", () => {
  const u = { ...base, available: true, current: "2.1.236", latest: "2.1.267" };
  const waved = updateBarView(u, "", NOW).sig;

  const newer = { ...u, latest: "2.1.300" };
  assert.equal(updateBarView(newer, waved, NOW).show, true);

  const afterUpgrade = { ...u, available: false, lastResult: { ok: true, message: "updated to 2.1.267", at: NOW } };
  assert.equal(updateBarView(afterUpgrade, waved, NOW).show, true);

  const errored = { ...u, lastError: "brew exited 1" };
  assert.equal(updateBarView(errored, waved, NOW).show, true);
});

test("an upgrade in flight is never hidden — the log under it is the only view of it", () => {
  const u = { ...base, running: true, current: "2.1.236", latest: "2.1.267" };
  const { sig } = updateBarView(u, "", NOW);
  assert.equal(updateBarView(u, sig, NOW).show, true);
});

test("a result goes stale on its own, and takes the bar with it", () => {
  const u = { ...base, current: "2.1.267", latest: "2.1.267", lastResult: { ok: true, message: "updated", at: NOW } };
  assert.equal(updateBarView(u, "", NOW + RESULT_FRESH_MS - 1).show, true);
  assert.equal(updateBarView(u, "", NOW + RESULT_FRESH_MS).show, false);
});

test("after a clean upgrade the bar says so without offering the upgrade again", () => {
  const done = { ...base, current: "2.1.267", latest: "2.1.267", lastResult: { ok: true, message: "updated to 2.1.267", at: NOW } };
  const v = updateBarView(done, "", NOW);
  assert.equal(v.show, true);
  assert.equal(v.canApply, false);
  assert.equal(v.staleAt, NOW + RESULT_FRESH_MS);
  // A run that moved nothing (cask lagging npm) still has something to apply.
  const lagging = { ...done, available: true, latest: "2.1.270" };
  assert.equal(updateBarView(lagging, "", NOW).canApply, true);
});
