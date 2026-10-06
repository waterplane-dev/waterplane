import test from "node:test";
import assert from "node:assert/strict";
import { promptPairParts } from "./promptPairParts.ts";

test("first only", () => {
  assert.deepEqual(promptPairParts({ firstPrompt: " A " }), { first: "A" });
});
test("first === last shows the start part only", () => {
  assert.deepEqual(promptPairParts({ firstPrompt: "A", lastPrompt: "A" }), { first: "A" });
});
test("first + last", () => {
  assert.deepEqual(promptPairParts({ firstPrompt: "A", lastPrompt: "B" }), { first: "A", now: "B", nowKind: "latest" });
});
test("pinned replaces last", () => {
  assert.deepEqual(promptPairParts({ firstPrompt: "A", lastPrompt: "yes", pinnedPrompt: "P" }), { first: "A", now: "P", nowKind: "pinned" });
});
test("last only, and none", () => {
  assert.deepEqual(promptPairParts({ lastPrompt: "B" }), { now: "B", nowKind: "latest" });
  assert.deepEqual(promptPairParts({}), {});
  assert.deepEqual(promptPairParts({ firstPrompt: "  ", lastPrompt: "" }), {});
});
