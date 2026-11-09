/**
 * `api.revokeDevice(id)` (plugin API 2.8): an IN-REPO extension revokes ONE paired device's token through the
 * registry's seam (core's `server/plugins.ts` wires it to the ledger revoke + socket close of
 * `POST /api/devices/revoke`). An external plugin's call throws, so does a malformed id, a host without the
 * seam, and an extension switched off. The real ledger is asserted too: the row goes, the others stay.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { DeviceLedger } = await import("../dist/deviceledger.js");
const { PLUGIN_API_VERSION, PLUGIN_MANIFEST } = await import("@waterplane/shared");

const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); after(() => rmSync(d, { recursive: true, force: true })); return d; };

/** A plugin folder whose activate() hands its api to the test (`globalThis.__revokeApis[id]`). */
function pluginDir(dir, id) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PLUGIN_MANIFEST), JSON.stringify({ id, name: id, version: "1", apiVersion: PLUGIN_API_VERSION }));
  writeFileSync(join(dir, "host.mjs"), `export function activate(api) { (globalThis.__revokeApis ??= {})[${JSON.stringify(id)}] = api; }`);
  return dir;
}

async function registry({ seam = true } = {}) {
  const root = tmp("wp-revoke-root-"), cfg = tmp("wp-revoke-cfg-"), ext = pluginDir(tmp("wp-revoke-ext-"), "inrepo");
  pluginDir(join(cfg, "plugins", "outside"), "outside");
  const ledger = new DeviceLedger(root);
  const closed = [];
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: { list: () => [], get: () => null, setPluginBadge: () => {} },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
    locateBuiltin: () => ({ dir: ext, hostFile: join(ext, "host.mjs") }),
    // The same two steps as server/plugins.ts.
    ...(seam ? { revokeDevice: (id) => { const revoked = ledger.revoke(id); if (revoked) closed.push(id); return { revoked, closedSockets: revoked ? 1 : 0 }; } } : {}),
  });
  after(() => reg.shutdownAll());
  await reg.loadBuiltins(["inrepo"], null);
  await reg.loadAll();
  return { reg, ledger, closed, api: globalThis.__revokeApis };
}

test("an in-repo extension revokes exactly the one device it names; the others keep their tokens", async () => {
  const { ledger, closed, api } = await registry();
  const a = ledger.mint("phone a", "lan").row, b = ledger.mint("phone b", "lan").row;
  assert.deepEqual(api.inrepo.revokeDevice(a.id), { revoked: true, closedSockets: 1 });
  assert.deepEqual(ledger.list().map((r) => r.id), [b.id], "only that row went");
  assert.deepEqual(closed, [a.id], "its sockets were closed");
  assert.deepEqual(api.inrepo.revokeDevice(a.id), { revoked: false, closedSockets: 0 }, "already gone: said, not thrown");
});

test("an external plugin cannot revoke a device; a malformed id and a host without the seam throw in words", async () => {
  const { ledger, api } = await registry();
  const a = ledger.mint("phone a", "lan").row;
  assert.throws(() => api.outside.revokeDevice(a.id), /only an in-repo extension may revoke a paired device/);
  assert.equal(ledger.list().length, 1, "nothing revoked");
  assert.throws(() => api.inrepo.revokeDevice("../../x"), /not a paired device's id/);
  const bare = await registry({ seam: false });
  assert.throws(() => bare.api.inrepo.revokeDevice(a.id), /cannot revoke a paired device/);
});
