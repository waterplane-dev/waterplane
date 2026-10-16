/** The wide sidebar's dragged width (`sideWidth.ts`): its floor, its ceiling
 *  against the window, and the default for a value that is not one. */
import test from "node:test";
import assert from "node:assert/strict";

import { SIDE_DEFAULT_PX, SIDE_MAIN_MIN_PX, SIDE_MAX_PX, SIDE_MIN_PX, clampSide } from "./sideWidth.ts";

test("clampSide: inside the range is kept, rounded", () => {
  assert.equal(clampSide(400.4, 1920), 400);
  assert.equal(clampSide(SIDE_DEFAULT_PX, 1024), SIDE_DEFAULT_PX);
});

test("clampSide: the floor and the fixed ceiling", () => {
  assert.equal(clampSide(10, 1920), SIDE_MIN_PX);
  assert.equal(clampSide(5000, 4000), SIDE_MAX_PX);
});

test("clampSide: the main pane keeps its minimum in a narrow window", () => {
  assert.equal(clampSide(700, 1100), 1100 - SIDE_MAIN_MIN_PX);
  assert.equal(clampSide(700, 700), SIDE_MIN_PX); // floor wins over the pane
});

test("clampSide: a stored value that is not a number is the default", () => {
  assert.equal(clampSide(Number.NaN, 1920), SIDE_DEFAULT_PX);
  assert.equal(clampSide(500, Number.NaN), 500);
});
