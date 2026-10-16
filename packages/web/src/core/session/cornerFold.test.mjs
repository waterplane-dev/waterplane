// The corner group's fold (`cornerFold.ts`): pushing it past the right edge
// takes one column off per button's width of overshoot, down to one column.
import test from "node:test";
import assert from "node:assert/strict";

import { foldCols } from "./cornerFold.ts";

test("no overshoot keeps the group in one row", () => {
  assert.equal(foldCols(7, 0, 40), 7);
  assert.equal(foldCols(7, -30, 40), 7);
});

test("each button's width of overshoot takes one column off", () => {
  assert.equal(foldCols(7, 39, 40), 7);
  assert.equal(foldCols(7, 40, 40), 6);
  assert.equal(foldCols(7, 130, 40), 4);
});

test("pushed all the way, the group is one column, never zero", () => {
  assert.equal(foldCols(7, 240, 40), 1);
  assert.equal(foldCols(7, 5000, 40), 1);
  assert.equal(foldCols(1, 500, 40), 1);
});
