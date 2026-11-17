/**
 * The ledger's one cell iteration: key split, tally to totals, and the price
 * lookup. An unpriced cell carries tokens and NO money; an undated one carries
 * no hour and no day.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CROSS, crossKey, eachLedgerCell, tallyToTotals, uncross, costOf } from "../dist/index.js";

test("crossKey and uncross are inverses; a bare key is a model with no hour", () => {
  assert.equal(crossKey("2026-11-01T10", "claude-sonnet-4-5"), `2026-11-01T10${CROSS}claude-sonnet-4-5`);
  assert.deepEqual(uncross(crossKey("2026-11-01T10", "m")), ["2026-11-01T10", "m"]);
  assert.deepEqual(uncross("m"), ["", "m"]);
});

test("tallyToTotals reads the positional tuple", () => {
  assert.deepEqual(tallyToTotals([1, 2, 3, 4, 5, 6]),
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 5, turns: 6 });
});

test("eachLedgerCell yields every cell with day, totals and cost", () => {
  const model = "claude-sonnet-4-5";
  const files = {
    slugA: {
      "c1": { sub: undefined, x: { [crossKey("2026-11-01T10", model)]: [1000, 500, 0, 0, 0, 2], [crossKey("", model)]: [10, 10, 0, 0, 0, 1] } },
      "c1/subagents/agent-x": { sub: 1, x: { [crossKey("2026-11-02T03", "no-such-model")]: [7, 0, 0, 0, 0, 1] } },
    },
  };
  const seen = [];
  eachLedgerCell(files, (c) => seen.push(c));
  assert.equal(seen.length, 3);
  const [a, undated, unpriced] = seen;
  assert.equal(a.slug, "slugA");
  assert.equal(a.fileKey, "c1");
  assert.equal(a.sum, files.slugA.c1);
  assert.equal(a.hour, "2026-11-01T10");
  assert.equal(a.day, "2026-11-01");
  assert.equal(a.model, model);
  assert.equal(a.totals.turns, 2);
  assert.deepEqual(a.cost, costOf(a.totals, model, "2026-11-01"));
  assert.ok(a.cost && a.cost.total > 0);
  // No hour: in the totals, in no time bucket.
  assert.equal(undated.hour, "");
  assert.equal(undated.day, "");
  assert.deepEqual(undated.cost, costOf(undated.totals, model, undefined));
  // No rate: tokens without money, never a zero charge.
  assert.equal(unpriced.fileKey, "c1/subagents/agent-x");
  assert.equal(unpriced.totals.input, 7);
  assert.equal(unpriced.cost, null);
});
