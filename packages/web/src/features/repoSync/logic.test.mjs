import test from "node:test";
import assert from "node:assert/strict";

import { doneToast, isBusy, leftOutWords, planWords, syncable, targets } from "./logic.ts";

const r = (id, o) => ({ id, ...o });

test("a repo needs an origin and an upstream to be synced", () => {
  assert.equal(syncable({ ahead: 0, behind: 0, hasOrigin: true }), true);
  assert.equal(syncable({ ahead: 0, behind: 0 }), true, "origin not known yet is not 'no origin'");
  assert.equal(syncable({ hasOrigin: true }), false, "no upstream");
  assert.equal(syncable({ ahead: 2, behind: 0, hasOrigin: false }), false);
});

test("pull and sync take every syncable repo; push only those ahead", () => {
  const repos = [r("a", { ahead: 0, behind: 0 }), r("b", { ahead: 3, behind: 0 }), r("c", {}), r("d", { ahead: 0, behind: 2 })];
  assert.deepEqual(targets(repos, "pull").map((x) => x.id), ["a", "b", "d"]);
  assert.deepEqual(targets(repos, "sync").map((x) => x.id), ["a", "b", "d"]);
  assert.deepEqual(targets(repos, "push").map((x) => x.id), ["b"]);
});

test("busy means still to finish", () => {
  assert.equal(isBusy({ s: "waiting" }), true);
  assert.equal(isBusy({ s: "pushing", startedAt: 1 }), true);
  assert.equal(isBusy({ s: "ok", text: "" }), false);
  assert.equal(isBusy(undefined), false);
});

test("the receipt counts every outcome", () => {
  assert.equal(doneToast([{ s: "ok", text: "" }]), "1 repo done");
  assert.equal(doneToast([{ s: "ok", text: "" }, { s: "ok", text: "" }, { s: "failed", text: "x" }, { s: "skipped", text: "" }]), "2 repos done, 1 failed, 1 stopped");
});

test("the plan and the left-out line say their numbers", () => {
  assert.match(planWords(0, 0), /nothing to pull/);
  assert.match(planWords(5, 2), /all 5.*the 2 with commits out/);
  assert.equal(leftOutWords(0), "");
  assert.equal(leftOutWords(1), "1 repo without an origin or an upstream not listed.");
});
