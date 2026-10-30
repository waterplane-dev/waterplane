import test from "node:test";
import assert from "node:assert/strict";
import { classifyBranchRules } from "../dist/branchmode.js";

const repo = { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false, allow_auto_merge: true };

test("no rules is direct", () => {
  const r = classifyBranchRules([], null, repo);
  assert.equal(r.mode, "direct");
  assert.deepEqual(r.allowedMerge, ["merge", "squash"]);
  assert.equal(r.autoMerge, true);
});
test("force-push and deletion blocks alone stay direct", () => {
  assert.equal(classifyBranchRules([{ type: "non_fast_forward" }, { type: "deletion" }]).mode, "direct");
});
test("pull_request is pr with the approvals count", () => {
  const r = classifyBranchRules([{ type: "pull_request", parameters: { required_approving_review_count: 2 } }]);
  assert.equal(r.mode, "pr");
  assert.equal(r.requiredApprovals, 2);
});
test("required_status_checks is pr-checks with contexts", () => {
  const r = classifyBranchRules([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }, { context: "lint" }] } }]);
  assert.equal(r.mode, "pr-checks");
  assert.deepEqual(r.requiredChecks, ["ci", "lint"]);
});
test("classic protection is the fallback", () => {
  const r = classifyBranchRules([], { required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: { contexts: ["ci"] } });
  assert.equal(r.mode, "pr-checks");
  assert.equal(r.requiredApprovals, 1);
  assert.deepEqual(r.requiredChecks, ["ci"]);
  assert.equal(classifyBranchRules([], { required_pull_request_reviews: {} }).mode, "pr");
});
test("garbage is absent, never a guess", () => {
  assert.equal(classifyBranchRules(undefined), undefined);
  assert.equal(classifyBranchRules("x"), undefined);
  assert.equal(classifyBranchRules({ message: "Not Found" }), undefined);
  assert.equal(classifyBranchRules([42]), undefined);
  assert.equal(classifyBranchRules([], "junk"), undefined);
});

test("pinnedChecks: ruleset integration_id and classic app_id pin; -1 / absent do not", () => {
  const a = classifyBranchRules([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "local-ci", integration_id: 15368 }, { context: "lint" }] } }]);
  assert.deepEqual(a.pinnedChecks, ["local-ci"]);
  assert.deepEqual(a.requiredChecks, ["local-ci", "lint"]);
  const b = classifyBranchRules([], { required_status_checks: { checks: [{ context: "local-ci", app_id: 9 }, { context: "x", app_id: -1 }, { context: "y" }] } });
  assert.deepEqual(b.pinnedChecks, ["local-ci"]);
  assert.equal("pinnedChecks" in classifyBranchRules([], { required_status_checks: { contexts: ["ci"] } }), false);
});

test("merge_queue: a PR-only branch whose merges are enqueued; absent elsewhere (bughunt 2026-10-29 PR-3)", () => {
  const q = classifyBranchRules([{ type: "merge_queue", parameters: { merge_method: "SQUASH" } }]);
  assert.equal(q.mode, "pr");
  assert.equal(q.mergeQueue, true);
  const qc = classifyBranchRules([{ type: "merge_queue" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
  assert.equal(qc.mode, "pr-checks");
  assert.equal(qc.mergeQueue, true);
  assert.equal("mergeQueue" in classifyBranchRules([{ type: "pull_request" }]), false);
});
