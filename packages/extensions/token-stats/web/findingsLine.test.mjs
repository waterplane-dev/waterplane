import test from "node:test";
import assert from "node:assert/strict";
import { spendFindingsOf, checkedBesideWords } from "./findingsLineLogic.ts";

const be = { understood: ["claude"], unread: [] };
const f = (id, over = {}) => ({ id, rule: id, scope: "machine", kind: "cost", weight: "consider", what: id, backends: be, evidence: { screen: "tokens" }, remedy: { kind: "howto", text: "x" }, waive: { via: "ignore" }, ...over });

test("the spend count is the screen cut: any scope, any weight, waived out", () => {
  assert.equal(spendFindingsOf([f("a"), f("b", { scope: "repo", weight: "finding" }), f("c", { evidence: null }), f("d", { waive: { via: "ignore", waived: { reason: "" } } })]), 2);
});

test("the checked-off words never say a second finding count", () => {
  assert.equal(checkedBesideWords(1, 0), "1 check passed");
  assert.equal(checkedBesideWords(3, 2), "3 checks passed · 2 not checked");
});
