// The floor under a PTY's geometry (`shared/src/ptysize.ts`). The measured
// failure: a phone reported `54x3` off a collapsed terminal container, the
// claude TUI could not draw a composer in three rows, and so every delivery
// into that session was unconfirmable — 28 consecutive echo misses and five
// copies of one prompt stacked in a composer nobody could see.
import test from "node:test";
import assert from "node:assert/strict";
import { MIN_PTY_COLS, MIN_PTY_ROWS, drawableViewport, ptySize } from "../dist/index.js";

test("a collapsed container is not a viewport", () => {
  assert.equal(drawableViewport(54, 3), false);   // the real one
  assert.equal(drawableViewport(54, 0), false);
  assert.equal(drawableViewport(0, 0), false);
  assert.equal(drawableViewport(8, 40), false);   // full height, no width
});

test("every real phone grid is one", () => {
  assert.equal(drawableViewport(54, 41), true);
  assert.equal(drawableViewport(40, 24), true);
  assert.equal(drawableViewport(MIN_PTY_COLS, MIN_PTY_ROWS), true);
});

test("the host clamps rather than refuses — a too-small report still has a session behind it", () => {
  assert.deepEqual(ptySize(54, 3), { cols: 54, rows: MIN_PTY_ROWS });
  assert.deepEqual(ptySize(4, 2), { cols: MIN_PTY_COLS, rows: MIN_PTY_ROWS });
});

test("a real geometry passes through untouched", () => {
  assert.deepEqual(ptySize(54, 41), { cols: 54, rows: 41 });
  assert.deepEqual(ptySize(80, 30), { cols: 80, rows: 30 });
});

test("an absent geometry is not a small one — it is the floor, never NaN", () => {
  assert.deepEqual(ptySize(undefined, undefined), { cols: MIN_PTY_COLS, rows: MIN_PTY_ROWS });
  assert.deepEqual(ptySize(Number.NaN, Infinity), { cols: MIN_PTY_COLS, rows: MIN_PTY_ROWS });
  assert.equal(drawableViewport(Number.NaN, 40), false);
});

test("fractional cells round DOWN — half a row is not a row", () => {
  assert.deepEqual(ptySize(54.9, 41.9), { cols: 54, rows: 41 });
  assert.equal(drawableViewport(54, MIN_PTY_ROWS - 0.5), false);
});
