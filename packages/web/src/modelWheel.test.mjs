/**
 * The model wheel's rules, pinned without a browser (`modelWheel.ts`).
 *
 *     node --test packages/web/src/modelWheel.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SPOKES, nodeAt, nodeXY, planPick, pricedId, spokeLabel, switchCostText, wheelCandidates, wheelSpokes } from "./modelWheel.ts";

const G = { spokes: 8, rings: 5, rIn: 40, rOut: 112 };

test("spokes: aliases first, current model always present, capped", () => {
  assert.deepEqual(wheelSpokes({ aliases: ["opus", "sonnet"], ids: ["claude-x"] }, "sonnet"), ["opus", "sonnet"]);
  assert.deepEqual(wheelSpokes({ aliases: ["opus", "sonnet"], ids: [] }, "claude-opus-5-5"), ["opus", "sonnet", "claude-opus-5-5"]);
  assert.deepEqual(wheelSpokes({ aliases: [], ids: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(wheelSpokes({ aliases: [], ids: [] }), []);
  const many = Array.from({ length: 20 }, (_, i) => `m${i}`);
  const s = wheelSpokes({ aliases: many, ids: [] }, "custom");
  assert.equal(s.length, MAX_SPOKES);
  assert.equal(s.at(-1), "custom");
});

test("spokes: a hidden model leaves the wheel, the current one never does", () => {
  const cat = { aliases: ["opus", "sonnet", "haiku", "fable"], ids: ["claude-x"] };
  assert.deepEqual(wheelCandidates(cat), ["opus", "sonnet", "haiku", "fable"]);
  assert.deepEqual(wheelSpokes(cat, "opus", ["haiku", "fable"]), ["opus", "sonnet"]);
  // Hidden but running: kept in its catalogue place, not moved to the end.
  assert.deepEqual(wheelSpokes(cat, "haiku", ["haiku", "fable"]), ["opus", "sonnet", "haiku"]);
  // Hiding frees room under the cap for a model past it.
  const many = Array.from({ length: 12 }, (_, i) => `m${i}`);
  const s = wheelSpokes({ aliases: many, ids: [] }, undefined, ["m0", "m1"]);
  assert.equal(s.length, MAX_SPOKES);
  assert.equal(s[0], "m2");
  // A current model past the cap takes the last place, never a tenth spoke.
  const t = wheelSpokes({ aliases: many, ids: [] }, "m11");
  assert.equal(t.length, MAX_SPOKES);
  assert.equal(t.at(-1), "m11");
});

test("spoke label names the 1M window in words", () => {
  assert.equal(spokeLabel("opus[1m]"), "opus 1M");
  assert.equal(spokeLabel("haiku"), "haiku");
});

test("hit test: every drawn node maps back to itself", () => {
  for (let s = 0; s < G.spokes; s++) {
    for (let r = 0; r < G.rings; r++) {
      const { x, y } = nodeXY(s, r, G);
      assert.deepEqual(nodeAt(x, y, G), { spoke: s, ring: r }, `node ${s}/${r}`);
    }
  }
});

test("hit test: a finger between rings picks the nearer one, never a far one", () => {
  // Straight up = spoke 0; ring step is 18.
  assert.deepEqual(nodeAt(0, -(40 + 8), G), { spoke: 0, ring: 0 });
  assert.deepEqual(nodeAt(0, -(40 + 10), G), { spoke: 0, ring: 1 });
  // Just left of straight up still belongs to spoke 0, not the last spoke.
  assert.deepEqual(nodeAt(-5, -100, G), { spoke: 0, ring: 3 });
});

test("hit test: the centre and far outside are not picks", () => {
  assert.equal(nodeAt(0, 0, G), null);
  assert.equal(nodeAt(5, 5, G), null);
  assert.equal(nodeAt(0, -200, G), null);
  // Just past the rim still counts as the rim.
  assert.deepEqual(nodeAt(0, -125, G), { spoke: 0, ring: 4 });
});

test("hit test: one ring (no efforts) picks only the spoke", () => {
  const g = { spokes: 4, rings: 1, rIn: 40, rOut: 112 };
  assert.deepEqual(nodeAt(90, 0, g), { spoke: 1, ring: 0 });
  assert.deepEqual(nodeAt(0, 60, g), { spoke: 2, ring: 0 });
});

const LIVE = { slash: true, effort: true };

test("plan: both are live on claude — /model then /effort, no restart", () => {
  const cur = { model: "opus", effort: "high" };
  assert.deepEqual(planPick(cur, { model: "sonnet", effort: "high" }, LIVE), { kind: "live", commands: ["/model sonnet"], model: "sonnet" });
  assert.deepEqual(planPick(cur, { model: "opus", effort: "max" }, LIVE), { kind: "live", commands: ["/effort max"], effort: "max" });
  assert.deepEqual(planPick(cur, { model: "sonnet", effort: "low" }, LIVE),
    { kind: "live", commands: ["/model sonnet", "/effort low"], model: "sonnet", effort: "low" });
  // A session on the default effort picking one is a change.
  assert.deepEqual(planPick({ model: "opus" }, { model: "opus", effort: "medium" }, LIVE), { kind: "live", commands: ["/effort medium"], effort: "medium" });
});

test("plan: no slash → one relaunch carrying whatever changed", () => {
  const cur = { model: "opus", effort: "high" };
  const off = { slash: false, effort: false };
  assert.deepEqual(planPick(cur, { model: "sonnet", effort: "high" }, off), { kind: "relaunch", patch: { model: "sonnet" } });
  assert.deepEqual(planPick(cur, { model: "sonnet", effort: "low" }, off), { kind: "relaunch", patch: { model: "sonnet", effort: "low" } });
});

test("plan: slash but no live effort → an effort change relaunches, a model change stays live", () => {
  const cur = { model: "a", effort: "high" };
  const half = { slash: true, effort: false };
  assert.deepEqual(planPick(cur, { model: "b", effort: "high" }, half), { kind: "live", commands: ["/model b"], model: "b" });
  assert.deepEqual(planPick(cur, { model: "b", effort: "low" }, half), { kind: "relaunch", patch: { model: "b", effort: "low" } });
});

test("plan: picking where the session already is does nothing", () => {
  assert.deepEqual(planPick({ model: "opus", effort: "high" }, { model: "opus", effort: "high" }, LIVE), { kind: "none" });
  // No effort concept on this backend.
  assert.deepEqual(planPick({ model: "a" }, { model: "a", effort: null }, { slash: false, effort: false }), { kind: "none" });
});

const IDS = ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-4-5"];

test("pricedId: ids as themselves, aliases as the newest of their family, the rest null", () => {
  assert.equal(pricedId("claude-opus-5-5", IDS), "claude-opus-5-5");
  assert.equal(pricedId("opus", IDS), "claude-opus-5-5");
  assert.equal(pricedId("opus[1m]", IDS), "claude-opus-5-5");
  assert.equal(pricedId("haiku", IDS), "claude-haiku-4-5");
  assert.equal(pricedId("opusplan", IDS), null);
  assert.equal(pricedId("my-model", IDS), null);
  assert.equal(pricedId("fable", IDS), null); // no fable id in this catalogue
});

const SW = { ids: IDS, tok: 200_000, baseTok: 40_000, cold: false };

test("switch cost: a model switch re-writes the whole context at the NEW model's 1h write rate", () => {
  const t = switchCostText({ ...SW, from: { model: "claude-opus-5-5", effort: "medium" }, to: { model: "haiku", effort: "medium" } });
  // 200k × $1 × 2 = $0.40 written on haiku; 200k × $0.20 = $0.04 re-read on opus 5.5.
  assert.match(t, /all 200k tokens/);
  assert.match(t, /≈ \$0\.40 at list prices \(as claude-haiku-4-5\)/);
  assert.match(t, /staying re-reads it for ≈ \$0\.04/);
});

test("switch cost: effort alone re-writes the conversation, not the preamble", () => {
  const t = switchCostText({ ...SW, from: { model: "claude-opus-5-5", effort: "medium" }, to: { model: "claude-opus-5-5", effort: "high" } });
  // (200k − 40k) × $4 × 2 = $1.28.
  assert.match(t, /about 160k tokens/);
  assert.match(t, /≈ \$1\.28/);
});

test("switch cost: absent facts drop the money, never invent it", () => {
  assert.equal(switchCostText({ ...SW, from: { model: "opus", effort: "high" }, to: { model: "opus", effort: "high" } }), null);
  assert.doesNotMatch(switchCostText({ ...SW, tok: null, from: { model: "opus" }, to: { model: "haiku", effort: null } }), /\$/);
  assert.doesNotMatch(switchCostText({ ...SW, from: { model: "opus" }, to: { model: "opusplan", effort: null } }), /\$/);
  assert.doesNotMatch(switchCostText({ ...SW, baseTok: null, from: { model: "opus", effort: "low" }, to: { model: "opus", effort: "high" } }), /\$/);
});

test("switch cost: a cache that already expired makes the switch free of extra", () => {
  const t = switchCostText({ ...SW, cold: true, from: { model: "opus" }, to: { model: "haiku", effort: null } });
  assert.match(t, /adds nothing/);
  assert.doesNotMatch(t, /\$/);
});
