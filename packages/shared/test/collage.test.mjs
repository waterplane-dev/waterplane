// How several pictures become one (`shared/src/collage.ts`). The rule under
// test is that the ARRANGEMENT is chosen by the shape that comes out: portrait
// screenshots go side by side, landscape ones stack, and nothing is decided by
// counting orientations. A 1:8 ribbon of stacked phone shots is unmarkable on
// the device this feature exists for, which is the failure these pin.
import test from "node:test";
import assert from "node:assert/strict";
import { collageLabel, collagePanelNote, defaultGap, layoutCollage, pickCols } from "../dist/index.js";

const PHONE = { w: 1170, h: 2532 };   // portrait screenshot, 0.46:1
const DESKTOP = { w: 2560, h: 1440 }; // landscape capture, 1.78:1
const rep = (n, s) => Array.from({ length: n }, () => ({ ...s }));

test("two portrait screenshots go side by side, never stacked", () => {
  assert.equal(pickCols(rep(2, PHONE)), 2);
});

test("two landscape captures stack, for the same reason in the other direction", () => {
  assert.equal(pickCols(rep(2, DESKTOP)), 1);
});

test("three portrait screenshots stay one row — a sequence reads left to right", () => {
  assert.equal(pickCols(rep(3, PHONE)), 3);
});

test("four portrait screenshots stay one row — a 2x2 of tall panels is still tall", () => {
  // An n x m grid of identical panels has the panel's own aspect times n/m, so
  // 2 x 2 of phone screenshots is exactly as unreadable as one screenshot
  // (0.46:1). Only widening the row moves the shape at all.
  assert.equal(pickCols(rep(4, PHONE)), 4);
});

test("five portrait screenshots wrap rather than growing a fifth column", () => {
  assert.equal(pickCols(rep(5, PHONE)), 4);
});

test("four landscape captures make a 2x2 too", () => {
  assert.equal(pickCols(rep(4, DESKTOP)), 2);
});

test("the chosen arrangement is the one nearest the target aspect", () => {
  const sizes = rep(4, PHONE);
  const cols = pickCols(sizes, 0);
  const score = (c) => {
    const l = layoutCollage(sizes, { cols: c, gap: 0, maxSide: 1e9, maxPixels: 1e18 });
    return Math.abs(Math.log(l.width / l.height / 1.25));
  };
  for (let c = 1; c <= sizes.length; c++) if (c !== cols) assert.ok(score(cols) <= score(c) + 1e-9);
});

test("a row normalizes on height, so mixed sizes share a baseline", () => {
  const l = layoutCollage([{ w: 1000, h: 500 }, { w: 400, h: 400 }], { cols: 2, gap: 0 });
  const [a, b] = l.cells;
  assert.equal(a.h, b.h);
  assert.equal(a.y, b.y);
  // The narrow one is scaled up to the row height, keeping its aspect.
  assert.ok(Math.abs(b.w / b.h - 1) < 0.02);
});

test("panels never overlap and never leave the canvas", () => {
  const l = layoutCollage([PHONE, DESKTOP, { w: 800, h: 600 }, { w: 300, h: 900 }, PHONE], { gap: 12 });
  for (const c of l.cells) {
    assert.ok(c.x >= 0 && c.y >= 0);
    assert.ok(c.x + c.w <= l.width, `${c.x + c.w} <= ${l.width}`);
    assert.ok(c.y + c.h <= l.height, `${c.y + c.h} <= ${l.height}`);
  }
  for (let i = 0; i < l.cells.length; i++) {
    for (let j = i + 1; j < l.cells.length; j++) {
      const a = l.cells[i], b = l.cells[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `cells ${i} and ${j} overlap`);
    }
  }
});

test("every input gets exactly one panel, in pick order", () => {
  const l = layoutCollage(rep(5, PHONE), { cols: 2 });
  assert.deepEqual(l.cells.map((c) => c.i), [0, 1, 2, 3, 4]);
  assert.equal(l.rows, 3);
});

