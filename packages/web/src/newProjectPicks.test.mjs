import { test } from "node:test";
import assert from "node:assert/strict";
import { newProjectPicks, tickedOptions, withPick } from "./newProjectPicks.ts";

const opts = [{ id: "a", on: true }, { id: "b", on: false }];

test("an untouched box follows the desktop's default; a touched one the person's choice", () => {
  assert.deepEqual(tickedOptions(opts, {}), ["a"]);
  assert.deepEqual(tickedOptions(opts, withPick(withPick({}, "a", false), "b", true)), ["b"]);
  assert.deepEqual(tickedOptions(opts, { gone: true }), ["a"], "a box no longer offered is never sent");
});

test("a memory of the wrong shape is no memory", () => {
  for (const o of [null, undefined, "nope", [1], 3]) assert.deepEqual(newProjectPicks(o), {});
  assert.deepEqual(newProjectPicks({ a: false, b: "yes" }), { a: false });
});
