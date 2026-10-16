/**
 * Where a tap lands on the desktop: fit width, pinch zoom about the fingers, pan clamped to the
 * source, the visible rect "Crop to view" streams, and the one mapping from a phone point to a
 * normalised source coordinate — which a crop arriving late must never move.
 *
 *     node --test packages/extensions/desktop/web/view.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FULL, aspectOf, clampView, fitWidth, keepInView, minZoom, onSource, panBy, regionOnFrame, regionOnStatus, regionRect, regionStart, sameCrop, screenToSource,
  sourceToScreen, visibleRect, zoomAt,
  centreOn, isPanButton, overviewDrag, overviewGrab, overviewPoint, overviewRect, overviewSize, OVERVIEW_MAX,
} from "./view.ts";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);
const nearPt = (a, b, e = 1e-6) => { near(a.x, b.x, e); near(a.y, b.y, e); };

// A 390×700 phone box, a 16:10 desktop (2560×1600).
const box = { w: 390, h: 700 };
const A = 1600 / 2560;

test("fit width: the source spans the box's width, centred top-to-bottom when shorter", () => {
  const v = fitWidth(box, A);
  assert.equal(v.zoom, 1);
  near(v.ox, 0);
  // 390 px wide ⇒ 243.75 px tall, centred in 700: the top letterbox is (700-243.75)/2.
  near(-v.oy * 390, (700 - 243.75) / 2);
  nearPt(screenToSource(box, A, v, { x: 0, y: (700 - 243.75) / 2 }), { x: 0, y: 0 });
  nearPt(screenToSource(box, A, v, { x: 195, y: 350 }), { x: 0.5, y: 0.5 });
  assert.equal(onSource(box, A, v, { x: 10, y: 10 }), false);
  assert.equal(visibleRect(box, A, v), null);
});

test("pinch zoom keeps the point under the fingers where it was", () => {
  const v0 = fitWidth(box, A);
  const at = { x: 120, y: 300 }; // on the source, and far enough in that no edge clamps a 6× zoom
  const before = screenToSource(box, A, v0, at);
  const v1 = zoomAt(box, A, v0, 6, at);
  assert.equal(v1.zoom, 6);
  nearPt(screenToSource(box, A, v1, at), before);
  // and sourceToScreen is its inverse
  nearPt(sourceToScreen(box, A, v1, before), at);
});

test("a pinch that also moves carries the content with the fingers", () => {
  const v0 = zoomAt(box, A, fitWidth(box, A), 4, { x: 195, y: 350 });
  const at = { x: 195, y: 350 };
  const under = screenToSource(box, A, v0, at);
  const v1 = zoomAt(box, A, v0, 1, at, { x: -40, y: 20 });
  nearPt(screenToSource(box, A, v1, { x: 155, y: 370 }), under);
});

test("zoom is clamped: never past 8×, never smaller than the whole source fitting", () => {
  const v = zoomAt(box, A, fitWidth(box, A), 100, { x: 0, y: 0 });
  assert.equal(v.zoom, 8);
  const tall = { w: 800, h: 300 }; // a phone held sideways: the whole source fits only below fit-width
  const mz = minZoom(tall, A);
  near(mz, 300 / (A * 800));
  assert.equal(zoomAt(tall, A, fitWidth(tall, A), 0.01, { x: 0, y: 0 }).zoom, mz);
});

test("pan never shows past the source's edge", () => {
  const v = zoomAt(box, A, fitWidth(box, A), 4, { x: 0, y: 0 });
  const left = panBy(box, A, v, { x: 10_000, y: 0 });
  near(left.ox, 0);
  const right = panBy(box, A, v, { x: -10_000, y: 0 });
  near(right.ox, 1 - 390 / (390 * 4));
  const down = panBy(box, A, v, { x: 0, y: -10_000 });
  near(down.oy, A - 700 / (390 * 4));
  assert.deepEqual(clampView(box, A, down), down);
});

test("the visible rect is what Crop to view streams; the whole source is no crop", () => {
  const v = zoomAt(box, A, fitWidth(box, A), 4, { x: 0, y: 0 });
  const r = visibleRect(box, A, v);
  near(r.x, 0, 1e-3); near(r.w, 0.25, 1e-3);
  near(r.y, 0, 1e-3); near(r.h, (700 / (390 * 4)) / A, 1e-3);
  assert.equal(visibleRect(box, A, fitWidth(box, A)), null);
  assert.equal(sameCrop(r, { ...r, x: r.x + 0.001 }), true);
  assert.equal(sameCrop(r, { ...r, x: r.x + 0.01 }), false);
  assert.equal(sameCrop(null, undefined), true);
  assert.equal(sameCrop(r, null), false);
});

test("a cropped picture is drawn exactly over its region, so a tap on it maps to the right source pixel", () => {
  const v = zoomAt(box, A, fitWidth(box, A), 4, { x: 195, y: 350 });
  const crop = visibleRect(box, A, v);
  const rect = regionRect(box, A, v, crop);
  // A 1170-px-wide picture of that crop: picture pixel (px, py) is source (crop.x + px/W·crop.w, …).
  const W = 1170, H = Math.round(W * (crop.h * A) / crop.w);
  const px = 300, py = 200;
  const screen = { x: rect.left + (px / W) * rect.width, y: rect.top + (py / H) * rect.height };
  nearPt(screenToSource(box, A, v, screen), { x: crop.x + (px / W) * crop.w, y: crop.y + (py / H) * crop.h }, 1e-3);
  // The full picture before the crop arrived maps the same screen point to the same source point:
  const full = regionRect(box, A, v, FULL);
  const fx = (screen.x - full.left) / full.width, fy = (screen.y - full.top) / full.height;
  nearPt(screenToSource(box, A, v, screen), { x: fx, y: fy }, 1e-6);
});

test("keepInView drags a zoomed view along when the trackpad cursor walks off its edge", () => {
  const v = zoomAt(box, A, fitWidth(box, A), 4, { x: 0, y: 0 });
  const p = { x: 500, y: 100 }; // past the right edge
  const v2 = keepInView(box, A, v, p);
  assert.ok(v2.ox > v.ox);
  assert.equal(keepInView(box, A, v, { x: 200, y: 200 }), v);
});

test("the aspect comes from the host's source size, else from the picture and its region, else 16:9", () => {
  near(aspectOf({ srcWidth: 2560, srcHeight: 1600 }, null, FULL), 0.625);
  near(aspectOf(null, { w: 1000, h: 500 }, { x: 0, y: 0, w: 0.5, h: 0.4 }), (500 / 0.4) / (1000 / 0.5));
  near(aspectOf(null, null, FULL), 9 / 16);
});

// ── which region the arriving frames cover ──────────────────────────────────

const B = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
const C = { x: 0, y: 0.5, w: 1, h: 0.25 };

test("region: a key moves the arriving region only to what a status named, never to what was asked for", () => {
  let t = regionStart(null);
  assert.equal(t.arriving, FULL);
  // The phone asks for B and for a key. A key the core asked for earlier (or the encoder made on its
  // own) arrives BEFORE the helper has applied the config: no status has named B, so it stays FULL.
  t = regionOnFrame(t, true);
  assert.equal(t.arriving, FULL, "a key with nothing named is still the old region");
  // The helper announces B immediately before B's first frame.
  t = regionOnStatus(t, B);
  assert.equal(t.arriving, FULL, "naming is not arriving: P-frames in between are still the old region");
  t = regionOnFrame(t, false);
  assert.equal(t.arriving, FULL);
  t = regionOnFrame(t, true);
  assert.equal(t.arriving, B, "the key after the name is the first picture of B");
  t = regionOnFrame(t, true);
  assert.equal(t.arriving, B);
});

test("region: a status that names the arriving region (a bitrate change, the stats tick) waits for nothing", () => {
  const t0 = regionStart(B);
  const same = regionOnStatus(t0, { ...B });
  assert.equal(same, t0, "same region: the very same track, so the player's tag keeps its identity");
  assert.equal(regionOnStatus(t0, undefined), t0, "no region in the status: nothing changes");
  assert.equal(regionOnStatus(t0, null), t0);
  // Named, then named back to the arriving one before any key: nothing is left waiting.
  const named = regionOnStatus(t0, C);
  assert.equal(named.named, C);
  const back = regionOnStatus(named, B);
  assert.deepEqual([back.arriving, back.named], [B, null]);
  assert.equal(regionOnFrame(back, true).arriving, B);
});

test("region: crops in a row follow the names in order", () => {
  let t = regionStart(null);
  const seen = [];
  for (const [name, key] of [[B, false], [null, true], [C, false], [null, false], [null, true], [FULL, false], [null, true]]) {
    if (name) t = regionOnStatus(t, name); else t = regionOnFrame(t, key);
    seen.push(t.arriving);
  }
  assert.deepEqual(seen, [FULL, B, B, B, C, C, FULL]);
});

// ── the overview and the mouse's pan ──────────────────────────────────────────

test("the overview is the source's shape, small, and absent where there is no room", () => {
  const m = overviewSize(box, A);
  assert.ok(m.w <= OVERVIEW_MAX && m.w <= 390 * 0.32 + 0.5, "never more than a third of the width");
  near(m.h / m.w, A, 0.02);
  const wide = overviewSize({ w: 1600, h: 900 }, A);
  assert.equal(wide.w, OVERVIEW_MAX);
  // A tall source in a short box: the height is the limit, the width follows.
  const tall = overviewSize({ w: 1600, h: 300 }, 2);
  assert.ok(tall.h <= 300 * 0.32 + 0.5);
  near(tall.h / tall.w, 2, 0.05);
  assert.equal(overviewSize({ w: 100, h: 60 }, A), null);
  assert.equal(overviewSize({ w: 0, h: 700 }, A), null);
});

test("the overview's rectangle is what is on screen, and all of it at fit", () => {
  const map = { w: 160, h: 100 };
  const fit = overviewRect(box, A, fitWidth(box, A), map);
  near(fit.left, 0); near(fit.top, 0); near(fit.width, 160); near(fit.height, 100);
  const v = clampView(box, A, { zoom: 4, ox: 0.5, oy: 0.2 });
  const r = overviewRect(box, A, v, map);
  const vis = visibleRect(box, A, v);
  near(r.left / 160, vis.x, 1e-3); near(r.top / 100, vis.y, 1e-3);
  near(r.width / 160, vis.w, 1e-3); near(r.height / 100, vis.h, 1e-3);
});

test("a press outside the rectangle centres the view there; inside it grabs without a jump", () => {
  const map = { w: 160, h: 100 };
  const v = clampView(box, A, { zoom: 4, ox: 0, oy: 0 });
  const at = overviewPoint(map, { x: 80, y: 50 });
  nearPt(at, { x: 0.5, y: 0.5 });
  const g = overviewGrab(box, A, v, at, map);
  nearPt(g, { x: 0, y: 0 }, 1e-9);
  const moved = overviewDrag(box, A, v, at, g);
  const r = overviewRect(box, A, moved, map);
  near(r.left + r.width / 2, 80, 1e-6); near(r.top + r.height / 2, 50, 1e-6);
  // Grab the moved rectangle near its top-left corner and drag by 10 map px: it moves by 10, no jump.
  const press = overviewPoint(map, { x: r.left + 2, y: r.top + 2 });
  const grab = overviewGrab(box, A, moved, press, map);
  assert.ok(grab.x < 0 && grab.y < 0, "held off-centre");
  const still = overviewDrag(box, A, moved, press, grab);
  near(still.ox, moved.ox, 1e-9); near(still.oy, moved.oy, 1e-9);
  const after = overviewRect(box, A, overviewDrag(box, A, moved, overviewPoint(map, { x: r.left + 12, y: r.top + 2 }), grab), map);
  near(after.left, r.left + 10, 1e-6); near(after.top, r.top, 1e-6);
});

test("centring is clamped: the view never shows past the source's edge", () => {
  const v = clampView(box, A, { zoom: 4, ox: 0.3, oy: 0.1 });
  const c = centreOn(box, A, v, { x: 0, y: 0 });
  near(c.ox, 0); near(c.oy, 0); near(c.zoom, v.zoom);
  const e = centreOn(box, A, v, { x: 1, y: 1 });
  const s = 390 * e.zoom;
  near(e.ox + 390 / s, 1); near(e.oy + 700 / s, A);
});

test("only the mouse's middle button pans", () => {
  assert.equal(isPanButton({ pointerType: "mouse", button: 1 }), true);
  assert.equal(isPanButton({ pointerType: "mouse", button: 0 }), false);
  assert.equal(isPanButton({ pointerType: "mouse", button: 2 }), false);
  assert.equal(isPanButton({ pointerType: "touch", button: 1 }), false);
  assert.equal(isPanButton({ pointerType: "pen", button: 1 }), false);
});
