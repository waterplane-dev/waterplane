/**
 * A value that crossed the wire is an OPEN set: a newer host (or a newer
 * phone) adds a member this build has no word for. Every function here words
 * such a value, and each one printed `undefined` for a member it did not know
 * before it got a `default`. The lint rule `local/total-wire-words` keeps the
 * next one from shipping without; these pin the sentences.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as shared from "../dist/index.js";

const FUTURE = "someFutureValue";
/** A real sentence: a string, no "undefined", not empty. */
function sentence(text, what) {
  assert.equal(typeof text, "string", `${what} answers a string`);
  assert.doesNotMatch(text, /undefined/, `${what} never prints undefined`);
  assert.ok(text.trim().length > 3, `${what} says something`);
}

test("carriedRows labels a carried part kind this build does not know", () => {
  // `CarriedPart.kind` comes from the host's reading of the CLI's log.
  const rows = shared.carriedRows({ parts: [{ kind: FUTURE, chars: 400 }], firstRequestTok: null, laterDeltas: 0 }, String);
  sentence(rows[0].label, "the row label");
});

test("assessVerdictLabel and downgradeText word a verdict or downgrade this build does not know", () => {
  // Both ride on the host-stored assessment proposal.
  sentence(shared.assessVerdictLabel(FUTURE), "assessVerdictLabel");
  sentence(shared.downgradeText(FUTURE), "downgradeText");
  assert.match(shared.downgradeText(FUTURE), /^left undecided/);
});

test("budgetReasonText words a budget state this build does not know", () => {
  // `BudgetVerdict.state` comes from the host's `budget.state` message.
  sentence(shared.budgetReasonText({ state: FUTURE, unit: "pct", which: "session" }), "budgetReasonText");
});

test("healthCapWords names an entry this build does not know", () => {
  // `cappedBy` is a field of the host's health-index summary.
  sentence(shared.healthCapWords({ value: 40, mean: 70, cappedBy: FUTURE }), "healthCapWords");
});

test("pairRedeemErrorText words a refusal this build does not know", () => {
  // `error` is the host's answer to a pairing redeem.
  sentence(shared.pairRedeemErrorText(FUTURE), "pairRedeemErrorText");
});

test("passiveUnlockErrorText words a refusal this build does not know", () => {
  // `error` is the host's answer to `POST /api/auth/unlock`.
  sentence(shared.passiveUnlockErrorText(FUTURE), "passiveUnlockErrorText");
});

test("sessionBudgetLabel words a budget unit this build does not know", () => {
  // `SessionBudget.unit` is stored on the host and served to every phone.
  sentence(shared.sessionBudgetLabel({ unit: FUTURE, max: 5 }), "sessionBudgetLabel");
});

test("wordOf answers own keys, and the fallback for anything else", () => {
  const T = { a: "x", b: "y" };
  assert.equal(shared.wordOf(T, "a", "?"), "x");
  assert.equal(shared.wordOf(T, FUTURE, "?"), "?");
  // an inherited name is not a key of the table
  assert.equal(shared.wordOf(T, "constructor", "?"), "?");
  assert.equal(shared.wordOf(T, "toString", "?"), "?");
  // any value type: an icon table's fallback is an icon, never undefined
  const Check = () => null, Help = () => null;
  assert.equal(shared.wordOf({ done: Check }, FUTURE, Help), Help);
  assert.equal(shared.wordOf({ done: Check }, "done", Help), Check);
});
