/**
 * A verb fired at the reader runs once, however often the reader remounts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { takeVerb } from "./spentVerb.ts";

test("a fired verb runs on the mount that sees it, and not on the next mount", () => {
  const spent = new WeakSet();
  const cmd = { kind: "find", key: 1 };
  assert.equal(takeVerb(cmd, spent), true);
  assert.equal(takeVerb(cmd, spent), false, "a remount over the same prop must not re-open find");
});

test("a new tap with a key already seen is still a new tap", () => {
  const spent = new WeakSet();
  assert.equal(takeVerb({ kind: "outline", key: 1 }, spent), true);
  assert.equal(takeVerb({ kind: "outline", key: 1 }, spent), true, "keys restart per session; identity decides");
});

test("nothing fired is nothing to do", () => {
  const spent = new WeakSet();
  assert.equal(takeVerb(null, spent), false);
  assert.equal(takeVerb(undefined, spent), false);
});
