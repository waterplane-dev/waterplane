/**
 * The demo as a saved host (demo-mode-plan.md §4, WP5a): entering it parks the
 * real desktop's words, leaving gives every one back and leaves no trace of the
 * demo — and the places a demo can run say what each can offer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HOST_PARK_PREFIX } from "@waterplane/shared";

import {
  DEMO_HOST_ID, bootHosts, markDemoEnter, markDemoLeave, readHosts, realHosts, addHost, writeSwitch, finishSwitch,
} from "./hosts.ts";
import { demoPlaceOf } from "./demoEntry.ts";
import { prefixedStorage } from "./demo/world.ts";
import { DEMO_WORLD_PREFIX, LS } from "./storage.ts";

function shim(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    clear() { m.clear(); },
  };
}

/** A phone with one paired desktop `d` active and a typed draft on it. */
function pairedPhone() {
  const kv = shim({ [LS.compose]: JSON.stringify("words nobody may lose") });
  const r = addHost(kv, { name: "desk", base: "100.64.0.5" });
  assert.ok(r.ok);
  writeSwitch(kv, { from: null, to: r.host.id });
  bootHosts(kv);
  assert.equal(kv.getItem(LS.hostActive), r.host.id);
  return { kv, id: r.host.id };
}

test("entering the demo parks the desktop's words and makes the demo the host", () => {
  const { kv, id } = pairedPhone();
  assert.equal(markDemoEnter(kv, "first-look"), true);
  bootHosts(kv, "first-look");
  assert.equal(kv.getItem(LS.hostActive), DEMO_HOST_ID);
  assert.equal(kv.getItem(LS.demo), "first-look");
  assert.equal(kv.getItem(LS.compose), null, "the demo does not see the real draft");
  assert.ok([...kv.m.keys()].some((k) => k.startsWith(`${HOST_PARK_PREFIX}${id}.`)), "the draft is parked, not gone");
  assert.deepEqual(realHosts(readHosts(kv)).map((h) => h.id), [id]);
});

test("leaving the demo gives every word back and removes the demo row and its keys", () => {
  const { kv, id } = pairedPhone();
  markDemoEnter(kv, "first-look");
  bootHosts(kv);
  kv.setItem(LS.compose, JSON.stringify("typed inside the demo"));
  markDemoLeave(kv);
  bootHosts(kv);
  assert.equal(kv.getItem(LS.hostActive), id);
  assert.equal(kv.getItem(LS.demo), null);
  assert.equal(JSON.parse(kv.getItem(LS.compose)), "words nobody may lose");
  assert.deepEqual(readHosts(kv).map((h) => h.id), [id], "no demo row left");
  assert.equal([...kv.m.keys()].some((k) => k.includes(DEMO_HOST_ID)), false, "no demo keys parked");
});

test("any other way out of the demo (tapping a real host) ends it too", () => {
  const { kv, id } = pairedPhone();
  markDemoEnter(kv, "first-look");
  bootHosts(kv);
  writeSwitch(kv, { from: DEMO_HOST_ID, to: id });
  bootHosts(kv);
  assert.equal(kv.getItem(LS.demo), null, "the flag does not follow a person onto a real desktop");
  assert.equal(kv.getItem(LS.hostActive), id);
});

test("first run: the demo with no desktop leaves to the setup screen (no host)", () => {
  const kv = shim();
  assert.equal(markDemoEnter(kv, "first-look"), true);
  bootHosts(kv);
  assert.equal(kv.getItem(LS.hostActive), DEMO_HOST_ID);
  markDemoLeave(kv);
  bootHosts(kv);
  assert.equal(kv.getItem(LS.hostActive), null);
  assert.equal(kv.getItem(LS.hostBase), null, "hostConfigured() is false again: the first-run screen");
  assert.deepEqual(readHosts(kv), []);
});

test("a demo host with nothing asking for it is repaired, never stranded on demo.invalid", () => {
  const { kv, id } = pairedPhone();
  markDemoEnter(kv, "first-look");
  finishSwitch(kv);
  kv.removeItem(LS.demo); // the flag lost (cleared storage, an interrupted exit)
  bootHosts(kv);
  assert.equal(kv.getItem(LS.hostActive), id);
  assert.deepEqual(readHosts(kv).map((h) => h.id), [id]);
});

test("entering twice is a no-op", () => {
  const { kv } = pairedPhone();
  markDemoEnter(kv, "first-look");
  bootHosts(kv);
  assert.equal(markDemoEnter(kv, "first-look"), false);
});

test("where a demo runs decides what its line offers", () => {
  assert.equal(demoPlaceOf(true, "localhost"), "shell");
  assert.equal(demoPlaceOf(false, "100.64.0.5"), "host");
  assert.equal(demoPlaceOf(false, "desk.tail1234.ts.net"), "host");
  assert.equal(demoPlaceOf(false, "localhost"), "host");
  assert.equal(demoPlaceOf(false, "demo.example.com"), "static");
});

test("the static demo's storage is its own corner; only the demo flag keeps its name", () => {
  const real = shim({ "waterplane.compose": "real" });
  const w = prefixedStorage(real, DEMO_WORLD_PREFIX, new Set([LS.demo]));
  assert.equal(w.getItem("waterplane.compose"), null);
  w.setItem("waterplane.compose", "demo");
  assert.equal(real.getItem("waterplane.compose"), "real");
  assert.equal(real.getItem(`${DEMO_WORLD_PREFIX}waterplane.compose`), "demo");
  w.setItem(LS.demo, "first-look");
  assert.equal(real.getItem(LS.demo), "first-look");
  assert.deepEqual([...Array(w.length).keys()].map((i) => w.key(i)), ["waterplane.compose"]);
  w.clear();
  assert.equal(w.length, 0);
  assert.equal(real.getItem("waterplane.compose"), "real");
});
