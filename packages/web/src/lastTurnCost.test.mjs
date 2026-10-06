/**
 * The terminal's last-prompt cost strip: which turn it speaks for, what it
 * calls that turn, and the one-line chip — absent rather than zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { agentsSoFarAt, hasFigures, lastCostTurn, lastTurnChip, lastTurnLabel, lastTurnNote, lastTurnWhich, turnAgents } from "./lastTurnCost.ts";

const turn = (n, extra = {}) => ({
  id: `t${n}`, n, prompt: "", promptLabel: "", blocks: [], toolCount: 0, files: [], sidechains: 0, ...extra,
});

test("a turn with no measured number has no figures — and neither do markers or queued prompts", () => {
  assert.equal(hasFigures(turn(1)), false);
  assert.equal(hasFigures(turn(1, { costUsd: 0, ctxTok: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })), false);
  assert.equal(hasFigures(turn(1, { costUsd: 0.5 })), true);
  assert.equal(hasFigures(turn(1, { ctxTok: 1000 })), true);
  assert.equal(hasFigures(turn(1, { models: [{ id: "claude-opus-5-5", tok: 10 }] })), true);
  assert.equal(hasFigures(turn(1, { marker: "compaction", costUsd: 1 })), false);
  assert.equal(hasFigures(turn(1, { queued: true, costUsd: 1 })), false);
});

test("the newest turn WITH figures, skipping a newer one without", () => {
  const turns = [turn(1, { costUsd: 1 }), turn(2, { costUsd: 2 }), turn(3)];
  assert.equal(lastCostTurn(turns)?.n, 2);
  assert.equal(lastCostTurn([turn(1), turn(2)]), null);
  assert.equal(lastCostTurn([]), null);
});

test("agents so far: any turn up to this one started one", () => {
  const turns = [turn(1), turn(2, { sidechains: 1 }), turn(3)];
  assert.equal(agentsSoFarAt(turns, "t1"), false);
  assert.equal(agentsSoFarAt(turns, "t2"), true);
  assert.equal(agentsSoFarAt(turns, "t3"), true);
  assert.equal(turnAgents(turn(4, { blocks: [{ kind: "tool", name: "Task" }, { kind: "tool", name: "Bash" }] })), 1);
});

test("which prompt: finished, the running one so far, or the previous one", () => {
  const t = turn(7, { costUsd: 1, sentAt: 100_000 });
  assert.equal(lastTurnWhich(t, false, 100_000), "last");
  assert.equal(lastTurnWhich(t, true, 100_500), "running");
  assert.equal(lastTurnWhich(t, true, 500_000), "previous");
  // No start time on the wire: never claim the figures are the running turn's.
  assert.equal(lastTurnWhich(t, true, undefined), "previous");
  assert.match(lastTurnLabel(t, "last"), /^last prompt #7$/);
  assert.match(lastTurnLabel(t, "running"), /#7 so far · running/);
  assert.match(lastTurnLabel(t, "previous"), /newer one is running/);
  // The reader folds every turn: an older one is just "prompt #n", never "last".
  assert.equal(lastTurnLabel(t, "earlier"), "prompt #7");
  assert.equal(lastTurnNote("last"), null);
  assert.equal(lastTurnNote("earlier"), null);
  assert.match(lastTurnNote("previous"), /replace these when it ends/);
});

test("the chip: dollars (agents folded in) and context, tokens when unpriced, null with neither", () => {
  assert.equal(lastTurnChip(turn(1, { costUsd: 4.5, agentCostUsd: 17, ctxTok: 306_000 })), "$21.50 · 306k ctx");
  assert.equal(lastTurnChip(turn(1, { tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 } })), "2k tokens");
  assert.equal(lastTurnChip(turn(1, { models: [{ id: "x", tok: 3 }] })), null);
  assert.equal(lastTurnChip(turn(1, { costUsd: 0, ctxTok: 0 })), null);
});
