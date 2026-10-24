// Which marks the phone's text-in-marks reader is asked about, and the crop it is handed
// (`annReadPlan.ts`, R-images-015). Typed words always win; no reader means nothing runs.
import test from "node:test";
import assert from "node:assert/strict";

import { cleanRead, planReads, readCropRect, readKey, readScale, READ_MAX_SIDE } from "./annReadPlan.ts";

const mk = (id, tool, x0, y0, x1, y1, extra = {}) => ({ id, tool, x0, y0, x1, y1, ...extra });

test("a finished highlight, box or circle is read; an arrow, line, label or blur never", () => {
  const marks = [mk(1, "marker", 0, 0, 100, 10), mk(2, "rect", 0, 0, 50, 50), mk(3, "circle", 0, 0, 50, 50),
    mk(4, "arrow", 0, 0, 50, 50), mk(5, "line", 0, 0, 50, 50), mk(6, "text", 0, 0, 0, 0), mk(7, "blur", 0, 0, 50, 50)];
  assert.deepEqual(planReads(marks, new Map(), true).start.map((m) => m.id), [1, 2, 3]);
});

test("no reader: nothing starts, and every read still out is called off", () => {
  const m = mk(1, "rect", 0, 0, 50, 50);
  assert.deepEqual(planReads([m], new Map([[1, readKey(m)]]), false), { start: [], abort: [1] });
});

test("words the person typed are never read over — and a read out for them is called off", () => {
  const m = mk(1, "rect", 0, 0, 50, 50, { readBy: "hand" });
  assert.deepEqual(planReads([m], new Map([[1, "old"]]), true), { start: [], abort: [1] });
  assert.deepEqual(planReads([m], new Map(), true).start, []);
});

test("same geometry is read once; a move or resize re-reads; a deleted mark's read is aborted", () => {
  const m = mk(1, "circle", 0, 0, 50, 50, { readBy: "phone" });
  assert.deepEqual(planReads([m], new Map([[1, readKey(m)]]), true), { start: [], abort: [] });
  const moved = { ...m, x0: 10, x1: 60 };
  assert.deepEqual(planReads([moved], new Map([[1, readKey(m)]]), true).start.map((x) => x.id), [1]);
  assert.deepEqual(planReads([], new Map([[1, readKey(m)]]), true).abort, [1]);
});

test("the crop is the mark's box, padded, clamped on both edges; a thin highlight is as tall as its ink", () => {
  const r = readCropRect(mk(1, "rect", -20, 10, 200, 100), 150, 1000, 20);
  assert.equal(r.x, 0);
  assert.equal(r.x + r.w, 150);
  assert.ok(r.y < 10 && r.y + r.h > 100);
  const band = readCropRect(mk(2, "marker", 100, 500, 400, 500), 1000, 1000, 40);
  assert.ok(band.h >= 40, `band crop ${band.h} px tall`);
  assert.equal(readCropRect(mk(3, "rect", 2000, 2000, 2100, 2100), 1000, 1000, 20), null);
});

test("a turned box is read over its upright bounds, not the unturned box", () => {
  const flat = readCropRect(mk(1, "rect", 100, 100, 300, 120), 1000, 1000, 0);
  const turned = readCropRect(mk(1, "rect", 100, 100, 300, 120, { angle: Math.PI / 2 }), 1000, 1000, 0);
  assert.ok(turned.h > flat.h * 3);
});

test("small text is enlarged (≥2× up to 1000 px), a large crop shrinks to the cap", () => {
  assert.equal(readScale(100, 20), 4);
  assert.ok(readScale(1000, 300) >= 2);
  assert.equal(Math.round(4000 * readScale(4000, 1000)), READ_MAX_SIDE);
});

test("a reader's answer: whitespace flattened, nothing is absent — never an empty quote", () => {
  assert.equal(cleanRead("  Save\n  changes "), "Save changes");
  assert.equal(cleanRead("   "), null);
  assert.equal(cleanRead(null), null);
});
