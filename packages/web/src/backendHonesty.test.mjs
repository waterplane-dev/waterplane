/**
 * P1 (phone honesty for non-claude sessions): claude's TUI is decided by CAPS, the claude family
 * reads exactly as before, and every absence says why.
 *     node --test packages/web/src/backendHonesty.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  cliSetupDone, cliSetupHold, interruptWho, liveEffortHere, modesReason, runsClaudeTui, sessionCants,
} from "./backendCaps.ts";
import { askRulesDue, askRulesGoneText, askRulesNone, askRulesText } from "./core/session/toldWords.ts";

const caps = (o = {}) => ({
  contextMeter: true, usageLimits: true, transcript: true, slash: true,
  promptBoxes: true, hooks: true, effort: true, remoteControl: true,
  permissionModes: ["default", "plan"], ...o,
});
const NONE = { contextMeter: false, usageLimits: false, transcript: false, slash: false, promptBoxes: false, hooks: false, effort: false, remoteControl: false, permissionModes: [] };
const CLAUDE = { id: "claude", label: "Claude Code", caps: caps() };
// claude-local / -endpoint: claude's caps minus remoteControl (and, on the wire, whatever facts drop).
const LOCAL = { id: "claude-local", label: "Claude Code (local model)", caps: caps({ remoteControl: false }) };
const ENDPOINT = { id: "claude-endpoint", label: "Claude Code (custom endpoint)", caps: caps({ remoteControl: false }) };
const COPILOT = { id: "copilot", label: "GitHub Copilot", caps: caps({ ...NONE, transcript: true }) };
const SHELL = { id: "shell", label: "Shell", kind: "shell", caps: caps(NONE) };
const ALL = [CLAUDE, LOCAL, ENDPOINT, COPILOT, SHELL];

test("claude's TUI is a cap test: the claude family yes, Copilot and a shell no, an old host yes", () => {
  for (const id of ["claude", "claude-local", "claude-endpoint"]) assert.equal(runsClaudeTui(ALL, id), true, id);
  assert.equal(runsClaudeTui(ALL, "copilot"), false);
  assert.equal(runsClaudeTui(ALL, "shell"), false);
  assert.equal(runsClaudeTui(null, undefined), true, "no backends frame ⇒ today's UI");
});

test("Esc names who it interrupts: claude in claude's TUI, else the backend's label", () => {
  assert.equal(interruptWho(ALL, "claude"), "claude");
  assert.equal(interruptWho(ALL, "claude-local"), "claude");
  assert.equal(interruptWho(ALL, "copilot"), "GitHub Copilot");
  assert.equal(interruptWho(ALL, "shell"), "the running command");
  assert.equal(interruptWho(null, undefined), "claude");
});

test("live /effort is exactly as before: claude only, never claude-local/endpoint, never Copilot", () => {
  assert.equal(liveEffortHere(ALL, "claude", true), true);
  assert.equal(liveEffortHere(ALL, undefined, true), true);
  assert.equal(liveEffortHere(ALL, "claude", false), false);
  assert.equal(liveEffortHere(ALL, "claude-local", true), false);
  assert.equal(liveEffortHere(ALL, "claude-endpoint", true), false);
  assert.equal(liveEffortHere(ALL, "copilot", true), false);
});

test("the sign-in hold keeps claude's words for the family and names any other backend", () => {
  assert.match(cliSetupHold(ALL, "claude"), /^claude is not signed in on the desktop yet/);
  assert.match(cliSetupHold(ALL, "claude-local"), /^claude is not signed in/);
  assert.match(cliSetupHold(ALL, "copilot"), /^GitHub Copilot is not signed in/);
  assert.equal(cliSetupDone(ALL, "claude"), "claude is set up: back to the reader.");
  assert.equal(cliSetupDone(ALL, "copilot"), "GitHub Copilot is set up: back to the reader.");
});

test("sessionCants: the claude family stays [], a non-claude TUI says usage / hooks / boxes too", () => {
  for (const id of ["claude", "claude-local", "claude-endpoint"]) assert.deepEqual(sessionCants(ALL, id), [], id);
  const labels = sessionCants(ALL, "copilot").map((c) => c.label);
  for (const l of ["usage limits", "turn-end reports", "readable choice boxes"]) assert.ok(labels.includes(l), l);
  for (const c of sessionCants(ALL, "copilot")) assert.match(c.reason, /GitHub Copilot/, "named by its own label");
  assert.deepEqual(sessionCants(ALL, "shell"), [], "a shell keeps its one quiet line");
});

test("a backend with no permission modes says so; one with modes (or no frame) says nothing", () => {
  assert.match(modesReason(ALL, "copilot"), /^GitHub Copilot has no permission modes/);
  assert.equal(modesReason(ALL, "claude"), null);
  assert.equal(modesReason(null, undefined), null);
});

test("ask rules: only 'none' is said, once per backend; native / gate / absent never", () => {
  assert.equal(askRulesNone("none"), true);
  for (const v of ["native", "gate", undefined]) assert.equal(askRulesNone(v), false, String(v));
  assert.equal(askRulesNone("none", "shell"), false);
  assert.equal(askRulesDue("none", "copilot", []), true);
  assert.equal(askRulesDue("none", "copilot", ["askrules:copilot"]), false);
  assert.equal(askRulesDue("none", "copilot", ["copilot"]), true, "the outbox notice's mark is a different fact");
  assert.match(askRulesText("GitHub Copilot"), /not enforced in a GitHub Copilot session/);
  assert.match(askRulesGoneText("GitHub Copilot"), /icon beside the title brings it back/);
});
