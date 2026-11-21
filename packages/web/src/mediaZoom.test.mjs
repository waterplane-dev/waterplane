/** The before/after picture zoom ladder (`mediaZoom.ts`), pinned without a browser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampMediaZoom, nextMediaZoom, MEDIA_ZOOM_MAX } from "./mediaZoom.ts";

test("buttons step the ladder and stop at its ends", () => {
  assert.equal(nextMediaZoom(1, -1), null);
  assert.equal(nextMediaZoom(1, 1), 1.5);
  assert.equal(nextMediaZoom(MEDIA_ZOOM_MAX, 1), null);
  assert.equal(nextMediaZoom(MEDIA_ZOOM_MAX, -1), 3);
});

test("a pinch left between steps goes to the neighbouring step, not back to the same one", () => {
  assert.equal(nextMediaZoom(2.4, 1), 3);
  assert.equal(nextMediaZoom(2.4, -1), 2);
});

test("a pinch is clamped and never yields a non-number", () => {
  assert.equal(clampMediaZoom(0.3), 1);
  assert.equal(clampMediaZoom(99), MEDIA_ZOOM_MAX);
  assert.equal(clampMediaZoom(NaN), 1);
});
