/**
 * Which reader-table columns wrap and which stay on one line, pinned without a browser.
 *
 *     node --test packages/web/src/tableFit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { columnFits, visibleText, KEEP_MAX_CH, WRAP_MAX_CH, WRAP_MIN_CH } from "./tableFit.ts";

// The table from the owner's screenshot (11-12): round, change, price.
const body = [
  ["1", "Check the stub CLI's hook events against real captures", "~$10"],
  ["1", "Delivery takes a `Clock` parameter, so its waits can be tested without real time", "~$35"],
  ["2 (vault)", "One atomic-file primitive for the vault's side files, reviewed on Fable for data safety", "~$90"],
  ["End", "Final design review and proposals", "~$50"],
];

test("short columns stay on one line, the prose column wraps", () => {
  const f = columnFits(body, 3);
  assert.equal(f[0].kind, "keep");
  assert.equal(f[1].kind, "wrap");
  assert.equal(f[2].kind, "keep");
});

test("a wrapping column never goes narrower than its longest word, within the clamp", () => {
  const [f] = columnFits([["a ".repeat(20) + "supercalifragilistic"]], 1);
  assert.deepEqual(f, { kind: "wrap", minCh: 20 });
  const [tiny] = columnFits([["ab ".repeat(10)]], 1);
  assert.deepEqual(tiny, { kind: "wrap", minCh: WRAP_MIN_CH });
  const [huge] = columnFits([["x".repeat(60)]], 1);
  assert.deepEqual(huge, { kind: "wrap", minCh: WRAP_MAX_CH });
});

test("the header does not decide: a long header over short cells keeps the cells whole", () => {
  assert.equal(columnFits([["~$10"], ["~$115"]], 1)[0].kind, "keep");
});

test("markdown markers and link targets do not count as width", () => {
  assert.equal(visibleText("**`Clock`**"), "Clock");
  assert.equal(visibleText("[docs](https://example.com/a/very/long/path/indeed)"), "docs");
  const exactly = "x".repeat(KEEP_MAX_CH);
  assert.equal(columnFits([[`**${exactly}**`]], 1)[0].kind, "keep");
});

test("a ragged row (fewer cells) is an empty cell, not a crash", () => {
  assert.deepEqual(columnFits([["a"], ["b", "c"]], 2).map((f) => f.kind), ["keep", "keep"]);
});
