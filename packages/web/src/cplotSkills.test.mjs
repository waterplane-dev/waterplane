/**
 * The skills chart's rows and sentences, pinned without a browser.
 *
 *     node --test packages/web/src/cplotSkills.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makePlot } from "./contextPlot.ts";
import {
  allSkillLoads, skillAtPoint, skillReadout, skillRepeatText, skillRows, skillSummary, skillTokText, SKILL_ROW_H,
} from "./contextPlot/cplotSkills.ts";

const T0 = Date.parse("2026-10-21T20:00:00Z");
const samples = [{ t: T0, tok: 1000 }, { t: T0 + 600_000, tok: 2000 }];
const plot = () => makePlot({ width: 300, height: 100, pad: { top: 4, right: 10, bottom: 20, left: 40 }, samples, events: [], windowTok: null, refs: [], agents: [] });
const own = [{ t: T0 + 60_000, name: "host", chars: 8000 }, { t: T0 + 120_000, name: "web", chars: 4000 }];
const agents = [
  { id: "a1", at: T0 + 100_000, endAt: T0 + 200_000, tok: 1, type: "Explore", skills: [{ t: T0 + 110_000, name: "host", chars: 8000 }] },
  { id: "a2", at: T0 + 300_000, endAt: T0 + 400_000, tok: 1 },
];

test("one row per skill, in order of its first load, the conversation's and the agents' together", () => {
  const rows = skillRows(plot(), own, agents);
  assert.deepEqual(rows.map((r) => [r.name, r.marks.length]), [["host", 2], ["web", 1]]);
  assert.equal(rows[0].marks[1].agent.id, "a1");
  assert.equal(rows[0].marks[0].agent, undefined);
});

test("a load outside the readings is clamped into the plot, never off the edge", () => {
  const p = plot();
  const rows = skillRows(p, [{ t: T0 - 3_600_000, name: "early", chars: 1 }], []);
  assert.equal(rows[0].marks[0].x, p.x);
});

test("the pointer picks within its row, nearest in x", () => {
  const rows = skillRows(plot(), own, agents);
  const hit = skillAtPoint(rows, 4, 0, 4 + SKILL_ROW_H + 5);
  assert.equal(hit.load.name, "web");
  assert.equal(skillAtPoint([], 4, 0, 0), null);
});

test("the token figure is always an estimate, said with its sign", () => {
  assert.match(skillTokText(8000), /^≈2(\.0)?k tokens$/);
});

test("the headline names whose loads they were; none is null, not a zero", () => {
  assert.equal(skillSummary([], []), null);
  assert.equal(skillSummary(undefined, []), null);
  const s = skillSummary(own, agents);
  assert.match(s, /^2 skills · 3 loads, 2 by this conversation, 1 by subagents · ≈/);
  assert.match(skillSummary(own, []), /all by this conversation/);
  assert.equal(allSkillLoads(own, agents).length, 3);
});

test("the repeat sentence appears only for a skill loaded more than once", () => {
  assert.match(skillRepeatText(skillRows(plot(), own, agents)), /^host was loaded 2 times/);
  assert.equal(skillRepeatText(skillRows(plot(), [own[1]], [])), null);
});

test("a tapped mark says who loaded it", () => {
  const rows = skillRows(plot(), own, agents);
  assert.match(skillReadout(rows[0].marks[1], 600_000), /^host · .* · by a subagent \(Explore\) · /);
  assert.match(skillReadout(rows[1].marks[0], 600_000), /by this conversation/);
});
