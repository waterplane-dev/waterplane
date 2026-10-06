/**
 * The reader's per-turn model bar: a model keeps ONE hue across the whole
 * conversation, shares are money only when every model in the turn is priced,
 * and nothing is drawn for a turn with no request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { REST_SLOT, mixSlots, turnMix } from "./turnMix.ts";

const turn = (models) => ({ id: "x", n: 1, prompt: "", promptLabel: "", blocks: [], toolCount: 0, files: [], sidechains: 0, models });

test("a model's slot is its family's, whatever else ran and however much", () => {
  const turns = [
    turn([{ id: "claude-sonnet-5", tok: 10, costUsd: 0.01 }]),
    turn([{ id: "claude-opus-5-5", tok: 1000, costUsd: 1 }, { id: "claude-sonnet-5", tok: 10, costUsd: 0.01 }]),
  ];
  const s = mixSlots(turns);
  assert.equal(s.of.get("claude-opus-5-5"), 0);
  assert.equal(s.of.get("claude-sonnet-5"), 1);
  assert.equal(turnMix(turns[0], s).parts[0].slot, 1);
  assert.equal(s.rest, null);
  // Sonnet out-spending opus does not swap their colours.
  const flipped = mixSlots([turn([{ id: "claude-sonnet-5", tok: 9000 }, { id: "claude-opus-5-5", tok: 1 }])]);
  assert.equal(flipped.of.get("claude-opus-5-5"), 0);
  assert.equal(flipped.of.get("claude-sonnet-5"), 1);
  assert.equal(mixSlots([turn([{ id: "claude-fable-5-1", tok: 1 }])]).of.get("claude-fable-5-1"), 3);
});

test("models no family owns fold into ONE grey part, never a generated hue", () => {
  const turns = [turn([{ id: "claude-opus-5-5", tok: 50 }, ...[1, 2, 3].map((i) => ({ id: `m${i}`, tok: 10 }))])];
  const s = mixSlots(turns);
  assert.equal(s.rest, REST_SLOT);
  const parts = turnMix(turns[0], s).parts;
  assert.deepEqual(parts.map((p) => [p.slot, p.name, p.tok]), [[0, "opus-5-5", 50], [REST_SLOT, "3 more", 30]]);
  // A second model of an owned family is the tail too: two bands in one hue read as one model.
  const two = mixSlots([turn([{ id: "claude-opus-5-5", tok: 50 }, { id: "claude-opus-4-7", tok: 5 }])]);
  assert.equal(two.of.get("claude-opus-4-7"), undefined);
  assert.equal(two.rest, REST_SLOT);
});

test("shares are by cost only when every model is priced", () => {
  const priced = turn([{ id: "claude-opus-5-5", tok: 900, costUsd: 1 }, { id: "claude-haiku-4-5", tok: 100, costUsd: 3 }]);
  const m = turnMix(priced, mixSlots([priced]));
  assert.equal(m.by, "cost");
  assert.equal(m.parts.find((p) => p.id === "claude-haiku-4-5").share, 0.75);
  const mixed = turn([{ id: "claude-opus-5-5", tok: 900, costUsd: 1 }, { id: "local", tok: 100 }]);
  assert.equal(turnMix(mixed, mixSlots([mixed])).by, "tokens");
});

test("no request, no bar", () => {
  assert.equal(turnMix(turn(undefined), mixSlots([turn(undefined)])), null);
  assert.equal(mixSlots([]), null);
});

test("the bar counts the subagents the turn's figure counts, folded by model", () => {
  const t = { ...turn([{ id: "claude-opus-5-5", tok: 100, costUsd: 1 }]),
    agentModels: [{ id: "claude-opus-5-5", tok: 900, costUsd: 8 }, { id: "claude-sonnet-5-5", tok: 50, costUsd: 1 }] };
  const m = turnMix(t, mixSlots([t]));
  assert.equal(m.by, "cost");
  assert.deepEqual(m.parts.map((p) => [p.id, p.costUsd]), [["claude-opus-5-5", 9], ["claude-sonnet-5-5", 1]]);
});
