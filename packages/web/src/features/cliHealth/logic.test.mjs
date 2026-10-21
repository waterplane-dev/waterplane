import test from "node:test";
import assert from "node:assert/strict";

import { chipShown, chipSplit, chipVerdicts, cliRank, inspectPrompt, worsened } from "./logic.ts";

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

const SRC = { repo: "/r/waterplane", stateDir: "/s/state" };

test("the inspect prompt names the signal, its record and its captures", () => {
  const p = inspectPrompt({ id: "deliver.submit", name: "Confirming a submitted prompt started a turn", verdict: "degraded",
    version: "2.1.306", sentence: "It is degraded.", via: "press-and-look · last 1m ago", sample: "1 line, 20 chars",
    sampleAgo: "1m ago", stats: "4 of the last 16 failed" }, SRC);
  assert.match(p, /`deliver\.submit`/);
  assert.match(p, /\/s\/state\/clihealth\.json/);
  assert.match(p, /\/s\/state\/clifixtures\/2\.1\.306\//);
  assert.match(p, /1 line, 20 chars/);
  assert.match(p, /press-and-look/);
});

test("a block-notice sample is pointed at, never quoted into a prompt", () => {
  const p = inspectPrompt({ id: "limit.reset", name: "Reading when a usage block ends", verdict: "broken",
    version: null, sentence: "It is broken.", sample: "SECRET-NOTICE-TEXT" }, SRC);
  assert.doesNotMatch(p, /SECRET-NOTICE-TEXT/);
  assert.match(p, /never print it/);
});
