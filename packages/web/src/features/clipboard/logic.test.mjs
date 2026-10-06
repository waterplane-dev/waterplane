import test from "node:test";
import assert from "node:assert/strict";

import { emptyDumpText, quoteBlock } from "./logic.ts";

test("a quote is every line prefixed, with its lead-in and a blank line after", () => {
  assert.equal(quoteBlock("  one\ntwo  "), "Quote from your last response:\n> one\n> two\n\n");
});

test("nothing but whitespace quotes nothing", () => {
  assert.equal(quoteBlock(""), null);
  assert.equal(quoteBlock(" \n\t "), null);
});

test("the empty dump says why, differently with and without a session", () => {
  assert.match(emptyDumpText(true), /reader view/);
  assert.equal(emptyDumpText(false), "No session on screen.");
});

import { decisionBlock, decisionItems, optionsOf } from "./logic.ts";

const SCREEN = [
  "  4. Example scope: which devices, and should touch and buttons both",
  "     be required? I'd say both.",
  "  5. Publish sdk-mcp to npm with npx, or keep it local?",
  "  6. Claude Code plugin: in 0.1, or after it?",
  "",
  "  Suggested build order",
  "  1. Phase 0 cleanup",
  "  2. Build fallback + keygen",
  "────────────────",
];

test("numbered items rejoin their wrapped rows and keep their own numbers", () => {
  const items = decisionItems(SCREEN);
  assert.deepEqual(items.map((i) => i.num), ["4", "5", "6", "1", "2"]);
  assert.equal(items[0].label, "Example scope");
  assert.match(items[0].text, /touch and buttons both be required\? I'd say both\.$/);
});

test("an 'X, or Y?' question offers X and Y; a long one offers nothing", () => {
  assert.deepEqual(optionsOf("Claude Code plugin: in 0.1, or after it?"), ["in 0.1", "after it"]);
  assert.deepEqual(optionsOf("Publish sdk-mcp to npm with npx, or keep it local in the monorepo for now?"), []);
  assert.deepEqual(optionsOf("No question here."), []);
});

test("picked plain lines are each an item; furniture is not", () => {
  const items = decisionItems(["Should we ship it?", "", "────────", "Rename the flag"]);
  assert.deepEqual(items.map((i) => i.text), ["Should we ship it?", "Rename the flag"]);
});

test("the block names each answer by number and label and skips the blank", () => {
  const items = decisionItems(SCREEN);
  assert.equal(decisionBlock(items, ["both", " ", "after it"]),
    "My decisions:\n4. Example scope: both\n6. Claude Code plugin: after it\n");
  assert.equal(decisionBlock(items, []), null);
});
