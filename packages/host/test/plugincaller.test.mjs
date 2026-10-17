/**
 * D6 (plugin API 1.8): a `handle` method learns who asked. `callerOf` names the paired device, or
 * says null for a socket with no token; the registry threads the caller to the handler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { callerOf } = await import("../dist/routes/system.js");
const { DeviceLedger } = await import("../dist/deviceledger.js");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

test("callerOf names the paired device and is null for an untokened socket", () => {
  const ledger = new DeviceLedger(mkdtempSync(join(tmpdir(), "wp-caller-")));
  const { row } = ledger.mint("Pixel", "tailscale");
  assert.equal(ledger.get(row.id).name, "Pixel");
  assert.equal(ledger.get("nope"), null);
  assert.deepEqual(callerOf("tailscale", row.id, ledger), { kind: "tailscale", deviceId: row.id, deviceName: "Pixel" });
  assert.deepEqual(callerOf("tailscale", undefined, ledger), { kind: "tailscale", deviceId: null, deviceName: null });
  assert.deepEqual(callerOf(undefined, undefined, ledger), { kind: "unknown", deviceId: null, deviceName: null });
  assert.deepEqual(callerOf("lan", "revoked", ledger), { kind: "lan", deviceId: "revoked", deviceName: null });
});

test("the registry hands the caller to the handler, and a bare call is an in-process caller of unknown route (never a local browser)", async () => {
  const seen = [];
  const reg = Object.create(PluginRegistry.prototype);
  const fn = (args, caller) => { seen.push(caller); return { ok: 1 }; };
  reg.byId = () => ({ state: "active", manifest: { name: "X" }, methods: new Map([["m", fn]]) });
  const who = { kind: "lan", deviceId: "d1", deviceName: "Tablet" };
  assert.equal((await reg.call("x", "m", {}, who)).ok, true);
  assert.equal((await reg.call("x", "m", {})).ok, true);
  assert.deepEqual(seen, [who, { kind: "unknown", deviceId: null, deviceName: null }]);
});
