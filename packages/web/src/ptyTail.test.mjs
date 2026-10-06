import test from "node:test";
import assert from "node:assert/strict";

import { escapeSafeTail } from "./ptyTail.ts";

// A tail cut at an arbitrary byte lands mid-escape about half the time, and
// xterm paints the surviving fragment as garbage across the first row. The cut
// moves FORWARD to the next ESC — but only within the first KiB, because a head
// that long before any ESC is ordinary text worth keeping.

test("a tail cut mid-sequence starts at the next ESC", () => {
  assert.equal(escapeSafeTail("2;5Hhello\x1b[0mworld"), "\x1b[0mworld");
});

test("a tail that already starts on an ESC is unchanged", () => {
  const s = "\x1b[2Jscreen";
  assert.equal(escapeSafeTail(s), s);
});

test("a tail with no ESC at all is unchanged", () => {
  assert.equal(escapeSafeTail("plain text"), "plain text");
});

test("an ESC further in than 1024 characters keeps the head", () => {
  const s = "x".repeat(1025) + "\x1b[0m";
  assert.equal(escapeSafeTail(s), s);
  const t = "x".repeat(1024) + "\x1b[0m";
  assert.equal(escapeSafeTail(t), "\x1b[0m");
});