test("a short last row is centered, not left-aligned", () => {
  const l = layoutCollage(rep(3, PHONE), { cols: 2, gap: 0 });
  const last = l.cells[2];
  assert.ok(Math.abs((last.x + last.w / 2) - l.width / 2) <= 1);
});

test("the canvas is capped, and the cap scales the whole layout together", () => {
  const l = layoutCollage(rep(4, { w: 4000, h: 4000 }), { cols: 2, gap: 40, maxSide: 2048 });
  assert.ok(Math.max(l.width, l.height) <= 2048);
  assert.ok(l.scale < 1);
  // Ratio between panels survives the cap: all four are the same size.
  const ws = new Set(l.cells.map((c) => c.w));
  assert.equal(ws.size, 1);
});

test("a pixel cap applies even when neither side is over the side cap", () => {
  const l = layoutCollage(rep(4, { w: 3000, h: 3000 }), { cols: 2, gap: 0, maxSide: 1e9, maxPixels: 4e6 });
  assert.ok(l.width * l.height <= 4.2e6);
});

test("maxWidth caps the width without flattening a tall stack to it", () => {
  const l = layoutCollage(rep(3, PHONE), { cols: 1, gap: 0, maxWidth: 1080, maxSide: 1e9 });
  assert.equal(l.width, 1080);
  // The upload rule caps width only, so the rows it keeps are all of them.
  assert.ok(l.height > 1080 * 3);
});

test("cols is clamped to what there is, and a bad one never throws", () => {
  assert.equal(layoutCollage(rep(2, PHONE), { cols: 9 }).cols, 2);
  assert.equal(layoutCollage(rep(2, PHONE), { cols: 0 }).cols, 1);
});

test("a zero-sized decode is survived rather than dividing by it", () => {
  const l = layoutCollage([{ w: 0, h: 0 }, PHONE], { cols: 2 });
  assert.ok(Number.isFinite(l.width) && l.width > 0);
  assert.ok(l.cells.every((c) => c.w > 0 && c.h > 0));
});

test("one image is a no-op layout: no gap, no scaling, its own size", () => {
  const l = layoutCollage([PHONE]);
  assert.equal(l.cols, 1);
  assert.equal(l.gap, 0);
  assert.equal(l.width, PHONE.w);
  assert.equal(l.height, PHONE.h);
});

test("the gap follows the source resolution instead of being fixed", () => {
  assert.ok(defaultGap(rep(2, { w: 400, h: 400 })) < defaultGap(rep(2, { w: 4000, h: 4000 })));
  assert.equal(defaultGap([PHONE]), 0);
});

test("layouts are named the way the picker shows them", () => {
  assert.equal(collageLabel(2, 2), "2 across");
  assert.equal(collageLabel(2, 1), "stacked");
  assert.equal(collageLabel(4, 2), "2 × 2");
  assert.equal(collageLabel(5, 2), "2 × 3");
});

// ── What the combined image says about itself ────────────────────────────────
//
// The panel numbers exist as PIXELS and nowhere else, so the order they run in
// is something the reader has to infer from a picture — and with the labels off
// there is no badge to infer it from at all. The clause below is the only place
// the arrangement is stated in words.

test("a row says it is a row, and that the numbers on it are real", () => {
  assert.equal(collagePanelNote(3, 3, true), "collage of 3 panels in one row, left to right, numbered 1-3 in that order");
});

test("a stack says top to bottom — the same sequence, read the other way", () => {
  assert.match(collagePanelNote(3, 1, true), /^collage of 3 panels stacked top to bottom/);
});

test("a grid says how wide a row is, so panel 3 is findable without counting", () => {
  assert.match(collagePanelNote(4, 2, true), /2 per row, left to right then down/);
});

test("labels off says NOT numbered — an order implied by pixels is not a numbering", () => {
  assert.match(collagePanelNote(4, 2, false), /not numbered$/);
});

test("one image is not a collage and says nothing", () => {
  assert.equal(collagePanelNote(1, 1, true), "");
});
