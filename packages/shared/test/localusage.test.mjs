/**
 * The local runner ledger's folds and sentences (`shared/localusage.ts`):
 * sums add, peaks take the max, the least-available takes the min, a field
 * nobody measured stays absent through every fold, a rate is a ratio of sums.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addModelDay, computeMs, fmtDurationMs, localModelTotals, localUsageNotes, meanOf, requestCount, tokPerSec,
} from "../dist/index.js";

const Q = "qwen3-coder:30b-64k";
const day = (d, ...models) => ({ day: d, models });

test("addModelDay: sums, peaks, mins — and absent stays absent", () => {
  const a = { model: Q, compute: { requests: 1, promptTok: 10, promptMs: 5, cachedTok: 2, genTok: 4, genMs: 8 },
    mem: { samples: 1, sumBytes: 100, peakBytes: 100, sumVram: 100, peakVram: 100, residentMs: 0, contextLength: 65536 },
    machine: { samples: 1, usedSum: 50, usedPeak: 50, availMin: 14, totalBytes: 64, source: "vm_stat" } };
  const b = { model: Q, untimed: { requests: 2, ms: 300 }, byApi: { "/v1/messages": 2 },
    mem: { samples: 1, sumBytes: 120, peakBytes: 120, sumVram: 120, peakVram: 120, residentMs: 20000 },
    machine: { samples: 1, usedSum: 60, usedPeak: 60, availMin: 4, totalBytes: 64, swapPeak: 2, source: "vm_stat" } };
  const s = addModelDay(a, b);
  assert.deepEqual(s.compute, a.compute);
  assert.deepEqual(s.untimed, { requests: 2, ms: 300 });
  assert.equal(s.timed, undefined);
  assert.equal(s.loads, undefined);
  assert.deepEqual(s.mem, { samples: 2, sumBytes: 220, peakBytes: 120, sumVram: 220, peakVram: 120, residentMs: 20000, contextLength: 65536 });
  assert.deepEqual(s.machine, { samples: 2, usedSum: 110, usedPeak: 60, availMin: 4, totalBytes: 64, swapPeak: 2, source: "vm_stat" });
  assert.equal(a.untimed, undefined, "inputs untouched");
});

test("localModelTotals: per model over a span, the unidentified row last", () => {
  const days = [
    day("2026-09-30", { model: Q, compute: { requests: 1, promptTok: 1, promptMs: 1000, cachedTok: 0, genTok: 1, genMs: 1000 } }),
    day("2026-10-01", { model: null, untimed: { requests: 1, ms: 50 } }, { model: "gemma4:e4b", compute: { requests: 1, promptTok: 1, promptMs: 10, cachedTok: 0, genTok: 1, genMs: 10 } }),
    day("2026-10-02", { model: Q, compute: { requests: 2, promptTok: 3, promptMs: 500, cachedTok: 1, genTok: 2, genMs: 500 } }),
  ];
  const all = localModelTotals(days);
  assert.deepEqual(all.map((m) => m.model), [Q, "gemma4:e4b", null]);
  assert.equal(all[0].compute.requests, 3);
  assert.equal(computeMs(all[0]), 3000);
  const recent = localModelTotals(days, "2026-10-01");
  assert.equal(recent[0].compute.requests, 2, "the cut drops days before it");
  assert.equal(requestCount(all[2]), 1);
});

test("rates only from measured sums; means only over a count", () => {
  assert.equal(tokPerSec(80, 1000), 80);
  assert.equal(tokPerSec(0, 1000), null);
  assert.equal(tokPerSec(10, 0), null);
  assert.equal(tokPerSec(undefined, 5), null);
  assert.equal(meanOf(300, 3), 100);
  assert.equal(meanOf(300, 0), null);
});

test("durations", () => {
  assert.equal(fmtDurationMs(850), "850 ms");
  assert.equal(fmtDurationMs(3400), "3.4 s");
  assert.equal(fmtDurationMs(252_000), "4 min 12 s");
  assert.equal(fmtDurationMs(7_800_000), "2 h 10 min");
});

test("absent states are different sentences, never collapsed", () => {
  const base = { available: true, runner: "ollama", url: "http://127.0.0.1:11434", since: 0, lastSampleAt: 5, reachable: true,
    loaded: [], intervalMs: 20000, log: { readable: true, file: "/x", readAt: 1 }, days: [], unattributedWhy: "" };
  const t = () => "then";
  assert.deepEqual(localUsageNotes(base, t), ["No request seen yet — the runner's log has recorded no completed request since then."]);
  const down = localUsageNotes({ ...base, reachable: false }, t);
  assert.match(down[0], /^Ollama is not running/);
  const nolog = localUsageNotes({ ...base, log: { readable: false, file: null, reason: "on Linux it logs to the journal." } }, t);
  assert.equal(nolog.length, 1, "no 'no request yet' when the log could not be read — that would be a claim");
  assert.match(nolog[0], /^Server log not readable: on Linux/);
  const fresh = localUsageNotes({ ...base, reachable: null }, t);
  assert.match(fresh[0], /not been asked yet/);
});
