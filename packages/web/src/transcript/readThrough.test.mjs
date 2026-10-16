/**
 * The reader's watermark follows what has been scrolled THROUGH, not only the tail.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { readThrough } from "./readThrough.ts";

test("the newest turn whose end is on screen is the mark", () => {
  const turns = [{ ts: 10, bottom: 100 }, { ts: 20, bottom: 400 }, { ts: 30, bottom: 900 }];
  assert.equal(readThrough(turns, 500), 20);
});

test("a turn scrolled past above the viewport counts as read", () => {
  assert.equal(readThrough([{ ts: 10, bottom: -300 }, { ts: 20, bottom: -50 }], 600), 20);
});

test("a turn whose end is still below the fold is not read", () => {
  assert.equal(readThrough([{ ts: 10, bottom: 700 }], 600), 0);
});

test("slack absorbs a few pixels of rounding, no more", () => {
  assert.equal(readThrough([{ ts: 10, bottom: 606 }], 600), 10);
  assert.equal(readThrough([{ ts: 10, bottom: 640 }], 600), 0);
});
