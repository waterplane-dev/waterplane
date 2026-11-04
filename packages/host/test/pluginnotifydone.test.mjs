/**
 * `api.notifyDone(tag)` (plugin API 2.6): a plugin settles the approval item its own
 * `notify({urgent, tag})` filed — through the real registry, the real `notify` (`server/clients.ts`)
 * and the real attention store — and can never reach another plugin's item (even one whose
 * namespaced tag spells the same string) or a core item.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { createClients } = await import("../dist/server/clients.js");
const { settlePluginNotice } = await import("../dist/server/plugins.js");
const { PLUGIN_API_VERSION, needsYou } = await import("@waterplane/shared");

const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); after(() => rmSync(d, { recursive: true, force: true })); return d; };

// One plugin per id; its actions: `raise:<tag>` notifies urgently under <tag>, `done:<tag>` settles <tag>.
function plugin(parent, id) {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "waterplane-plugin.json"), JSON.stringify({
    id, name: id, version: "1.0.0", apiVersion: PLUGIN_API_VERSION,
    actions: ["raise:card", "raise:x", "done:card", "done:b-x", "done:x"].map((a) => ({ id: a, label: a, scope: "global" })),
  }));
  writeFileSync(join(dir, "host.mjs"), `export function activate(api) {
    api.on("action", ({ action }) => {
      const [verb, tag] = action.split(":");
      if (verb === "raise") api.notify({ title: "Approve?", body: "b", urgent: true, tag });
      else api.notifyDone(tag);
      return { ok: true, message: "ok" };
    });
  }`);
}

function fakeSessions() {
  return { list: () => [], get: () => null, isWatched: () => false, scrollback: () => "", setSuggestion: () => {}, setPluginBadge: () => {}, setPluginToggle: () => false, anyPluginAnswer: () => false };
}

test("notifyDone settles this plugin's own tag — never another plugin's, never a core item", async () => {
  const cfg = tmp("waterplane-ndcfg-"), root = tmp("waterplane-ndroot-");
  for (const id of ["echo", "echo-b", "other"]) plugin(join(cfg, "plugins"), id);
  const frames = [];
  const c = createClients({ auth: { passive: {} }, notifyPrefs: { enabled: () => true, pushInfo: () => false, get: () => ({}) }, push: { notify: () => {} }, sessions: { list: () => [] } });
  c.clients.add({ OPEN: 1, readyState: 1, send: (b) => frames.push(JSON.parse(b)) });
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: fakeSessions(),
    decision: () => {}, meter: () => {}, usage: () => ({ ok: false }), changed: () => {},
    notify: (k, p) => c.notify(k, p),
    notifyDone: (pl, tag) => { settlePluginNotice(c, pl, tag); },
  });
  await reg.loadAll();
  const act = async (id, a) => assert.equal((await reg.action(id, a)).ok, true, `${id} ${a}`);

  await act("echo", "raise:card");
  await act("other", "raise:card");
  await act("echo-b", "raise:x"); // tag `plugin-echo-b-x` — exactly what echo's `b-x` namespaces to
  // A core item carrying the very tag string echo's card has, but no `plugin`.
  c.notify("approval", { title: "core", body: "b", tag: "plugin-echo-card" });
  const waiting = () => c.attention.items().filter(needsYou).map((i) => `${i.plugin ?? "core"}|${i.tag}`).sort();
  assert.deepEqual(waiting(), ["core|plugin-echo-card", "echo-b|plugin-echo-b-x", "echo|plugin-echo-card", "other|plugin-other-card"]);

  // Names that are not its own reach nothing: another plugin's raw tag, the colliding spelling.
  await act("echo", "done:x");
  await act("echo", "done:b-x");
  assert.equal(waiting().length, 4, "echo cannot settle echo-b's item, whatever it spells");

  const before = frames.filter((f) => f.t === "notification.list").length;
  await act("echo", "done:card");
  assert.deepEqual(waiting(), ["core|plugin-echo-card", "echo-b|plugin-echo-b-x", "other|plugin-other-card"]);
  const mine = c.attention.items().find((i) => i.plugin === "echo");
  assert.equal(mine.handled.by, "resolved");
  assert.equal(frames.filter((f) => f.t === "notification.list").length, before + 1, "the change is broadcast at once");

  // Idempotent: settling again changes nothing and broadcasts nothing.
  await act("echo", "done:card");
  assert.equal(frames.filter((f) => f.t === "notification.list").length, before + 1);
  assert.equal(settlePluginNotice(c, "echo", "plugin-echo-card"), 0);
});
