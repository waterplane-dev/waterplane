/**
 * The browser dictation engine's result list, merged into one transcript.
 *
 *     node --test packages/web/src/speechMerge.test.mjs
 *
 * Android Chrome repeats earlier words in later results; joining them blindly
 * dictated "orsofixorsofixorsofix" into the prompt box.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeSpeechResults } from "./speechMerge.ts";

test("desktop: one phrase per result joins with single spaces", () => {
  assert.equal(mergeSpeechResults(["hello world", " how are you"]), "hello world how are you");
});

test("android: a growing prefix replaces what came before", () => {
  assert.equal(mergeSpeechResults(["or", "or so", "or so fix"]), "or so fix");
});

test("android: a repeated final phrase is kept once", () => {
  assert.equal(mergeSpeechResults(["or so fix", "or so fix", "or so fix"]), "or so fix");
});

test("android: repeats then a new phrase, with no leading spaces", () => {
  assert.equal(
    mergeSpeechResults(["or so fix", "or so fix", "or so fix die", "die open code view"]),
    "or so fix die die open code view",
  );
  assert.equal(
    mergeSpeechResults(["or so fix", "or so fix die", "or so fix die Open Code view"]),
    "or so fix die Open Code view",
  );
});

test("empty and blank results add nothing", () => {
  assert.equal(mergeSpeechResults([]), "");
  assert.equal(mergeSpeechResults(["", "  ", "hi"]), "hi");
});
