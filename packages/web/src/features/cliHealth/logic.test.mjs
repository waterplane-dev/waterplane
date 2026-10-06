import test from "node:test";
import assert from "node:assert/strict";

import { chipShown, chipSplit, chipVerdicts, cliRank, worsened } from "./logic.ts";

test("unknown ranks with healthy — a quiet morning is not a step down", () => {
  assert.equal(cliRank("unknown"), cliRank("healthy"));
  assert.ok(cliRank("broken") > cliRank("degraded"));
  assert.ok(cliRank("degraded") > cliRank("healthy"));
});

test("the first frame sets the baseline silently", () => {
  assert.equal(worsened(null, "broken"), false);
});

test("only a step DOWN is a worsening", () => {
  assert.equal(worsened("healthy", "degraded"), true);
  assert.equal(worsened("degraded", "broken"), true);
  assert.equal(worsened("broken", "broken"), false);
  assert.equal(worsened("broken", "degraded"), false);
  assert.equal(worsened("healthy", "unknown"), false);
  assert.equal(worsened("unknown", "healthy"), false);
});

test("the chip draws for degraded and broken only", () => {
  const r = (verdict) => ({ verdict, broken: [], degraded: [], unknown: [], lines: [], version: null });
  assert.equal(chipShown(null), false);
  assert.equal(chipShown(r("healthy")), false);
  assert.equal(chipShown(r("unknown")), false);
  assert.equal(chipShown(r("degraded")), true);
  assert.equal(chipShown(r("broken")), true);
});

test("the chip's count is the filter its tap opens", () => {
  assert.deepEqual(chipVerdicts({ broken: ["a"], degraded: ["b", "c"] }), ["broken", "degraded"]);
  assert.deepEqual(chipVerdicts({ broken: [], degraded: ["b"] }), ["degraded"]);
  assert.deepEqual(chipVerdicts({ broken: ["a"], degraded: [] }), ["broken"]);
  assert.equal(chipSplit({ broken: ["a"], degraded: ["b", "c"] }), "1 broken · 2 degraded");
  assert.equal(chipSplit({ broken: [], degraded: ["b"] }), "1 degraded");
});
