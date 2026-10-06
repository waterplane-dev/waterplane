// Knob mode (`annKnobs.ts`) — the opt-in alternative to relative drag: move,
// size and turn knobs hung off the selected mark on strings. Every rule here is
// about where a knob sits (on the picture, never on another knob) and what a
// drag on it does to the mark.
import test from "node:test";
import assert from "node:assert/strict";

import { applyKnob, knobAt, knobHint, knobPlaces, knobsFor, KNOB_R_PX, MIN_SPAN_PX } from "./annKnobs.ts";

const m = (tool, x0, y0, x1, y1) => ({ tool, x0, y0, x1, y1, color: "#ff2d2d" });
const box = (s) => ({
  x: Math.min(s.x0, s.x1), y: Math.min(s.y0, s.y1),
  w: Math.abs(s.x1 - s.x0), h: Math.abs(s.y1 - s.y0),
});
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("a mark gets only the knobs it can use", () => {
  assert.deepEqual(knobsFor("arrow"), ["move", "size", "turn"]);
  assert.deepEqual(knobsFor("line"), ["move", "size", "turn"]);
  assert.deepEqual(knobsFor("rect"), ["move", "size", "turn"]);
  assert.deepEqual(knobsFor("circle"), ["move", "size", "turn"]);
  assert.deepEqual(knobsFor("marker"), ["move", "size"]);
  assert.deepEqual(knobsFor("text"), ["move", "turn"]);
});

test("the move knob hangs below the mark, and above it when there is no room below", () => {
  const s = m("rect", 100, 100, 200, 150);
  const below = knobPlaces(s, box(s), 1, 1000, 1000).find((p) => p.knob === "move");
  assert.ok(below.y > 150);
  const low = m("rect", 100, 950, 200, 990);
  const above = knobPlaces(low, box(low), 1, 1000, 1000).find((p) => p.knob === "move");
  assert.ok(above.y < 950);
});

test("knobs keep their SCREEN size at any zoom", () => {
  const s = m("rect", 100, 100, 200, 150);
  const at1 = knobPlaces(s, box(s), 1, 1000, 1000).find((p) => p.knob === "move");
  const at2 = knobPlaces(s, box(s), 2, 1000, 1000).find((p) => p.knob === "move");
  // Twice the zoom, half the canvas distance from the mark.
  near((at1.y - 150) / 2, at2.y - 150);
});

test("a knob that would fall off the picture is pulled back onto it", () => {
  const s = m("rect", 900, 100, 995, 150);
  const size = knobPlaces(s, box(s), 1, 1000, 1000).find((p) => p.knob === "size");
  assert.ok(size.x <= 1000 - KNOB_R_PX);
});

test("no two knobs are left on top of each other", () => {
  // A short vertical arrow: head knob points down, right where the move knob hangs.
  const s = m("arrow", 500, 400, 500, 440);
  const places = knobPlaces(s, box(s), 1, 1000, 1000);
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      const d = Math.hypot(places[i].x - places[j].x, places[i].y - places[j].y);
      assert.ok(d >= KNOB_R_PX * 2.2 - 1e-6, `${places[i].knob}/${places[j].knob} overlap`);
    }
  }
});

test("a tap finds the nearest knob within reach, and nothing beyond it", () => {
  const places = [{ knob: "move", ax: 0, ay: 0, x: 100, y: 100 }, { knob: "size", ax: 0, ay: 0, x: 130, y: 100 }];
  assert.equal(knobAt(places, 125, 100, 1), "size");
  assert.equal(knobAt(places, 100, 160, 1), null);
});

test("the move knob carries the whole mark by the finger's movement", () => {
  const s = m("arrow", 10, 10, 50, 30);
  assert.deepEqual(applyKnob("move", s, { x: 0, y: 0 }, { x: 5, y: -3 }, 1), m("arrow", 15, 7, 55, 27));
});

test("size on a box moves the lower-right corner and holds the upper-left, whichever way it was drawn", () => {
  const s = m("rect", 200, 150, 100, 100); // drawn from the lower right
  const out = applyKnob("size", s, { x: 0, y: 0 }, { x: 20, y: 10 }, 1);
  assert.deepEqual([out.x0, out.y0, out.x1, out.y1], [100, 100, 220, 160]);
});

