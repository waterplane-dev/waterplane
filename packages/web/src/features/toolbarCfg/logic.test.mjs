import test from "node:test";
import assert from "node:assert/strict";

import { MENU_KEEP_OPEN, closesMenu, draggedOnto, movedBy, toggled } from "./logic.ts";

test("only the in-place entries keep the menu open", () => {
  assert.deepEqual([...MENU_KEEP_OPEN].sort(), ["bookmark", "followup", "limit", "star"]);
  assert.equal(closesMenu("star"), false);
  assert.equal(closesMenu("diff"), true);
  assert.equal(closesMenu(), true);
});

test("toggling removes a present id and appends an absent one", () => {
  assert.deepEqual(toggled(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggled(["a"], "c"), ["a", "c"]);
});

test("a move swaps one step and refuses at the ends", () => {
  assert.deepEqual(movedBy(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(movedBy(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.equal(movedBy(["a", "b"], "a", -1), null);
  assert.equal(movedBy(["a", "b"], "b", 1), null);
  assert.equal(movedBy(["a"], "x", 1), null);
});

test("a drag drops the item into the slot under the pointer", () => {
  assert.deepEqual(draggedOnto(["a", "b", "c", "d"], "a", "c"), ["b", "c", "a", "d"]);
  assert.deepEqual(draggedOnto(["a", "b", "c", "d"], "d", "b"), ["a", "d", "b", "c"]);
  assert.equal(draggedOnto(["a", "b"], "a", "a"), null);
  assert.equal(draggedOnto(["a", "b"], "a", null), null);
  assert.equal(draggedOnto(["a", "b"], "a", "zz"), null);
});
