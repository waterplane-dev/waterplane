/**
 * The person's dictation vocabulary: parsed one way on both ends, handed to
 * whisper as a prompt, and put back into a transcript that missed it — without
 * ever rewriting an ordinary word the person actually said.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DICTATE_TERMS_MAX,
  applyDictateTerms,
  dictatePrompt,
  dictateTermsDropped,
  isPromptEcho,
  parseDictateTerms,
  serializeDictateTerms,
} from "../dist/index.js";

test("one term per line, aliases after a colon, comments and blanks skipped", () => {
  const terms = parseDictateTerms("# my words\nBA3: bee a three, be a 3\n\n  Tiptoi  \nba3: B A three\n");
  assert.deepEqual(terms, [
    { term: "BA3", heard: ["bee a three", "be a 3", "B A three"] },
    { term: "Tiptoi", heard: [] },
  ]);
  assert.deepEqual(parseDictateTerms(serializeDictateTerms(terms)), terms);
  assert.deepEqual(parseDictateTerms(""), []);
  assert.deepEqual(parseDictateTerms(null), []);
});

test("the list is capped by COUNT and the cut is countable", () => {
  const text = Array.from({ length: DICTATE_TERMS_MAX + 4 }, (_, i) => `T${i}x`).join("\n");
  assert.equal(parseDictateTerms(text).length, DICTATE_TERMS_MAX);
  assert.equal(dictateTermsDropped(text), 4);
  assert.equal(dictateTermsDropped("A\na\nB"), 0);
});

test("the prompt is the terms and nothing else", () => {
  assert.equal(dictatePrompt(parseDictateTerms("BA3\nTiptoi")), "BA3, Tiptoi.");
  assert.equal(dictatePrompt([]), "");
  // One term alone was measured to change nothing; said twice, it does.
  assert.equal(dictatePrompt(parseDictateTerms("Kwixel")), "Kwixel, Kwixel.");
});

test("an alias is replaced, whole words only, longest first", () => {
  const terms = parseDictateTerms("BA3: bee a three, three");
  assert.equal(applyDictateTerms("Open bee a three and check", terms), "Open BA3 and check");
  assert.equal(applyDictateTerms("Open Bee  A three.", terms), "Open BA3.");
  assert.equal(applyDictateTerms("threes are fine", terms), "threes are fine");
});

test("a term arriving split or re-cased is rejoined", () => {
  const terms = parseDictateTerms("BA3");
  assert.equal(applyDictateTerms("Fix the BA 3 login.", terms), "Fix the BA3 login.");
  assert.equal(applyDictateTerms("B.A.3 crashes", terms), "BA3 crashes");
  assert.equal(applyDictateTerms("in ba3 today", terms), "in BA3 today");
  assert.equal(applyDictateTerms("Ist die BA-3 App offen?", terms), "Ist die BA3 App offen?");
  assert.equal(applyDictateTerms("ABA3 and BA30", terms), "ABA3 and BA30");
});

test("an ordinary word is never re-cased onto a sentence", () => {
  const terms = parseDictateTerms("Go\nTiptoi\nIT");
  assert.equal(applyDictateTerms("let's go, tiptoi works, it is fine", terms), "let's go, tiptoi works, it is fine");
  // …but a split one still is joined: nobody says "tip toi" meaning two words.
  assert.equal(applyDictateTerms("the tip toi pen", terms), "the Tiptoi pen");
});

test("the prompt handed back on silence is recognised as no speech", () => {
  const terms = parseDictateTerms("BA3\nTiptoi");
  assert.equal(isPromptEcho(" BA3, Tiptoi.", terms), true);
  assert.equal(isPromptEcho("open BA3", terms), false);
  assert.equal(isPromptEcho("anything", []), false);
  assert.equal(isPromptEcho("Kwixel, Kwixel.", parseDictateTerms("Kwixel")), true);
});
