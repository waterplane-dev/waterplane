/**
 * The picker's window sentence: two MEASURED numbers or no sentence. Every case
 * below is a way it could say something untrue — a guessed overhead, a 0 read as
 * a window, a "left" that is negative, a sentence under every ordinary model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ADVICE_SHARE, windowAdviceText } from "../dist/windowadvice.js";
import * as index from "../dist/index.js";

test("the measured claude-local case, word for word", () => {
  assert.equal(windowAdviceText(65536, 33689),
    "65.5k window, ~33.7k of it used by the first request of the last session on this model (mostly Claude Code's own instructions and tools) — ~31.8k is left for the conversation.");
  assert.equal(windowAdviceText(65536, 5661), null, "lean: under a quarter, nothing to say");
});

test("absent, zero, negative, NaN, strings: no sentence — never a guess", () => {
  for (const [w, o] of [[undefined, 30000], [65536, undefined], [0, 30000], [65536, 0], [-1, 5], [NaN, 5], ["65536", 30000], [65536, null]]) {
    assert.equal(windowAdviceText(w, o), null, `${w}/${o}`);
  }
});

test("the threshold, and a window the first request already filled", () => {
  assert.equal(ADVICE_SHARE, 0.25);
  assert.equal(windowAdviceText(200000, 34000), null, "an ordinary claude window says nothing");
  assert.match(windowAdviceText(100000, 25000), /~75k is left/);
  assert.equal(windowAdviceText(100000, 24999), null);
  assert.match(windowAdviceText(32768, 33689), /that is the whole window, so the runner will cut the prompt\. Pick a model with a larger window\.$/);
});

test("exported from the index", () => {
  assert.equal(index.windowAdviceText, windowAdviceText);
});
