/**
 * The phone's storage across a product rename: a draft typed under the old
 * name is still there under the new one, and nothing the new build wrote is
 * ever replaced by a stale legacy copy.
 *
 * Every test builds a phone the way an OLDER build left it — keys spelled with
 * the legacy prefix, computed from `LEGACY` so the next rename re-uses this
 * file unchanged — runs the migration, then reads through the CURRENT registry
 * the way the app does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRAND, BRAND_WORDS, HOST_PARK_PREFIX, LEGACY } from "@waterplane/shared";

import {
  LEGACY_PULL_CACHES, PULL_CACHE, PULL_CACHE_PREFIXES, isSyncTsKey, migrateStorage, rewriteSyncTs,
} from "./brandMigrate.ts";
import { LS, RESET_KEEP_PREFIXES } from "../storage.ts";
import { activeHostId, bootHosts, finishSwitch, readHosts, writeSwitch } from "../hosts.ts";

const OLD = LEGACY[0];
/** A current registry key spelled the way the legacy build spelled it. */
const old = (key) => OLD.storagePrefix + key.slice(BRAND.storagePrefix.length);
/** A parked key, legacy spelling. */
const oldParked = (id, key) => `${OLD.storagePrefix}h.${id}.${key.slice(BRAND.storagePrefix.length)}`;
const newParked = (id, key) => `${HOST_PARK_PREFIX}${id}.${key.slice(BRAND.storagePrefix.length)}`;

