/**
 * The backlog feature's pure half — the schedule↔row joins App built in three
 * memos, and the receipts that moved with the sheet.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { BL_OFFLINE, assessRunToast, clockParentsOf, runAgainQueuedToast, scheduleMaps, schedChipName } from "./logic.ts";

const entry = (id, name, text, childId) => ({ id, name, action: { kind: "backlog", text, repoDir: "/r" }, lastResult: childId ? { childId } : undefined });

test("a rule nobody named is not a 120-char slice on a chip", () => {
  const long = "x".repeat(60);
  assert.equal(schedChipName(entry("a", "nightly", "run the sweep")), "nightly");
  // A name that is just the prompt's head is not a typed name.
  assert.equal(schedChipName(entry("b", long, long)), `${"x".repeat(40)}…`);
});

test("the entry maps answer by id and by the LAST child only", () => {
  const { byId, byChild } = scheduleMaps([entry("s1", "nightly", "sweep", "c9"), entry("s2", "weekly", "tidy")]);
  assert.deepEqual(byId.get("s2"), { id: "s2", name: "weekly" });
  assert.deepEqual(byChild.get("c9"), { id: "s1", name: "nightly" });
  assert.equal(byChild.size, 1);
});

test("clock parents come only off timed one-off rows, titled by the caller", () => {
  const timed = {
    id: "t1", cwd: "/r", state: "done", target: { kind: "repo" }, payload: { kind: "prompt", steps: ["x"] },
    trigger: { kind: "at", rule: { kind: "once", at: 1 } }, result: { childId: "c1" },
  };
  const plain = { ...timed, id: "p1", trigger: { kind: "idle" }, result: { childId: "c2" } };
  const { byId, byChild } = clockParentsOf([timed, plain], (i) => `title ${i.id}`);
  assert.equal(byId.get("p1"), undefined);
  assert.equal(byChild.get("c2"), undefined);
  assert.deepEqual(byId.get("t1"), { id: "t1", name: "title t1" });
  assert.deepEqual(byChild.get("c1"), { id: "t1", name: "title t1" });
});

test("receipts keep App's words", () => {
  assert.match(BL_OFFLINE, /^no connection — the backlog lives on the desktop/);
  assert.equal(assessRunToast(undefined), "reading the repo — this takes a while; the proposal lands here");
  assert.equal(assessRunToast(["a"]), "reading the repo to judge this one — this takes a while; the proposal lands here");
  assert.equal(assessRunToast(["a", "b"]), "reading the repo to judge these 2 — this takes a while; the proposal lands here");
  assert.equal(runAgainQueuedToast(1), "queued — it goes back in the queue when the link is back");
  assert.equal(runAgainQueuedToast(3), "queued — all 3 go back in the queue when the link is back");
});

