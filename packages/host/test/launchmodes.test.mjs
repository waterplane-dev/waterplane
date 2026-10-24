/**
 * `caps.launchModes` (plugin API 2.2): the subset of `permissionModes` a session can START in.
 * Absent ⇒ every permissionModes entry and the wire caps do not move; a non-subset or empty list is
 * refused at registration in words; `SessionManager.create` refuses an out-of-set launch BEFORE `prepare()`.
 */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { pluginDescriptor } = await import("../dist/plugins/pluginapi.js");
const { registerBackend, unregisterBackend } = await import("../dist/backends/registry.js");
const { backendInfos } = await import("../dist/backends/index.js");
const { SessionManager } = await import("../dist/sessions.js");

let prepared = 0;
const def = (id, caps) => ({
  id, label: "Mode Kit", bin: () => "modekit",
  prepare: async () => { prepared++; return { args: [], instructionsVia: "none", askRulesVia: "none" }; },
  caps: { turns: true, slash: "none", remoteControl: false, ...caps },
  facts: {}, measured: { versions: [], version: async () => null }, models: async () => ({ aliases: [], ids: [] }),
});
const wire = (id) => backendInfos().find((b) => b.id === id)?.caps;

test("absent launchModes: the wire caps carry no such key", () => {
  registerBackend(pluginDescriptor(def("lmabsent", { permissionModes: ["default", "plan"] }), "Kit"));
  try { assert.equal("launchModes" in wire("lmabsent"), false); assert.equal("launchModes" in wire("claude"), false); }
  finally { unregisterBackend("lmabsent"); }
});

test("a declared subset rides the wire, permissionModes untouched", () => {
  registerBackend(pluginDescriptor(def("lmsub", { permissionModes: ["default", "plan"], launchModes: ["default"] }), "Kit"));
  try { assert.deepEqual(wire("lmsub").launchModes, ["default"]); assert.deepEqual(wire("lmsub").permissionModes, ["default", "plan"]); }
  finally { unregisterBackend("lmsub"); }
});

test("a non-subset, unknown, empty or non-list launchModes is refused in words", () => {
  for (const [lm, re] of [
    [["default", "plan"], /not in caps\.permissionModes/],
    [["yolo"], /not a known permission mode/],
    [[], /empty/],
    ["default", /must be a list/],
  ]) {
    assert.throws(() => registerBackend(pluginDescriptor(def("lmbad", { permissionModes: ["default"], launchModes: lm }), "Kit")), re);
  }
});

test("create refuses a mode outside the launch set before prepare() is asked", async () => {
  registerBackend(pluginDescriptor(def("lmcreate", { permissionModes: ["default", "plan"], launchModes: ["default"] }), "Kit"));
  try {
    const sm = new SessionManager(mkdtempSync(join(tmpdir(), "wp-lm-")), 8799);
    prepared = 0;
    await assert.rejects(sm.create(tmpdir(), { launch: { backend: "lmcreate", permissionMode: "plan" } }), /Mode Kit cannot start in "plan" mode \(it can switch to it once running\); it starts in: default/);
    assert.equal(prepared, 0, "prepare() was never asked");
  } finally { unregisterBackend("lmcreate"); }
});
