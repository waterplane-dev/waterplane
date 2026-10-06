// Peer desktops, WP8 (`shared/src/peer.ts`): what a delegated job cost and why a
// peer session exists — read field by field, worded once, never summed silently.
import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanPeerJobCost, peerCostParts, peerDurationText, peerJobLine, peerJobOriginText, peerModelName,
  peerReportPrompt, peerSpendSplit, peerWeekSpend, peerWeekText, turnCostParts,
} from "../dist/index.js";

const view = (over = {}) => ({ id: "j", state: "done", peerApi: 1, version: "x", intentId: "i", sessionId: "s9", ...over });
const report = { ok: true, text: "all green", truncated: false, artifacts: [] };

test("cleanPeerJobCost: each field stands alone, a bad one is dropped never zeroed", () => {
  const c = cleanPeerJobCost({ usd: 0.84, tokens: { in: 10, out: 20, cacheRead: 3000, cacheWrite: 400 }, model: "claude-opus-5-5-20260901", durationMs: 360_000, weekPct: 0.05 });
  assert.deepEqual(c, { usd: 0.84, tokens: { in: 10, out: 20, cacheRead: 3000, cacheWrite: 400 }, model: "opus-5-5", durationMs: 360_000, weekPct: 0.05 });
  // usd 0 reads as free; a negative, NaN or string is no reading at all
  for (const usd of [0, -1, NaN, "1", Infinity]) assert.equal(cleanPeerJobCost({ usd })?.usd, undefined, String(usd));
  // a split missing a kind is not a split; all-zero is no reading
  assert.equal(cleanPeerJobCost({ tokens: { in: 1, out: 2, cacheRead: 3 } }), undefined);
  assert.equal(cleanPeerJobCost({ tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }), undefined);
  // the rest survives a bad neighbour
  assert.deepEqual(cleanPeerJobCost({ usd: "x", durationMs: 60_000, weekPct: 400 }), { durationMs: 60_000 });
  assert.equal(cleanPeerJobCost(null), undefined);
  assert.equal(cleanPeerJobCost({}), undefined);
});

test("peerModelName: the alias, never a raw dated id; junk is null", () => {
  assert.equal(peerModelName("claude-opus-5-5"), "opus-5-5");
  assert.equal(peerModelName("claude-sonnet-5-20260801"), "sonnet-5");
  assert.equal(peerModelName("claude-opus-5[1m]"), "opus-5");
  assert.equal(peerModelName("<script>"), null);
  assert.equal(peerModelName(7), null);
});

test("peerDurationText and peerWeekText", () => {
  assert.equal(peerDurationText(30_000), "<1 min");
  assert.equal(peerDurationText(6 * 60_000 + 5), "6 min");
  assert.equal(peerDurationText(80 * 60_000), "1 h 20 min");
  assert.equal(peerDurationText(120 * 60_000), "2 h");
  assert.equal(peerDurationText(27 * 3600_000), "1 d 3 h");
  assert.equal(peerDurationText(0), "");
  assert.equal(peerDurationText(undefined), "");
  assert.equal(peerWeekText(0.05), "≈0.05% of week");
  assert.equal(peerWeekText(2.345), "≈2.3% of week");
  assert.equal(peerWeekText(undefined), "");
});

test("peerReportPrompt: the head carries the cost parts that were measured, in order", () => {
  const p = peerReportPrompt("pc", view({ report, cost: { usd: 0.84, model: "opus-5-5", durationMs: 6 * 60_000 } }));
  assert.ok(p.startsWith("[report from peer pc · $0.84 · opus-5-5 · 6 min] The job finished on pc."), p);
  assert.ok(peerReportPrompt("pc", view({ report, cost: { durationMs: 6 * 60_000 } })).startsWith("[report from peer pc · 6 min]"));
  // no cost: the mark exactly as it always was
  assert.ok(peerReportPrompt("pc", view({ report })).startsWith("[report from peer pc] The job"));
  assert.deepEqual(peerCostParts(undefined), []);
});

