/**
 * Several desktops on one phone, over a real localStorage-shaped shim: the
 * one-host migration, the two-phase switch (`finishSwitch` at boot), remove
 * and re-add. What it pins is the one thing that must never happen here —
 * a host switch LOSING typed words — so every test that moves keys also
 * checks that every value ever written is still somewhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BRAND, HOST_PARK_PREFIX, bareKeyFor, lsKey, parkedKeyFor } from "@waterplane/shared";

import {
  addHost, allKeys, bootHosts, dropInactiveHost, finishSwitch, planRemove, readGone, readHosts, stallTail, takeSwitchFailure, updateHost, writeSwitch,
} from "./hosts.ts";
import { pickSavedBase } from "./hostUrl.ts";
import { LS } from "./storage.ts";

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
const snapshot = (kv) => Object.fromEntries([...kv.m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
const bare = (kv) => Object.fromEntries([...kv.m.entries()].filter(([k]) => !k.startsWith(HOST_PARK_PREFIX)).sort(([a], [b]) => (a < b ? -1 : 1)));
const hostOf = (kv) => kv.getItem(LS.hostActive);

// Typed words and caches of host A, as a real phone holds them — unicode,
// JSON, an empty string, a built key, a key no registry knows.
const A_WORDS = {
  [LS.composeDrafts]: JSON.stringify({ s1: "fix the flaky test — ümlaut 🙂", s2: "line\nbreak" }),
  [LS.composeOutbox]: JSON.stringify([{ ackId: "a1", text: "queued words", status: "failed" }]),
  [LS.composeSheets]: JSON.stringify({ send: "a sheet draft" }),
  [LS.pad]: JSON.stringify([{ id: "n1", text: "pad note", ts: 1 }]),
  [LS.backlogDraft]: "a backlog idea",
  [LS.snippets]: "[\"synced\"]",
  [LS.syncTs]: JSON.stringify({ [LS.snippets]: 5 }),
  [LS.snapSessions]: "[]",
  [LS.fanoutText]: "\"\"",
  [lsKey("trSeen.s1")]: "42",
  [lsKey("fromAnOlderBuild")]: "kept",
};
const DEVICE = {
  [LS.theme]: "dark",
  [LS.deviceId]: "dev-1",
  [LS.textScale]: "1.2",
  "unrelated.key": "not ours",
};

function twoHosts() {
  const kv = shim({ ...DEVICE, ...A_WORDS, [LS.hostBase]: "http://100.64.0.5:8770" });
  bootHosts(kv); // migration: A is the legacy host
  const r = addHost(kv, { name: "laptop", base: "100.64.0.9" });
  assert.ok(r.ok);
  return { kv, a: "legacy", b: r.host.id };
}

/** Every value of `words` is present under its bare key or some parked copy. */
function assertNothingLost(kv, words) {
  for (const [k, v] of Object.entries(words)) {
    const where = [...kv.m.entries()].filter(([key, val]) => val === v && (key === k || key.endsWith(k.slice(BRAND.storagePrefix.length))));
    assert.ok(where.length > 0, `${k} is gone`);
  }
}

test("boot migrates the one-hostBase era to a legacy host, copying nothing", () => {
  const kv = shim({ ...A_WORDS, [LS.hostBase]: "100.64.0.5" });
  const before = snapshot(kv);
  bootHosts(kv);
  const hosts = readHosts(kv);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].id, "legacy");
  assert.equal(hosts[0].legacy, true);
  assert.equal(hostOf(kv), "legacy");
  for (const [k, v] of Object.entries(A_WORDS)) assert.equal(kv.getItem(k), v, k);
  assert.ok(!allKeys(kv).some((k) => k.startsWith(HOST_PARK_PREFIX)));
  // Idempotent.
  const once = snapshot(kv);
  bootHosts(kv);
  assert.deepEqual(snapshot(kv), once);
  assert.notDeepEqual(once, before);
});

test("nothing configured: boot writes nothing", () => {
  const kv = shim({ ...DEVICE });
  bootHosts(kv);
  assert.deepEqual(snapshot(kv), snapshot(shim({ ...DEVICE })));
});

