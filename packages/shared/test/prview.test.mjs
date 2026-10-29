import test from "node:test";
import assert from "node:assert/strict";
import { prViewsFrom, prBlockedBy, actionsRunId, prChanges } from "../dist/prview.js";

const run = (name, status, conclusion, detailsUrl) => ({ __typename: "CheckRun", name, status, conclusion, detailsUrl });
const base = { number: 7, title: "t", url: "https://github.com/o/r/pull/7", headRefName: "wp/x" };

test("maps check runs and status contexts; unknown fields are absent", () => {
  const [p] = prViewsFrom([{ ...base, reviewDecision: "", mergeable: "UNKNOWN", autoMergeRequest: null, statusCheckRollup: [
    run("a", "COMPLETED", "SUCCESS", "https://github.com/o/r/actions/runs/11/job/1"),
    run("b", "IN_PROGRESS", ""),
    run("c", "COMPLETED", "SKIPPED"),
    { __typename: "StatusContext", context: "ci", state: "FAILURE", targetUrl: "https://ci/x" },
    { nonsense: true },
  ] }]);
  assert.deepEqual(p.checks.map((c) => [c.name, c.state]), [["a", "passed"], ["b", "running"], ["c", "skipped"], ["ci", "failed"]]);
  assert.equal(p.reviewDecision, undefined);
  assert.equal(p.mergeable, undefined);
  assert.equal(p.autoMerge, false);
  assert.equal(p.checks[3].url, "https://ci/x");
});
test("garbage and rows without number/url are dropped", () => {
  assert.deepEqual(prViewsFrom("x"), []);
  assert.deepEqual(prViewsFrom([{ title: "a" }, null, { ...base, number: 0 }]), []);
});
test("blockedBy wording", () => {
  const rules = { mode: "pr-checks", requiredChecks: ["local-ci"], requiredApprovals: 2, allowedMerge: [], autoMerge: true };
  const mk = (extra) => prViewsFrom([{ ...base, ...extra }], rules)[0];
  assert.equal(mk({ reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [run("local-ci", "COMPLETED", "SUCCESS")] }).blockedBy, "waiting for 2 approvals");
  assert.equal(mk({ statusCheckRollup: [run("local-ci", "COMPLETED", "FAILURE")] }).blockedBy, "check local-ci failed");
  assert.equal(mk({ statusCheckRollup: [run("local-ci", "QUEUED", "")] }).blockedBy, "checks still running");
  assert.equal(mk({ statusCheckRollup: [] }).blockedBy, "waiting for check local-ci");
  assert.equal(mk({ mergeable: "CONFLICTING", statusCheckRollup: [run("local-ci", "COMPLETED", "SUCCESS")] }).blockedBy, "it has merge conflicts with the base branch");
  assert.equal(mk({ reviewDecision: "APPROVED", mergeable: "MERGEABLE", autoMergeRequest: { enabledAt: "x" }, statusCheckRollup: [run("local-ci", "COMPLETED", "SUCCESS")] }).blockedBy, undefined);
  assert.equal(mk({ reviewDecision: "APPROVED", autoMergeRequest: {} }).autoMerge, true);
  // an unrequired failing check does not block when checks are required by name
  assert.equal(mk({ statusCheckRollup: [run("local-ci", "COMPLETED", "SUCCESS"), run("lint", "COMPLETED", "FAILURE")] }).blockedBy, undefined);
  assert.equal(prBlockedBy({ checks: [], reviewDecision: "REVIEW_REQUIRED" }), "waiting for 1 approval");
});
test("actionsRunId", () => {
  assert.equal(actionsRunId("https://github.com/o/r/actions/runs/123/job/9"), "123");
  assert.equal(actionsRunId("https://ci.example/build/5"), undefined);
});
test("prChanges: first reading is silent; new failure, changes requested, gone", () => {
  const a = prViewsFrom([{ ...base, statusCheckRollup: [run("x", "IN_PROGRESS", "")] }]);
  assert.deepEqual(prChanges(undefined, a), []);
  const b = prViewsFrom([{ ...base, reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [run("x", "COMPLETED", "FAILURE")] }]);
  assert.deepEqual(prChanges(a, b).map((c) => [c.kind, c.detail]), [["checks-failed", "x"], ["changes-requested", undefined]]);
  assert.deepEqual(prChanges(b, b), []);
  assert.deepEqual(prChanges(b, []).map((c) => c.kind), ["gone"]);
});
