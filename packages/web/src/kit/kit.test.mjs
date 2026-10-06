import { test } from "node:test";
import assert from "node:assert/strict";
import { chipText, toggleChip, chipRows } from "./chips.ts";

test("a chip says its count, and its detail when there is one", () => {
  assert.equal(chipText("older than 30 days", { count: 27, detail: "3.9 GB" }), "older than 30 days · 27 · 3.9 GB");
  assert.equal(chipText("open", { count: 4 }), "open · 4");
});

test("a 0-count bucket is still a chip", () => {
  const rows = chipRows(["a", "b"], (k) => ({ count: k === "a" ? 0 : 2 }), (k) => k.toUpperCase());
  assert.deepEqual(rows.map((r) => r.text), ["A · 0", "B · 2"]);
});

test("the bucketing function is called once per key, and feeds the text", () => {
  let calls = 0;
  chipRows(["a", "b", "c"], () => { calls++; return { count: 1 }; }, (k) => k);
  assert.equal(calls, 3);
});

test("tapping the active chip clears, another moves", () => {
  assert.equal(toggleChip("a", "a"), null);
  assert.equal(toggleChip("a", "b"), "b");
  assert.equal(toggleChip(null, "b"), "b");
});
