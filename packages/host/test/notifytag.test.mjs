/** A plugin's notify({tag}) reaches the item and the OS push, namespaced per plugin (one notification per scope). */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { createClients } = await import("../dist/server/clients.js");
const { PLUGIN_API_VERSION } = await import("@waterplane/shared");

function plugin(parent, id, host) {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "waterplane-plugin.json"), JSON.stringify({ id, name: id, version: "1", apiVersion: PLUGIN_API_VERSION, actions: [{ id: "go", label: "Go", scope: "global" }] }));
  writeFileSync(join(dir, "host.mjs"), host);
}
const fakeSessions = { list: () => [], get: () => null, setPluginBadge: () => {} };

async function run(sources) {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-ntcfg-"));
  const root = mkdtempSync(join(tmpdir(), "waterplane-ntroot-"));
  after(() => { for (const d of [cfg, root]) rmSync(d, { recursive: true, force: true }); });
  for (const [id, body] of Object.entries(sources)) {
    plugin(join(cfg, "plugins"), id, `export function activate(api) { api.on("action", () => { ${body}; return { ok: true, message: "x" }; }); }`);
  }
  const pushed = [];
  const clients = createClients({
    auth: { passive: {} }, notifyPrefs: { enabled: () => true }, push: { notify: (p) => { pushed.push(p); } }, sessions: { list: () => [] },
  });
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: fakeSessions, decision: () => {}, meter: () => {},
    notify: (k, p) => clients.notify(k, p), usage: () => ({ ok: false }), changed: () => {},
  });
  await reg.loadAll();
  return { reg, clients, pushed };
}

test("notify({tag}): the feed item and the push carry the namespaced tag; two notifies with one tag share it", async () => {
  const { reg, clients, pushed } = await run({ pa: 'api.notify({ title: "1", body: "b", tag: "ask:k1" }); api.notify({ title: "2", body: "b", tag: "ask:k1" })' });
  await reg.action("pa", "go");
  assert.deepEqual(clients.notifications.map((n) => n.tag), ["plugin-pa-ask:k1", "plugin-pa-ask:k1"]);
  assert.deepEqual(pushed.map((p) => p.tag), ["plugin-pa-ask:k1", "plugin-pa-ask:k1"]);
});

test("notify: tags are namespaced per plugin, and no tag keeps the session/all fallback", async () => {
  const { reg, clients } = await run({
    pa: 'api.notify({ title: "1", body: "b", tag: "t" }); api.notify({ title: "n", body: "b" })',
    pb: 'api.notify({ title: "2", body: "b", tag: "t" })',
  });
  await reg.action("pa", "go");
  await reg.action("pb", "go");
  assert.deepEqual(clients.notifications.map((n) => n.tag).sort(), ["plugin-pa-all", "plugin-pa-t", "plugin-pb-t"]);
});
