// The kit's own tests: the conformance suite on a minimal good plugin, and each check refusing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeApi, runConformance, checks } from "../index.mjs";

const manifest = { id: "demo", name: "Demo", version: "0.1.0", apiVersion: "2.1", backends: ["demo"], env: ["DEMO_BIN"] };
const goodDef = () => ({
  id: "demo", label: "Demo", bin: () => "demo",
  prepare: async () => ({ args: [], instructionsVia: "none", askRulesVia: "none" }),
  caps: { turns: true, slash: "none", permissionModes: [], remoteControl: false },
  facts: { turns: [{ screen: "silence" }] },
  measured: { versions: ["1"], version: async () => null },
  models: async () => ({ aliases: [], ids: [] }),
});
export const activate = (api) => { api.backend(goodDef()); };

runConformance({ activate, manifest, env: { DEMO_BIN: "/nonexistent/demo" } });

test("fakeApi refuses an undeclared backend id and reads only declared env", () => {
  const api = fakeApi({ manifest, env: { DEMO_BIN: "x", OTHER: "y" } });
  assert.throws(() => api.backend({ ...goodDef(), id: "evil" }), /may register only the backends its manifest lists/);
  assert.equal(api.env("DEMO_BIN"), "x");
  assert.equal(api.env("OTHER"), undefined);
});

test("checks refuse the bad cases", () => {
  assert.ok(checks.descriptorProblems({ ...goodDef(), caps: { hooks: true } }).length);
  assert.ok(checks.factProblems({ nonsense: [] }).length);
  assert.ok(checks.factProblems({ turns: [{ screen: "nope" }] }).length);
  assert.ok(checks.sourceSlotProblems({ dialogs: [{ source: true }] }, {}).length);
  assert.equal(checks.sourceSlotProblems({ dialogs: [{ source: true }] }, { dialogs: {} }).length, 0);
  assert.ok(checks.planProblems({ args: [1], instructionsVia: "none", askRulesVia: "none" }).length);
  assert.ok(checks.planProblems({ args: [], askRulesVia: "none" }).length);
  assert.ok(checks.keysProblem("123456789"));
  assert.ok(checks.keysProblem("\x03"));
  assert.equal(checks.keysProblem("2\r"), null);
  assert.ok(checks.typedProblem({ typed: "x".repeat(1001) }));
  assert.ok(checks.typedProblem({ typed: "a\nb" }));
});

// 2.2: a backend with the new slots, asked cold by the conformance suite.
const manifest22 = { id: "demo22", name: "Demo 2.2", version: "0.1.0", apiVersion: "2.2", backends: ["demo22"], env: ["DEMO_BIN"] };
const def22 = () => ({
  ...goodDef(), id: "demo22",
  caps: { turns: true, slash: "own", permissionModes: ["default", "plan"], remoteControl: false },
  facts: { turns: [{ screen: "silence" }], mode: [{ source: true }], commands: [{ source: true }], tokens: [{ source: true }], context: [{ source: true }] },
  sources: {
    attach: async () => ({ close: async () => {}, health: () => ({ state: "down", since: 0 }) }),
    mode: { current: () => "plan", set: async () => ({ keys: "\x1b[Z" }) },
    commands: { list: async () => [{ name: "/compact", description: "Compact the conversation", local: false }, { name: "/model", args: "[name]", local: true }] },
    tokens: { ledger: async () => ({ available: false, reason: "demo" }), session: () => ({ at: 1, tok: 1200, native: { amount: 0.5, unit: "AIC" } }) },
    context: { sample: () => ({ at: 1, usedTok: 900, window: 200000 }), compactions: () => [{ at: 1, preTok: 900, postTok: 100, auto: true }, { at: 2 }] },
  },
});
runConformance({
  activate: (api) => { api.backend(def22()); }, manifest: manifest22, env: { DEMO_BIN: "/nonexistent/demo" },
  answers: async () => [{ label: "mode.set keys", answer: await def22().sources.mode.set({}, "plan") }],
  readings: async () => [{ label: "a parsed /help", kind: "commands", value: await def22().sources.commands.list("/") }],
});

test("2.2 readings: shared's shape rule refuses the bad ones in words", () => {
  const modes = { permissionModes: ["default", "plan"] };
  assert.deepEqual(checks.readingProblems("mode", null, modes), []);
  assert.deepEqual(checks.readingProblems("mode", "plan", modes), []);
  assert.match(checks.readingProblems("mode", "yolo", modes)[0], /not one this backend declares; caps\.permissionModes is: default, plan/);
  assert.match(checks.readingProblems("commands", [{ name: "compact" }])[0], /a slash and one word/);
  assert.match(checks.readingProblems("commands", [{ name: "/a" }, { name: "/a" }])[0], /listed twice/);
  assert.match(checks.readingProblems("commands", Array.from({ length: 201 }, (_, i) => ({ name: `/c${i}` })))[0], /at most 200/);
  assert.match(checks.readingProblems("commands", [{ name: "/a", local: "yes" }])[0], /local is not true or false/);
  assert.match(checks.readingProblems("spend", { at: 1, usd: -1 })[0], /spend\.usd/);
  assert.match(checks.readingProblems("spend", { at: 1, tok: Infinity })[0], /spend\.tok/);
  assert.match(checks.readingProblems("spend", { tok: 1 })[0], /no `at`/);
  assert.match(checks.readingProblems("spend", { at: 1, native: { amount: 2, unit: "USD" } })[0], /not dollars/);
  assert.match(checks.readingProblems("spend", { at: 1, native: { amount: 2 } })[0], /name the unit/);
  assert.deepEqual(checks.readingProblems("spend", { at: 1, usd: 0.25, agentUsd: 0, native: { amount: 3, unit: "AIC", agentAmount: 1 } }), []);
  assert.match(checks.readingProblems("compactions", [{ at: 5 }, { at: 2 }])[0], /oldest first/);
  assert.match(checks.readingProblems("compactions", [{ at: 1, preTok: -3 }])[0], /preTok/);
  assert.match(checks.readingProblems("context", { at: 1, usedTok: 5, window: 0 })[0], /whole number of tokens above 0/);
  assert.match(checks.readingProblems("context", { at: 1, usedTok: 5, window: 1.5 })[0], /window/);
  assert.deepEqual(checks.readingProblems("context", { at: 1, usedTok: 5 }), []);
  assert.match(checks.readingProblems("nonsense", 1)[0], /no reading kind/);
  // Tab and Shift+Tab are one key each (a mode cycle)
  assert.equal(checks.keysProblem("\x1b[Z"), null);
  assert.equal(checks.keysProblem("\t"), null);
  assert.ok(checks.keysProblem("\x1b[Z".repeat(9)));
});
