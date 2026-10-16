/**
 * The context meter, scraped off the TUI's status line.
 *
 * The stated rule for every heuristic here is that it degrades to null or
 * absent, never to a WRONG number — a context gauge reading 80% free when it is
 * nearly full is worse than no gauge, because the whole point of it is deciding
 * whether to start something long.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMeterRow, detectContext } from "../dist/context.js";

test("nothing on screen means no reading, not zero", () => {
  const c = detectContext("just some output\nand more of it");
  assert.equal(c.leftPct, null);
  assert.equal(c.usedTok, undefined);
});

test("the auto-compact phrasing is read as percent FREE", () => {
  assert.equal(detectContext("Context left until auto-compact: 42%").leftPct, 42);
});

test("an absolute token ratio yields both the figures and the percent", () => {
  const c = detectContext("123k/200k tokens");
  assert.equal(c.usedTok, 123_000);
  assert.equal(c.totalTok, 200_000);
  assert.equal(c.leftPct, 39); // 1 - 123/200
});

test("an explicit percent beats one derived from a ratio", () => {
  // The percent is the direct signal; the ratio may be a stale row still on
  // screen from an earlier redraw.
  const c = detectContext("100k/200k tokens\nContext left until auto-compact: 12%");
  assert.equal(c.leftPct, 12);
});

test("the freshest redraw wins", () => {
  // The status line is rewritten in place, so the screen holds every value it
  // has ever shown. The last one is the only true one.
  const c = detectContext("10k/200k tokens\n50k/200k tokens\n150k/200k tokens");
  assert.equal(c.usedTok, 150_000);
});

test("an impossible ratio is ignored rather than believed", () => {
  // used > total is a mis-parse, not a full window.
  const c = detectContext("900k/200k tokens");
  assert.equal(c.leftPct, null);
});

test("a percent outside 0..100 is refused", () => {
  assert.equal(detectContext("Context left until auto-compact: 420%").leftPct, null);
});

test("the meter gate ignores prose ABOUT the context window", () => {
  // A real false alarm: the agent's own line filed 18 "misses" on the health board.
  assert.equal(contextMeterRow('⏺ I moved the /compact button onto the "Context window" title row'), null);
  assert.equal(contextMeterRow("the Context window title row has no number on it"), null);
  assert.equal(contextMeterRow("Context left until auto-compact: 42%"), "Context left until auto-compact: 42%");
  assert.equal(contextMeterRow("ctx 120k used of the context window"), "ctx 120k used of the context window");
});
