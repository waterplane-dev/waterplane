/**
 * Which window an hour bucket belongs to.
 *
 *     node --test packages/host/test/tokenwindows.test.mjs
 *
 * This is the whole of the correctness of the past-window grids: the fold is a
 * sum, and every way a heat grid can be wrong is a bucket landing in the wrong
 * box. Three things are pinned here — that a cell is the window it says it is,
 * that the hour a window OPENED in is shared with the cell before it (the price
 * of an hour being the finest bucket on record, and the same rule the live cut
 * states on screen), and that nothing lands in a cell that does not exist.
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

test("the hour a window OPENED in is in that window AND in the one before it", () => {
  // Cell 0 is [12:30, 17:30) and counts from the top of 12:00; cell 1 is
  // [07:30, 12:30) and runs through it. That overlap is the stated price of an
  // hour bucket, and it is the same rule the live readout applies.
  assert.deepEqual(windowCells(at(12), offHour, 5 * HOUR), [0, 1]);
  assert.deepEqual(windowCells(at(13), offHour, 5 * HOUR), [0]);
  assert.deepEqual(windowCells(at(7), offHour, 5 * HOUR), [1, 2]);
});

test("an hour after the anchor is in no cell — a window that has not closed is not a past one", () => {
  assert.deepEqual(windowCells(at(18), onHour, 5 * HOUR), []);
  assert.deepEqual(windowCells(at(17), onHour, 5 * HOUR), []);
  // …but 17:00 IS inside a window that resets at 17:30.
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
