/**
 * P4c (phone consumers of the 2.2 wire caps): live mode for `caps.modes`, the backend's own slash
 * list for `caps.commands`, fork by cap and by the backend's own record.
 *     node --test packages/web/src/p4c.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { liveModesHere, modesReason, ownCommandsHere, sessionCants } from "./backendCaps.ts";
import { exactLog } from "./forkAnchor.ts";

const caps = (o = {}) => ({
  contextMeter: false, usageLimits: false, transcript: true, slash: false,
  promptBoxes: false, hooks: false, effort: false, remoteControl: false,
  permissionModes: ["default", "plan"], ...o,
});
const CLAUDE = { id: "claude", label: "Claude Code", caps: caps({ contextMeter: true, usageLimits: true, slash: true, promptBoxes: true, hooks: true, effort: true }) };
const PLAIN = { id: "codex", label: "Codex", caps: caps() };
const LIVE = { id: "copilot", label: "GitHub Copilot", caps: caps({ modes: true, commands: true }) };
const ALL = [CLAUDE, PLAIN, LIVE];

test("modes cap: the live switch is offered with that backend's modes; without it, launch-time + the hint", () => {
  assert.equal(liveModesHere(ALL, "copilot"), true);
  assert.equal(liveModesHere(ALL, "codex"), false);
  assert.equal(liveModesHere(ALL, "claude"), true);
  assert.equal(liveModesHere(null, undefined), true);
  assert.equal(modesReason(ALL, "copilot"), null);
  assert.equal(modesReason(ALL, "claude"), null);
  assert.match(modesReason(ALL, "codex"), /when a session starts/);
});

test("commands cap: own list, and the slash row does not claim nothing to send", () => {
  assert.equal(ownCommandsHere(ALL, "copilot"), true);
  assert.equal(ownCommandsHere(ALL, "codex"), false);
  assert.equal(ownCommandsHere(ALL, "claude"), false);
  assert.equal(ownCommandsHere(null, undefined), false);
  assert.ok(sessionCants(ALL, "codex").some((c) => c.label === "slash commands"));
  assert.ok(!sessionCants(ALL, "copilot").some((c) => c.label === "slash commands"));
});

test("fork reads the transcript's exactness, not claude: store/backend ok, history never, jsonl needs its id", () => {
  assert.equal(exactLog({ source: "backend", turns: [] }), true);
  assert.equal(exactLog({ source: "store", turns: [] }), true);
  assert.equal(exactLog({ source: "history", turns: [], claudeSessionId: "x" }), false);
  assert.equal(exactLog({ source: "jsonl", turns: [] }), false);
  assert.equal(exactLog({ source: "jsonl", turns: [], claudeSessionId: "x" }), true);
  assert.equal(exactLog(null), false);
});

// ── fixweb (review-web.md) ───────────────────────────────────────────────
import { launchWindowsOff } from "./budgetInput.ts";
import { planHint } from "./planHint.ts";
import { modeRows, modeNowText } from "./modePick.ts";
import { forkBlocker } from "./forkAnchor.ts";
import { usageReadNoWallText } from "./backendCaps.ts";

test("M1: a source plan (path '') names no file; a claude plan reads as before", () => {
  assert.equal(planHint({ path: "", cut: false }), null);
  assert.equal(planHint({ path: "", cut: true }), "longer than the host sends");
  assert.equal(planHint({ path: "/Users/me/p/plan.md", cut: false }), "from ~/p/plan.md");
  assert.equal(planHint({ path: "/home/me/p.md", cut: true }), "longer than the host sends — the rest is in ~/p.md");
});

test("M2: a backend whose usage is read does not claim 'counted against no quota'", () => {
  const list = [CLAUDE, { id: "copilot", label: "GitHub Copilot", caps: caps({ usage: true, commands: true }) }];
  const row = sessionCants(list, "copilot").find((c) => c.label === "usage limits");
  assert.equal(row.reason, usageReadNoWallText("GitHub Copilot"));
  assert.doesNotMatch(row.reason, /nothing here is counted/);
});

test("M3: a commands backend still SAYS how many Claude header chips are withheld", () => {
  const row = sessionCants(ALL, "copilot", { hiddenSlash: 2 }).find((c) => c.label === "your Claude header chips");
  assert.match(row.reason, /^2 of your header chips are Claude slash commands and are not offered here/);
  assert.equal(sessionCants(ALL, "copilot", { hiddenSlash: 0 }).some((c) => c.label === "your Claude header chips"), false);
});

test("M4: launch-time budget units: claude / old host offer percents, another backend says why", () => {
  assert.equal(launchWindowsOff(ALL, "claude"), null);
  assert.equal(launchWindowsOff(null, "codex"), null);
  assert.equal(launchWindowsOff(ALL, undefined), null);
  assert.match(launchWindowsOff(ALL, "codex"), /Codex does not spend from it/);
});

test("m1/m7: a source backend's mode words name its own reading and every declared mode is a row", () => {
  assert.match(modeNowText({ mode: "plan", source: "live" }, "Codex"), /^Now: Plan, read from Codex\.$/);
  assert.match(modeNowText({ mode: "plan", source: "live" }), /read off the CLI’s footer/);
  assert.doesNotMatch(modeNowText({ mode: null, source: "unknown" }, "Codex"), /footer/);
  const declared = ["default", "plan", "dontAsk"];
  assert.deepEqual(modeRows(declared, {}).map((r) => r.mode), ["default", "plan"]);
  assert.deepEqual(modeRows(declared, {}, false).map((r) => r.mode), ["default", "plan", "dontAsk"]);
});

test("m6: the no-modes sentence mentions ultracode only for claude's TUI", () => {
  const none = { id: "x", label: "X", caps: caps({ permissionModes: [] }) };
  assert.doesNotMatch(modesReason([CLAUDE, none], "x"), /ultracode/);
});

test("m8: an unidentified conversation is refused before the tap", () => {
  assert.match(forkBlocker(null, { id: "t1", n: 1 }, true, false), /no id yet/);
});
