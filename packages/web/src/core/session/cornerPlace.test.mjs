// R-toolbar-012: the corner group may be dropped anywhere on the session screen
// and is drawn there again, whatever the layout does to the terminal meanwhile.
import test from "node:test";
import assert from "node:assert/strict";

import { drawnAt, HOME, keepIn, placeFor, readPlace } from "./cornerPlace.ts";

const screen = { left: 0, top: 40, right: 412, bottom: 900 };
const box = { left: 0, top: 240, right: 412, bottom: 700 };
const home = { right: 404, top: 246 };
const size = { width: 200, height: 36 };

test("R-toolbar-012: dropped on the header or the compose box it stays there", () => {
  for (const at of [{ right: 300, top: 60 }, { right: 404, top: 840 }]) {
    const p = placeFor(at, size, home, box, screen);
    assert.ok("free" in p);
    assert.deepEqual(drawnAt(p, size, home, box, screen), at);
  }
});

test("half over the terminal's edge counts as outside it", () => {
  assert.ok("free" in placeFor({ right: 300, top: 230 }, size, home, box, screen));
  assert.ok("free" in placeFor({ right: 300, top: 680 }, size, home, box, screen));
});

test("parked near the bottom it rides up with the keyboard, and comes back down", () => {
  const p = placeFor({ right: 404, top: 840 }, size, home, box, screen);
  const kb = { ...screen, bottom: 500 };
  assert.deepEqual(drawnAt(p, size, home, box, kb), { right: 404, top: 440 });
  assert.deepEqual(drawnAt(p, size, home, box, screen), { right: 404, top: 840 });
});

test("dropped over the terminal it is an offset from home and kept in that box", () => {
  const p = placeFor({ right: 304, top: 600 }, size, home, box, screen);
  assert.deepEqual(p, { x: -100, y: 354 });
  assert.deepEqual(drawnAt(p, size, home, { ...box, bottom: 400 }, screen), { right: 304, top: 364 });
  assert.deepEqual(drawnAt(p, size, home, box, screen), { right: 304, top: 600 });
});

test("with no terminal box to carry it, a drop is free", () => {
  assert.ok("free" in placeFor({ right: 304, top: 300 }, size, home, null, screen));
});

test("never off screen: 8px from the right, and the grip's corner wins when it is too big", () => {
  assert.deepEqual(keepIn({ right: 900, top: -50 }, size, screen), { right: 404, top: 40 });
  assert.equal(keepIn({ right: 10, top: 60 }, size, screen).right, 200);
  assert.deepEqual(keepIn({ right: 300, top: 60 }, { width: 600, height: 2000 }, screen), { right: 600, top: 40 });
});

test("the fold is kept with the place", () => {
  assert.equal(placeFor({ right: 300, top: 60 }, size, home, box, screen, 2).cols, 2);
  assert.equal(placeFor({ right: 300, top: 600 }, size, home, box, screen, 1).cols, 1);
});

test("storage: an older build's offset still reads, anything else is home", () => {
  assert.deepEqual(readPlace({ x: -5, y: 9, cols: 2 }), { x: -5, y: 9, cols: 2 });
  const free = { free: true, right: 8, edge: "bottom", gap: 20 };
  assert.deepEqual(readPlace(free), free);
  for (const bad of [null, 3, {}, { x: "1", y: 2 }, { ...free, edge: "left" }, { ...free, gap: NaN }]) assert.deepEqual(readPlace(bad), HOME);
});
