/**
 * `api.push` never reaches a passive (kids') device, even while a PIN has unlocked it (R-connection-013): a plugin push carries no
 * caller, so the core filters it (`pushToFullDevices`, `server/plugins.ts`). The vault's asks and its export file path ride it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { pushToFullDevices } = await import("../dist/server/plugins.js");

test("a plugin push skips a socket whose device row is passive, and reaches every other socket", () => {
  const kid = {}, owner = {}, anon = {};
  const wsDevice = new WeakMap([[kid, "kid"], [owner, "owner"]]);
  const rows = { kid: { id: "kid", scope: "passive" }, owner: { id: "owner", scope: "full" } };
  const got = [];
  const ctx = {
    clients: new Set([kid, owner, anon]), wsDevice,
    auth: { devices: { get: (id) => rows[id] ?? null } },
    send: (ws, msg) => got.push([ws, msg]),
  };
  const msg = { t: "plugin.push", plugin: "vault", event: "fileReady", data: { path: "/api/plugin-file/vault/x" } };
  pushToFullDevices(ctx, msg);
  assert.deepEqual(got.map(([ws]) => ws), [owner, anon]);
  assert.ok(got.every(([, m]) => m === msg));
});
