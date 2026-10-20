/**
 * Why the next restart is coming (`restartnote.ts`): one clean line, dropped
 * when stale, never invented.
 *
 *     node --test packages/host/test/restartnote.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanReason, NOTE_TTL_MS, restartReason, setRestartNote } from "../dist/restartnote.js";

test("no note ⇒ no reason", () => {
  assert.equal(restartReason(0), undefined);
});

test("a junk body sets nothing", () => {
  assert.equal(setRestartNote(undefined, 0), false);
  assert.equal(setRestartNote({ x: 1 }, 0), false);
  assert.equal(setRestartNote("  \n\t ", 0), false);
  assert.equal(restartReason(0), undefined);
});

test("one line, capped, fresh only within the TTL", () => {
  assert.equal(cleanReason("a\nb\u0007  c"), "a b c");
  assert.equal(cleanReason("x".repeat(500)).length, 160);
  assert.equal(setRestartNote("npm run restart · new build ad1f6b9", 1000), true);
  assert.equal(restartReason(1000 + NOTE_TTL_MS), "npm run restart · new build ad1f6b9");
  assert.equal(restartReason(1001 + NOTE_TTL_MS), undefined);
});
