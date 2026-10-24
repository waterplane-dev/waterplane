/**
 * The plugin testkit (`packages/plugin-testkit`) restates the host's plugin-registration rules in
 * plain JS so a plugin repo can test against them. Rules that live only in host TypeScript are
 * pinned HERE: the same fixtures go to the host's real check and to the kit's, and each must
 * agree with the fixture's verdict — so neither can loosen or tighten alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks = await import("../../plugin-testkit/checks.mjs");
const shared = await import("../../plugin-testkit/shared.mjs");
const { pluginDescriptor } = await import("../dist/plugins/pluginapi.js");
const { registerBackend, unregisterBackend } = await import("../dist/backends/registry.js");
const { factProblems, CORE_SCREEN, CORE_STORE } = await import("../dist/backends/derive.js");
const { resolveLaunchFiles, LAUNCH_FILES_MAX, LAUNCH_FILE_MAX_BYTES } = await import("../dist/launchfiles.js");
const { sourceKeysProblem, sourceTypedProblem } = await import("../dist/sourceanswer.js");
const sharedPkg = await import("@waterplane/shared");

const refuses = (fn) => { try { fn(); return false; } catch { return true; } };
function both(name, fixtures, host, kit) {
  test(name, async () => {
    for (const [label, input, bad] of fixtures) {
      assert.equal(!!(await host(input)), bad, `host on "${label}"`);
      assert.equal(!!(await kit(input)), bad, `testkit on "${label}"`);
    }
  });
}

test("constants the kit imports are shared's, and its core reader tables are the host's", () => {
  assert.deepEqual([...shared.FACT_NAMES], [...sharedPkg.FACT_NAMES]);
  assert.equal(shared.SOURCE_KEYS_MAX, sharedPkg.SOURCE_KEYS_MAX);
  assert.equal(shared.SOURCE_TYPED_MAX, sharedPkg.SOURCE_TYPED_MAX);
  assert.deepEqual(checks.CORE_SCREEN, CORE_SCREEN);
  assert.deepEqual(checks.CORE_STORE, CORE_STORE);
  assert.equal(checks.LAUNCH_FILES_MAX, LAUNCH_FILES_MAX);
  assert.equal(checks.LAUNCH_FILE_MAX_BYTES, LAUNCH_FILE_MAX_BYTES);
});

const good = () => ({
  id: "kitfix", label: "Kit", bin: () => "kit", prepare: async () => ({ args: [], instructionsVia: "none", askRulesVia: "none" }),
  caps: { turns: true, slash: "none", permissionModes: [], remoteControl: false },
  facts: {}, measured: { versions: [], version: async () => null }, models: async () => ({ aliases: [], ids: [] }),
});

both("descriptor shape: the same defs are refused", [
  ["complete", good(), false],
  ["no label", { ...good(), label: " " }, true],
  ["no prepare", { ...good(), prepare: undefined }, true],
  ["v1 launchArgs only", { ...good(), prepare: undefined, launchArgs: () => [] }, true],
  ["no models", { ...good(), models: undefined }, true],
  ["no caps", { ...good(), caps: undefined }, true],
  ["a v1 cap", { ...good(), caps: { ...good().caps, transcript: "claude-jsonl" } }, true],
  ["facts is a list", { ...good(), facts: [] }, true],
  ["no measured.version", { ...good(), measured: { versions: [] } }, true],
  ["measured.versions not a list", { ...good(), measured: { versions: "1", version: async () => null } }, true],
], (d) => refuses(() => pluginDescriptor(d, "Kit")), (d) => checks.descriptorProblems(d).length);

both("backend id: registerBackend and the kit refuse the same ids", [
  ["plain", "kitid", false], ["dashes", "kit-id-2", false],
  ["upper", "Kit", true], ["digit first", "1kit", true], ["underscore", "kit_id", true], ["empty", "", true], ["33 chars", "a".repeat(33), true],
], (id) => {
  try { registerBackend(pluginDescriptor({ ...good(), id }, "Kit")); } catch { return true; }
  unregisterBackend(id);
  return false;
}, (id) => checks.descriptorProblems({ ...good(), id }).length);

const readers = { screen: new Set(["my-dialogs"]), store: new Set(["my-store"]) };
both("facts: the same provider tables are refused", [
  ["empty", {}, false],
  ["core silence", { turns: [{ screen: "silence" }] }, false],
  ["source", { dialogs: [{ source: true }], transcript: [{ source: true }] }, false],
  ["contributed screen on dialogs", { dialogs: [{ screen: "my-dialogs" }] }, false],
  ["contributed store on transcript", { transcript: [{ store: "my-store" }] }, false],
  ["unknown fact", { bogus: [{ source: true }] }, true],
  ["not a list", { turns: { source: true } }, true],
  ["unknown screen reader", { turns: [{ screen: "nope" }] }, true],
  ["contributed screen on a fact that takes none", { turns: [{ screen: "my-dialogs" }] }, true],
  ["unknown store reader", { transcript: [{ store: "nope" }] }, true],
  ["contributed store on agents", { agents: [{ store: "my-store" }] }, true],
  ["two keys", { turns: [{ source: true, screen: "silence" }] }, true],
  ["source: false", { turns: [{ source: false }] }, true],
  ["not an object provider", { turns: ["silence"] }, true],
  // 2.2: mode and commands are answered by a source only — no screen or store reader exists for either.
  ["mode + commands from a source", { mode: [{ source: true }], commands: [{ source: true }] }, false],
  ["mode from a core screen reader", { mode: [{ screen: "silence" }] }, true],
  ["mode from a contributed screen reader", { mode: [{ screen: "my-dialogs" }] }, true],
  ["commands from a core store", { commands: [{ store: "claude-jsonl" }] }, true],
  ["commands from a contributed store", { commands: [{ store: "my-store" }] }, true],
  ["facts is an array", [], true],
  ["facts is null", null, true],
], (f) => factProblems(f, readers).length, (f) => checks.factProblems(f, readers).length);

const data = mkdtempSync(join(tmpdir(), "kitfix-"));
const dataDir = join(data, "plugins", "kit");
const f = (path, content = "x") => ({ path, content });
both("launch files: the same plans are refused", [
  ["none", [], false],
  ["session file", [f("session:instructions/AGENTS.md")], false],
  ["inside dataDir", [f(join(dataDir, "a.txt"))], false],
  ["16 files", Array.from({ length: 16 }, (_, i) => f(`session:f${i}`)), false],
  ["17 files", Array.from({ length: 17 }, (_, i) => f(`session:f${i}`)), true],
  ["exactly 1 MiB", [f("session:big", "a".repeat(LAUNCH_FILE_MAX_BYTES))], false],
  ["over 1 MiB", [f("session:big", "a".repeat(LAUNCH_FILE_MAX_BYTES + 1))], true],
  ["no text", [{ path: "session:x", content: null }], true],
  ["escapes the session dir", [f("session:../x")], true],
  ["absolute after prefix", [f("session:/etc/passwd")], true],
  ["empty name", [f("session:")], true],
  ["outside dataDir", [f("/etc/passwd")], true],
  ["dataDir itself", [f(dataDir)], true],
  ["sibling of dataDir", [f(dataDir + "-evil/x")], true],
  ["relative", [f("AGENTS.md")], true],
  ["not a list", "x", true],
], (files) => !resolveLaunchFiles(files, { launchDir: join(data, "launch", "s1"), dataDir, who: "Kit" }).ok,
(files) => checks.launchFilesProblems(files, { dataDir }).length);

const planOf = (over) => ({ args: [], instructionsVia: "none", askRulesVia: "none", ...over });
both("prepare plan: args and how-told are refused alike", [
  ["good", planOf({}), false],
  ["every via", planOf({ instructionsVia: "env-file", askRulesVia: "gate" }), false],
  ["args not strings", planOf({ args: [1] }), true],
  ["args not a list", planOf({ args: "x" }), true],
  ["no instructionsVia", planOf({ instructionsVia: undefined }), true],
  ["bad instructionsVia", planOf({ instructionsVia: "magic" }), true],
  ["no askRulesVia", planOf({ askRulesVia: undefined }), true],
  ["bad askRulesVia", planOf({ askRulesVia: "hope" }), true],
], async (plan) => {
  const d = pluginDescriptor({ ...good(), prepare: async () => plan }, "Kit");
  try { await d.prepare({ launch: {}, hookPort: 1, cwd: "/", hostSessionId: "s1", instructions: "", askRules: [] }); return false; } catch { return true; }
}, (plan) => checks.planProblems(plan, { dataDir }).filter((p) => /list of arguments|Via must/.test(p)).length);

both("caps: the host reads what the kit says it reads", [
  ["complete", { turns: true, slash: "own", permissionModes: ["plan"], remoteControl: true }, false],
  ["all absent", {}, false],
  ["turns false", { turns: false }, false],
  ["turns a string", { turns: "no" }, true],
  ["remoteControl a string", { remoteControl: "yes" }, true],
  ["permissionModes not a list", { permissionModes: "plan" }, true],
  ["unknown slash", { slash: "both" }, true],
], (caps) => {
  // The host never refuses caps; "bad" = it normalises them to something other than what was written.
  const n = pluginDescriptor({ ...good(), caps }, "Kit").caps;
  return n.turns !== (caps.turns ?? true) || n.remoteControl !== (caps.remoteControl ?? false)
    || n.slash !== (caps.slash ?? "none") || JSON.stringify(n.permissionModes) !== JSON.stringify(caps.permissionModes ?? []);
}, (caps) => checks.capsProblems(caps).length);

both("caps.launchModes: registration refuses what the kit flags, in the same cases", [
  ["absent", { permissionModes: ["default", "plan"] }, false],
  ["a subset", { permissionModes: ["default", "plan"], launchModes: ["default"] }, false],
  ["the whole set", { permissionModes: ["default", "plan"], launchModes: ["plan", "default"] }, false],
  ["not a subset", { permissionModes: ["default"], launchModes: ["default", "plan"] }, true],
  ["empty", { permissionModes: ["default", "plan"], launchModes: [] }, true],
  ["not a list", { permissionModes: ["default", "plan"], launchModes: "default" }, true],
  ["unknown mode", { permissionModes: ["default", "plan"], launchModes: ["yolo"] }, true],
], (caps) => {
  const d = pluginDescriptor({ ...good(), id: "kitlaunch", caps }, "Kit");
  try { registerBackend(d); unregisterBackend("kitlaunch"); return false; } catch { return true; }
}, (caps) => checks.capsProblems(caps).length);

test("plan lints are KIT-ONLY: the host accepts a plan the kit flags, and planProblems stays the host's", async () => {
  for (const over of [{ env: { A: 1 } }, { dropEnv: "A" }, { exec: "relative/bin" }]) {
    const plan = planOf(over);
    const d = pluginDescriptor({ ...good(), prepare: async () => plan }, "Kit");
    await d.prepare({ launch: {}, hookPort: 1, cwd: "/", hostSessionId: "s1", instructions: "", askRules: [] }); // does not throw
    assert.equal(checks.planProblems(plan, { dataDir }).length, 0, JSON.stringify(over));
    assert.ok(checks.planLints(plan).length, `lint on ${JSON.stringify(over)}`);
  }
});

test("compactions: the cap is one rule on the host's validator and the kit's", () => {
  const list = (n) => Array.from({ length: n }, (_, i) => ({ at: i }));
  const max = sharedPkg.SOURCE_COMPACTIONS_MAX;
  assert.equal(shared.SOURCE_COMPACTIONS_MAX, max);
  assert.equal(checks.readingProblems("compactions", list(max)).length, 0);
  assert.equal(checks.readingProblems("compactions", list(max + 1)).length, 1);
  assert.equal(sharedPkg.sourceCompactionsProblems(list(max + 1)).length, 1);
});

both("source keys: the same keystrokes are refused", [
  ["digit", "2", false], ["digit and Return", "2\r", false], ["arrow", "\x1b[B", false], ["Escape", "\x1b", false],
  ["8 keys", "12345678", false], ["9 keys", "123456789", true], ["arrows count once", "\x1b[A".repeat(8), false],
  ["9 arrows", "\x1b[A".repeat(9), true], ["ctrl-c", "\x03", true], ["bracketed paste (too many keys)", "\x1b[200~hello", true],
  // 2.2: a mode cycle presses Tab / Shift+Tab, each ONE key.
  ["tab", "\t", false], ["shift+tab", "\x1b[Z", false], ["8 shift+tabs", "\x1b[Z".repeat(8), false],
  ["9 shift+tabs", "\x1b[Z".repeat(9), true], ["shift+tab then Return", "\x1b[Z\r", false], ["ctrl-i is tab", "\x09", false], ["ctrl-j", "\n", true],
  ["DEL", "\x7f", true], ["empty", "", true], ["not a string", 5, true], ["null", null, true],
], (k) => sourceKeysProblem(k), (k) => checks.keysProblem(k));

both("source typed words: the same answers are refused", [
  ["words", { typed: "because" }, false], ["then Return", { typed: "ok", then: "\r" }, false],
  ["1000 chars", { typed: "a".repeat(1000) }, false], ["1001 chars", { typed: "a".repeat(1001) }, true],
  ["newline", { typed: "a\nb" }, true], ["escape", { typed: "a\x1bb" }, true], ["C1 control", { typed: "a\u0085b" }, true],
  ["then not Return", { typed: "ok", then: "\t" }, true], ["empty", { typed: "" }, true], ["no typed", {}, true], ["null", null, true],
], (t) => sourceTypedProblem(t), (t) => checks.typedProblem(t));
