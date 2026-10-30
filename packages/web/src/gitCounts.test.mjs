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

test("branch list: the current branch's upstream is the header's verdict — a gone one reads none in both", async () => {
  const { branchUpstream } = await import("./gitCounts.ts");
  const gone = { branch: "feat" }; // `## feat...origin/feat [gone]` ⇒ no upstream in the status
  assert.equal(branchUpstream({ name: "feat", current: true, upstream: "origin/feat" }, gone), undefined);
  assert.equal(branchUpstream({ name: "feat", current: true, upstream: "origin/feat" }, { branch: "feat", upstream: "origin/feat" }), "origin/feat");
  assert.equal(branchUpstream({ name: "other", current: false, upstream: "origin/other" }, gone), "origin/other", "another branch: its own listing");
  assert.equal(branchUpstream({ name: "feat", current: true, upstream: "origin/feat" }, undefined), "origin/feat", "no status read yet: the listing");
  assert.equal(branchUpstream({ name: "feat", current: true, upstream: "origin/feat" }, { branch: "main" }), "origin/feat", "a status of another branch says nothing about this one");
});
