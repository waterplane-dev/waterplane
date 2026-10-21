/** The session chrome's dragged height cap (`chromeCap.ts`). */
import test from "node:test";
import assert from "node:assert/strict";

import { chromeCapAfter, chromeCapOf } from "./chromeCap.ts";

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
