// The annotator's toolbar layout (`annLayout.ts`): what a stored arrangement
// draws, and that no stored shape — old, new or hand-edited — hides a control
// this build has without the person having hidden it.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ANN_CONTROLS, DEFAULT_LAYOUT, autoPlace, isDefaultLayout, moveControl, readLayout, shownControls, toggleHidden,
} from "./annLayout.ts";

const ids = ANN_CONTROLS.map((c) => c.id);

test("nothing stored is the default layout", () => {
  for (const raw of [null, undefined, 3, "x", {}]) {
    const l = readLayout(raw);
    assert.deepEqual(l.order, ids);
    assert.deepEqual(l.hidden, []);
    assert.equal(l.place, "auto");
    assert.ok(isDefaultLayout(l));
  }
});

test("unknown and duplicate ids are dropped, a missing control comes back after its neighbour", () => {
  const l = readLayout({ order: ["crop", "nope", "undo", "crop", "circle"], hidden: ["gone", "blur", "blur"], place: "sideways" });
  assert.equal(l.order.length, ids.length);
  assert.deepEqual(new Set(l.order), new Set(ids));
  const at = (id) => l.order.indexOf(id);
  assert.ok(at("crop") < at("undo") && at("undo") < at("circle"));
  // `rect` follows `circle` by default, so it lands right after it; `move` after `crop`.
  assert.equal(at("rect"), at("circle") + 1);
  assert.equal(at("move"), at("crop") + 1);
  assert.deepEqual(l.hidden, ["blur"]);
  assert.equal(l.place, "auto");
});

test("hide, show and reorder", () => {
  let l = toggleHidden(DEFAULT_LAYOUT, "line");
  assert.ok(!shownControls(l).includes("line"));
  l = toggleHidden(l, "line");
  assert.ok(shownControls(l).includes("line"));
  l = moveControl(l, "rect", -1);
  assert.deepEqual(l.order.slice(1, 3), ["rect", "circle"]);
  assert.equal(moveControl(l, "undo", -1), l);
  assert.equal(moveControl(l, "clear", 1), l);
  assert.ok(!isDefaultLayout(l));
});

test("auto puts the bar where the picture is drawn larger", () => {
  const phone = { w: 390, h: 560 }; // the body between the head and the send bar
  // A wide collage on an upright phone is width-bound: a rail would shrink it.
  assert.equal(autoPlace(phone, { w: 1500, h: 580 }), "top");
  // A phone screenshot is height-bound there: a row would shrink it.
  assert.equal(autoPlace(phone, { w: 1008, h: 2244 }), "left");
  // Landscape box, tall picture: the rail costs nothing it needs.
  assert.equal(autoPlace({ w: 900, h: 400 }, { w: 1008, h: 2244 }), "left");
  // Landscape box, wide picture.
  assert.equal(autoPlace({ w: 900, h: 400 }, { w: 3000, h: 600 }), "top");
});

test("auto is undecided until both sizes are known", () => {
  assert.equal(autoPlace(null, { w: 10, h: 10 }), null);
  assert.equal(autoPlace({ w: 400, h: 800 }, null), null);
  assert.equal(autoPlace({ w: 0, h: 800 }, { w: 10, h: 10 }), null);
});