test("the asking page only writes the marker; the switch happens at the next boot", () => {
  const { kv, a, b } = twoHosts();
  const before = bare(kv);
  writeSwitch(kv, { from: a, to: b });
  assert.equal(hostOf(kv), a);
  for (const [k, v] of Object.entries(A_WORDS)) assert.equal(kv.getItem(k), v, `${k} moved before the reload`);
  bootHosts(kv);
  assert.equal(hostOf(kv), b);
  assert.equal(kv.getItem(LS.hostSwitch), null);
  assert.equal(kv.getItem(LS.hostBase), "http://100.64.0.9:8770");
  // A's words are parked, none are bare.
  for (const [k, v] of Object.entries(A_WORDS)) {
    assert.equal(kv.getItem(k), null, `${k} still bare on B`);
    assert.equal(kv.getItem(parkedKeyFor(k, a)), v, `${k} not parked`);
  }
  // Device keys never move.
  for (const [k, v] of Object.entries(DEVICE)) assert.equal(kv.getItem(k), v, k);
  assert.notDeepEqual(bare(kv), before);
});

test("A → B → A is a byte-identical round trip, and B keeps what was typed on B", () => {
  const { kv, a, b } = twoHosts();
  const onA = bare(kv);
  writeSwitch(kv, { from: a, to: b });
  bootHosts(kv);
  kv.setItem(LS.composeDrafts, JSON.stringify({ sB: "typed on B" }));
  kv.setItem(LS.theme, "light"); // a device key changed while on B stays changed
  const onB = bare(kv);
  writeSwitch(kv, { from: b, to: a });
  bootHosts(kv);
  assert.deepEqual(bare(kv), { ...onA, [LS.theme]: "light" });
  assert.equal(kv.getItem(parkedKeyFor(LS.composeDrafts, b)), JSON.stringify({ sB: "typed on B" }));
  // …and back to B again restores B's bare keys exactly.
  writeSwitch(kv, { from: a, to: b });
  bootHosts(kv);
  assert.deepEqual(bare(kv), onB);
  assertNothingLost(kv, A_WORDS);
});

test("the park is a mirror: a draft SENT while active does not come back on return", () => {
  const { kv, a, b } = twoHosts();
  writeSwitch(kv, { from: a, to: b });
  bootHosts(kv);
  writeSwitch(kv, { from: b, to: a });
  bootHosts(kv);
  kv.removeItem(LS.backlogDraft); // the app itself deleted it on A
  writeSwitch(kv, { from: a, to: b });
  bootHosts(kv);
  writeSwitch(kv, { from: b, to: a });
  bootHosts(kv);
  assert.equal(kv.getItem(LS.backlogDraft), null);
  assert.equal(kv.getItem(parkedKeyFor(LS.backlogDraft, a)), null);
});

test("a boot interrupted after the commit point finishes the restore only", () => {
  const { kv, a, b } = twoHosts();
  kv.setItem(parkedKeyFor(LS.composeDrafts, b), JSON.stringify({ x: "B's parked draft" }));
  writeSwitch(kv, { from: a, to: b });
  // Simulate: everything up to the commit point ran, the restore did not.
  const marker = kv.getItem(LS.hostSwitch);
  finishSwitch(kv);
  kv.removeItem(LS.composeDrafts); // pretend the restore never landed
  kv.setItem(LS.hostSwitch, marker);
  bootHosts(kv);
  assert.equal(hostOf(kv), b);
  assert.equal(kv.getItem(LS.composeDrafts), JSON.stringify({ x: "B's parked draft" }));
  assertNothingLost(kv, A_WORDS);
});

test("a stale marker (from is not the active host) moves nothing", () => {
  const { kv, b } = twoHosts();
  const before = snapshot(kv);
  kv.setItem(LS.hostSwitch, JSON.stringify({ from: "gone0000", to: b }));
  bootHosts(kv);
  assert.deepEqual(snapshot(kv), before);
});

test("removing an inactive host drops only its row; its parked words and id are kept for a re-add", () => {
  const { kv, a, b } = twoHosts();
  writeSwitch(kv, { from: a, to: b });
  bootHosts(kv);
  assert.deepEqual(planRemove(kv, a), { kind: "drop" });
  assert.ok(dropInactiveHost(kv, a));
  assert.deepEqual(readHosts(kv).map((h) => h.id), [b]);
  assert.equal(readGone(kv)[0].id, a);
  assertNothingLost(kv, A_WORDS);
  // Re-adding the same address reuses the id (and the legacy IDB name).
  const r = addHost(kv, { base: "http://100.64.0.5:8770" });
  assert.ok(r.ok);
  assert.equal(r.host.id, a);
  assert.equal(r.host.legacy, true);
  assert.equal(r.reused, true);
  assert.equal(readGone(kv).length, 0);
  writeSwitch(kv, { from: b, to: a });
  bootHosts(kv);
  for (const [k, v] of Object.entries(A_WORDS)) assert.equal(kv.getItem(k), v, k);
});

