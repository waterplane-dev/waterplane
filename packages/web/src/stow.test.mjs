/**
 * The fold store's bookkeeping: marks age out, the newest survive the cap, and
 * a fold is keyed by its CONTENT — a new link under the same slot is not folded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { STOW_KEEP_MS, coveringKey, isStowed, sharesFact, pruneStowed, stow, stowMark, trayAdd, trayEntries, unstow } from "./stow.ts";

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

test("a fold is a set of facts: a lost or reordered link is not news, a new one is", () => {
  stow("shell-links", "\nhttps://x/a\nhttps://x/b\ncode AB-12");
  assert.ok(isStowed("shell-links", "https://x/b\nhttps://x/a\ncode AB-12"), "order never counts");
  assert.ok(isStowed("shell-links", "\nhttps://x/a\n"), "a link the screen lost is not news");
  assert.ok(!isStowed("shell-links", "https://x/a\nhttps://x/c"), "a new link comes back up");
  assert.ok(!isStowed("shell-links", "await\nhttps://x/a"), "waiting for a code comes back up");
  assert.equal(coveringKey("shell-links", "https://x/a"), "\nhttps://x/a\nhttps://x/b\ncode AB-12");
  assert.ok(sharesFact("https://x/a\nhttps://x/c", "https://x/a"));
  assert.ok(!sharesFact("https://x/c", "https://x/a"), "another session's links are not this fold");
  unstow("shell-links", "\nhttps://x/a\nhttps://x/b\ncode AB-12");
});
