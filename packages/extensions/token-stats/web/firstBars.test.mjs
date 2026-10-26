import test from "node:test";
import assert from "node:assert/strict";
import { firstBarPcts, FIRST_BAR_MIN_PCT } from "./firstBars.ts";

test("one shared scale: the largest first request is full width", () => {
  const m = firstBarPcts([{ id: "a", firstTok: 60000 }, { id: "b", firstTok: 30000 }]);
  assert.equal(m.get("a"), 100);
  assert.equal(m.get("b"), 50);
});

test("absent or zero firstTok draws nothing, and does not move the scale", () => {
  const m = firstBarPcts([{ id: "a", firstTok: 40000 }, { id: "b" }, { id: "c", firstTok: 0 }]);
  assert.equal(m.has("b"), false);
  assert.equal(m.has("c"), false);
  assert.equal(m.get("a"), 100);
  assert.equal(firstBarPcts([{ id: "x" }]).size, 0);
});

test("a sliver is a mark, but never drawn wider than 1%", () => {
  assert.equal(FIRST_BAR_MIN_PCT, 1);
  const m = firstBarPcts([{ id: "a", firstTok: 1_000_000 }, { id: "b", firstTok: 10 }, { id: "c", firstTok: 3000 }]);
  assert.equal(m.get("b"), 1);
  assert.ok(m.get("c") <= 1);
  // a row at 2% draws at 2%, not at the same length as the 0.3% row
  const n = firstBarPcts([{ id: "a", firstTok: 1000 }, { id: "b", firstTok: 20 }, { id: "c", firstTok: 3 }]);
  assert.equal(n.get("b"), 2);
  assert.equal(n.get("c"), 1);
});
