/**
 * Which window an hour bucket belongs to.
 *
 *     node --test packages/host/test/tokenwindows.test.mjs
 *
 * This is the whole of the correctness of the past-window grids: the fold is a
 * sum, and every way a heat grid can be wrong is a bucket landing in the wrong
 * box. Three things are pinned here — that a cell is the window it says it is,
 * that a window opening mid-hour starts at the NEAREST hour (`windowStartHour`,
 * the rule the live cut states on screen) so the cells TILE with no hour in two,
 * and that nothing lands in a cell that does not exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { windowCells } from "../dist/tokenstats.js";

const HOUR = 3_600_000;
/** 17:00 today, local — an anchor that falls exactly on an hour. */
const onHour = new Date(2026, 8, 20, 17, 0, 0, 0).getTime();
/** 17:30 — the ordinary case: a window that opened mid-hour. */
const offHour = new Date(2026, 8, 20, 17, 30, 0, 0).getTime();
const at = (h, m = 0) => new Date(2026, 8, 20, h, m, 0, 0).getTime();

test("a window anchored on the hour claims each bucket exactly once", () => {
  // Cell 0 is [12:00, 17:00), cell 1 is [07:00, 12:00).
  assert.deepEqual(windowCells(at(16), onHour, 5 * HOUR), [0]);
  assert.deepEqual(windowCells(at(12), onHour, 5 * HOUR), [0]);
  assert.deepEqual(windowCells(at(11), onHour, 5 * HOUR), [1]);
  assert.deepEqual(windowCells(at(7), onHour, 5 * HOUR), [1]);
  assert.deepEqual(windowCells(at(6), onHour, 5 * HOUR), [2]);
});

test("a window opening mid-hour starts at the NEAREST hour, and the cells tile", () => {
  // Reset at 17:30: cell 0 is [12:30, 17:30), cell 1 [07:30, 12:30). Each edge rounds to the
  // nearest hour (a tie to the later one): cell 0 counts [13:00, 18:00), cell 1 [08:00, 13:00).
  // Flooring put 12:00 in BOTH — and 59 minutes of last week into a week resetting at 18:59.
  assert.deepEqual(windowCells(at(12), offHour, 5 * HOUR), [1]);
  assert.deepEqual(windowCells(at(13), offHour, 5 * HOUR), [0]);
  assert.deepEqual(windowCells(at(7), offHour, 5 * HOUR), [2]);
  assert.deepEqual(windowCells(at(8), offHour, 5 * HOUR), [1]);
  // Reset at :59 — the measured weekly case, one level down: the opening hour is the PREVIOUS
  // window's, and this one starts at the top of the next.
  const late = at(17, 59);
  assert.deepEqual(windowCells(at(12), late, 5 * HOUR), [1]);
  assert.deepEqual(windowCells(at(13), late, 5 * HOUR), [0]);
  // Reset at :20 — rounds DOWN: the opening hour belongs to this window, the closing one to the next.
  const early = at(17, 20);
  assert.deepEqual(windowCells(at(12), early, 5 * HOUR), [0]);
  assert.deepEqual(windowCells(at(16), early, 5 * HOUR), [0]);
  assert.deepEqual(windowCells(at(17), early, 5 * HOUR), []);
  // Every hour across three windows lands in exactly one cell.
  for (const anchor of [onHour, offHour, late, early]) {
    for (let h = at(3); h < at(17); h += HOUR) assert.equal(windowCells(h, anchor, 5 * HOUR).length, 1, new Date(h).toString());
  }
});

test("an hour after the anchor is in no cell — a window that has not closed is not a past one", () => {
  assert.deepEqual(windowCells(at(18), onHour, 5 * HOUR), []);
  assert.deepEqual(windowCells(at(17), onHour, 5 * HOUR), []);
  // …but 17:00 IS inside a window that resets at 17:30 (its close rounds up to 18:00).
  assert.deepEqual(windowCells(at(17), offHour, 5 * HOUR), [0]);
});

test("a week-long window folds the same way, over days", () => {
  const week = 7 * 24 * HOUR;
  const anchor = new Date(2026, 8, 24, 19, 0, 0, 0).getTime();
  assert.deepEqual(windowCells(anchor - HOUR, anchor, week), [0]);
  assert.deepEqual(windowCells(anchor - week - HOUR, anchor, week), [1]);
  assert.deepEqual(windowCells(anchor - 2 * week - HOUR, anchor, week), [2]);
  // The opening hour of a window that resets on the hour belongs to it alone.
  assert.deepEqual(windowCells(anchor - week, anchor, week), [0]);
});

test("nothing is answered for a grid that is not one", () => {
  assert.deepEqual(windowCells(at(12), onHour, 0), []);
  assert.deepEqual(windowCells(NaN, onHour, 5 * HOUR), []);
  assert.deepEqual(windowCells(at(12), NaN, 5 * HOUR), []);
  // A bucket from before the grid's own beginning is in no NEGATIVE cell.
  assert.ok(windowCells(at(12), onHour, 5 * HOUR).every((k) => k >= 0));
});
