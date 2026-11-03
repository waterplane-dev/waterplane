import { test } from "node:test";
import assert from "node:assert/strict";
import { BEHIND_STALE_MS, behindLabel, gitPending, gitSyncText, gitTitle, incomingReading, incomingWords } from "./gitCounts.ts";

const NOW = 1_800_000_000_000;
const FRESH = NOW - 5 * 60_000;                    // fetched five minutes ago
const STALE = NOW - 27 * 24 * 60 * 60_000;         // fetched 27 days ago (the 2026-11-03 case)

test("no upstream: ahead/behind absent draw nothing", () => {
  const r = { changedCount: 0 };
  assert.equal(gitPending(r), false);
  assert.equal(gitSyncText(r), "");
  assert.equal(gitTitle(r), "nothing pending — open git");
});

test("commits out with a clean tree are pending", () => {
  const r = { changedCount: 0, ahead: 15, behind: 0, fetchedAt: FRESH };
  assert.equal(gitPending(r), true);
  assert.equal(gitSyncText(r, NOW), "↑15");
  assert.equal(gitTitle(r, NOW), "15 commits to push — open git");
});

test("all three", () => {
  const r = { changedCount: 1, ahead: 2, behind: 1, fetchedAt: FRESH };
  assert.equal(gitSyncText(r, NOW), "↑2 ↓1");
  assert.equal(gitTitle(r, NOW), "1 changed file, 2 commits to push, 1 commit to pull — open git");
});

// ↓ is counted against the remote-tracking ref, which only a fetch moves. The cut is on
// `fetchedAt`, never on the count: a month-old 0 is "not known", a month-old 30 is a floor.
test("incoming reading: the staleness cut is on the fetch time, never on the count", () => {
  assert.deepEqual(incomingReading({}, NOW), { kind: "none" }, "no upstream (behind absent): nothing to count against");
  assert.deepEqual(incomingReading({ behind: 0, fetchedAt: FRESH }, NOW), { kind: "fresh", behind: 0, checkedAt: FRESH });
  assert.deepEqual(incomingReading({ behind: 0, fetchedAt: STALE }, NOW), { kind: "aged", behind: 0, checkedAt: STALE });
  assert.deepEqual(incomingReading({ behind: 30, fetchedAt: STALE }, NOW), { kind: "aged", behind: 30, checkedAt: STALE });
  assert.deepEqual(incomingReading({ behind: 0, fetchedAt: undefined }, NOW), { kind: "unchecked", behind: 0 }, "never fetched here, or an older host");
  assert.equal(incomingReading({ behind: 0, fetchedAt: NOW - BEHIND_STALE_MS }, NOW).kind, "fresh", "the edge itself is still fresh");
  assert.equal(incomingReading({ behind: 0, fetchedAt: NOW - BEHIND_STALE_MS - 1 }, NOW).kind, "aged");
});

test("↓'s figure: a current count, a nonzero floor, or ? — never a stale zero passing for in sync", () => {
  assert.equal(behindLabel(incomingReading({}, NOW)), null, "no upstream: nothing drawn");
  assert.equal(behindLabel(incomingReading({ behind: 0, fetchedAt: FRESH }, NOW)), "0");
  assert.equal(behindLabel(incomingReading({ behind: 30, fetchedAt: STALE }, NOW)), "30", "a stale nonzero count is a floor");
  assert.equal(behindLabel(incomingReading({ behind: 0, fetchedAt: STALE }, NOW)), "?");
  assert.equal(behindLabel(incomingReading({ behind: 0 }, NOW)), "?", "never fetched here: a 0 nobody measured");
  assert.equal(behindLabel({ kind: "unchecked", behind: 0 }), "?");
});

test("the badge and its title: a stale zero draws nothing and the title says why; a stale floor is drawn and dated", () => {
  const staleZero = { changedCount: 2, ahead: 0, behind: 0, fetchedAt: STALE };
  assert.equal(gitSyncText(staleZero, NOW), "", "nothing is what it knows — never ↓0 as a claim");
  assert.equal(gitTitle(staleZero, NOW), "2 changed files, last checked against the remote 27d ago — open git");
  const staleFloor = { changedCount: 0, ahead: 0, behind: 30, fetchedAt: STALE };
  assert.equal(gitPending(staleFloor), true);
  assert.equal(gitSyncText(staleFloor, NOW), "↓30");
  assert.equal(gitTitle(staleFloor, NOW), "30 commits to pull at least, last checked against the remote 27d ago — open git");
  const unchecked = { changedCount: 0, ahead: 1, behind: 0 };
  assert.equal(gitTitle(unchecked, NOW), "1 commit to push, never checked against the remote — open git");
  assert.equal(gitTitle({ changedCount: 0 }, NOW), "nothing pending — open git", "no upstream: no clause about checking");
});

test("the sentence under the git sheet's counts names the upstream and the age", () => {
  const up = "origin/main";
  assert.equal(incomingWords({ kind: "none" }, up, NOW), null);
  assert.equal(incomingWords(incomingReading({ behind: 0, fetchedAt: FRESH }, NOW), up, NOW), "↓ is as of the last check of origin/main, 5m ago.");
  assert.equal(incomingWords(incomingReading({ behind: 0, fetchedAt: STALE }, NOW), up, NOW), "origin/main was last checked 27d ago, so ↓ is not known — Pull checks first.");
  assert.equal(incomingWords(incomingReading({ behind: 30, fetchedAt: STALE }, NOW), up, NOW), "origin/main was last checked 27d ago, so ↓ is at least that — Pull checks first.");
  assert.equal(incomingWords({ kind: "unchecked", behind: 0 }, up, NOW), "origin/main has never been checked from this worktree, so ↓ is not known — Pull checks first.");
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
