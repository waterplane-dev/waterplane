/**
 * `api.notifyDoneExcept(keep)` (plugin API 2.7): a plugin's start settles every waiting item IT filed
 * except those under a kept tag — through the real registry, the real `notify` (`server/clients.ts`) and
 * the real attention store. Another plugin's items (even one whose namespaced tag spells the same string)
 * and core items are never reached.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { createClients } = await import("../dist/server/clients.js");
const { settlePluginNoticesExcept } = await import("../dist/server/plugins.js");
const { PLUGIN_API_VERSION, needsYou } = await import("@waterplane/shared");

const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); after(() => rmSync(d, { recursive: true, force: true })); return d; };

// One plugin per id; `raise:<tag>` notifies urgently under <tag>; `clear:<a>,<b>` settles all but those tags.
function plugin(parent, id) {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "waterplane-plugin.json"), JSON.stringify({
    id, name: id, version: "1.0.0", apiVersion: PLUGIN_API_VERSION,
    actions: ["raise:old", "raise:live", "raise:x", "clear:live"].map((a) => ({ id: a, label: a, scope: "global" })),
  }));
  writeFileSync(join(dir, "host.mjs"), `export function activate(api) {
    api.on("action", ({ action }) => {
      const [verb, arg] = action.split(":");
      if (verb === "raise") api.notify({ title: "Approve?", body: "b", urgent: true, tag: arg });
      else api.notifyDoneExcept(arg.split(","));
      return { ok: true, message: "ok" };
    });
  }`);
}

function fakeSessions() {
  return { list: () => [], get: () => null, isWatched: () => false, scrollback: () => "", setSuggestion: () => {}, setPluginBadge: () => {}, setPluginToggle: () => false, anyPluginAnswer: () => false };
}

test("notifyDoneExcept settles this plugin's own items but the kept tags — never another plugin's, never core", async () => {
  const cfg = tmp("waterplane-ndxcfg-"), root = tmp("waterplane-ndxroot-");
  for (const id of ["echo", "echo-b", "other"]) plugin(join(cfg, "plugins"), id);
  const frames = [];
  const c = createClients({ auth: { passive: {} }, notifyPrefs: { enabled: () => true, pushInfo: () => false, get: () => ({}) }, push: { notify: () => {} }, sessions: { list: () => [] } });
  c.clients.add({ OPEN: 1, readyState: 1, send: (b) => frames.push(JSON.parse(b)) });
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: fakeSessions(),
    decision: () => {}, meter: () => {}, usage: () => ({ ok: false }), changed: () => {},
    notify: (k, p) => c.notify(k, p),
    notifyDoneExcept: (pl, keep) => { settlePluginNoticesExcept(c, pl, keep); },
  });
  await reg.loadAll();
  const act = async (id, a) => assert.equal((await reg.action(id, a)).ok, true, `${id} ${a}`);

  await act("echo", "raise:old");
  await act("echo", "raise:live");
  await act("other", "raise:old");
  await act("echo-b", "raise:x"); // tag `plugin-echo-b-x`
  c.notify("approval", { title: "core", body: "b", tag: "plugin-echo-old" }); // a core item spelling echo's tag
  const waiting = () => c.attention.items().filter(needsYou).map((i) => `${i.plugin ?? "core"}|${i.tag}`).sort();
  assert.equal(waiting().length, 5);

  const before = frames.filter((f) => f.t === "notification.list").length;
  await act("echo", "clear:live");
  assert.deepEqual(waiting(), ["core|plugin-echo-old", "echo-b|plugin-echo-b-x", "echo|plugin-echo-live", "other|plugin-other-old"],
    "only echo's leftover settled; its live tag, another plugin's items and the core item still wait");
  assert.equal(c.attention.items().find((i) => i.plugin === "echo" && i.tag === "plugin-echo-old").handled.by, "resolved");
  assert.equal(frames.filter((f) => f.t === "notification.list").length, before + 1, "the change is broadcast at once");

  // Idempotent: nothing left to settle ⇒ no change, no broadcast.
  await act("echo", "clear:live");
  assert.equal(frames.filter((f) => f.t === "notification.list").length, before + 1);
  assert.equal(settlePluginNoticesExcept(c, "echo", ["plugin-echo-live"]), 0);
});