test("size never shrinks a box below a visible span", () => {
  const s = m("circle", 100, 100, 200, 200);
  const out = applyKnob("size", s, { x: 0, y: 0 }, { x: -500, y: -500 }, 1);
  assert.equal(out.x1 - out.x0, MIN_SPAN_PX);
  assert.equal(out.y1 - out.y0, MIN_SPAN_PX);
});

test("size on an arrow changes its length about the middle and keeps its direction", () => {
  const s = m("arrow", 100, 100, 200, 100);
  const out = applyKnob("size", s, { x: 0, y: 0 }, { x: 10, y: 50 }, 1); // only the along-line part counts
  assert.deepEqual([out.x0, out.y0, out.x1, out.y1], [90, 100, 210, 100]);
});

test("turn swings an arrow about its middle and keeps its length", () => {
  const s = m("arrow", 100, 100, 200, 100); // centre 150,100
  const out = applyKnob("turn", s, { x: 150, y: 50 }, { x: 200, y: 100 }, 1); // a quarter-turn clockwise
  near(out.x0, 150); near(out.y0, 50); near(out.x1, 150); near(out.y1, 150);
});

test("turn holds still when the finger is on top of the middle", () => {
  const s = m("line", 100, 100, 200, 100);
  assert.deepEqual(applyKnob("turn", s, { x: 150, y: 100 }, { x: 152, y: 99 }, 1), s);
});

test("every mark with an area can be turned; only the highlight band cannot", () => {
  for (const t of ["rect", "circle", "blur", "text", "arrow", "line"]) assert.ok(knobsFor(t).includes("turn"), t);
  assert.ok(!knobsFor("marker").includes("turn"));
});

test("turning a box keeps its points and gives it an angle about its middle", () => {
  const s = m("rect", 100, 100, 200, 160); // centre 150,130
  const out = applyKnob("turn", s, { x: 150, y: 60 }, { x: 220, y: 130 }, 1);
  assert.deepEqual([out.x0, out.y0, out.x1, out.y1], [100, 100, 200, 160]);
  near(out.angle, Math.PI / 2);
});

test("text turns about the middle it is given, not about its corner", () => {
  const s = m("text", 100, 100, 100, 100);
  const out = applyKnob("turn", s, { x: 150, y: 50 }, { x: 200, y: 100 }, 1, { x: 150, y: 100 });
  near(out.angle, Math.PI / 2);
});

test("sizing a turned box holds its opposite corner still on screen", () => {
  const a = Math.PI / 6;
  const s = { ...m("rect", 100, 100, 200, 160), angle: a };
  const heldBefore = corner(s, -1, -1);
  const out = applyKnob("size", s, { x: 0, y: 0 }, { x: 30, y: 20 }, 1);
  const heldAfter = corner(out, -1, -1);
  near(heldBefore.x, heldAfter.x); near(heldBefore.y, heldAfter.y);
  assert.ok(out.x1 - out.x0 > 100);
});

test("a turned box's turn knob rides round with it", () => {
  const s = { ...m("rect", 400, 400, 600, 500), angle: Math.PI }; // upside down
  const t = knobPlaces(s, box(s), 1, 1000, 1000).find((p) => p.knob === "turn");
  assert.ok(t.y > 500, "an upside-down box has its top underneath");
});

function corner(s, sx, sy) {
  const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
  const dx = sx * Math.abs(s.x1 - s.x0) / 2, dy = sy * Math.abs(s.y1 - s.y0) / 2;
  const a = s.angle ?? 0;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

test("the hint names exactly the knobs the mark wears", () => {
  assert.equal(knobHint("rect"), "Blue moves · orange sizes · green turns");
  assert.equal(knobHint("arrow"), "Blue moves · orange sets the length · green turns");
  assert.equal(knobHint("marker"), "Blue moves · orange sets the length");
  assert.equal(knobHint("text"), "Blue moves · green turns");
});
