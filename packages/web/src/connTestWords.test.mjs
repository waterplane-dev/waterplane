import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeLatency, latencyVerdict, throughputBasis } from "./connTestWords.ts";

test("a lost round trip is counted, never averaged into the median", () => {
  const s = summarizeLatency([30, null, 40, 50, null]);
  assert.equal(s.sent, 5);
  assert.equal(s.lost, 2);
  assert.equal(s.median, 40);
  assert.equal(s.best, 30);
  assert.equal(s.worst, 50);
  assert.equal(s.jitter, 10);
});

test("nothing answered: no numbers, and the sentence says it is unreachable", () => {
  const s = summarizeLatency([null, null]);
  assert.equal(s.median, null);
  assert.equal(s.jitter, null);
  assert.match(latencyVerdict(s), /None of 2/);
});

test("the verdict names the loss beside the speed", () => {
  const v = latencyVerdict(summarizeLatency([20, 25, null, 22]));
  assert.match(v, /^Fast/);
  assert.match(v, /1 of 4 got no answer/);
});

test("a swinging delay is said", () => {
  assert.match(latencyVerdict(summarizeLatency([40, 400, 40, 400])), /swings/);
});

test("throughput basis", () => {
  assert.equal(throughputBasis(32 * 1024 * 1024, 2400), "32 MB in 2.4 s");
  assert.equal(throughputBasis(512 * 1024, 300), "512 kB in 300 ms");
});
