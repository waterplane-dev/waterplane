// The paired-device ledger as the phone sees it (`shared/src/devices.ts`).
import test from "node:test";
import assert from "node:assert/strict";
import { DEVICE_SEEN_THROTTLE_MS, cleanDeviceRow, deviceSeenDue, isDeviceId, normalizeDeviceName, sortDevices } from "../dist/index.js";

test("device names are cleaned and capped, empty is null", () => {
  assert.equal(normalizeDeviceName("  Pixel\n8 "), "Pixel 8");
  assert.equal(normalizeDeviceName(""), null);
  assert.equal(normalizeDeviceName(null), null);
  assert.equal(normalizeDeviceName("x".repeat(100)).length, 40);
});

test("a ledger row is read strictly: no creation time, no row", () => {
  const ok = cleanDeviceRow({ id: "dev_abc123", name: "Pixel", createdAt: 100, lastSeenAt: 200, lastKind: "lan", tokenHash: "h" });
  assert.deepEqual(ok, { id: "dev_abc123", name: "Pixel", createdAt: 100, lastSeenAt: 200, lastKind: "lan" });
  assert.equal(cleanDeviceRow({ id: "dev_abc123", name: "Pixel" }), null);
  assert.equal(cleanDeviceRow({ id: "../x", name: "Pixel", createdAt: 1 }), null);
  assert.equal(cleanDeviceRow({ id: "dev_abc123", name: " ", createdAt: 1 }), null);
  const partial = cleanDeviceRow({ id: "dev_abc123", name: "P", createdAt: 100, lastKind: "mars", current: true });
  assert.equal(partial.lastSeenAt, 100);
  assert.equal(partial.lastKind, null);
  assert.equal(partial.current, true);
  assert.ok(isDeviceId("abcdef"));
  assert.ok(!isDeviceId("a b"));
});

test("this phone first, then most recently seen", () => {
  const rows = [
    { id: "a", name: "a", createdAt: 1, lastSeenAt: 5, lastKind: null },
    { id: "b", name: "b", createdAt: 1, lastSeenAt: 9, lastKind: null },
    { id: "c", name: "c", createdAt: 1, lastSeenAt: 1, lastKind: null, current: true },
  ];
  assert.deepEqual(sortDevices(rows).map((r) => r.id), ["c", "b", "a"]);
});

test("lastSeen is written at most once a minute", () => {
  assert.ok(!deviceSeenDue(1000, 1000 + DEVICE_SEEN_THROTTLE_MS - 1));
  assert.ok(deviceSeenDue(1000, 1000 + DEVICE_SEEN_THROTTLE_MS));
});
