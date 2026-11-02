// The android-apps host half over a real temp state dir and a fake HostPluginApi: the store reads
// today's installs.json read-only (same rows as core's store), writes only behind WRITE, answers the
// three methods, pushes only a {n,at} ping, and flushes synchronously.
//
//     node --test packages/extensions/android-apps/test/host.test.mjs   (after the host build)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, statSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const D = "../../../host/dist/extensions/android-apps";
const X = await import(`${D}/host/index.mjs`);
const W = await import(`${D}/shared/wire.mjs`);
const { hostStateDir } = await import("../../../host/dist/branddirs.js");

const T0 = 1_700_000_000_000;
const K1 = '["aa11bb22","l_1",1700000000000]', K2 = '["cc33dd44","l_9",1700000100000]', K3 = '["aa11bb22","l_2",0]';
// installs.json's shape as core's store wrote it before P5 deleted that store: the file a phone's history is in.
const FIXTURE = {
  entries: [
    { key: K1, deviceId: "aa11bb22", pullId: "l_1", pkg: "de.hoh.tiptoi", outcome: "installed", reportedAt: T0 + 5_000,
      deviceName: "kitchen phone", deviceModel: "Pixel 8", label: "Tiptoi", version: "0.1.98", code: 98, file: "app-debug.apk", repo: "Tiptoi", auto: true, at: T0 },
    { key: K2, deviceId: "cc33dd44", pullId: "l_9", pkg: "de.hoh.game", outcome: "failed", reportedAt: T0 + 200_000,
      label: "Game", error: "INSTALL_FAILED_VERSION_DOWNGRADE", at: T0 + 100_000 },
    { key: K3, deviceId: "aa11bb22", pullId: "l_2", pkg: "de.hoh.game", outcome: "installed", reportedAt: T0 + 9_000, deviceName: "kitchen phone" },
  ],
};

function stateWith(content) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-aa-"));
  const dir = hostStateDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "installs.json");
  if (content !== undefined) writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return { root, dir, path };
}
function fakeApi(over = {}) {
  const handlers = new Map(), pushes = [];
  return {
    handlers, pushes,
    handle: (m, fn) => { handlers.set(m, fn); return () => handlers.delete(m); },
    push: (e, d) => { pushes.push({ e, d }); return over.pushResult ?? null; },
    repoApps: async () => over.apps ?? [],
    call: (m, a) => handlers.get(m)(a, {}),
  };
}
const AT = Date.now() - 1000;
const row = (over = {}) => ({ pullId: "l_1", pkg: "de.hoh.tiptoi", outcome: "installed", auto: true, at: AT, ...over });
const PHONE = { id: "aa11bb22", name: "kitchen phone", model: "Pixel 8" };

test("the manifest declares the default rule and the API it needs", () => {
  const m = JSON.parse(readFileSync(new URL("../waterplane-plugin.json", import.meta.url), "utf8"));
  assert.equal(m.id, "android-apps");
  assert.equal(m.optional, true);
  assert.equal(m.autoOn, "androidRepo");
  assert.equal(m.apiVersion, "2.5");
  assert.deepEqual(JSON.parse(readFileSync(new URL("../ship.json", import.meta.url), "utf8")), { ship: true, on: true });
  const builtins = JSON.parse(readFileSync(new URL("../../../../deploy/ship.json", import.meta.url), "utf8")).builtins;
  assert.deepEqual(builtins["android-apps"], { ship: true, on: true });
});

test("WRITE is true: the extension is installs.json's one writer (core stopped in the same commit)", () => assert.equal(X.WRITE, true));

test("today's installs.json fixture reads back row for row (core's store wrote it; P5 deleted that store)", () => {
  const { path } = stateWith(FIXTURE);
  const ext = new X.InstallLogStore(path).fullDoc();
  assert.equal(ext.total, 3);
  assert.deepEqual(ext.devices.map((d) => d.id).sort(), ["aa11bb22", "cc33dd44"]);
  const by = Object.fromEntries(ext.entries.map((e) => [e.key, e]));
  assert.deepEqual(by[K1], FIXTURE.entries[0]);
  assert.deepEqual(by[K2], FIXTURE.entries[1]);
  assert.deepEqual(by[K3], FIXTURE.entries[2]);
});

