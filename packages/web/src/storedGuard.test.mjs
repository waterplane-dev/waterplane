/**
 * A stored value that cannot be read is a STATE, not an empty list: it is kept
 * aside before a save replaces it, and a refused write says so.
 *     node --test packages/web/src/storedGuard.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readGuarded, writeChecked, keepAside } from "./storedGuard.ts";

function stub(init = {}, { failSet = false } = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (failSet) throw new Error("QuotaExceededError"); m.set(k, String(v)); },
  };
}
const isArr = Array.isArray;

test("round trip", () => {
  const st = stub();
  assert.equal(writeChecked(st, "k", [{ a: 1 }]), true);
  assert.deepEqual(readGuarded(st, "k", [], isArr), { value: [{ a: 1 }], unreadable: false });
});

test("nothing stored is empty, not unreadable", () => {
  assert.deepEqual(readGuarded(stub(), "k", [], isArr), { value: [], unreadable: false });
});

test("invalid JSON is unreadable and kept aside, key untouched", () => {
  const st = stub({ k: "{not json" });
  assert.deepEqual(readGuarded(st, "k", [], isArr), { value: [], unreadable: true });
  assert.equal(st.m.get("k.unreadable"), "{not json");
  assert.equal(st.m.get("k"), "{not json");
});

test("valid JSON of the wrong shape is unreadable too", () => {
  const st = stub({ k: '{"a":1}' });
  assert.equal(readGuarded(st, "k", [], isArr).unreadable, true);
  assert.equal(st.m.get("k.unreadable"), '{"a":1}');
});

test("a save after an unreadable read cannot destroy the raw copy", () => {
  const st = stub({ k: "garbage" });
  readGuarded(st, "k", [], isArr);
  writeChecked(st, "k", []);
  assert.equal(st.m.get("k.unreadable"), "garbage");
});

test("the aside slot is never overwritten; a second different value gets its own", () => {
  const st = stub({ k: "one" });
  readGuarded(st, "k", [], isArr);
  readGuarded(st, "k", [], isArr); // same value again: no pile-up
  st.m.set("k", "two");
  readGuarded(st, "k", [], isArr);
  assert.equal(st.m.get("k.unreadable"), "one");
  const extra = [...st.m.keys()].filter((x) => x.startsWith("k.unreadable-"));
  assert.equal(extra.length, 1);
  assert.equal(st.m.get(extra[0]), "two");
});

test("a refused write reports false", () => {
  assert.equal(writeChecked(stub({}, { failSet: true }), "k", [1]), false);
});

test("a store that throws on read is unreadable, not empty", () => {
  const st = { getItem() { throw new Error("denied"); }, setItem() {} };
  assert.equal(readGuarded(st, "k", [], isArr).unreadable, true);
});

test("keepAside reports failure when even that is refused", () => {
  assert.equal(keepAside(stub({}, { failSet: true }), "k", "x"), false);
});

test("a second corrupt value is copied once, however many reads follow", () => {
  const st = stub({ k: "A" });
  readGuarded(st, "k", [], isArr);
  st.m.set("k", "B");
  for (let i = 0; i < 5; i++) readGuarded(st, "k", [], isArr);
  const extra = [...st.m.keys()].filter((x) => x.startsWith("k.unreadable-"));
  assert.equal(extra.length, 1, "five reads of the same corrupt value are one copy");
  assert.equal(st.m.get(extra[0]), "B");
  st.m.set("k", "C");
  readGuarded(st, "k", [], isArr);
  assert.equal([...st.m.keys()].filter((x) => x.startsWith("k.unreadable-")).length, 2, "a third distinct value gets its own");
});

test("a checked write refuses to replace an unreadable value whose copy could not be kept", () => {
  const st = stub({ k: "garbage" });
  const real = st.setItem;
  st.setItem = (k, v) => { if (k.includes(".unreadable")) throw new Error("QuotaExceededError"); real(k, v); };
  assert.equal(readGuarded(st, "k", [], isArr).unreadable, true);
  assert.equal(writeChecked(st, "k", [], isArr), false);
  assert.equal(st.m.get("k"), "garbage", "the only copy is still there");
});

test("a checked write copies an unreadable value aside itself, then writes", () => {
  const st = stub({ k: "garbage" }); // never read first
  assert.equal(writeChecked(st, "k", [1], isArr), true);
  assert.equal(st.m.get("k.unreadable"), "garbage");
  assert.equal(st.m.get("k"), "[1]");
});