/** `Storage`'s shape over a Map — insertion-ordered like the real one. */
function shim(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

const DRAFTS = JSON.stringify({ s1: "fix the flaky test — ümlaut 🙂", s2: "line\nbreak" });
const QUEUE = JSON.stringify([{ ackId: "a1", text: "queued words", status: "failed" }]);
const PAD = JSON.stringify([{ id: "n1", text: "pad note", ts: 1 }]);
const B_DRAFTS = JSON.stringify({ x: "B's parked draft" });

/** A two-desktop phone as the legacy build left it: A active, B parked. */
function legacyPhone() {
  const hosts = JSON.stringify([
    { id: "aaaa1111", name: "desk", base: "http://100.64.0.5:8770" },
    { id: "bbbb2222", name: "laptop", base: "http://100.64.0.9:8770" },
  ]);
  return shim({
    [old(LS.hosts)]: hosts,
    [old(LS.hostActive)]: "aaaa1111",
    [old(LS.hostBase)]: "http://100.64.0.5:8770",
    [old(LS.composeDrafts)]: DRAFTS,
    [old(LS.composeOutbox)]: QUEUE,
    [old(LS.pad)]: PAD,
    [old(LS.snippets)]: "[\"synced\"]",
    [old(LS.syncTs)]: JSON.stringify({ [old(LS.pad)]: 7, [old(LS.snippets)]: 5 }),
    [old(LS.theme)]: "light",
    [`${old(LS.deviceId)}`]: "dev-1",
    [`${OLD.storagePrefix}trSeen.s1`]: "42",
    [oldParked("bbbb2222", LS.composeDrafts)]: B_DRAFTS,
    [oldParked("bbbb2222", LS.syncTs)]: JSON.stringify({ [old(LS.pad)]: 3 }),
    "unrelated.key": "not ours",
  });
}

test("a typed draft, the queue and the pad survive: read through the current registry after the copy", () => {
  const kv = legacyPhone();
  const r = migrateStorage(kv, 1000);
  assert.equal(r.ran, true);
  assert.equal(kv.getItem(LS.composeDrafts), DRAFTS);
  assert.equal(kv.getItem(LS.composeOutbox), QUEUE);
  assert.equal(kv.getItem(LS.pad), PAD);
  assert.equal(kv.getItem(LS.theme), "light");
  assert.equal(kv.getItem(`${BRAND.storagePrefix}trSeen.s1`), "42", "built keys ride along");
  assert.equal(kv.getItem(newParked("bbbb2222", LS.composeDrafts)), B_DRAFTS, "a parked host's draft too");
  assert.equal(kv.getItem("unrelated.key"), "not ours");
});

test("COPY, never move: every legacy key still holds exactly what it held", () => {
  const before = legacyPhone();
  const kv = legacyPhone();
  migrateStorage(kv, 1000);
  for (const [k, v] of before.m) assert.equal(kv.getItem(k), v, k);
});

test("a key the new build already wrote is never overwritten by its legacy copy", () => {
  const kv = legacyPhone();
  kv.setItem(LS.composeDrafts, JSON.stringify({ s1: "typed in the new build" }));
  const r = migrateStorage(kv, 1000);
  assert.equal(kv.getItem(LS.composeDrafts), JSON.stringify({ s1: "typed in the new build" }));
  assert.ok(r.kept.includes(old(LS.composeDrafts)));
});

test("runs once: a draft cleared after the copy stays cleared", () => {
  const kv = legacyPhone();
  migrateStorage(kv, 1000);
  kv.removeItem(LS.composeDrafts);
  const again = migrateStorage(kv, 2000);
  assert.equal(again.ran, false);
  assert.equal(kv.getItem(LS.composeDrafts), null);
});

test("syncTs names the CURRENT keys afterwards, bare and parked — or every local value reads as never written", () => {
  const kv = legacyPhone();
  migrateStorage(kv, 1000);
  assert.deepEqual(JSON.parse(kv.getItem(LS.syncTs)), { [LS.pad]: 7, [LS.snippets]: 5 });
  assert.deepEqual(JSON.parse(kv.getItem(newParked("bbbb2222", LS.syncTs))), { [LS.pad]: 3 });
  // …and the legacy copy is untouched, for a bundle that still reads it.
  assert.deepEqual(JSON.parse(kv.getItem(old(LS.syncTs))), { [old(LS.pad)]: 7, [old(LS.snippets)]: 5 });
});

test("rewriteSyncTs: a current-name entry wins over its legacy twin; garbage is left alone", () => {
  const mixed = JSON.stringify({ [old(LS.pad)]: 1, [LS.pad]: 9, "other.key": 4 });
  assert.deepEqual(JSON.parse(rewriteSyncTs(mixed)), { [LS.pad]: 9, "other.key": 4 });
  assert.equal(rewriteSyncTs("not json"), "not json");
  assert.equal(rewriteSyncTs("[1,2]"), "[1,2]");
  assert.ok(isSyncTsKey(LS.syncTs));
  assert.ok(isSyncTsKey(newParked("abcd1234", LS.syncTs)));
  assert.ok(!isSyncTsKey(LS.pad));
  assert.ok(!isSyncTsKey(newParked("abcd1234", LS.pad)));
});

test("end to end: copy, boot the host list, switch to the parked desktop — its draft is there", () => {
  const kv = legacyPhone();
  migrateStorage(kv, 1000);
  bootHosts(kv);
  assert.equal(readHosts(kv).length, 2);
  assert.equal(activeHostId(kv), "aaaa1111");
  assert.equal(kv.getItem(LS.composeDrafts), DRAFTS, "A's draft is bare and active");
  writeSwitch(kv, { from: "aaaa1111", to: "bbbb2222" });
  finishSwitch(kv);
  assert.equal(activeHostId(kv), "bbbb2222");
  assert.equal(kv.getItem(LS.composeDrafts), B_DRAFTS, "B's draft restored from its park");
  assert.equal(kv.getItem(newParked("aaaa1111", LS.composeDrafts)), DRAFTS, "A's draft parked, not lost");
  // The mark followed the phone, not the host: a switch must not make the
  // copy run again (it would resurrect what was cleared since).
  assert.notEqual(kv.getItem(LS.brandMigrated), null);
  assert.equal(migrateStorage(kv, 3000).ran, false);
});

test("a hard reset keeps every legacy key and both marks", () => {
  const kv = legacyPhone();
  migrateStorage(kv, 1000);
  kv.setItem(LS.brandStores, "[]");
  for (const k of [...kv.m.keys()]) {
    if (!RESET_KEEP_PREFIXES.some((p) => k.startsWith(p))) kv.removeItem(k);
  }
  for (const k of legacyPhone().m.keys()) {
    if (k === "unrelated.key") continue;
    assert.notEqual(kv.getItem(k), null, `${k} dropped by the reset`);
  }
  assert.notEqual(kv.getItem(LS.brandMigrated), null);
  assert.notEqual(kv.getItem(LS.brandStores), null);
  assert.equal(kv.getItem(LS.composeDrafts), DRAFTS);
});

test("the pulls cache: one current name, every legacy one kept by reset and purge", () => {
  assert.ok(PULL_CACHE.startsWith(BRAND.slug));
  assert.equal(LEGACY_PULL_CACHES.length, LEGACY.length);
  for (const n of LEGACY_PULL_CACHES) assert.ok(PULL_CACHE_PREFIXES.includes(n));
  const sw = readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8");
  assert.match(sw, /const PULLS = `\$\{BRAND_SLUG\}-pulls-v1`/, "sw.js builds the name pull.ts reads");
  assert.match(sw, /!LEGACY_PULLS\.includes\(n\)/, "the activate purge spares the legacy pulls cache");
});

test("no product name is spelled in the files that cannot import brand.ts — they carry placeholders", () => {
  for (const rel of ["../../public/sw.js", "../../public/manifest.webmanifest", "../../index.html"]) {
    const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").toLowerCase();
    for (const w of BRAND_WORDS) assert.ok(!text.includes(w.toLowerCase()), `${rel} spells "${w}"`);
  }
});