test("removing the ACTIVE host switches first, then drops it — words parked, not deleted", () => {
  const { kv, a, b } = twoHosts();
  assert.deepEqual(planRemove(kv, a), { kind: "switch", next: b });
  writeSwitch(kv, { from: a, to: b, drop: a });
  bootHosts(kv);
  assert.equal(hostOf(kv), b);
  assert.deepEqual(readHosts(kv).map((h) => h.id), [b]);
  assertNothingLost(kv, A_WORDS);
});

test("removing the LAST host parks its words and lands on the setup screen; re-adding brings them back", () => {
  const kv = shim({ ...DEVICE, ...A_WORDS, [LS.hostBase]: "100.64.0.5" });
  bootHosts(kv);
  assert.deepEqual(planRemove(kv, "legacy"), { kind: "switch", next: null });
  writeSwitch(kv, { from: "legacy", to: null, drop: "legacy" });
  bootHosts(kv);
  assert.equal(hostOf(kv), null);
  assert.equal(kv.getItem(LS.hostBase), null);
  assert.deepEqual(readHosts(kv), []);
  for (const k of Object.keys(A_WORDS)) assert.equal(kv.getItem(k), null, k);
  assertNothingLost(kv, A_WORDS);
  // First-run add of the same address: no previous host, restore only.
  const r = addHost(kv, { base: "100.64.0.5" });
  assert.ok(r.ok && r.reused);
  writeSwitch(kv, { from: null, to: r.host.id });
  bootHosts(kv);
  for (const [k, v] of Object.entries(A_WORDS)) assert.equal(kv.getItem(k), v, k);
});

test("a first add over leftover bare words never overwrites them", () => {
  const kv = shim({ [LS.composeDrafts]: "\"leftover\"", [parkedKeyFor(LS.composeDrafts, "abcd1234")]: "\"parked\"" });
  kv.setItem(LS.hostsGone, JSON.stringify([{ id: "abcd1234", name: "x", base: "http://100.64.0.7:8770" }]));
  const r = addHost(kv, { base: "100.64.0.7" });
  assert.ok(r.ok && r.reused);
  writeSwitch(kv, { from: null, to: r.host.id });
  bootHosts(kv);
  assert.equal(kv.getItem(LS.composeDrafts), "\"leftover\"");
  assert.equal(kv.getItem(parkedKeyFor(LS.composeDrafts, "abcd1234")), "\"parked\"");
});

test("add refuses a duplicate address; edit re-points hostBase only for the active host", () => {
  const { kv, a, b } = twoHosts();
  const dup = addHost(kv, { base: "100.64.0.9" });
  assert.equal(dup.ok, false);
  const e = updateHost(kv, b, { name: "renamed", base: "100.64.0.10", lan: { base: "192.168.1.20", ssids: ["\"Home\""], auto: true } });
  assert.ok(e.ok);
  assert.equal(e.host.name, "renamed");
  assert.deepEqual(e.host.lan, { base: "http://192.168.1.20:8770", ssids: ["Home"], auto: true });
  assert.equal(kv.getItem(LS.hostBase), "http://100.64.0.5:8770");
  const e2 = updateHost(kv, a, { base: "100.64.0.6" });
  assert.ok(e2.ok);
  assert.equal(kv.getItem(LS.hostBase), "http://100.64.0.6:8770");
  assert.equal(readHosts(kv).find((h) => h.id === a).legacy, true);
});

// ── Crash at every step ──────────────────────────────────────────────
// The WebView can die between any two storage writes of the boot-time switch.
// Each case lets the first `n` mutations land, throws on the next (the
// process dying there), then boots again with no limit — and asserts every
// typed word of A is parked, B's parked words are restored, and nothing of A
// is left bare. `n` walks every boundary, then a second crash is layered on
// each first one, because the redo itself can die too.

/** A shim whose mutations throw once `budget` of them have landed. */
function crashing(kv) {
  const box = { budget: Infinity, count: 0 };
  const guard = () => { if (box.count >= box.budget) throw new Error("webview died"); box.count++; };
  return {
    box,
    kv: {
      m: kv.m,
      getItem: kv.getItem,
      setItem: (k, v) => { guard(); kv.setItem(k, v); },
      removeItem: (k) => { guard(); kv.removeItem(k); },
      key: kv.key,
      get length() { return kv.m.size; },
    },
  };
}

const B_WORDS = {
  [parkedKeyFor(LS.composeDrafts, "__B__")]: JSON.stringify({ sB: "B's own draft" }),
  [parkedKeyFor(LS.pad, "__B__")]: JSON.stringify([{ id: "nB", text: "B pad", ts: 2 }]),
};