test("oldest shapes and damage: a bare array reads, a row with no reportedAt is dropped, a corrupt or absent file is empty", () => {
  assert.equal(new X.InstallLogStore(stateWith(FIXTURE.entries).path).count(), 3);
  assert.equal(new X.InstallLogStore(stateWith({ entries: [{ ...FIXTURE.entries[0], reportedAt: undefined }, FIXTURE.entries[1]] }).path).count(), 1);
  assert.equal(new X.InstallLogStore(stateWith("{not json").path).count(), 0);
  assert.equal(new X.InstallLogStore(stateWith().path).count(), 0);
});

test("read-only: a report neither merges nor writes, and the file is untouched", () => {
  const { path, dir } = stateWith(FIXTURE);
  const before = readFileSync(path, "utf8");
  const store = new X.InstallLogStore(path, { write: false });
  assert.deepEqual(store.report(PHONE, [row({ pullId: "new" })]), { added: 0, updated: 0 });
  store.flush();
  assert.equal(store.count(), 3);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== "installs.json"), []);
});

test("read-only follows another writer's writes to the same file", () => {
  const { path } = stateWith(FIXTURE);
  const store = new X.InstallLogStore(path, { write: false });
  assert.equal(store.count(), 3);
  const other = new X.InstallLogStore(path, { write: true });
  other.report(PHONE, [row({ pullId: "from-other" })]);
  other.flush();
  assert.equal(store.count(), 4, "a row another store wrote is seen without a restart");
});

test("with writing on: idempotent merge, persisted in the {entries} shape, read back whole", () => {
  const { path } = stateWith(FIXTURE);
  const store = new X.InstallLogStore(path, { write: true });
  assert.deepEqual(store.report(PHONE, [row({ pullId: "n1" })]), { added: 1, updated: 0 });
  for (let i = 0; i < 3; i++) assert.deepEqual(store.report(PHONE, [row({ pullId: "n1" })]), { added: 0, updated: 0 });
  store.flush();
  const disk = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(disk), ["entries"]);
  assert.equal(disk.entries.length, 4);
  assert.equal(new X.InstallLogStore(path).fullDoc().total, 4);
  assert.deepEqual(new X.InstallLogStore(path).fullDoc().entries, store.fullDoc().entries);
});

test("with writing on, a corrupt file is moved aside, not overwritten", () => {
  const { path, dir } = stateWith("{not json");
  const store = new X.InstallLogStore(path, { write: true });
  store.report(PHONE, [row()]);
  store.flush();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).entries.length, 1);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("installs.json.corrupt-")));
});

test("methods: readiness over repoApps, log trimmed, report chunk answers {n, at} and pings small", async () => {
  const { path } = stateWith(FIXTURE);
  const apps = [{ repoId: "r", repoName: "Tiptoi", repoDir: "/x", module: "app/build.gradle", autoPull: { enabled: true, builds: true, maxBytes: 1 } }];
  const api = fakeApi({ apps });
  const store = new X.InstallLogStore(path, { write: true });
  X.serve(api, store, () => 42);
  assert.deepEqual([...api.handlers.keys()].sort(), ["log", "readiness", "report"]);
  assert.deepEqual(await api.call("readiness"), { at: 42, apps });
  assert.equal((await api.call("log")).total, 3);
  const r1 = await api.call("report", { device: PHONE, entries: [row({ pullId: "a" }), row({ pullId: "b" }), null, "x"] });
  assert.deepEqual(r1, { n: 5, at: 42, kept: true });
  assert.deepEqual(api.pushes, [{ e: "changed", d: { n: 5, at: 42 } }]);
  assert.ok(Buffer.byteLength(JSON.stringify(api.pushes[0].d)) < 64);
  await api.call("report", { device: PHONE, entries: [row({ pullId: "a" })] }); // a repeat
  assert.equal(api.pushes.length, 1, "a re-statement pings nobody");
  assert.deepEqual(await api.call("report", undefined), { n: 5, at: 42, kept: true }, "garbage args are a no-op, not a throw");
});

