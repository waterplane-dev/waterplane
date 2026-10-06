// Reshaping or moving a mark already on the picture (`annMove.ts`) — the
// occlusion problem a finger has with a SMALL mark, solved by relative drag
// instead of a floating handle. Every rule here is about what a drag commits
// to, and what it must never silently delete.
import test from "node:test";
import assert from "node:assert/strict";

import { moveGrab, settleMove, smallOnScreen, SMALL_PX } from "./annMove.ts";

const m = (tool, x0, y0, x1, y1) => ({ tool, x0, y0, x1, y1, color: "#ff2d2d" });

test("a mark whose span is under the touch-target floor is small", () => {
  assert.equal(smallOnScreen(m("circle", 0, 0, 20, 20), 1), true); // diag ~28 < 48
  assert.equal(smallOnScreen(m("circle", 0, 0, 60, 60), 1), false); // diag ~85 >= 48
});

test("smallness is measured on SCREEN, so zoom changes the answer", () => {
  const s = m("rect", 0, 0, 40, 0); // 40 canvas px wide
  assert.equal(smallOnScreen(s, 0.5), true);  // 20 CSS px on screen
  assert.equal(smallOnScreen(s, 2), false);   // 80 CSS px on screen
});

test("a label is never small — it has no end dots to hide", () => {
  assert.equal(smallOnScreen(m("text", 0, 0, 0, 0), 0.01), false);
});

test("a hit end dot wins over everything else", () => {
  const g = moveGrab({ sel: 3, small: false, handleHit: 1, pickHit: 5, target: 0 });
  assert.deepEqual(g, { kind: "handle", i: 3, h: 1 });
});

test("a small mark's dots are never grabbed, even if a hit slips through", () => {
  // The caller is expected to gate handleHit on !small itself; the decision
  // refuses one anyway, falling through to a relative drag on the selection.
  const g = moveGrab({ sel: 3, small: true, handleHit: 1, pickHit: null, target: null });
  assert.deepEqual(g, { kind: "relative", i: 3, h: null });
});

test("picking a mark under the finger wins over a relative drag on the selection", () => {
  const g = moveGrab({ sel: 3, small: false, handleHit: null, pickHit: 7, target: 1 });
  assert.deepEqual(g, { kind: "pick", i: 7 });
});

test("nothing under the finger, but a selection exists: relative drag, by the chip's target", () => {
  const g = moveGrab({ sel: 3, small: false, handleHit: null, pickHit: null, target: 1 });
  assert.deepEqual(g, { kind: "relative", i: 3, h: 1 });
  const whole = moveGrab({ sel: 3, small: false, handleHit: null, pickHit: null, target: null });
  assert.deepEqual(whole, { kind: "relative", i: 3, h: null });
});

test("nothing selected and nothing hit: no gesture yet", () => {
  assert.deepEqual(moveGrab({ sel: null, small: false, handleHit: null, pickHit: null, target: null }), { kind: "none" });
});

test("a move that keeps the mark on the picture clips exactly as annClip does", () => {
  const base = m("rect", 100, 100, 200, 200);
  const live = m("rect", 900, 100, 1300, 200); // dragged so it overhangs the right edge
  const { mark, refused } = settleMove(live, base, 1000, 1000);
  assert.equal(refused, false);
  assert.deepEqual([mark.x0, mark.x1], [900, 1000]); // clipped at the border, not deleted
});

test("a move that would push the mark fully off the picture is REFUSED, not deleted", () => {
  const base = m("rect", 100, 100, 200, 200);
  const live = m("rect", 1400, 100, 1600, 200); // dragged entirely past the right edge
  const { mark, refused } = settleMove(live, base, 1000, 1000);
  assert.equal(refused, true);
  assert.deepEqual(mark, base); // left exactly where it was before the drag
});

test("an ellipse dragged fully off is refused the same way — never reshaped by the clip", () => {
  const base = m("circle", 100, 100, 200, 200);
  const live = m("circle", -900, -900, -700, -700);
  const { mark, refused } = settleMove(live, base, 1000, 1000);
  assert.equal(refused, true);
  assert.deepEqual(mark, base);
});

test(`SMALL_PX is the documented floor`, () => {
  assert.equal(SMALL_PX, 48);
});
