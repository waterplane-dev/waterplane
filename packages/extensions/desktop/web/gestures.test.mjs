/**
 * Fingers → desktop input, as a state machine fed with numbers: Touch (tap, double tap, long press,
 * drag, two-finger scroll), Trackpad (relative cursor with acceleration, tap at the cursor,
 * two-finger tap = right click, double-tap-and-drag), View only (pans, sends nothing), a pinch that
 * is never input, and the per-frame coalescing of what goes upstream.
 *
 *     node --test packages/extensions/desktop/web/gestures.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOUBLE_MS, LONG_MS, PINCH_SLOP, accel, createCoalescer, createGestures } from "./gestures.ts";

// A mapper over a 400×400 box showing the whole source: point (x, y) ⇒ (x/400, y/400); one phone
// px is 2 source px.
const map = { toSource: (p) => ({ x: p.x / 400, y: p.y / 400 }), unitsPerPx: () => ({ x: 1 / 400, y: 1 / 400 }), srcPxPerPx: () => 2 };
const ev = (out) => out.filter((o) => o.t === "input").map((o) => o.ev);
const kinds = (out) => out.map((o) => (o.t === "input" ? o.ev.k : o.t));
const P = (id, x, y, t) => ({ id, x, y, t });

test("Touch: a tap clicks where the finger is", () => {
  const g = createGestures(map, { mode: "touch" });
  assert.deepEqual(g.down(P(1, 100, 200, 0)), []);
  assert.deepEqual(ev(g.up(P(1, 102, 201, 80))), [{ k: "click", b: "l", x: 0.25, y: 0.5, n: 1 }]);
});

test("Touch: a second tap close by and soon is a double click; far away or late is a single", () => {
  const g = createGestures(map, { mode: "touch" });
  g.down(P(1, 100, 100, 0)); g.up(P(1, 100, 100, 50));
  g.down(P(1, 104, 100, 150));
  assert.equal(ev(g.up(P(1, 104, 100, 200)))[0].n, 2);
  g.down(P(1, 300, 300, 260));
  assert.equal(ev(g.up(P(1, 300, 300, 300)))[0].n, 1); // far
  g.down(P(1, 300, 300, 300 + DOUBLE_MS + 100));
  assert.equal(ev(g.up(P(1, 300, 300, 300 + DOUBLE_MS + 150)))[0].n, 1); // late
});

test("Touch: held 500 ms without moving is a right click at the finger, and the lift sends nothing", () => {
  const g = createGestures(map, { mode: "touch" });
  g.down(P(1, 200, 200, 1000));
  assert.equal(g.nextTick(), 1000 + LONG_MS);
  assert.deepEqual(g.tick(1000 + LONG_MS - 1), []);
  assert.deepEqual(ev(g.tick(1000 + LONG_MS)), [{ k: "click", b: "r", x: 0.5, y: 0.5, n: 1 }]);
  assert.deepEqual(g.move(P(1, 260, 200, 1600)), []);
  assert.deepEqual(g.up(P(1, 260, 200, 1700)), []);
});

test("Touch: a one-finger drag is a mouse drag — down at the start, moves, up where it ends", () => {
  const g = createGestures(map, { mode: "touch" });
  g.down(P(1, 100, 100, 0));
  assert.deepEqual(g.move(P(1, 104, 100, 10)), []); // inside the slop: still maybe a tap
  assert.deepEqual(ev(g.move(P(1, 120, 100, 20))), [{ k: "down", b: "l", x: 0.25, y: 0.25 }, { k: "move", x: 0.3, y: 0.25 }]);
  assert.deepEqual(ev(g.move(P(1, 200, 120, 30))), [{ k: "move", x: 0.5, y: 0.3 }]);
  assert.equal(g.nextTick(), null); // a drag never becomes a long press
  assert.deepEqual(ev(g.up(P(1, 200, 120, 40))), [{ k: "up", b: "l", x: 0.5, y: 0.3 }]);
});

test("Touch: a two-finger drag scrolls at the fingers, content following them (source px)", () => {
  const g = createGestures(map, { mode: "touch" });
  g.down(P(1, 100, 200, 0)); g.down(P(2, 200, 200, 5));
  assert.deepEqual(g.move(P(1, 100, 204, 10)), []); // centroid moved 2px: under the slop
  const out = [...g.move(P(1, 100, 240, 20)), ...g.move(P(2, 200, 240, 21))];
  const s = ev(out);
  assert.ok(s.every((e) => e.k === "scroll"));
  assert.equal(s.reduce((a, e) => a + e.dy, 0), 80); // centroid 40 phone px down ⇒ 80 source px
  assert.deepEqual(ev(g.up(P(1, 100, 240, 30))), []);
  assert.deepEqual(g.move(P(2, 200, 300, 40)), []); // the last finger is spent, not a new drag
  assert.deepEqual(g.up(P(2, 200, 300, 50)), []);
});

test("a two-finger scroll before the desktop's width is known is dropped, never sized by a guess", () => {
  let k = null;
  const g = createGestures({ ...map, srcPxPerPx: () => k }, { mode: "touch" });
  g.down(P(1, 100, 200, 0)); g.down(P(2, 200, 200, 5));
  const before = [...g.move(P(1, 100, 240, 20)), ...g.move(P(2, 200, 240, 21))];
  assert.deepEqual(ev(before), [], "no scroll event at all");
  k = 2;
  const after = [...g.move(P(1, 100, 250, 30)), ...g.move(P(2, 200, 250, 31))];
  assert.equal(ev(after).reduce((a, e) => a + e.dy, 0), 20, "once known, only the movement since then: 10 phone px ⇒ 20 source px");
});

test("a pinch zooms about the fingers and is never input, in every mode", () => {
  for (const mode of ["touch", "trackpad", "view"]) {
    const g = createGestures(map, { mode });
    g.down(P(1, 150, 200, 0)); g.down(P(2, 250, 200, 0));
    const out = [...g.move(P(1, 150 - PINCH_SLOP, 200, 10)), ...g.move(P(2, 250 + PINCH_SLOP, 200, 11))];
    assert.deepEqual(ev(out), [], mode);
    const zooms = out.filter((o) => o.t === "zoom");
    assert.ok(zooms.length >= 1, mode);
    const total = zooms.reduce((a, z) => a * z.factor, 1);
    assert.ok(Math.abs(total - (100 + 2 * PINCH_SLOP) / 100) < 1e-9, `${mode}: ${total}`);
    assert.deepEqual(ev([...g.up(P(1, 0, 0, 20)), ...g.up(P(2, 0, 0, 21))]), [], mode);
  }
});

test("a second finger landing mid-drag releases the button first", () => {
  const g = createGestures(map, { mode: "touch" });
  g.down(P(1, 100, 100, 0)); g.move(P(1, 140, 100, 10));
  assert.deepEqual(ev(g.down(P(2, 300, 300, 20))), [{ k: "up", b: "l", x: 0.35, y: 0.25 }]);
});

test("Trackpad: one finger moves the cursor relatively; a tap clicks at the cursor, not the finger", () => {
  const g = createGestures(map, { mode: "trackpad", cursor: { x: 0.5, y: 0.5 } });
  g.down(P(1, 10, 10, 0));
  const out = g.move(P(1, 30, 10, 400)); // 20 px in 400 ms: slow ⇒ 1:1
  assert.deepEqual(kinds(out), ["cursor", "move"]);
  assert.deepEqual(g.cursor(), { x: 0.55, y: 0.5 });
  g.up(P(1, 30, 10, 410));
  g.down(P(1, 380, 380, 2000));
  assert.deepEqual(ev(g.up(P(1, 380, 380, 2050))), [{ k: "click", b: "l", x: 0.55, y: 0.5, n: 1 }]);
});

test("Trackpad: a fast flick moves the cursor further than a slow one (acceleration)", () => {
  assert.equal(accel(0.1), 1);
  assert.ok(accel(1) > 2);
  assert.ok(accel(100) <= 4);
  const slow = createGestures(map, { mode: "trackpad", cursor: { x: 0, y: 0 } });
  slow.down(P(1, 0, 0, 0)); slow.move(P(1, 40, 0, 400));
  const fast = createGestures(map, { mode: "trackpad", cursor: { x: 0, y: 0 } });
  fast.down(P(1, 0, 0, 0)); fast.move(P(1, 40, 0, 20));
  assert.ok(fast.cursor().x > slow.cursor().x * 2, `${fast.cursor().x} vs ${slow.cursor().x}`);
  // and the cursor never leaves the source
  const g = createGestures(map, { mode: "trackpad", cursor: { x: 0.99, y: 0.5 } });
  g.down(P(1, 0, 0, 0)); g.move(P(1, 300, 0, 10));
  assert.equal(g.cursor().x, 1);
});

test("Trackpad: a two-finger tap right-clicks at the cursor; a two-finger drag scrolls there", () => {
  const g = createGestures(map, { mode: "trackpad", cursor: { x: 0.2, y: 0.3 } });
  g.down(P(1, 100, 100, 0)); g.down(P(2, 150, 100, 10));
  assert.deepEqual(ev(g.up(P(1, 100, 100, 120))), [{ k: "click", b: "r", x: 0.2, y: 0.3, n: 1 }]);
  g.up(P(2, 150, 100, 130));
  g.down(P(1, 100, 100, 1000)); g.down(P(2, 150, 100, 1000));
  const s = ev([...g.move(P(1, 100, 60, 1010)), ...g.move(P(2, 150, 60, 1011))]);
  assert.ok(s.length >= 1 && s.every((e) => e.k === "scroll" && e.x === 0.2 && e.y === 0.3));
  assert.equal(s.reduce((a, e) => a + e.dy, 0), -80);
  // a slow two-finger hold is not a tap
  const h = createGestures(map, { mode: "trackpad" });
  h.down(P(1, 100, 100, 0)); h.down(P(2, 150, 100, 0));
  assert.deepEqual(ev(h.up(P(1, 100, 100, 900))), []);
});

test("Trackpad: double-tap-and-drag holds the button through the drag", () => {
  const g = createGestures(map, { mode: "trackpad", cursor: { x: 0.5, y: 0.5 } });
  g.down(P(1, 100, 100, 0));
  assert.equal(ev(g.up(P(1, 100, 100, 60)))[0].k, "click");
  g.down(P(1, 100, 100, 150));
  const out = g.move(P(1, 140, 100, 550));
  assert.deepEqual(ev(out)[0], { k: "down", b: "l", x: 0.5, y: 0.5 });
  assert.equal(ev(out)[1].k, "move");
  assert.deepEqual(ev(g.up(P(1, 140, 100, 600))), [{ k: "up", b: "l", ...g.cursor() }]);
  // …while a second TAP in time is a double click, not a drag
  g.down(P(1, 0, 0, 2000)); g.up(P(1, 0, 0, 2040));
  g.down(P(1, 0, 0, 2100));
  assert.equal(ev(g.up(P(1, 0, 0, 2140)))[0].n, 2);
});

test("Trackpad: no long press (a resting finger is not a right click)", () => {
  const g = createGestures(map, { mode: "trackpad" });
  g.down(P(1, 0, 0, 0));
  assert.equal(g.nextTick(), null);
  assert.deepEqual(g.tick(5000), []);
});

test("View only: one finger pans, two fingers pan or zoom, nothing is ever input", () => {
  const g = createGestures(map, { mode: "view" });
  g.down(P(1, 100, 100, 0));
  assert.deepEqual(g.move(P(1, 140, 120, 10)), [{ t: "pan", d: { x: 40, y: 20 } }]);
  assert.deepEqual(g.move(P(1, 150, 120, 20)), [{ t: "pan", d: { x: 10, y: 0 } }]);
  assert.deepEqual(g.up(P(1, 150, 120, 30)), []);
  g.down(P(1, 100, 100, 100)); // a tap
  assert.deepEqual(g.up(P(1, 100, 100, 130)), []);
  assert.deepEqual(g.tick(10_000), []);
  g.down(P(1, 100, 100, 200)); g.down(P(2, 200, 100, 200));
  const out = [...g.move(P(1, 100, 130, 210)), ...g.move(P(2, 200, 130, 211))];
  assert.deepEqual(ev(out), []);
  assert.ok(out.every((o) => o.t === "pan"));
});

test("a cancelled pointer releases a drag and never clicks", () => {
  const g = createGestures(map, { mode: "touch" });
  g.down(P(1, 100, 100, 0));
  assert.deepEqual(g.cancel(P(1, 100, 100, 50)), []);
  g.down(P(1, 100, 100, 100)); g.move(P(1, 160, 100, 110));
  assert.deepEqual(ev(g.cancel(P(1, 160, 100, 120))), [{ k: "up", b: "l", x: 0.4, y: 0.25 }]);
});

test("switching mode mid-drag releases the button and forgets the gesture", () => {
  const g = createGestures(map, { mode: "touch" });
  g.down(P(1, 100, 100, 0)); g.move(P(1, 160, 100, 10));
  assert.deepEqual(ev(g.setMode("view")), [{ k: "up", b: "l", x: 0.4, y: 0.25 }]);
  assert.equal(g.mode, "view");
  assert.deepEqual(g.up(P(1, 160, 100, 20)), []);
});

test("coalescing: moves keep only the latest, scrolls at one point add up, order is kept", () => {
  const c = createCoalescer(2000);
  c.push({ k: "down", b: "l", x: 0, y: 0 });
  c.push({ k: "move", x: 0.1, y: 0 });
  c.push({ k: "move", x: 0.2, y: 0 });
  c.push({ k: "move", x: 0.3, y: 0 });
  c.push({ k: "up", b: "l", x: 0.3, y: 0 });
  c.push({ k: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 10 });
  c.push({ k: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 15 });
  c.push({ k: "scroll", x: 0.6, y: 0.5, dx: 0, dy: 5 });
  assert.deepEqual(c.drain(), [
    { k: "down", b: "l", x: 0, y: 0 },
    { k: "move", x: 0.3, y: 0 },
    { k: "up", b: "l", x: 0.3, y: 0 },
    { k: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 25 },
    { k: "scroll", x: 0.6, y: 0.5, dx: 0, dy: 5 },
  ]);
  assert.equal(c.size, 0);
  // a sum past the cap starts a new event rather than being clamped away
  c.push({ k: "scroll", x: 0, y: 0, dx: 0, dy: 1500 });
  c.push({ k: "scroll", x: 0, y: 0, dx: 0, dy: 1500 });
  assert.equal(c.drain().length, 2);
});

test("Three fingers pan the view in every mode and send nothing — even after two had started a scroll", () => {
  for (const mode of ["touch", "trackpad", "view"]) {
    const g = createGestures(map, { mode });
    const out = [];
    out.push(...g.down(P(1, 100, 100, 0)), ...g.down(P(2, 200, 100, 5)));
    out.push(...g.move(P(1, 100, 120, 10)), ...g.move(P(2, 200, 120, 12))); // two fingers together: a scroll (or a pan)
    out.push(...g.down(P(3, 150, 200, 20)));
    assert.equal(g.phase, "pan3", mode);
    const pans = [...g.move(P(1, 130, 120, 30)), ...g.move(P(2, 230, 120, 31)), ...g.move(P(3, 180, 200, 32))];
    assert.deepEqual(kinds(pans), ["pan", "pan", "pan"], mode);
    const sum = pans.reduce((a, o) => ({ x: a.x + o.d.x, y: a.y + o.d.y }), { x: 0, y: 0 });
    assert.ok(Math.abs(sum.x - 30) < 1e-9 && Math.abs(sum.y) < 1e-9, `${mode}: the view follows the fingers 1:1`);
    const tail = [...g.up(P(1, 130, 120, 40)), ...g.move(P(2, 260, 160, 41)), ...g.up(P(2, 260, 160, 42)), ...g.up(P(3, 180, 200, 43))];
    assert.deepEqual(ev([...pans, ...tail]), [], `${mode}: nothing reaches the desktop`);
    assert.equal(g.phase, "idle", mode);
  }
});

test("Three fingers: a fourth changes nothing, and lifting one ends the pan without a jump", () => {
  const g = createGestures(map, { mode: "touch" });
  g.down(P(1, 0, 0, 0)); g.down(P(2, 10, 0, 1)); g.down(P(3, 20, 0, 2));
  assert.deepEqual(g.down(P(4, 30, 0, 3)), []);
  assert.deepEqual(g.up(P(3, 20, 0, 10)), []);
  assert.deepEqual(g.move(P(1, 50, 50, 11)), []);
});
