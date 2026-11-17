import test from "node:test";
import assert from "node:assert/strict";
import { hostSpendWords } from "./hostSpendWords.ts";

const base = { today: { calls: 0, inTok: 0, outTok: 0, costUsd: 0 }, byModel: [], lastAt: 1 };

test("no calls draws nothing", () => {
  assert.equal(hostSpendWords(null), null);
  assert.equal(hostSpendWords({ ...base, calls: 0, inTok: 0, outTok: 0, costUsd: 0 }), null);
});

test("priced calls: split and dollars", () => {
  const v = hostSpendWords({ ...base, calls: 3, inTok: 2000, outTok: 500, costUsd: 0.02, unpricedCalls: 0, unpricedTok: 0 });
  assert.match(v.text, /3 calls/);
  assert.match(v.text, /\(2\.00k in, 500 out\)|in, 500 out/);
  assert.match(v.text, /\$0\.02 for the priced part/);
  assert.doesNotMatch(v.text, /no price/);
});

test("unpriced calls are counted in words, never free", () => {
  const v = hostSpendWords({ ...base, calls: 4, inTok: 1000, outTok: 1000, costUsd: 0.01, unpricedCalls: 1, unpricedTok: 300 });
  assert.match(v.text, /1 call on a model with no price/);
  assert.match(v.text, /not in the dollars/);
});

test("all unpriced: no dollar figure at all", () => {
  const v = hostSpendWords({ ...base, calls: 2, inTok: 100, outTok: 50, costUsd: 0, unpricedCalls: 2, unpricedTok: 150 });
  assert.doesNotMatch(v.text, /\$/ );
  assert.match(v.text, /2 calls on models with no price/);
});

test("an older host that did not say: dollars only when nonzero", () => {
  assert.doesNotMatch(hostSpendWords({ ...base, calls: 1, inTok: 1, outTok: 1, costUsd: 0 }).text, /\$/);
});
