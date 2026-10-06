// The saved-host list (`shared/src/hosts.ts`): what a host row is, the
// migration from the one `hostBase`, and the key parking a host switch does.
import test from "node:test";
import { BRAND } from "../dist/brand.js";
const P = BRAND.storagePrefix;
import assert from "node:assert/strict";
import {
  LEGACY_HOST_ID, cleanHostList, cleanSavedHost, dbNameFor, defaultHostName, isHostId, newHostId,
  normalizeHostName, normalizeSsid, normalizeSsids, parseHostList, planHostMigration, planHostSwitch,
  parkedKeyFor, bareKeyFor, parkedKeysOf, serializeHostList,
} from "../dist/index.js";

test("a new id is well-formed and never collides", () => {
  let n = 0;
  const bytes = (k) => Uint8Array.from({ length: k }, () => n++ % 256);
  const a = newHostId([], bytes);
  assert.ok(isHostId(a));
  assert.equal(a.length, 8);
  const seq = () => (k) => new Uint8Array(k); // always "aaaaaaaa"
  let calls = 0;
  const stuck = (k) => (calls++ === 0 ? new Uint8Array(k) : Uint8Array.from({ length: k }, () => 1));
  assert.equal(newHostId([], seq()), "aaaaaaaa");
  assert.equal(newHostId(["aaaaaaaa"], stuck), "bbbbbbbb");
  for (let i = 0; i < 50; i++) assert.ok(isHostId(newHostId()));
});

test("names and ssids are cleaned, never invented", () => {
  assert.equal(normalizeHostName("  my\tdesk \n"), "my desk");
  assert.equal(normalizeHostName("   "), null);
  assert.equal(normalizeHostName("x".repeat(80)).length, 40);
  assert.equal(defaultHostName("http://desk.tail1234.ts.net:8770"), "desk");
  assert.equal(defaultHostName("http://100.64.0.5:8770"), "100.64.0.5");
  assert.equal(defaultHostName("http://[fd7a::1]:8770"), "fd7a::1");
  assert.equal(normalizeSsid('"Home"'), "Home");
  assert.equal(normalizeSsid("<unknown ssid>"), null);
  assert.equal(normalizeSsid('"<unknown ssid>"'), null);
  assert.equal(normalizeSsid(""), null);
  assert.deepEqual(normalizeSsids(['"Home"', "Home", "home", 3, null]), ["Home", "home"]);
});

test("a stored row is cleaned; garbage is dropped", () => {
  assert.deepEqual(cleanSavedHost({ id: "abcd1234", name: "", base: "100.64.0.5" }), {
    id: "abcd1234", name: "100.64.0.5", base: "http://100.64.0.5:8770",
  });
  assert.equal(cleanSavedHost({ id: "abcd1234", base: "javascript:alert(1)" }), null);
  assert.equal(cleanSavedHost({ id: "../x", base: "100.64.0.5" }), null);
  const withLan = cleanSavedHost({ id: "abcd1234", name: "d", base: "x.ts.net", lan: { base: "192.168.1.2", ssids: ['"Home"'], auto: "yes" } });
  assert.deepEqual(withLan.lan, { base: "http://192.168.1.2:8770", ssids: ["Home"], auto: false });
  const list = cleanHostList([
    { id: "aaaa1111", name: "a", base: "a.ts.net", legacy: true },
    { id: "aaaa1111", name: "dup", base: "b.ts.net" },
    { id: "bbbb2222", name: "b", base: "b.ts.net", legacy: true },
    "junk",
  ]);
  assert.deepEqual(list.map((h) => [h.id, !!h.legacy]), [["aaaa1111", true], ["bbbb2222", false]]);
  assert.equal(parseHostList(null), null);
  assert.equal(parseHostList("{nope"), null);
  assert.deepEqual(parseHostList(serializeHostList(list)), list);
});

test("dbNameFor: the legacy host keeps the old IDB", () => {
  assert.equal(dbNameFor({ id: LEGACY_HOST_ID, legacy: true }), BRAND.cacheName);
  assert.equal(dbNameFor(null), BRAND.cacheName);
  assert.equal(dbNameFor({ id: "abcd1234" }), `${BRAND.cacheName}.abcd1234`);
});

function applyMigration(store, m) {
  if (m.writes.hosts !== undefined) store.hosts = m.writes.hosts;
  if (m.writes.active !== undefined) store.active = m.writes.active;
  if (m.writes.hostBase !== undefined) store.hostBase = m.writes.hostBase;
}

test("migration: one hostBase becomes one legacy host, and a second run writes nothing", () => {
  const store = { hosts: null, active: null, hostBase: "http://100.64.0.5:8770" };
  const m1 = planHostMigration(store);
  assert.equal(m1.activeId, LEGACY_HOST_ID);
  assert.deepEqual(m1.hosts, [{ id: LEGACY_HOST_ID, name: "100.64.0.5", base: "http://100.64.0.5:8770", legacy: true }]);
  assert.equal(m1.writes.hostBase, undefined, "an already-canonical hostBase is not rewritten");
  applyMigration(store, m1);
  const m2 = planHostMigration(store);
  assert.deepEqual(m2.writes, {});
  assert.deepEqual(m2.hosts, m1.hosts);
  // A lost write (only hosts landed) still converges to the same result.
  const half = { hosts: m1.writes.hosts, active: null, hostBase: store.hostBase };
  const m3 = planHostMigration(half);
  assert.equal(m3.activeId, LEGACY_HOST_ID);
  applyMigration(half, m3);
  assert.deepEqual(planHostMigration(half).writes, {});
});

