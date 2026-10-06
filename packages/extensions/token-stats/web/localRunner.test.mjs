/**
 * The Local runner view's words (`localRunner.ts`): totals beside their splits,
 * runner timings never mixed with time to answer, absent families as sentences,
 * rates only from measured sums, and the tab only where there is something.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerCardLines, runnerDayRows, runnerModelView, runnerViews, showRunnerTab, spanFromDay } from "./localRunner.ts";

const Q = "qwen3-coder:30b-64k";
// The spike's three requests, folded (host test `localusage.test.mjs`'s fold).
const qRow = {
  model: Q,
  compute: { requests: 3, promptTok: 26, promptMs: 294.7, cachedTok: 11, genTok: 30, genMs: 229.83 },
  timed: { requests: 3, ms: 4032.93 },
  byApi: { "/v1/messages": 2, "/api/chat": 1 },
  mem: { samples: 3, sumBytes: 3 * 25412721704, peakBytes: 25412721704, sumVram: 3 * 25412721704, peakVram: 25412721704, residentMs: 40000, contextLength: 65536 },
  machine: { samples: 3, usedSum: 150e9, usedPeak: 58e9, availMin: 6e9, totalBytes: 68.7e9, swapPeak: 1.34e9, source: "vm_stat" },
};
const doc = (over = {}) => ({
  available: true, runner: "ollama", url: "http://127.0.0.1:11434", since: 0, lastSampleAt: 1, reachable: true, loaded: [Q],
  intervalMs: 20000, log: { readable: true, file: "/x", readAt: 1 }, unattributedWhy: "why",
  days: [{ day: "2026-10-02", models: [qRow, { model: null, untimed: { requests: 1, ms: 10629 }, byApi: { "/v1/responses": 1 } }] }],
  ...over,
});

test("a model card: busy with its split, tokens with theirs, time to answer apart", () => {
  const v = runnerModelView(qRow);
  assert.equal(v.busy.total, "525 ms");
  assert.deepEqual(v.busy.split, ["prompt processing 295 ms", "generating 230 ms"]);
  assert.equal(v.tokens.total, "67 tokens");
  assert.deepEqual(v.tokens.split, ["prompt processed 26", "prompt reused from the runner's cache 11", "generated 30"]);
  assert.match(v.answer, /^Time to answer 4\.0 s over 3 requests — .*including waiting in the runner's queue/);
  assert.deepEqual(v.requests.split, ["/v1/messages 2", "/api/chat 1"]);
  assert.equal(v.rates.length, 2);
  assert.match(v.rates[1], /^generation 131 tok\/s$/);
  assert.match(v.memory[0], /typical \(mean of 3 samples\)/);
  assert.match(v.machine[1], /^Swap in use at most/);
  assert.deepEqual(v.absent, []);
});

test("the unidentified row: no compute, no memory — each said, never zero", () => {
  const v = runnerModelView({ model: null, untimed: { requests: 1, ms: 10629 } });
  assert.equal(v.title, "model not identified");
  assert.equal(v.busy, null);
  assert.equal(v.tokens, null);
  assert.deepEqual(v.rates, []);
  assert.match(v.untimed, /no runner timings in its log — time to answer only: 11 s/);
  assert.deepEqual(v.absent, [
    "No runner timings for these requests — only their time to answer.",
    "No memory reading — the runner was not sampled while this model was loaded.",
  ]);
  assert.equal(v.requests.split.at(-1), "endpoint not paired 1");
});

test("a resident model nobody asked: memory only, and says no request", () => {
  const v = runnerModelView({ model: Q, mem: qRow.mem });
  assert.equal(v.requests, null);
  assert.deepEqual(v.absent, ["No request tied to this model in this span."]);
});

test("views order identified first; day rows newest first; the span cuts days", () => {
  assert.deepEqual(runnerViews(doc().days).map((v) => v.title), [Q, "model not identified"]);
  const rows = runnerDayRows(doc().days);
  assert.equal(rows[0].model, Q);
  assert.match(rows[0].text, /^busy 525 ms \(prompt 295 ms · generate 230 ms\) · 37 prompt · 30 generated · 3 requests · peak/);
  assert.equal(spanFromDay("all", Date.now()), undefined);
  const now = new Date(2026, 9, 2, 12).getTime();
  assert.equal(spanFromDay("today", now), "2026-10-02");
  assert.equal(spanFromDay("7", now), "2026-09-26");
  assert.deepEqual(runnerViews(doc().days, "2026-10-03"), []);
});

test("the tab exists only where the runner was seen or a day was kept", () => {
  assert.equal(showRunnerTab(null), false);
  assert.equal(showRunnerTab({ available: false, reason: "off" }), false);
  assert.equal(showRunnerTab(doc({ reachable: false, days: [] })), false);
  assert.equal(showRunnerTab(doc({ reachable: true, days: [] })), true);
  assert.equal(showRunnerTab(doc({ reachable: false })), true);
});

test("the All-backends card: lines with splits, or the sentence", () => {
  const c = runnerCardLines(doc());
  assert.match(c.lines[0], /^qwen3-coder:30b-64k — busy 525 ms \(prompt processing 295 ms · generating 230 ms\) — 67 tokens \(/);
  assert.equal(c.lastDay, "2026-10-02");
  assert.equal(runnerCardLines({ available: false, reason: "switched off" }).absent, "switched off");
  assert.match(runnerCardLines(doc({ days: [], reachable: false })).absent, /not running/);
});
