// A two-finger pan in the annotator with one finger off the picture (R-images-018):
// the finger that landed first on a bar is adopted by the wrapper's touch, but
// never one whose up was missed — that phantom would make every later touch a pinch.
import test from "node:test";
import assert from "node:assert/strict";

import { adoptStrays } from "./annotator/annStray.ts";

const wrapWith = (live) => ({
  captured: [],
  setPointerCapture(id) {
    if (!live.has(id)) throw new Error("NotFoundError");
    this.captured.push(id);
  },
});

test("a finger resting on a bar joins the wrapper's touch, so two fingers are counted", () => {
  const wrap = wrapWith(new Set([1, 2]));
  const pointers = new Map([[2, { x: 50, y: 400 }]]);
  const strays = new Map([[1, { x: 60, y: 900 }]]);
  adoptStrays(wrap, pointers, strays);
  assert.equal(pointers.size, 2);
  assert.deepEqual(wrap.captured, [1]);
  assert.equal(strays.size, 0);
});

test("a stray whose up was missed is dropped, never counted as a finger", () => {
  const wrap = wrapWith(new Set([2]));
  const pointers = new Map([[2, { x: 50, y: 400 }]]);
  const strays = new Map([[7, { x: 60, y: 900 }]]);
  adoptStrays(wrap, pointers, strays);
  assert.deepEqual([...pointers.keys()], [2]);
  assert.equal(strays.size, 0);
});
