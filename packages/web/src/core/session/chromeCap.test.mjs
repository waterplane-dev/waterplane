/** The session chrome's dragged height cap (`chromeCap.ts`). */
import test from "node:test";
import assert from "node:assert/strict";

import { chromeCapAfter, chromeCapOf, drawerHeightAfter } from "./chromeCap.ts";

test("chromeCapAfter: a drag up shrinks, never below zero", () => {
  assert.equal(chromeCapAfter(200, -50, 200), 150);
  assert.equal(chromeCapAfter(200, -500, 200), 0);
});

test("chromeCapAfter: reaching the content's height is no cap at all", () => {
  assert.equal(chromeCapAfter(150, 50, 200), null);
  assert.equal(chromeCapAfter(150, 80, 200), null);
  assert.equal(chromeCapAfter(150, 20.4, 200), 170);
});

test("chromeCapOf: junk reads as no cap", () => {
  assert.equal(chromeCapOf(null), null);
  assert.equal(chromeCapOf(""), null);
  assert.equal(chromeCapOf("abc"), null);
  assert.equal(chromeCapOf("-3"), null);
  assert.equal(chromeCapOf("120"), 120);
  assert.equal(chromeCapOf("0"), 0);
});

test("chromeCapAfter: a floor is the least it shrinks to, and a frame no taller than the floor has no cap", () => {
  assert.equal(chromeCapAfter(150, -500, 200, 60), 60);
  assert.equal(chromeCapAfter(150, -20, 200, 60), 130);
  assert.equal(chromeCapAfter(60, -20, 60, 60), null);
});

// R-layout-036: the reader's outline. Usual height 300, content 1000, ceiling 600, floor 48.
test("drawerHeightAfter: a long list shrinks to its floor and grows past its usual height, up to the ceiling", () => {
  assert.equal(drawerHeightAfter(300, -100, 1000, 48, 300, 600), 200);
  assert.equal(drawerHeightAfter(300, -900, 1000, 48, 300, 600), 48);
  assert.equal(drawerHeightAfter(300, 100, 1000, 48, 300, 600), 400);
  assert.equal(drawerHeightAfter(300, 900, 1000, 48, 300, 600), 600);
});

test("drawerHeightAfter: never past its content, and a list that fits its usual height goes back to it", () => {
  assert.equal(drawerHeightAfter(300, 200, 400, 48, 300, 600), 400);
  assert.equal(drawerHeightAfter(150, 100, 200, 48, 300, 600), null);
  assert.equal(drawerHeightAfter(40, 20, 40, 48, 300, 600), null);
});
