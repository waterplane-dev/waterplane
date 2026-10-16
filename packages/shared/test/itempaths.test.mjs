/**
 * The files an item's words name (`itempaths.ts`) — moved out of the smart
 * pick's tests when the smart pick was removed (2026-10-16).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { imagePaths, transportPaths } from "../dist/index.js";

test("transportPaths finds inbox/outbox paths and images, trailing punctuation off", () => {
  assert.deepEqual(
    transportPaths("look at .claude/outbox/flow.gif, then docs/a.png."),
    [".claude/outbox/flow.gif", "docs/a.png"],
  );
  assert.deepEqual(imagePaths("no files here"), []);
  // An inbox file that is not an image is still a file the words name.
  assert.deepEqual(transportPaths("read .claude/inbox/log.txt"), [".claude/inbox/log.txt"]);
});

test("a path in markdown is read without its markup", () => {
  assert.deepEqual(transportPaths("see `.claude/inbox/a.png`"), [".claude/inbox/a.png"]);
  assert.deepEqual(imagePaths("**docs/flow.png**"), ["docs/flow.png"]);
});

test("the same path twice is one path, and a non-string is none", () => {
  assert.deepEqual(imagePaths("a.png and a.png"), ["a.png"]);
  assert.deepEqual(imagePaths(undefined), []);
  assert.deepEqual(transportPaths(""), []);
});
