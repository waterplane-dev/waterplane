import { test } from "node:test";
import assert from "node:assert/strict";
import { gitPending, gitSyncText, gitTitle } from "./gitCounts.ts";

test("no upstream: ahead/behind absent draw nothing", () => {
  const r = { changedCount: 0 };
  assert.equal(gitPending(r), false);
  assert.equal(gitSyncText(r), "");
  assert.equal(gitTitle(r), "nothing pending — open git");
});

test("commits out with a clean tree are pending", () => {
  const r = { changedCount: 0, ahead: 15, behind: 0 };
  assert.equal(gitPending(r), true);
  assert.equal(gitSyncText(r), "↑15");
  assert.equal(gitTitle(r), "15 commits to push — open git");
});

test("all three", () => {
  const r = { changedCount: 1, ahead: 2, behind: 1 };
  assert.equal(gitSyncText(r), "↑2 ↓1");
  assert.equal(gitTitle(r), "1 changed file, 2 commits to push, 1 commit to pull — open git");
});
