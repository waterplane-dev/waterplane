/**
 * The parallel-agent count's pure half: the sum, the marks and when a mark is
 * worth a toast. The strip and the toast read these and decide nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_WARN_DEFAULT, agentCountText, agentLevel, cleanAgentWarn, countAgents, levelRose,
} from "./agentCount.ts";

test("a working session counts once, each subagent once, an idle session with agents only through them", () => {
  const c = countAgents([
    { working: true, agents: 0 },
    { working: true, agents: 3 },
    { working: false, agents: 2 },
    { working: false, agents: 0 },
  ]);
  assert.deepEqual(c, { sessions: 2, subagents: 5, total: 7 });
});

test("more than the mark, not at it", () => {
  const cfg = { warn: 10, alarm: 30 };
  assert.equal(agentLevel(10, cfg), "ok");
  assert.equal(agentLevel(11, cfg), "warn");
  assert.equal(agentLevel(30, cfg), "warn");
  assert.equal(agentLevel(31, cfg), "alarm");
});

test("a mark at 0 is off", () => {
  assert.equal(agentLevel(500, { warn: 0, alarm: 0 }), "ok");
  assert.equal(agentLevel(500, { warn: 10, alarm: 0 }), "warn");
  assert.equal(agentLevel(500, { warn: 0, alarm: 30 }), "alarm");
});

test("only a rise is worth a toast", () => {
  assert.equal(levelRose("ok", "warn"), true);
  assert.equal(levelRose("warn", "alarm"), true);
  assert.equal(levelRose("ok", "alarm"), true);
  assert.equal(levelRose("alarm", "warn"), false);
  assert.equal(levelRose("warn", "warn"), false);
});

test("a stored value: garbage falls back per mark to the default, never to off", () => {
  assert.deepEqual(cleanAgentWarn(null), AGENT_WARN_DEFAULT);
  assert.deepEqual(cleanAgentWarn({ warn: "x", alarm: 40 }), { warn: 10, alarm: 40 });
  assert.deepEqual(cleanAgentWarn({ warn: 0, alarm: -1 }), { warn: 0, alarm: 30 });
  assert.deepEqual(cleanAgentWarn({ warn: 2.5, alarm: 1e6 }), AGENT_WARN_DEFAULT);
});

test("the total is said with its split", () => {
  assert.equal(agentCountText({ sessions: 1, subagents: 12, total: 13 }),
    "13 agents running at once on the desktop: 1 session working + 12 subagents");
});

import { agentSeries, orderAgentRows, pushAgentSample, stripForced, AGENT_SAMPLE_MS } from "./agentCount.ts";

test("the forced strip: past a mark, until closed at that level; a higher mark brings it back", () => {
  assert.equal(stripForced("ok", null), false);
  assert.equal(stripForced("warn", null), true);
  assert.equal(stripForced("warn", "warn"), false);
  assert.equal(stripForced("alarm", "warn"), true);
  assert.equal(stripForced("warn", "alarm"), false);
});

test("the ring keeps the newest, and a gap is a break, never bridged", () => {
  let ring = [];
  for (let i = 0; i < 5; i++) ring = pushAgentSample(ring, { at: i, total: i, sessions: 0, subagents: i }, 3);
  assert.deepEqual(ring.map((s) => s.total), [2, 3, 4]);
  const t = (at, total) => ({ at, total, sessions: 0, subagents: total });
  assert.deepEqual(agentSeries([t(0, 1), t(AGENT_SAMPLE_MS, 2), t(AGENT_SAMPLE_MS * 10, 3)]), [1, 2, null, 3]);
});

test("rows: only sessions that count, busiest first", () => {
  const r = (id, working, n) => ({ id, label: id, repo: "r", working, agents: Array.from({ length: n }, () => ({ what: "x", startedAt: 0 })) });
  assert.deepEqual(orderAgentRows([r("a", true, 0), r("b", false, 0), r("c", false, 3), r("d", true, 3)]).map((x) => x.id), ["d", "c", "a"]);
});