test("peerJobLine: one line per job, state words, cost only where measured", () => {
  assert.equal(peerJobLine({ peer: "pc", state: "running", label: "run e2e" }), "sent to pc: run e2e · running");
  assert.equal(peerJobLine({ peer: "pc", state: "done", label: "run e2e", cost: { usd: 0.84, durationMs: 360_000 } }), "sent to pc: run e2e · done · $0.84 · 6 min");
  assert.equal(peerJobLine({ peer: "pc", state: "unreachable" }), "sent to pc: a job · unreachable");
  assert.equal(peerJobLine({ peer: "pc", state: "bogus" }), "");
  assert.equal(peerJobLine(null), "");
});

test("peerSpendSplit: never a total without its split", () => {
  const s = peerSpendSplit(22.28, [{ peer: "pc", cost: { usd: 0.84 } }]);
  assert.equal(s.text, "$22.28 here + $0.84 on pc");
  assert.doesNotMatch(s.text, /23\.12/); // the sum is never printed
  // two peers, and a job nobody could price is counted not charged zero
  const t = peerSpendSplit(1, [{ peer: "pc", cost: { usd: 0.5 } }, { peer: "pc", cost: { usd: 0.25 } }, { peer: "vm", cost: { usd: 0.1 } }, { peer: "vm" }]);
  assert.equal(t.text, "$1.00 here + $0.75 on pc + $0.10 on vm · 1 peer job not priced");
  assert.equal(t.unpriced, 1);
  // this desktop unpriced: says so rather than dropping the half
  assert.equal(peerSpendSplit(null, [{ peer: "pc", cost: { usd: 0.84 } }]).text, "$0.84 on pc (this desktop's share is not priced)");
  // nothing priced on any peer, or no jobs: no split to show
  assert.equal(peerSpendSplit(5, [{ peer: "pc", cost: { durationMs: 1 } }]), null);
  assert.equal(peerSpendSplit(5, []), null);
});

test("peerWeekSpend: only jobs wholly inside the window, a straddler counted not prorated", () => {
  const from = 1_000_000, to = 2_000_000;
  const jobs = [
    { peer: "pc", since: 1_100_000, endedAt: 1_200_000, cost: { usd: 0.84 } },
    { peer: "pc", since: 900_000, endedAt: 1_100_000, cost: { usd: 9 } }, // started before the window
    { peer: "pc", since: 1_900_000, cost: { usd: 3 } },                   // still running
    { peer: "pc", since: 1_300_000, endedAt: 1_400_000 },                 // nothing measured
    { peer: "pc", since: 100, endedAt: 200, cost: { usd: 4 } },           // long before
  ];
  const w = peerWeekSpend(jobs, from, to);
  assert.equal(w.usd, 0.84);
  assert.equal(w.text, "incl. $0.84 on pc");
  assert.equal(w.straddling, 2);
  assert.equal(peerWeekSpend(jobs.slice(1), from, to), null);
  assert.equal(peerWeekSpend(jobs, to, from), null);
});

test("turnCostParts: a week share whose calibration counted peer jobs says so", () => {
  const p = turnCostParts({ costUsd: 1, usdPerWeekPct: 20, weekIncl: "incl. $0.84 on pc" });
  assert.match(p.note, /% of week estimated from this desktop's spend \(incl\. \$0\.84 on pc\) against the weekly limit reading/);
  // no peer in it: the note exactly as before
  assert.match(turnCostParts({ costUsd: 1, usdPerWeekPct: 20 }).note, /this desktop's spend against the weekly/);
  // no share drawn: no label either
  assert.doesNotMatch(turnCostParts({ costUsd: 1, weekIncl: "incl. $0.84 on pc" }).note, /incl\./);
});

test("peerJobOriginText: why a peer session exists", () => {
  assert.equal(peerJobOriginText({ from: "mac", jobId: "j", askerLabel: "repo · fix the tests", label: "run e2e" }), "job from mac · repo · fix the tests · run e2e");
  assert.equal(peerJobOriginText({ from: "mac", jobId: "j" }), "job from mac");
  assert.equal(peerJobOriginText({ from: "mac", jobId: "j", askerLabel: "  a\n b " }), "job from mac · a b");
  assert.equal(peerJobOriginText(undefined), "");
});
