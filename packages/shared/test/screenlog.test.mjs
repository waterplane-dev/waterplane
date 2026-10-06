// What scrolled off an alt screen (`shared/src/screenlog.ts`). The anchor is the
// TOP of the new grid on purpose: the bottom of a claude screen is a composer, a
// spinner and a token counter, which redraw every frame whether anything
// scrolled or not.
import test from "node:test";
import assert from "node:assert/strict";
import { SCREENLOG_MAX_LINES, absorbScreen, newScreenLog, screenLogLines, scrollOffCount } from "../dist/index.js";

test("an unscrolled repaint reports nothing scrolled off", () => {
  const grid = ["one", "two", "three"];
  assert.equal(scrollOffCount(grid, grid), 0);
  assert.equal(scrollOffCount([], grid), 0);
});

test("a scroll is the offset of the new top inside the old grid", () => {
  assert.equal(scrollOffCount(["a", "b", "c", "d", "e"], ["c", "d", "e", "f", "g"]), 2);
});

test("leading blank rows are not the anchor — a composer pads above itself", () => {
  assert.equal(scrollOffCount(["a", "b", "c", "d"], ["", "  ", "c", "d", "e"]), 2);
});

test("an all-blank grid is a repaint in progress, not a scroll", () => {
  assert.equal(scrollOffCount(["a", "b", "c"], ["", "   ", ""]), 0);
});

test("a nowhere-to-be-found anchor is a full repaint: everything left", () => {
  const prev = ["a", "b", "c"];
  assert.equal(scrollOffCount(prev, ["totally", "different", "view"]), prev.length);
});

test("a near-full-screen scroll still anchors on a partial match at the bottom", () => {
  // Only "e" survives; the anchor runs off the end of `prev` and must still count.
  assert.equal(scrollOffCount(["a", "b", "c", "d", "e"], ["e", "f", "g", "h", "i"]), 4);
});

test("a single repeated line is too weak to anchor on its own", () => {
  // "x" occurs at 0 and 3 in prev; three consecutive lines are what disambiguate.
  assert.equal(scrollOffCount(["x", "a", "b", "x", "y", "z"], ["x", "y", "z", "w"]), 3);
});

test("absorbScreen returns the SAME object when nothing moved", () => {
  const state = newScreenLog([], ["a", "b"]);
  assert.equal(absorbScreen(state, ["a", "b"]), state);
  assert.equal(absorbScreen(state, ["a", "b", "", "  "]), state); // trailing blanks trimmed
  assert.equal(absorbScreen(state, ["", ""]), state);             // mid-repaint blank grid
});

test("absorbScreen archives only what left, and keeps the new screen", () => {
  const next = absorbScreen(newScreenLog([], ["a", "b", "c", "d"]), ["c", "d", "e", "f"]);
  assert.deepEqual(next.archived, ["a", "b"]);
  assert.deepEqual(next.screen, ["c", "d", "e", "f"]);
  assert.deepEqual(screenLogLines(next), ["a", "b", "c", "d", "e", "f"]);
});

test("a redraw with no scroll replaces the screen and archives nothing", () => {
  const next = absorbScreen(newScreenLog(["old"], ["a", "b"]), ["a", "b", "c"]);
  assert.deepEqual(next.archived, ["old"]);
  assert.deepEqual(next.screen, ["a", "b", "c"]);
});

test("the archive is capped from the OLD end, keeping the newest lines", () => {
  const archived = Array.from({ length: 10 }, (_, i) => `arch${i}`);
  const next = absorbScreen(newScreenLog(archived, ["a", "b", "c"]), ["c", "x"], 5);
  assert.equal(next.archived.length, 5);
  assert.equal(next.archived.at(-1), "b");   // the newest arrival survives
  assert.equal(next.archived[0], "arch7");   // the oldest were dropped
  assert.ok(SCREENLOG_MAX_LINES > 0);
});

test("a resize that shifts the grid up and then repaints it from the top archives nothing", () => {
  // The keyboard opening: xterm drops the top row, then the CLI redraws the
  // header from row 0. Before this, the header landed in the archive per toggle.
  const full = ["logo1  Claude Code", "logo2  Opus", "logo3  ~/dev", "", "/remote-control", "> Try", "[mode]"];
  let s = absorbScreen(newScreenLog([], []), full);
  s = absorbScreen(s, full.slice(1));           // shifted up one row
  assert.deepEqual(s.archived, ["logo1  Claude Code"]);
  s = absorbScreen(s, full);                     // repainted from the top
  assert.deepEqual(s.archived, []);
  assert.deepEqual(screenLogLines(s), full);
});

test("content moving down with nothing archived above it leaves the archive alone", () => {
  const before = ["old1", "old2"];
  const s = absorbScreen(newScreenLog(before, ["a", "b", "c", "d"]), ["new", "a", "b", "c", "d"]);
  assert.equal(s.archived, before);
  assert.deepEqual(s.screen, ["new", "a", "b", "c", "d"]);
});

test("a real view switch still archives the outgoing screen whole", () => {
  const s = absorbScreen(newScreenLog([], ["a", "b", "c"]), ["usage", "view", "here"]);
  assert.deepEqual(s.archived, ["a", "b", "c"]);
});
