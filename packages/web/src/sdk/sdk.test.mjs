/**
 * The SDK's pure half: the store, the cached per-repo list, and the run/output
 * bookkeeping build and capture share.
 *
 * In a subfolder on purpose — `npm run test:unit` globs `packages/web/src/**`,
 * and a test here that never ran would be the proof that it does not.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "./store.ts";
import { cachedList, fromSnap, withList } from "./cached.ts";
import { appendOutput, replaceRepoRuns, repoRunStore, upsertRun } from "./repoRun.ts";
import { mapWith, mapWithout } from "./hooks.ts";
import { bindCore, core } from "../core/api.ts";

test("a store emits on change, and not on an equal value", () => {
  const s = createStore({ n: 0 });
  let emits = 0;
  const off = s.subscribe(() => { emits++; });
  s.set((p) => ({ n: p.n + 1 }));
  assert.deepEqual(s.get(), { n: 1 });
  // Returning `prev` is how a chatty push keeps everything still.
  s.set((p) => p);
  assert.equal(emits, 1);
  off();
  s.set({ n: 2 });
  assert.equal(emits, 1);
});

test("a listener that unsubscribes mid-emit does not skip the next one", () => {
  const s = createStore(0);
  const seen = [];
  const offA = s.subscribe(() => { seen.push("a"); offA(); });
  s.subscribe(() => seen.push("b"));
  s.set(1);
  assert.deepEqual(seen, ["a", "b"]);
});

test("a cached list is seeded from the snapshot and stamped by the save", () => {
  const saved = {};
  const store = cachedList({
    load: () => ({ "/r/a": { v: ["x"], at: 5 } }),
    save: (dir, list) => { saved[dir] = { v: list, at: 42 }; return saved; },
  });
  assert.deepEqual(store.get().lists.get("/r/a"), ["x"]);
  assert.equal(store.get().at.get("/r/a"), 5);
  store.put("/r/b", ["y"]);
  // The screen's stamp is the one the disk has — never a second Date.now().
  assert.equal(store.get().at.get("/r/b"), 42);
  assert.deepEqual(store.get().lists.get("/r/a"), ["x"]);
});

test("withList never mutates the value it was given", () => {
  const a = fromSnap({});
  const b = withList(a, "/r", [1], 7);
  assert.equal(a.lists.size, 0);
  assert.deepEqual(b.lists.get("/r"), [1]);
});

test("runs are upserted to the front by id and capped", () => {
  const r = (runId, repoDir = "/r") => ({ runId, repoDir });
  assert.deepEqual(upsertRun([r("1"), r("2")], r("2")).map((x) => x.runId), ["2", "1"]);
  assert.equal(upsertRun([r("1"), r("2"), r("3")], r("4"), 3).length, 3);
  assert.deepEqual(replaceRepoRuns([r("1", "/a"), r("2", "/b")], "/a", [r("9", "/a")]).map((x) => x.runId), ["9", "2"]);
});

test("output keeps the TAIL, and a full frame replaces", () => {
  assert.equal(appendOutput("abc", "def", false, 4), "cdef");
  assert.equal(appendOutput("abc", "xy", true), "xy");
});

test("a run that falls off the list takes its output with it, and a hidden sheet re-renders nothing", () => {
  const s = repoRunStore({ load: () => ({}), save: () => ({}) });
  s.onOutput("old", "hello", false, false);
  assert.equal(s.outTick.get(), 0);
  s.onOutput("old", " world", false, true);
  assert.equal(s.outTick.get(), 1);
  assert.equal(s.outputOf("old"), "hello world");
  // The read-only view a sheet is handed is the buffer itself: one object for
  // the store's life, so `outTick` is what says it moved.
  const view = s.output;
  assert.equal(view.get("old"), "hello world");
  s.onRun({ runId: "old", repoDir: "/r" });
  for (let i = 0; i < 60; i++) s.onRun({ runId: `n${i}`, repoDir: "/r" });
  assert.equal(s.outputOf("old"), "");
  assert.equal(s.output, view);
  assert.equal(view.has("old"), false);
  assert.equal(s.runs.get().length, 60);
});

test("map helpers copy, and a no-op delete keeps identity", () => {
  const m = new Map([["a", 1]]);
  assert.notEqual(mapWith(m, "b", 2), m);
  assert.equal(m.has("b"), false);
  assert.equal(mapWithout(m, "zz"), m);
  assert.equal(mapWithout(m, "a").has("a"), false);
});

test("core() refuses before App binds it, and returns the last binding after", () => {
  assert.throws(() => core(), /before App bound it/);
  const api = /** @type {any} */ ({ tag: 1 });
  bindCore(api);
  assert.equal(core(), api);
});

test("extStorage: an extension's keys are built, per plugin, host-scoped, and refuse a bad name", async () => {
  const { extStorage } = await import("./extStorage.ts");
  const { EXT_PREFIX, HOST_KEY_PREFIXES, isDeviceKey } = await import("../storage.ts");
  const mem = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); },
  };
  try {
    const s = extStorage("desktop");
    assert.deepEqual(s.read("quality", { a: 1 }), { a: 1 });
    s.write("quality", { a: 2 });
    assert.deepEqual(s.read("quality", null), { a: 2 });
    const [k] = [...mem.keys()];
    assert.equal(k, `${EXT_PREFIX}desktop.quality`);
    assert.ok(HOST_KEY_PREFIXES.includes(EXT_PREFIX));
    assert.equal(isDeviceKey(k), false);
    // Another plugin's same name is another key.
    assert.equal(extStorage("other").read("quality", "none"), "none");
    s.remove("quality");
    assert.equal(mem.size, 0);
    assert.throws(() => s.read("../x", 0));
    assert.throws(() => extStorage("Bad Id"));
  } finally {
    globalThis.localStorage = prev;
  }
});
