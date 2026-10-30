import test from "node:test";
import assert from "node:assert/strict";
import { cardVisible, checkCounts, checksState, checksWords, mergeMethod, pickedMethod, pushLabel, reviewWords } from "./prCardLogic.ts";

const rules = (mode, o = {}) => ({ mode, requiredChecks: [], requiredApprovals: 0, allowedMerge: ["squash", "merge"], autoMerge: false, ...o });

test("absent and direct keep today's push label and draw no card", () => {
  for (const r of [undefined, rules("direct")]) {
    assert.equal(pushLabel(r), "Push");
    assert.equal(pushLabel(r, 3), "Push 3");
    assert.equal(cardVisible(r), false);
  }
});

test("pr and pr-checks open a PR and show the card", () => {
  for (const m of ["pr", "pr-checks"]) {
    assert.equal(pushLabel(rules(m), 2), "Push & open PR");
    assert.equal(cardVisible(rules(m)), true);
  }
});

test("a failed check outranks a running one outranks green", () => {
  const ck = (state) => ({ name: state, state });
  assert.equal(checksState([ck("passed"), ck("running"), ck("failed")]), "failed");
  assert.equal(checksState([ck("passed"), ck("running")]), "running");
  assert.equal(checksState([ck("passed"), ck("skipped")]), "passed");
  assert.equal(checksState([]), "none");
  assert.deepEqual(checkCounts([ck("passed"), ck("passed")]), { running: 0, passed: 2, failed: 0, skipped: 0 });
  assert.equal(checksWords([ck("failed"), ck("passed")]), "1 failed · 1 passed");
  assert.equal(checksWords([]), "no checks reported");
});

test("review words are absent when the forge did not say", () => {
  assert.equal(reviewWords(undefined), null);
  assert.equal(reviewWords("CHANGES_REQUESTED"), "changes requested");
});

test("merge method is the chosen allowed one, else the first allowed", () => {
  assert.equal(mergeMethod(rules("pr")), "squash");
  assert.equal(mergeMethod(rules("pr"), "merge"), "merge");
  assert.equal(mergeMethod(rules("pr"), "rebase"), "squash", "not allowed");
  assert.equal(mergeMethod(rules("pr", { allowedMerge: [] })), undefined);
});

test("GitView mounts PrCard only behind cardVisible and takes its push label from pushLabel", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./GitView.tsx", import.meta.url), "utf8");
  assert.match(src, /cardVisible\(status\?\.branchRules\) && <PrCard/);
  assert.match(src, /pushLabelText\(status\?\.branchRules, status\?\.ahead \?\? 0\)/);
  assert.equal(src.includes('"Push"'), false, "the literal label lives in logic.ts only");
});

test("the merge method the person picked reaches auto-merge too (bughunt 2026-10-29 PR-6)", async () => {
  const { readFileSync } = await import("node:fs");
  const api = readFileSync(new URL("./webapi/webapiGit.ts", import.meta.url), "utf8");
  assert.match(api, /prAutoMerge: \(repoId: string, number: number, on: boolean, method\?: string\) =>[^\n]*\{ number, on, method \}/);
  const card = readFileSync(new URL("./PrCard.tsx", import.meta.url), "utf8");
  assert.match(card, /api\.prAutoMerge\(repoId, pr\.number, !pr\.autoMerge, pickedMethod\(rules, method\)\)/);
});

test("auto-merge sends only a method the person picked; no pick lets the host choose from its fresh rules (review A2 L6)", () => {
  assert.equal(pickedMethod(rules("pr"), undefined), undefined, "no pick: the phone's possibly stale first-allowed is not sent");
  assert.equal(pickedMethod(rules("pr"), "merge"), "merge");
  assert.equal(pickedMethod(rules("pr"), "rebase"), undefined, "a pick the phone's rules no longer offer is not sent either");
});

test("a slow PR action waits the slow-op fuse, and a timeout says it may still have worked (bughunt 2026-10-29 PR-9)", async () => {
  const { readFileSync } = await import("node:fs");
  const { TimeoutError } = await import("@waterplane/shared");
  const { prActionFailWords } = await import("./prCardLogic.ts");
  const api = readFileSync(new URL("./webapi/webapiGit.ts", import.meta.url), "utf8");
  for (const name of ["prMerge", "prAutoMerge", "prClose"]) {
    const line = api.split("\n").find((l) => l.trimStart().startsWith(`${name}:`));
    assert.match(line ?? "", /SLOW_OP_TIMEOUT_MS\),$/, `${name} uses the slow-op fuse`);
  }
  const t = prActionFailWords(new TimeoutError("/api/x", 180000));
  assert.match(t, /may still have worked/);
  assert.doesNotMatch(t, /Did not reach/);
  assert.match(prActionFailWords(new TypeError("Failed to fetch")), /^Did not reach the desktop: /);
  const card = readFileSync(new URL("./PrCard.tsx", import.meta.url), "utf8");
  assert.match(card, /prActionFailWords\(e\)/);
});