test("a device whose id is not a string is dropped, as core drops it", async () => {
  const api = fakeApi();
  X.serve(api, new X.InstallLogStore(stateWith().path, { write: true }), () => 1);
  for (const id of [{}, 123, null]) {
    assert.deepEqual(await api.call("report", { device: { id }, entries: [row({ pullId: "q" })] }), { n: 0, at: 1, kept: true });
  }
  assert.deepEqual(api.pushes, []);
});

test("the change signature sees a same-size same-mtime rewrite (new inode)", () => {
  const { path } = stateWith(FIXTURE);
  const store = new X.InstallLogStore(path, { write: false });
  assert.equal(store.count(), 3);
  const text = readFileSync(path, "utf8");
  const st = statSync(path);
  const edited = text.replace("de.hoh.tiptoi", "de.hoh.tiptoj"); // same length
  writeFileSync(path + ".new", edited);
  renameSync(path + ".new", path);
  utimesSync(path, st.atime, st.mtime);
  assert.equal(statSync(path).size, st.size);
  assert.ok(store.fullDoc().entries.some((e) => e.pkg === "de.hoh.tiptoj"), "reloaded");
});

test("persist is core's writeJsonAtomic: hidden tmp, no leftovers on success or failure", () => {
  const { path, dir } = stateWith(FIXTURE);
  const store = new X.InstallLogStore(path, { write: true });
  store.report(PHONE, [row({ pullId: "w1" })]);
  store.flush();
  assert.deepEqual(readdirSync(dir).filter((f) => f !== "installs.json"), []);
  // failure: make the rename target a directory so renameSync throws; the tmp must be removed
  rmSync(path);
  mkdirSync(path);
  store.report(PHONE, [row({ pullId: "w2" })]);
  store.flush();
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "tmp deleted on failure");
});

test("read-only methods: a report answers the count, says kept:false, pings nobody", async () => {
  const api = fakeApi();
  X.serve(api, new X.InstallLogStore(stateWith(FIXTURE).path, { write: false }), () => 1);
  assert.deepEqual(await api.call("report", { device: PHONE, entries: [row({ pullId: "z" })] }), { n: 3, at: 1, kept: false });
  assert.deepEqual(api.pushes, []);
});

test("a refused push is logged, not thrown", async () => {
  const api = fakeApi({ pushResult: "over PLUGIN_PUSH_MAX" });
  X.serve(api, new X.InstallLogStore(stateWith().path, { write: true }), () => 1);
  const warns = [];
  const orig = console.warn; console.warn = (...a) => warns.push(a.join(" "));
  try { await api.call("report", { device: PHONE, entries: [row()] }); } finally { console.warn = orig; }
  assert.ok(warns.some((w) => /refused.*PLUGIN_PUSH_MAX/.test(w)));
});

test("activate opens <stateDir>/installs.json; deactivate unregisters and flushes synchronously; shutdown too", async () => {
  const { dir, path } = stateWith(FIXTURE);
  const api = { ...fakeApi(), stateDir: dir };
  await X.activate(api, { write: true });
  assert.equal(api.handlers.size, 3);
  assert.equal((await api.call("log")).total, 3);
  await api.call("report", { device: PHONE, entries: [row({ pullId: "late" })] });
  X.deactivate(); // not awaited by the host
  assert.equal(api.handlers.size, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).entries.length, 4, "the debounced write was flushed");
  await X.activate(api, { write: true });
  await api.call("report", { device: PHONE, entries: [row({ pullId: "later" })] });
  X.shutdown();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).entries.length, 5);
  X.deactivate();
});

test("a max-size 500 ring is answered by `log` under the reply cap", async () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, ...{
    pullId: `p${i}`, pkg: "k".repeat(120) + i, label: "L".repeat(120), version: "v".repeat(120), file: "f".repeat(120), repo: "r".repeat(120),
    outcome: "failed", error: "e".repeat(300), deviceId: "d".repeat(100) + (i % 3), deviceName: "n".repeat(120), deviceModel: "m".repeat(120),
    reportedAt: T0 + i, at: T0 + i } }));
  const api = fakeApi();
  X.serve(api, new X.InstallLogStore(stateWith({ entries }).path));
  const doc = await api.call("log");
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) <= W.LOG_REPLY_BYTES_MAX);
  assert.equal(doc.total, 500);
});