test("migration: nothing configured stays nothing; unreadable list not overwritten", () => {
  assert.deepEqual(planHostMigration({ hosts: null, active: null, hostBase: null }), { hosts: [], activeId: null, writes: {} });
  assert.deepEqual(planHostMigration({ hosts: "{bad", active: null, hostBase: null }).writes, {});
});

test("migration: unknown active falls back to the first host, hostBase follows active", () => {
  const hosts = serializeHostList([
    { id: "aaaa1111", name: "a", base: "http://a:8770" },
    { id: "bbbb2222", name: "b", base: "http://b:8770" },
  ]);
  const m = planHostMigration({ hosts, active: "gone0000", hostBase: "http://b:8770" });
  assert.equal(m.activeId, "aaaa1111");
  assert.deepEqual(m.writes, { active: "aaaa1111", hostBase: "http://a:8770" });
  const n = planHostMigration({ hosts, active: "bbbb2222", hostBase: "http://b:8770" });
  assert.deepEqual(n.writes, {});
});

test("parked key mapping round-trips", () => {
  assert.equal(parkedKeyFor(P + "outbox", "abcd1234"), P + "h.abcd1234.outbox");
  assert.equal(bareKeyFor(P + "h.abcd1234.outbox", "abcd1234"), P + "outbox");
  assert.equal(bareKeyFor(P + "h.other000.outbox", "abcd1234"), null);
  assert.equal(bareKeyFor(P + "outbox", "abcd1234"), null);
});

const DEVICE = new Set([P + "hosts", P + "hostActive", P + "hostBase", P + "theme"]);
const isDevice = (k) => DEVICE.has(k);

function run(store, ops) {
  for (const o of ops) {
    if (o.op === "copy") {
      assert.ok(o.from in store, `copy from missing ${o.from}`);
      store[o.to] = store[o.from];
    } else delete store[o.key];
  }
}

test("a host switch parks every host key, restores the other, never touches device keys", () => {
  const store = {
    [P + "hosts"]: "[]", [P + "theme"]: "dark", "other.key": "x",
    [P + "outbox"]: "A-out", [P + "compose.x"]: "A-draft", [P + "trSeen.s1"]: "1",
    [P + "h.bbbb2222.outbox"]: "B-out", [P + "h.bbbb2222.theme"]: "B-theme",
    [P + "h.aaaa1111.stale"]: "old",
  };
  const before = { ...store };
  const ops = planHostSwitch(Object.keys(store), isDevice, "aaaa1111", "bbbb2222");
  run(store, ops);
  // Every host-scoped value of A is parked — none dropped.
  for (const k of [P + "outbox", P + "compose.x", P + "trSeen.s1"]) {
    assert.equal(store[parkedKeyFor(k, "aaaa1111")], before[k], k);
  }
  assert.equal(store[P + "h.aaaa1111.stale"], undefined, "park mirrors the bare set");
  assert.equal(store[P + "outbox"], "B-out");
  assert.equal(store[P + "compose.x"], undefined);
  assert.equal(store[P + "theme"], "dark", "a parked copy never overwrites a device key");
  assert.equal(store[P + "hosts"], "[]");
  assert.equal(store["other.key"], "x");
  assert.equal(store[P + "h.bbbb2222.outbox"], "B-out", "parked namespaces are kept");
  // Switching back restores A exactly.
  run(store, planHostSwitch(Object.keys(store), isDevice, "bbbb2222", "aaaa1111"));
  for (const k of [P + "outbox", P + "compose.x", P + "trSeen.s1"]) assert.equal(store[k], before[k]);
  assert.deepEqual(parkedKeysOf(Object.keys(store), "bbbb2222").sort(), [P + "h.bbbb2222.outbox"], "B re-parked as a mirror: its dead device-key copy went");
});

test("parking never drops a key: every bare removal comes after its copy", () => {
  const keys = [P + "a", P + "b", P + "hostBase", P + "h.bbbb2222.a", P + "h.aaaa1111.a"];
  for (let cut = 0; cut <= 10; cut++) {
    const store = Object.fromEntries(keys.map((k) => [k, k]));
    const ops = planHostSwitch(keys, isDevice, "aaaa1111", "bbbb2222");
    run(store, ops.slice(0, cut));
    // Whatever step it died at, A's values exist bare or parked.
    for (const k of [P + "a", P + "b"]) {
      assert.ok(store[k] === k || store[parkedKeyFor(k, "aaaa1111")] === k, `cut ${cut}: ${k} lost`);
    }
  }
});

test("a switch to the same host only snapshots", () => {
  const ops = planHostSwitch([P + "a", P + "h.aaaa1111.gone"], isDevice, "aaaa1111", "aaaa1111");
  assert.deepEqual(ops, [{ op: "copy", from: P + "a", to: P + "h.aaaa1111.a" }]);
});