function armed() {
  const { kv, a, b } = twoHosts();
  for (const [k, v] of Object.entries(B_WORDS)) kv.setItem(k.replace("__B__", b), v);
  writeSwitch(kv, { from: a, to: b });
  return { kv, a, b };
}

function assertSwitchedIntact(kv, a, b, label) {
  assert.equal(hostOf(kv), b, `${label}: not on B`);
  assert.equal(kv.getItem(LS.hostSwitch), null, `${label}: marker left`);
  for (const [k, v] of Object.entries(A_WORDS)) {
    assert.equal(kv.getItem(parkedKeyFor(k, a)), v, `${label}: A's ${k} lost from its park`);
    const bIsHere = Object.keys(B_WORDS).some((bk) => bareKeyFor(bk, "__B__") === k);
    if (!bIsHere) assert.equal(kv.getItem(k), null, `${label}: A's ${k} still bare on B`);
  }
  for (const [k, v] of Object.entries(B_WORDS)) {
    const pk = k.replace("__B__", b);
    assert.equal(kv.getItem(pk), v, `${label}: B's parked ${pk} lost`);
    assert.equal(kv.getItem(bareKeyFor(pk, b)), v, `${label}: B's ${pk} not restored`);
  }
  for (const [k, v] of Object.entries(DEVICE)) assert.equal(kv.getItem(k), v, `${label}: device ${k}`);
}

/** How many mutations one uninterrupted switch makes. */
function totalSteps() {
  const { kv } = armed();
  const c = crashing(kv);
  bootHosts(c.kv);
  return c.box.count;
}

test("a switch killed at ANY step boundary loses no typed word on the next boot", () => {
  const total = totalSteps();
  assert.ok(total > Object.keys(A_WORDS).length * 2, `only ${total} steps — the walk would prove nothing`);
  for (let n = 0; n <= total; n++) {
    const { kv, a, b } = armed();
    const c = crashing(kv);
    c.box.budget = n;
    bootHosts(c.kv); // swallows the throw, like a boot that died there
    bootHosts(kv);
    assertSwitchedIntact(kv, a, b, `crash after ${n}/${total}`);
  }
});

test("…and when the redo is killed too, at any step, the third boot still loses nothing", () => {
  const total = totalSteps();
  for (let n = 0; n < total; n++) {
    for (let m = 0; m <= total; m++) {
      const { kv, a, b } = armed();
      const c = crashing(kv);
      c.box.budget = n;
      bootHosts(c.kv);
      c.box.count = 0;
      c.box.budget = m;
      bootHosts(c.kv);
      bootHosts(kv);
      assertSwitchedIntact(kv, a, b, `crash after ${n}, then after ${m}`);
    }
  }
});

test("the redo after the bare keys are gone does not mirror-delete the park (the bug this walk caught)", () => {
  const { kv, a, b } = armed();
  // Hand-play the old failure: every A key parked AND removed from bare, the
  // marker still says from=A, hostActive still A.
  for (const k of Object.keys(A_WORDS)) { kv.setItem(parkedKeyFor(k, a), kv.getItem(k)); kv.removeItem(k); }
  bootHosts(kv);
  assertSwitchedIntact(kv, a, b, "bare already cleared, no parked mark");
});

// ── A FULL store: the throw that repeats on every boot ──────────────────
//
// 2026-11-01, the owner's phone: a tap on the switch key, a reload, and the
// launcher back on the SAME desktop with nothing said; earlier the header had
// named the other desktop while every request still went to the old one. A
// park COPIES every host key before it removes any, so it needs as much free
// room again as the host's words take. A WebView over its localStorage quota
// throws at the same copy on every boot, `bootHosts` swallowed it, the marker
// stayed, and the redo failed identically forever — and the same throw skipped
// the migration that aligns `hostBase` with the active host.

/** A shim whose setItem throws QuotaExceededError past `cap` UTF-16 units. */
function full(kv, cap) {
  const used = () => [...kv.m.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    m: kv.m,
    getItem: kv.getItem,
    setItem: (k, v) => {
      const before = kv.m.has(k) ? k.length + kv.m.get(k).length : 0;
      if (used() - before + k.length + String(v).length > cap) {
        const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e;
      }
      kv.setItem(k, v);
    },
    removeItem: kv.removeItem,
    key: kv.key,
    get length() { return kv.m.size; },
  };
}
const sizeOf = (kv) => [...kv.m.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);

