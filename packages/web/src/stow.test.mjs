/**
 * The fold store's bookkeeping: marks age out, the newest survive the cap, and
 * a fold is keyed by its CONTENT — a new link under the same slot is not folded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { STOW_KEEP_MS, isStowed, pruneStowed, stow, stowMark, trayAdd, trayEntries, unstow } from "./stow.ts";

test("pruneStowed drops marks past the keep window and keeps the newest under the cap", () => {
  const now = 10 * STOW_KEEP_MS;
  const marks = { old: now - STOW_KEEP_MS - 1, a: now - 3, b: now - 2, c: now - 1, junk: "x" };
  assert.deepEqual(Object.keys(pruneStowed(marks, now)).sort(), ["a", "b", "c"]);
  assert.deepEqual(Object.keys(pruneStowed(marks, now, STOW_KEEP_MS, 2)).sort(), ["b", "c"]);
});

test("a fold holds only for the content it was made on", () => {
  stow("shell-links", "s1|https://x/a|CODE-1");
  assert.ok(isStowed("shell-links", "s1|https://x/a|CODE-1"));
  assert.ok(!isStowed("shell-links", "s1|https://x/a|CODE-2"), "a new code comes back up");
  assert.ok(!isStowed("login", "s1|https://x/a|CODE-1"), "slots never share a fold");
  unstow("shell-links", "s1|https://x/a|CODE-1");
  assert.ok(!isStowed("shell-links", "s1|https://x/a|CODE-1"));
  assert.equal(stowMark("a", "b"), "a|b");
});

test("a chip is up exactly while its strip says it is folded", () => {
  const down = trayAdd({ slot: "next", label: "next prompt", icon: () => null, unfold() {} });
  assert.deepEqual(trayEntries().map((e) => e.slot), ["next"]);
  down();
  assert.equal(trayEntries().length, 0);
});
