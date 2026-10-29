/** `caps.spendUnit` (plugin API 2.3): copied to the wire caps when declared, refused in words when bad. */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { pluginDescriptor } = await import("../dist/plugins/pluginapi.js");
const { registerBackend, unregisterBackend } = await import("../dist/backends/registry.js");
const { backendInfos } = await import("../dist/backends/index.js");

const def = (id, caps) => ({
  id, label: "Unit Kit", bin: () => "unitkit",
  prepare: async () => ({ args: [], instructionsVia: "none", askRulesVia: "none" }),
  caps: { turns: true, slash: "none", remoteControl: false, permissionModes: ["default"], ...caps },
  facts: {}, measured: { versions: [], version: async () => null }, models: async () => ({ aliases: [], ids: [] }),
});
const wire = (id) => backendInfos().find((b) => b.id === id)?.caps;

test("a declared spendUnit rides the wire; absent leaves no key (claude included)", () => {
  registerBackend(pluginDescriptor(def("suyes", { spendUnit: "AI credits" }), "Kit"));
  registerBackend(pluginDescriptor(def("suno", {}), "Kit"));
  try {
    assert.equal(wire("suyes").spendUnit, "AI credits");
    assert.equal("spendUnit" in wire("suno"), false);
    assert.equal("spendUnit" in wire("claude"), false);
  } finally { unregisterBackend("suyes"); unregisterBackend("suno"); }
});

test("an empty, padded, over-long or non-string spendUnit is refused in words", () => {
  for (const [v, re] of [["", /unit's name/], [5, /unit's name/], ["x".repeat(33), /at most 32/], [" AI credits", /spaces around/]]) {
    assert.throws(() => registerBackend(pluginDescriptor(def("subad", { spendUnit: v }), "Kit")), re);
  }
});
