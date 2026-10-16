import test from "node:test";
import assert from "node:assert/strict";

import { FANOUT_LANE, fanoutCostWords, fanoutToast, followUpLane, followUpToast } from "./logic.ts";

test("every sweep shares one lane; each run's follow-ups have their own", () => {
  assert.equal(FANOUT_LANE, "fanout");
  assert.equal(followUpLane("r1"), "fu:r1");
});

test("the sweep receipt counts repos, or says it waits for the link", () => {
  assert.equal(fanoutToast(false, 1), "fanning out to 1 repo");
  assert.equal(fanoutToast(false, 3), "fanning out to 3 repos");
  assert.equal(fanoutToast(true, 3), "queued — the sweep runs when the link is back");
});

test("the follow-up receipt counts sessions, or says it waits for the link", () => {
  assert.equal(followUpToast(false, 1), "following up in 1 session");
  assert.equal(followUpToast(false, 2), "following up in 2 sessions");
  assert.equal(followUpToast(true, 2), "queued — the follow-up goes out when the link is back");
});

const z = { total: 0 };
const convo = (id, runId, repo, total, agent) => ({ id, repo, label: repo, launch: { kind: "fanout", runId }, cost: { total }, agentCost: { total: agent }, totals: z, agentTotals: z });

test("the cost hint reads the run's own launch row, and is absent when the logs hold none of it", () => {
  const doc = { convos: [convo("a", "r1", "/x", 100, 60), convo("b", "r1", "/y", 100, 80), convo("c", "r2", "/z", 5, 0)] };
  const run = { id: "r1", text: "Review  everything", startedAt: 0, finishedAt: 1, targets: [] };
  const same = fanoutCostWords(doc, run, "review everything");
  assert.match(same, /^last similar run \(2 repos\): \$200\.00, 70% subagents$/);
  assert.match(fanoutCostWords(doc, run, "something else"), /^last run \(different prompt, 2 repos\)/);
  assert.equal(fanoutCostWords(doc, { ...run, id: "gone" }, "x"), null);
  assert.equal(fanoutCostWords({ convos: [] }, run, "x"), null);
});

test("the cost hint counts the targets the host folded past its cap, and their repos", () => {
  const folded = { repo: "/w", label: "w", launch: { kind: "fanout", runId: "r1" }, count: 40, agents: 0, cost: { total: 20 }, agentCost: { total: 0 }, totals: z, agentTotals: z, byModel: [], firstAt: null, lastAt: null };
  const doc = { convos: [convo("a", "r1", "/x", 100, 60), convo("b", "r1", "/y", 100, 80)], rest: [folded] };
  const run = { id: "r1", text: "review", startedAt: 0, finishedAt: 1, targets: [] };
  // $200 listed + $20 folded; agents $140 of $220 = 64%; three repos, the folded one included.
  assert.equal(fanoutCostWords(doc, run, "review"), "last similar run (3 repos): $220.00, 64% subagents");
  // A run whose every target was folded is still found.
  assert.match(fanoutCostWords({ convos: [], rest: [folded] }, run, "review"), /^last similar run \(1 repo\): \$20\.00/);
});
