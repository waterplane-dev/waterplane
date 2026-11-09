// PluginView.privacy: set only for an in-repo builtin whose own ship.json says "ship": false.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { isPrivateExtension } = await import("../dist/plugins/builtin.js");
const { PLUGIN_API_VERSION, PLUGIN_MANIFEST } = await import("@waterplane/shared");

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function viewWith(ship, optional = true) {
  const ext = tmp("wp-priv-ext-");
  writeFileSync(join(ext, PLUGIN_MANIFEST), JSON.stringify({ id: "privfix", name: "Priv", version: "1", apiVersion: PLUGIN_API_VERSION, ...(optional ? { optional: true } : {}) }));
  writeFileSync(join(ext, "host.mjs"), "export function activate() {}");
  if (ship !== undefined) writeFileSync(join(ext, "ship.json"), ship);
  const reg = new PluginRegistry({
    root: tmp("wp-priv-root-"), configDir: tmp("wp-priv-cfg-"), sessions: { list: () => [], get: () => null, setPluginBadge: () => {} },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
    locateBuiltin: () => ({ dir: ext, hostFile: join(ext, "host.mjs") }),
  });
  after(() => reg.shutdownAll());
  await reg.loadBuiltins(["privfix"], null);
  return reg.views().find((v) => v.manifest.id === "privfix");
}

test("ship:false marks the view private", async () => {
  assert.equal((await viewWith('{ "ship": false, "on": false }')).privacy, "private");
});
test("ship:true, missing or unparseable ship.json is not private", async () => {
  for (const s of ['{ "ship": true }', undefined, "{ not json"]) {
    const v = await viewWith(s);
    assert.ok(v, "listed");
    assert.equal("privacy" in v, false);
  }
});
test("isPrivateExtension reads the real extensions", () => {
  // The vault is left out of the public snapshot; there only the public half can be checked.
  const vault = new URL("../../extensions/vault/", import.meta.url).pathname;
  if (existsSync(vault)) assert.equal(isPrivateExtension(vault), true);
  assert.equal(isPrivateExtension(new URL("../../extensions/ocr/", import.meta.url).pathname), false);
});

test("a non-optional builtin is listed as fixed, an optional one is switchable; both are builtin", async () => {
  const f = await viewWith(undefined, false);
  assert.equal(f.fixed, true);
  assert.equal(f.builtin, true);
  const o = await viewWith(undefined, true);
  assert.equal("fixed" in o, false);
  assert.equal(o.builtin, true);
});
