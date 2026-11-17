/** The demo's Setup check speaks the engine's rule ids (bare), so a rule cut from the all-repos view lands on rows.  node --test packages/web/src/demo/host/setupcheck.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { findingCut, groupRuleOf } from "@waterplane/shared";
import { demoAllRepos, demoSetupCheck } from "./setupcheck.ts";

test("every demo finding's rule is the bare rule id, and a group's rule cut finds the repo's own rows", () => {
  const doc = demoSetupCheck("r1", "alpha", 1);
  for (const f of doc.findings) assert.ok(!/^(repo|machine)\./.test(f.rule), `${f.id} carries rule ${f.rule}`);
  for (const n of doc.notChecked) assert.ok(!/^(repo|machine)\./.test(n.rule), n.rule);
  const all = demoAllRepos([{ id: "r1", name: "alpha" }, { id: "r2", name: "beta" }], 1);
  const group = all.rollup.groups.find((g) => g.rule === "context-weight");
  assert.ok(group, "the shared rule is a group");
  assert.equal(findingCut(doc.findings, { scope: "repo", rule: group.rule }).count, 1, "the drill-down cut is not empty");
  assert.equal(groupRuleOf(doc.findings.find((f) => f.id === "repo.context-weight")), "context-weight");
});
