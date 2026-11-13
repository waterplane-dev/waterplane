/**
 * `download.ts` — the ONE download button, app-wide (skill `web-files`). The pure rules (what a button says,
 * who is eligible for the automatic hand-off) are `downloadState.test.mjs`'s; this pins what the module DOES
 * with them, against a fake queue:
 *
 *  - a tap makes a LOCAL record that promises the hand-off (`addLocal` with `autoSave`), never a host
 *    `pull.add`, and names the repo the target did not carry;
 *  - a tap on what is already here hands it over instead of fetching again; a second tap while the first
 *    hand-off is crossing the bridge writes nothing twice;
 *  - one tap, one file: `installDownloads` hands over a finished, promised download without a second tap,
 *    once, and marks the gallery only when the bytes are here.
 *
 *     node --test packages/web/src/download.test.mjs
 */
import "../../../scripts/lib-tsload.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

/** The stateful neighbours, faked: the queue, the toast, the gallery marks, the native bridge, storage. */
const fake = (globalThis.__downloadFakes = {
  records: {}, adds: [], saves: [], toasts: [], marks: new Map(), listeners: [], native: true, ls: {},
  saveResult: { ok: true, where: "Downloads" }, gate: null,
});
const MODULES = {
  "./pull": `const f = globalThis.__downloadFakes;
    export const pulls = {
      findFor: (repoId, relPath) => Object.values(f.records).find((r) => r.item.repoId === repoId && r.item.relPath === relPath),
      addLocal(t, opts) { f.adds.push({ t, opts }); const id = "id:" + t.relPath;
        f.records[id] ??= { state: "queued", received: 0, item: { id, ...t } }; f.records[id].autoSave ||= !!opts?.autoSave; return id; },
      get: (id) => f.records[id],
      list: () => Object.values(f.records),
      async save(id) { f.saves.push(id); await f.gate; return f.saveResult; },
      subscribe(cb) { f.listeners.push(cb); cb(Object.values(f.records)); return () => {}; },
    };`,
  "./toast": "export const showToast = (t) => globalThis.__downloadFakes.toasts.push(t);",
  "./artifactMarks": `const f = globalThis.__downloadFakes;
    export const artifactMark = (r, p, m) => f.marks.get(r + "|" + p + "|" + m);
    export const markArtifactDownloaded = (r, p, m) => f.marks.set(r + "|" + p + "|" + m, "downloaded");`,
  "./nativeSave": "export const nativeSaveSupported = () => globalThis.__downloadFakes.native;",
  "./storage": `const f = globalThis.__downloadFakes;
    export const LS = { pullAutoSave: "pullAutoSave" };
    export const lsGet = (k) => f.ls[k] ?? null; export const lsSet = (k, v) => { f.ls[k] = v; };`,
};
registerHooks({
  resolve(spec, ctx, next) {
    if (ctx.parentURL?.endsWith("/src/download.ts") && MODULES[spec]) {
      return { url: "data:text/javascript," + encodeURIComponent(MODULES[spec]), shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
globalThis.dispatchEvent ??= () => true;
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };

const dl = await import("./download.ts");

test.beforeEach(() => {
  Object.assign(fake, { records: {}, adds: [], saves: [], toasts: [], listeners: [], native: true, ls: {}, gate: null,
    saveResult: { ok: true, where: "Downloads" } });
  fake.marks.clear();
  dl.setRepoNamer(() => undefined);
});
const flush = () => new Promise((r) => setImmediate(r));
const target = { repoId: "r1", relPath: "build/app-debug.apk", mtime: 5, size: 10 };
const done = (extra = {}) => ({ state: "done", received: 10, item: { id: "id:build/app-debug.apk", ...target, name: "app-debug.apk" }, ...extra });

test("a tap queues a LOCAL record that promises the hand-off, named and with its repo filled in", () => {
  dl.setRepoNamer((id) => (id === "r1" ? { repoName: "tides", repoDir: "/dev/tides" } : undefined));
  const id = dl.startDownload(target);
  assert.equal(id, "id:build/app-debug.apk");
  assert.equal(fake.adds.length, 1);
  assert.deepEqual(fake.adds[0].opts, { autoSave: true }, "one tap, one file: the record carries the promise");
  assert.equal(fake.adds[0].t.name, "app-debug.apk", "named off the path when the caller gave none");
  assert.equal(fake.adds[0].t.repoName, "tides");
  assert.deepEqual(fake.toasts, ["downloading app-debug.apk — it saves itself when it lands"]);
});

test("a second tap on a half-fetched file resumes it, never a second record", () => {
  fake.records["id:build/app-debug.apk"] = { state: "paused", received: 4, item: { id: "id:build/app-debug.apk", ...target } };
  dl.startDownload(target);
  assert.equal(Object.keys(fake.records).length, 1);
  assert.deepEqual(fake.toasts, ["resuming app-debug.apk — see Downloads"]);
});

test("a tap on what is already here hands it over instead of fetching again", async () => {
  fake.records["id:build/app-debug.apk"] = done();
  dl.startDownload(target);
  await flush();
  assert.deepEqual(fake.saves, ["id:build/app-debug.apk"]);
  assert.deepEqual(fake.toasts, ["saved to Downloads"]);
});

test("a tap while the same hand-off is crossing the bridge writes nothing twice", async () => {
  fake.records["id:build/app-debug.apk"] = done();
  let open; fake.gate = new Promise((r) => { open = r; });
  const first = dl.saveNow("id:build/app-debug.apk");
  await flush();
  const second = dl.saveNow("id:build/app-debug.apk");
  await flush();
  assert.deepEqual(fake.saves, ["id:build/app-debug.apk"], "the bytes cross once");
  assert.deepEqual(fake.toasts, ["saving app-debug.apk…"]);
  open();
  await Promise.all([first, second]);
  assert.deepEqual(fake.toasts, ["saving app-debug.apk…", "saved to Downloads"]);
});

test("a failed hand-off says the file is still on the phone", async () => {
  fake.records["id:build/app-debug.apk"] = done();
  fake.saveResult = { ok: false, error: "no permission" };
  await dl.saveNow("id:build/app-debug.apk");
  assert.match(fake.toasts[0], /could not save app-debug\.apk — no permission\. It is still on this device/);
});

test("the button's tap follows the pure rule: start, hand over, or open Downloads", async () => {
  let opened = 0;
  const realDispatch = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (e) => { if (e.type === dl.OPEN_DOWNLOADS_EVENT) opened++; return true; };
  try {
    dl.downloadTap(target, undefined);
    assert.equal(fake.adds.length, 1, "nothing yet: start");
    dl.downloadTap(target, { state: "downloading", received: 3, item: { id: "x", ...target, size: 10 } });
    assert.equal(opened, 1, "moving: open Downloads, never a second start");
    assert.equal(fake.adds.length, 1);
    fake.records["id:build/app-debug.apk"] = done();
    dl.downloadTap(target, fake.records["id:build/app-debug.apk"]);
    await flush();
    assert.deepEqual(fake.saves, ["id:build/app-debug.apk"], "here and not handed over: hand it over");
  } finally { globalThis.dispatchEvent = realDispatch; }
});

test("one tap, one file: a finished, promised download is handed over by itself, once, and marked", async () => {
  dl.installDownloads();
  const emit = () => fake.listeners.at(-1)(Object.values(fake.records));
  fake.records.a = { ...done({ autoSave: true }), item: { ...done().item, id: "a" } };
  fake.records.b = { ...done({ autoSave: true, savedAt: 1 }), item: { ...done().item, id: "b", relPath: "b.apk" } };
  fake.records.c = { state: "downloading", received: 1, autoSave: true, item: { ...done().item, id: "c", relPath: "c.apk" } };
  let open; fake.gate = new Promise((r) => { open = r; });
  emit();
  emit(); // a repaint while the first save is still crossing
  await flush();
  assert.deepEqual(fake.saves, ["a"], "only the finished, unsaved, promised one; and only once");
  assert.equal(fake.marks.get("r1|build/app-debug.apk|5"), "downloaded", "marked when the bytes are here");
  assert.equal(fake.marks.get("r1|c.apk|5"), undefined, "never marked before they are");
  open();
  await flush();
  assert.deepEqual(fake.toasts, ["saved to Downloads"], "the automatic hand-off still says where the file went");
});

test("with the per-phone switch off, a finished download nobody tapped stays in the app", async () => {
  fake.ls.pullAutoSave = "0";
  dl.installDownloads();
  fake.records.a = { ...done(), item: { ...done().item, id: "a" } }; // host auto-pull: no promise
  fake.listeners.at(-1)(Object.values(fake.records));
  await flush();
  assert.deepEqual(fake.saves, []);
  fake.ls.pullAutoSave = "1";
  fake.listeners.at(-1)(Object.values(fake.records));
  await flush();
  assert.deepEqual(fake.saves, ["a"], "switch on: every finished download goes to the folder");
  fake.native = false;
  assert.equal(dl.autoSaveOut(), false, "a browser has no folder to write to: never automatic");
  assert.equal(dl.autoSaveOutPref(), true, "but the switch still shows what it is set to");
});
