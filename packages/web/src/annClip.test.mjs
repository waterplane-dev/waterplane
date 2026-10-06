// What survives of a mark drawn from OUTSIDE the picture (`annClip.ts`). A drag
// may start on the letterbox beside the image — that is the point of the
// feature — so every rule here is about what the agent is then told, and what it
// is not made to pay for.
import test from "node:test";
import assert from "node:assert/strict";

import { clipMark, clipSegment, touchesImage } from "./annClip.ts";

const W = 1000, H = 1000;
const m = (tool, x0, y0, x1, y1) => ({ tool, x0, y0, x1, y1, color: "#ff2d2d" });

test("a box dragged in from off the picture keeps only the part that is on it", () => {
  const c = clipMark(m("rect", -220, 480, 900, 520), W, H);
  assert.deepEqual(
    { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
    { x0: 0, y0: 480, x1: 900, y1: 520 },
  );
});

test("clipping a box never moves the edges that were already inside", () => {
  const c = clipMark(m("blur", 1200, 40, 300, 60), W, H);
  assert.equal(c.x0, 1000); // the overhanging end lands on the border
  assert.equal(c.x1, 300);  // the other one is exactly where it was drawn
});

test("a box drawn entirely beside the picture is not sent at all", () => {
  assert.equal(clipMark(m("rect", -400, 10, -20, 90), W, H), null);
  assert.equal(clipMark(m("marker", 20, 1100, 400, 1180), W, H), null);
});

test("a swipe along a line of text stays a swipe — a flat band is not an empty one", () => {
  const c = clipMark(m("marker", -80, 300, 640, 300), W, H);
  assert.deepEqual([c.x0, c.x1, c.y0, c.y1], [0, 640, 300, 300]);
});

test("an arrow drawn in from off the picture still points where it was aimed", () => {
  // Tail off the top-left corner, head at the middle: the direction is the mark.
  const c = clipMark(m("arrow", -500, -500, 500, 500), W, H);
  assert.deepEqual([c.x0, c.y0], [0, 0]);
  assert.deepEqual([c.x1, c.y1], [500, 500]);
  assert.equal((c.y1 - c.y0) / (c.x1 - c.x0), 1); // same slope it was drawn at
});

test("a line whose box overlaps but whose stroke misses is dropped", () => {
  // Crosses the top-left corner outside it: bounding box overlaps, line does not.
  assert.equal(clipMark(m("line", -100, 50, 50, -100), W, H), null);
});

test("a circle is never reshaped by the clip — only dropped when it misses", () => {
  const drawn = m("circle", -200, -200, 400, 400);
  const c = clipMark(drawn, W, H);
  assert.deepEqual({ ...c }, { ...drawn }); // the arc on screen must not move on release
  assert.equal(clipMark(m("circle", -900, -900, -100, -100), W, H), null);
});

test("a label is moved onto the picture, never dropped — it is the last copy of typed words", () => {
  const c = clipMark({ ...m("text", -60, 1400, -60, 1400), text: "here" }, W, H);
  assert.deepEqual([c.x0, c.y0, c.x1, c.y1], [0, 1000, 0, 1000]);
  assert.equal(c.text, "here");
});

test("a mark drawn wholly inside is returned untouched", () => {
  const drawn = m("rect", 100, 100, 300, 300);
  assert.deepEqual({ ...clipMark(drawn, W, H) }, { ...drawn });
});

test("clipSegment answers null for a segment parallel to an edge and outside it", () => {
  assert.equal(clipSegment({ x0: -5, y0: 0, x1: -5, y1: 900 }, W, H), null);
  assert.ok(clipSegment({ x0: 0, y0: -200, x1: 0, y1: 900 }, W, H));
});

test("touchesImage is about the bounding box, edges excluded", () => {
  assert.equal(touchesImage({ x0: -10, y0: -10, x1: 1, y1: 1 }, W, H), true);
  assert.equal(touchesImage({ x0: -10, y0: -10, x1: 0, y1: 0 }, W, H), false);
});
