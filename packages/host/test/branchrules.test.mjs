import test from "node:test";
import assert from "node:assert/strict";
import { cachedBranchRules, invalidateBranchRules, branchRules } from "../dist/branchrules.js";

test("a non-repo path is absent, never a guess, and never throws", async () => {
  const dir = "/nonexistent-wp-branchrules";
  assert.equal(await branchRules(dir), undefined);
  assert.equal(cachedBranchRules(dir), undefined);
  invalidateBranchRules(dir);
});
