import { test } from "node:test";
import assert from "node:assert/strict";
import { launchModesOf, launchModesProblems, launchModeRefusal, PERMISSION_MODE_NAMES } from "../dist/index.js";

test("absent launchModes inherits permissionModes", () => {
  const caps = { permissionModes: ["default", "plan"] };
  assert.deepEqual(launchModesOf(caps), ["default", "plan"]);
  assert.deepEqual(launchModesOf({ ...caps, launchModes: ["default"] }), ["default"]);
  assert.deepEqual(launchModesProblems(caps.permissionModes, undefined), []);
  assert.equal(launchModeRefusal("X", "plan", caps), null);
  assert.equal(launchModeRefusal("X", undefined, { ...caps, launchModes: ["default"] }), null);
});

test("problems are sentences: empty, not a list, unknown, outside permissionModes", () => {
  assert.match(launchModesProblems(["default"], [])[0], /empty/);
  assert.match(launchModesProblems(["default"], "x")[0], /must be a list/);
  assert.match(launchModesProblems(["default"], ["nope"])[0], /not a known permission mode/);
  assert.match(launchModesProblems(["default"], ["plan"])[0], /not in caps\.permissionModes/);
  assert.deepEqual(launchModesProblems(["default", "plan"], ["plan"]), []);
});

test("a mode listed twice is refused, naming it once (review minor 6: the picker drew two rows)", () => {
  const p = launchModesProblems(["default", "plan"], ["default", "plan", "default", "default"]);
  assert.equal(p.length, 1);
  assert.match(p[0], /names "default" more than once; list each mode once/);
  assert.deepEqual(launchModesProblems(["default", "plan"], ["default", "plan"]), []);
});

test("refusal names the set, and says when the mode is live-only", () => {
  const caps = { permissionModes: ["default", "plan"], launchModes: ["default"] };
  assert.match(launchModeRefusal("Codex", "plan", caps), /cannot start in "plan" mode \(it can switch to it once running\); it starts in: default/);
  assert.doesNotMatch(launchModeRefusal("Codex", "auto", caps), /switch to it/);
  assert.ok(PERMISSION_MODE_NAMES.includes("bypassPermissions"));
});
