import test from "node:test";
import assert from "node:assert/strict";
import { highlightAt, stepHighlight, reanchor } from "./tabHighlight.ts";

test("the highlight follows its tab when the list reorders or shrinks", () => {
  assert.equal(highlightAt(["a", "b", "c"], "b", 1), 1);
  assert.equal(highlightAt(["c", "b"], "b", 1), 1);
  assert.equal(highlightAt(["b", "c"], "b", 1), 0);
});
test("a closed highlighted tab clamps instead of pointing past the end or at a stranger beyond", () => {
  assert.equal(highlightAt(["a", "b"], "c", 2), 1);
  assert.equal(highlightAt(["a", "b", "c"], "x", 1), 1);
  assert.equal(highlightAt([], "a", 0), -1);
  assert.equal(highlightAt(["a"], null, 0), 0);
});
test("stepping wraps and starts from the followed index", () => {
  assert.equal(stepHighlight(["a", "b", "c"], "c", 2, 1), "a");
  assert.equal(stepHighlight(["a", "b", "c"], "a", 0, -1), "c");
  assert.equal(stepHighlight(["z", "a"], "a", 0, 1), "z");
  assert.equal(stepHighlight([], null, 0, 1), null);
});
test("after the highlighted tab closes, the neighbour becomes the identity and survives a reorder", () => {
  const k = reanchor(["a", "c"], "b", 1);
  assert.equal(k, "c");
  assert.equal(highlightAt(["c", "a", "x"], k, 1), 0);
  assert.equal(reanchor(["a", "b"], "b", 1), "b");
  assert.equal(reanchor([], "b", 1), "b");
});
