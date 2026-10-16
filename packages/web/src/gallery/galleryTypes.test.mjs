// What the gallery's bar and empty grid say about a cut. Pure; no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { KINDS, SINCE } from "./galleryTypes.ts";
import { emptyCutText, newCutText } from "./galleryCuts.ts";
import { pickText, togglePick } from "./galleryPick.ts";

test("the badge's cut says its count once, and the listed rows only when they differ", () => {
  assert.equal(newCutText(31, 31, false, false), "31 new since you last looked");
  assert.equal(newCutText(31, 29, false, false), "31 new since you last looked · 29 still here");
  assert.equal(newCutText(120, 60, false, true), "120 new since you last looked · newest 60 shown");
});

test("while the listing is on the wire the bar never guesses a row count", () => {
  assert.equal(newCutText(31, 0, true, false), "31 new since you last looked");
});

test("an empty grid under a time cut names the cut; no cut, no sentence", () => {
  assert.equal(emptyCutText(14400), "Nothing from the last 4 hours.");
  assert.equal(emptyCutText(600), "Nothing from the last 10 minutes.");
  assert.equal(emptyCutText(undefined), null);
  // The badge's own cut is an arbitrary number of seconds, not a toggle: no sentence.
  assert.equal(emptyCutText(12345), null);
});

test("picking to combine keeps tap order; a second tap takes a picture out", () => {
  const key = (r) => r.p;
  const a = { p: "a" }, b = { p: "b" }, c = { p: "c" };
  let picked = togglePick([], a, key);
  picked = togglePick(picked, b, key);
  picked = togglePick(picked, c, key);
  assert.deepEqual(picked.map(key), ["a", "b", "c"]);
  assert.deepEqual(togglePick(picked, { p: "b" }, key).map(key), ["a", "c"], "out by its key, the rest keep their order");
});

test("the pick bar says how many, and why one is not enough", () => {
  assert.match(pickText(0), /in the order/);
  assert.match(pickText(1), /at least two/);
  assert.equal(pickText(2), "2 picked, numbered in the order you tapped them.");
});

test("no chip is spelled 'all': none lit means everything", () => {
  for (const c of [...KINDS, ...SINCE]) assert.notEqual(c.label.toLowerCase(), "all");
});
