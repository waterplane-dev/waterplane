/**
 * randId: the length asked for, hex only, unique across many draws; randUnit stays in [0, 1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randId, randUnit } from "./randId.ts";

test("randId gives exactly the length asked for, in lowercase hex", () => {
  for (const len of [1, 4, 6, 8, 13]) assert.match(randId(len), new RegExp(`^[0-9a-f]{${len}}$`));
  assert.equal(randId().length, 8);
});

test("randId does not repeat across many draws", () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(randId(12));
  assert.equal(seen.size, 5000);
});

test("randUnit stays in [0, 1)", () => {
  for (let i = 0; i < 2000; i++) {
    const r = randUnit();
    assert.ok(r >= 0 && r < 1, String(r));
  }
});