test("a switch that cannot park for lack of room is abandoned and SAID, not retried silently every boot", () => {
  const { kv, a, b } = armed();
  const before = snapshot(kv);
  const tight = full(kv, sizeOf(kv) + 200); // room for the note, not for A's park
  bootHosts(tight);
  assert.equal(hostOf(kv), a, "still on A");
  assert.equal(kv.getItem(LS.hostSwitch), null, "marker dropped: no silent retry on the next boot");
  // Nothing lost, and no half-written park copy left to fill the store further.
  for (const [k, v] of Object.entries(A_WORDS)) {
    assert.equal(kv.getItem(k), v, `A's ${k} still bare`);
    assert.equal(kv.getItem(parkedKeyFor(k, a)), null, `A's ${k}: half-park copy left behind`);
  }
  const note = takeSwitchFailure(kv);
  assert.deepEqual({ ...note, at: 0 }, { stage: "park", from: a, to: b, at: 0 });
  assert.equal(takeSwitchFailure(kv), null, "said once");
  const settled = snapshot(kv);
  bootHosts(tight);
  assert.deepEqual(snapshot(kv), settled, "a second boot moves nothing");
  const { [LS.hostSwitch]: _marker, ...beforeNoMarker } = before;
  assert.deepEqual(settled, beforeNoMarker, "the store is as before the tap, minus the marker");
  // Room again: the next tap switches as usual.
  writeSwitch(kv, { from: a, to: b });
  bootHosts(kv);
  assertSwitchedIntact(kv, a, b, "after room was freed");
});

test("an ordinary throw (the process dying) still keeps the marker for the redo", () => {
  const { kv, a, b } = armed();
  const c = crashing(kv);
  c.box.budget = 3;
  bootHosts(c.kv);
  assert.notEqual(kv.getItem(LS.hostSwitch), null);
  assert.equal(takeSwitchFailure(kv), null, "a crash is not reported as a full store");
  bootHosts(kv);
  assertSwitchedIntact(kv, a, b, "redo");
});

test("the address the page dials is the active row's, even when hostBase lagged behind a throw", () => {
  const { kv, b } = armed();
  const hosts = kv.getItem(LS.hosts);
  // The 11:07 screen: hostActive already on B, hostBase still A's.
  assert.equal(pickSavedBase(hosts, b, "http://100.64.0.5:8770"), "http://100.64.0.9:8770");
  // No list (first run, an older build): the stored hostBase as before.
  assert.equal(pickSavedBase(null, null, "100.64.0.5"), "http://100.64.0.5:8770");
  assert.equal(pickSavedBase(hosts, "gone-id", "http://100.64.0.5:8770"), "http://100.64.0.5:8770");
  assert.equal(pickSavedBase(null, null, null), null);
});

test("the stall chip names the desktop the requests went to, once there are two", () => {
  const hosts = [{ id: "mac", name: "MacStudio", base: "http://100.64.0.5:8770" }, { id: "zen", name: "zenbookJ", base: "http://100.64.0.9:8770" }];
  assert.equal(stallTail(hosts, "mac"), " — MacStudio is not answering");
  assert.equal(stallTail(hosts.slice(0, 1), "mac"), " — the connection may be down", "one desktop: no name");
});

test("a switch that commits but cannot restore for lack of room dials the NEW desktop, never the old one under the new name", () => {
  // The owner's 11:07 screen: header "zenbookJ", every request to the Mac.
  // Both desktops used before, so A's park only overwrites its earlier copies
  // (no growth) and lands; B's restore needs B's size again and throws.
  const { kv, a, b } = armed();
  for (const k of Object.keys(A_WORDS)) kv.setItem(parkedKeyFor(k, a), kv.getItem(k));
  const big = "x".repeat(4000);
  kv.setItem(parkedKeyFor(LS.backlogDraft, b), big);
  const tight = full(kv, sizeOf(kv) + 400);
  bootHosts(tight);
  assert.equal(hostOf(kv), b, "committed: the list says B");
  const dialled = pickSavedBase(kv.getItem(LS.hosts), kv.getItem(LS.hostActive), kv.getItem(LS.hostBase));
  assert.equal(dialled, "http://100.64.0.9:8770", "the page dials B — the desktop its header names");
  assert.notEqual(kv.getItem(LS.hostSwitch), null, "marker kept: the restore is retried");
  assert.equal(kv.getItem(parkedKeyFor(LS.backlogDraft, b)), big, "B's words safe in the park");
  assert.equal(takeSwitchFailure(kv)?.stage, "restore", "and the page says so");
  // Room again: the next boot finishes the restore.
  bootHosts(kv);
  assert.equal(kv.getItem(LS.hostSwitch), null);
  assert.equal(kv.getItem(LS.backlogDraft), big);
  assert.equal(kv.getItem(LS.hostBase), "http://100.64.0.9:8770");
});
