import test from "node:test";
import assert from "node:assert/strict";

import { appendTail, applyPtyBytes, seedFromTails, sweepOrder } from "./tail.ts";

const maps = () => ({ buffers: new Map(), lastSeqById: new Map(), restore: new Map(), resumeBoot: new Map() });

test("a full replay REPLACES the buffer — a restored tail is never printed twice", () => {
  const b = new Map([["s", ["restored"]]]);
  assert.equal(applyPtyBytes(b, "s", "replay", true), true);
  assert.deepEqual(b.get("s"), ["replay"]);
});

test("an empty full replay leaves an empty buffer, not one empty chunk", () => {
  const b = new Map([["s", ["old"]]]);
  applyPtyBytes(b, "s", "", true);
  assert.deepEqual(b.get("s"), []);
});

test("a delta APPENDS onto what the terminal already shows, in the same array", () => {
  const arr = ["a"];
  const b = new Map([["s", arr]]);
  assert.equal(applyPtyBytes(b, "s", "b", false), false);
  assert.equal(b.get("s"), arr, "buffer-by-ref: the array is mutated, not replaced");
  assert.deepEqual(arr, ["a", "b"]);
  applyPtyBytes(b, "new", "x", undefined);
  assert.deepEqual(b.get("new"), ["x"]);
});

test("the liveness tail keeps the last `cap` characters", () => {
  assert.equal(appendTail(undefined, "abc", 5), "abc");
  assert.equal(appendTail("abcd", "efg", 5), "cdefg");
});

test("seed: bytes always, the resume point only with a boot id, live buffers never overwritten", () => {
  const m = maps();
  m.buffers.set("live", ["already"]);
  const stale = seedFromTails([
    { sessionId: "live", tail: "T0", seq: 1, savedAt: 10, boot: "b" },
    { sessionId: "old", tail: "T1", seq: 5, savedAt: 20 },
    { sessionId: "cur", tail: "T2", seq: 9, savedAt: 30, boot: "b2" },
  ], m);
  assert.deepEqual(m.buffers.get("live"), ["already"]);
  assert.deepEqual([...stale], [["old", 20], ["cur", 30]]);
  assert.deepEqual(m.buffers.get("old"), ["T1"]);
  assert.equal(m.lastSeqById.has("old"), false, "no boot id ⇒ never trusted as a resume point");
  assert.equal(m.restore.has("old"), false);
  assert.equal(m.lastSeqById.get("cur"), 9);
  assert.equal(m.restore.get("cur"), 9);
  assert.equal(m.resumeBoot.get("cur"), "b2");
});

test("an EMPTY live buffer does not block the seed", () => {
  const m = maps();
  m.buffers.set("s", []);
  seedFromTails([{ sessionId: "s", tail: "T", seq: 1, savedAt: 1, boot: "b" }], m);
  assert.deepEqual(m.buffers.get("s"), ["T"]);
});

test("sweep order: attached first, then newest", () => {
  const ss = [{ id: "a", createdAt: 1 }, { id: "b", createdAt: 3 }, { id: "c", createdAt: 2 }];
  assert.deepEqual(sweepOrder(ss, null), ["b", "c", "a"]);
  assert.deepEqual(sweepOrder(ss, "a"), ["a", "b", "c"]);
  assert.deepEqual(ss.map((s) => s.id), ["a", "b", "c"], "the input list is not sorted in place");
});
