/**
 * The fullscreen handle's place: a stored spot is validated, a drag is clamped to the glass.
 *
 *     node --test packages/extensions/desktop/web/spot.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SPOT, cleanSpot, spotAt } from "./spot.ts";

test("a stored spot is kept only when both halves are fractions", () => {
  assert.deepEqual(cleanSpot({ x: 0.2, y: 0.8 }), { x: 0.2, y: 0.8 });
  assert.deepEqual(cleanSpot({ x: 1.2, y: 0.5 }), DEFAULT_SPOT);
  assert.deepEqual(cleanSpot({ x: "0.2", y: 0.5 }), DEFAULT_SPOT);
  assert.deepEqual(cleanSpot(null), DEFAULT_SPOT);
});

test("a drag past the edge keeps the whole button on the glass", () => {
  assert.deepEqual(spotAt(-50, 1000, 400, 800, 40), { x: 20 / 400, y: 780 / 800 });
  assert.deepEqual(spotAt(200, 400, 400, 800, 40), { x: 0.5, y: 0.5 });
  assert.deepEqual(spotAt(10, 10, 30, 800, 40), { x: 0.5, y: 20 / 800 });
});
