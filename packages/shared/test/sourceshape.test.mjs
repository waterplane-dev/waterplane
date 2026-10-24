// What a 2.2 source slot may answer (`shared/src/sourceshape.ts`): one rule for the host's
// consumers and the plugin testkit. Null is "cannot say" and always fine; anything else wrong is
// a SENTENCE, and the consumer drops the whole answer to absent — never a clamped number.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_COMMANDS_MAX, sourceModeProblem, sourceCommandsProblems, sourceSpendProblems,
  sourceCompactionsProblems, sourceContextSampleProblems, FACT_NAMES,
} from "../dist/index.js";

test("2.2 facts are named", () => {
  for (const f of ["mode", "commands"]) assert.ok(FACT_NAMES.includes(f), f);
});

test("mode: one of the declared permissionModes, or null", () => {
  assert.equal(sourceModeProblem(null, ["default"]), null);
  assert.equal(sourceModeProblem("plan", ["default", "plan"]), null);
  assert.match(sourceModeProblem("auto", ["default", "plan"]), /"auto" is not one this backend declares; caps\.permissionModes is: default, plan/);
  assert.match(sourceModeProblem("plan", []), /declares no permissionModes/);
  assert.match(sourceModeProblem(3, ["default"]), /one of the backend's permissionModes or null/);
});

test("commands: slash-named, unique, bounded; text and a boolean", () => {
  assert.deepEqual(sourceCommandsProblems(null), []);
  assert.deepEqual(sourceCommandsProblems([{ name: "/compact", description: "Compact", args: "[instructions]", local: false }, { name: "/mcp:list" }]), []);
  assert.match(sourceCommandsProblems("x")[0], /must be a list/);
  assert.match(sourceCommandsProblems([{ name: "compact" }])[0], /a slash and one word/);
  assert.match(sourceCommandsProblems([{ name: "/two words" }])[0], /a slash and one word/);
  assert.match(sourceCommandsProblems([{ name: "//x" }])[0], /a slash and one word/);
  assert.match(sourceCommandsProblems([{ name: "/x" }, { name: "/x" }])[0], /\/x is listed twice/);
  assert.match(sourceCommandsProblems([{ name: "/x", description: 5 }])[0], /description is not text/);
  assert.match(sourceCommandsProblems([{ name: "/x", args: "a".repeat(501) }])[0], /over 500 characters/);
  assert.match(sourceCommandsProblems([{ name: "/x", local: 1 }])[0], /local is not true or false/);
  const many = Array.from({ length: SOURCE_COMMANDS_MAX + 1 }, (_, i) => ({ name: `/c${i}` }));
  assert.match(sourceCommandsProblems(many)[0], new RegExp(`at most ${SOURCE_COMMANDS_MAX}`));
  assert.deepEqual(sourceCommandsProblems(many.slice(1)), []);
});

test("session spend: stamped; every stated figure finite and ≥ 0; native names a unit that is not dollars", () => {
  assert.deepEqual(sourceSpendProblems(null), []);
  assert.deepEqual(sourceSpendProblems({ at: 1 }), []); // nothing stated is fine: every figure absent
  assert.deepEqual(sourceSpendProblems({ at: 1, tok: 10, agentTok: 0, usd: 0.5, agentUsd: 0.1, native: { amount: 3, unit: "AIC", agentAmount: 1 } }), []);
  assert.match(sourceSpendProblems({ tok: 1 })[0], /no `at`/);
  assert.match(sourceSpendProblems({ at: 1, usd: -0.01 })[0], /spend\.usd/);
  assert.match(sourceSpendProblems({ at: 1, agentTok: NaN })[0], /spend\.agentTok/);
  assert.match(sourceSpendProblems({ at: 1, native: { amount: 1, unit: " " } })[0], /name the unit/);
  assert.match(sourceSpendProblems({ at: 1, native: { amount: 1, unit: "dollars" } })[0], /dollars the CLI states go in `usd`/);
  assert.match(sourceSpendProblems({ at: 1, native: { amount: -1, unit: "AIC" } })[0], /native\.amount/);
  assert.match(sourceSpendProblems([])[0], /must be an object/);
});

test("compactions: oldest first, stamped, stated fills finite and ≥ 0", () => {
  assert.deepEqual(sourceCompactionsProblems(null), []);
  assert.deepEqual(sourceCompactionsProblems([]), []);
  assert.deepEqual(sourceCompactionsProblems([{ at: 1, preTok: 150000, postTok: 20000, auto: true }, { at: 1 }, { at: 3, auto: false }]), []);
  assert.match(sourceCompactionsProblems([{ at: 3 }, { at: 2 }])[0], /oldest first/);
  assert.match(sourceCompactionsProblems([{ preTok: 1 }])[0], /no `at`/);
  assert.match(sourceCompactionsProblems([{ at: 1, postTok: -1 }])[0], /postTok/);
  assert.match(sourceCompactionsProblems([{ at: 1, auto: "yes" }])[0], /auto is not true or false/);
});

test("context sample: stamped fill; window only as a stated whole number above 0", () => {
  assert.deepEqual(sourceContextSampleProblems(null), []);
  assert.deepEqual(sourceContextSampleProblems({ at: 1, usedTok: 5000, model: "gpt-5", window: 400000 }), []);
  assert.deepEqual(sourceContextSampleProblems({ at: 1, usedTok: 5000 }), []); // window absent = unknown
  for (const w of [0, -1, 1.5, Infinity, "200k"]) assert.match(sourceContextSampleProblems({ at: 1, usedTok: 1, window: w })[0], /window is/);
  assert.match(sourceContextSampleProblems({ at: 1 })[0], /usedTok/);
});
