/**
 * What a plugin (or an in-repo extension) may CONTRIBUTE through the host API
 * beyond events: setup rows and fixes, method handlers reached through the
 * registry's `call()`, a repo scope behind the containment guards, and a
 * prompt handed to a repo's agent through the backlog — never a side door.
 *
 * Every refusal is a sentence; nothing here throws at the caller.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { contributedChecks, contributedFixes } = await import("../dist/plugins/setupcontrib.js");
const { inspectRepo } = await import("../dist/compliance.js");
const { BRAND, PLUGIN_API_VERSION } = await import("@waterplane/shared");
const { knownBackend, resolveBackend } = await import("../dist/backends/index.js");

function plugin(parent, id, host) {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "usmc-plugin.json"), JSON.stringify({ id, name: id.toUpperCase(), version: "1", apiVersion: PLUGIN_API_VERSION }));
  writeFileSync(join(dir, "host.mjs"), host);
  return dir;
}

function boot({ repos = {}, handed = [] } = {}) {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-seamcfg-"));
  const root = mkdtempSync(join(tmpdir(), "waterplane-seamroot-"));
  after(() => { for (const d of [cfg, root]) rmSync(d, { recursive: true, force: true }); });
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: { list: () => [], get: () => null, setPluginBadge: () => {} },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
    findRepo: async (id) => repos[id] ?? null,
    handToAgent: async (p) => { handed.push(p); return { ok: true, intentId: p.id ?? `i${handed.length}` }; },
  });
  after(() => reg.shutdownAll()); // a builtin may hold a socket open, which keeps this process alive
  return { reg, pd: join(cfg, "plugins") };
}

const target = (id, wt) => ({ id, repoName: id, branch: "main", isPrimary: true, worktreePath: wt, outboxCount: 0, changedCount: 0 });

test("setup rows and fixes: contributed, run in order, gone when the plugin is off", async () => {
  const { reg, pd } = boot();
  plugin(pd, "rowmaker", `
    export function activate(api) {
      api.setupCheck(({ worktree }) => ({ id: "rowmaker", label: "Row maker", status: "warn", detail: "about " + worktree.length, fix: "rowmaker-fix" }));
      api.setupCheck(() => null);
      api.setupCheck(() => { throw new Error("kaput"); });
      api.setupFix("rowmaker-fix", ({ worktree }) => ({ applied: true, note: "fixed " + worktree.length }));
    }`);
  plugin(pd, "thief", `export function activate(api) { api.setupFix("gitignore", () => ({ applied: true, note: "" })); }`);
  plugin(pd, "twin", `export function activate(api) { api.setupFix("rowmaker-fix", () => ({ applied: true, note: "" })); }`);
  await reg.loadAll();
  const byId = (id) => reg.entries.find((e) => e.manifest.id === id);
  assert.equal(byId("thief").state, "error");
  assert.match(byId("thief").error, /fix "gitignore" belongs to waterplane's own checklist/);
  assert.equal(byId("twin").state, "error");
  assert.match(byId("twin").error, /already handled by ROWMAKER/);

  const wt = mkdtempSync(join(tmpdir(), "waterplane-seamwt-"));
  const rows = contributedChecks(wt);
  assert.deepEqual(rows.map((r) => r.id), ["rowmaker", "rowmaker-check"], "a null row is no row, a throwing one becomes a warn row");
  assert.deepEqual(rows[1], { id: "rowmaker-check", label: "ROWMAKER", status: "warn", detail: "setup check failed: kaput", fix: null });
  assert.match(byId("rowmaker").status.text, /setup check handler failed: kaput/, "the throw is the plugin's status line");
  assert.ok(inspectRepo(wt).some((c) => c.id === "rowmaker"), "the checklist carries the contributed row");
  assert.deepEqual(contributedFixes(["gitignore", "rowmaker-fix"], wt), [{ id: "rowmaker-fix", outcome: { applied: true, note: `fixed ${wt.length}` } }]);
  assert.deepEqual(contributedFixes(["gitignore"], wt), [], "a fix nobody asked for does not run");

  assert.equal(await reg.setEnabled("rowmaker", false), null);
  assert.deepEqual(contributedChecks(wt), [], "switched off takes the rows with it");
  assert.deepEqual(contributedFixes(["rowmaker-fix"], wt), []);
});

test("call(): routes to a handled method; every failure is a sentence", async () => {
  const { reg, pd } = boot();
  plugin(pd, "caller", `
    export function activate(api) {
      api.handle("echo", async (args) => ({ got: args }));
      api.handle("boom", () => { throw new Error("nope"); });
      api.handle("big", () => "x".repeat(600 * 1024));
      const off = api.handle("gone", () => 1); off();
    }`);
  await reg.loadAll();
  assert.deepEqual(await reg.call("caller", "echo", { repo: "r" }), { ok: true, result: { got: { repo: "r" } } });
  assert.deepEqual(await reg.call("nobody", "echo", {}), { ok: false, error: 'no plugin "nobody" is installed' });
  assert.deepEqual(await reg.call("caller", "gone", {}), { ok: false, error: 'CALLER has no method "gone"' });
  const boom = await reg.call("caller", "boom", {});
  assert.equal(boom.ok, false);
  assert.match(boom.error, /CALLER "boom" failed: nope/);
  assert.match((await reg.call("caller", "big", {})).error, /over the 512 KB a call may carry/);
  await reg.setEnabled("caller", false);
  assert.deepEqual(await reg.call("caller", "echo", {}), { ok: false, error: "CALLER is turned off" });
});

test("repo(): reads through the containment guards — no secret, no escape, no symlink out", async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "waterplane-seamrepo-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "waterplane-seamout-")));
  writeFileSync(join(outside, "loot.txt"), "loot");
  writeFileSync(join(wt, "README.md"), "hello");
  writeFileSync(join(wt, ".env"), "SECRET=1");
  writeFileSync(join(wt, ".env.example"), "SECRET=");
  writeFileSync(join(wt, "bin.dat"), Buffer.from([1, 0, 2]));
  mkdirSync(join(wt, "docs"));
  symlinkSync(join(outside, "loot.txt"), join(wt, "link.txt"));
  const { reg, pd } = boot({ repos: { r1: target("r1", wt) } });
  plugin(pd, "reader", `export function activate(api) { globalThis.__readerApi = api; }`);
  await reg.loadAll();
  const api = globalThis.__readerApi;
  assert.equal(await api.repo("nope"), null);
  const r = await api.repo("r1");
  assert.equal(r.worktree, wt);
  assert.equal(r.readFile("README.md"), "hello");
  assert.equal(r.readFile("README.md", 2), "he");
  assert.equal(r.readFile(".env"), null, "a secret is never read");
  assert.equal(r.readFile(".env.example"), "SECRET=");
  for (const sneaky of [".env/", "./.env/.", ".ENV", "docs/../.ENV", "docs/../.env"]) assert.equal(r.readFile(sneaky), null, `${sneaky} is the .env`);
  assert.equal(r.readFile("../" + outside.split("/").pop() + "/loot.txt"), null, "no traversal");
  assert.equal(r.readFile(join(outside, "loot.txt")), null, "no absolute path out");
  assert.equal(r.readFile("link.txt"), null, "no symlink out of the worktree");
  assert.equal(r.readFile("bin.dat"), null, "binary is not text");
  const names = r.listDir().map((d) => d.name);
  assert.ok(names.includes("docs") && names.includes("README.md"));
  assert.ok(!names.includes(".env"), "a secret is not even listed");
  assert.equal(r.listDir("../"), null);
  assert.equal(r.git(), null, "not a git repo ⇒ null, never made-up facts");
});

test("handToAgent(): through the backlog add, waiting for a tap unless asked to fire", async () => {
  const handed = [];
  const wt = mkdtempSync(join(tmpdir(), "waterplane-seamhand-"));
  const { reg, pd } = boot({ repos: { r1: target("r1", wt) }, handed });
  plugin(pd, "hander", `export function activate(api) { globalThis.__handApi = api; }`);
  await reg.loadAll();
  const api = globalThis.__handApi;
  assert.deepEqual(await api.handToAgent("r1", "update the list"), { ok: true, intentId: "i1" });
  assert.deepEqual(handed[0], { repoDir: wt, text: "update the list", origin: "plugin:hander", fire: false });
  assert.deepEqual(await api.handToAgent("r1", "again", { key: "k1", label: " Update ", fire: true }), { ok: true, intentId: "plugin-hander-k1" });
  assert.deepEqual(handed[1], { repoDir: wt, text: "again", label: "Update", id: "plugin-hander-k1", origin: "plugin:hander", fire: true });
  assert.match((await api.handToAgent("r1", "x", { key: "a b" })).reason, /not usable/);
  assert.match((await api.handToAgent("r1", "x", { key: "k".repeat(60) })).reason, /not usable/);
  assert.match((await api.handToAgent("r1", "  ")).reason, /prompt is empty/);
  assert.match((await api.handToAgent("zz", "x")).reason, /no repo "zz"/);
  assert.equal(handed.length, 2, "a refusal hands nothing over");
  await reg.setEnabled("hander", false);
  assert.match((await api.handToAgent("r1", "x")).reason, /not running/);
  assert.equal(handed.length, 2);
});

test("builtins: loaded first, always on unless optional, not listed unless optional, and their id cannot be taken", async () => {
  const { reg, pd } = boot();
  plugin(pd, "requirements", `export function activate() {}`);
  await reg.loadBuiltins();
  await reg.loadAll();
  const [builtin, impostor] = reg.entries.filter((e) => e.manifest.id === "requirements");
  assert.equal(builtin.state, "active");
  assert.equal(builtin.builtin, true);
  assert.equal(impostor.state, "error");
  assert.match(impostor.error, /duplicate id "requirements"/);
  assert.match(await reg.setEnabled("requirements", false), /part of waterplane and is always on/);
  assert.ok(!reg.views().some((v) => v.source.startsWith("built in") && v.manifest.id === "requirements"),
    "an always-on builtin is not in the phone's plugin list (an OPTIONAL one is — that extension's own test pins that half)");
});

test("builtins: a release decides which ship — one it does not name is not loaded and not listed broken", async () => {
  const only = boot().reg;
  await only.loadBuiltins(undefined, { requirements: { on: true } });
  assert.deepEqual(only.entries.filter((e) => e.builtin).map((e) => e.manifest.id), ["requirements"],
    "not in the release ⇒ not shipped, whatever packages/extensions/ holds");
  assert.equal(only.byId("requirements").state, "active");
});

test("callOnce(): a repeated ackId runs the handler once; the ledger refuses a different call under it", async () => {
  const { reg, pd } = boot();
  plugin(pd, "counter", `
    let n = 0;
    export function activate(api) {
      api.handle("slow", async () => { await new Promise((r) => setTimeout(r, 60)); return ++n; });
      api.handle("other", () => "other");
      api.handle("fn", () => () => 1);
    }`);
  await reg.loadAll();
  const a = reg.callOnce("ack1", "counter", "slow", null);
  const b = reg.callOnce("ack1", "counter", "slow", null); // mid-flight: joins
  assert.deepEqual(await a, { ok: true, result: 1 });
  assert.deepEqual(await b, { ok: true, result: 1 });
  assert.deepEqual(await reg.callOnce("ack1", "counter", "slow", null), { ok: true, result: 1 }, "after it finished: the stored answer");
  assert.deepEqual(await reg.callOnce("ack2", "counter", "slow", null), { ok: true, result: 2 });
  const clash = await reg.callOnce("ack1", "counter", "other", null);
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already named a different call/);
  const big = await reg.callOnce("ack3", "counter", "other", "x".repeat(70 * 1024));
  assert.equal(big.ok, false); assert.match(big.error, /over the 64 KB/);
  const cyc = {}; cyc.me = cyc;
  const nj = await reg.callOnce("ack4", "counter", "other", cyc);
  assert.equal(nj.ok, false); assert.match(nj.error, /not JSON/);
});

test("api.push(): through deps.push with the plugin's id; every refusal is a sentence", async () => {
  const pushed = [];
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-pushcfg-"));
  const roots = [cfg];
  after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
  const mk = (withPush) => new PluginRegistry({
    root: (roots[roots.push(mkdtempSync(join(tmpdir(), "waterplane-pushroot-"))) - 1]), configDir: cfg, sessions: { list: () => [], get: () => null, setPluginBadge: () => {} },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
    ...(withPush ? { push: (p, e, d) => pushed.push([p, e, d]) } : {}),
  });
  const reg = mk(true);
  plugin(join(cfg, "plugins"), "pusher", `export function activate(api) { globalThis.__pushApi = api; }`);
  await reg.loadAll();
  const api = globalThis.__pushApi;
  assert.equal(api.push("changed", { n: 1 }), null);
  assert.equal(api.push("bare"), null);
  assert.deepEqual(pushed, [["pusher", "changed", { n: 1 }], ["pusher", "bare", null]]);
  assert.match(api.push("Bad Name", 1), /not a usable name/);
  assert.match(api.push("big", "x".repeat(70 * 1024)), /over the 64 KB/);
  assert.match(api.push("fn", () => 1), /not JSON|over/);
  assert.equal(pushed.length, 2, "a refusal pushes nothing");
  await reg.setEnabled("pusher", false);
  assert.match(api.push("changed", 1), /is not running/);
  const reg2 = mk(false);
  plugin(join(cfg, "plugins"), "pusher2", `export function activate(api) { globalThis.__pushApi2 = api; }`);
  await reg2.loadAll();
  assert.match(globalThis.__pushApi2.push("ok", 1), /cannot push/);
});

test("createCallLedger: expiry and eviction, off an injected clock", async () => {
  const { createCallLedger } = await import("../dist/plugins/pluginrpc.js");
  let t = 0, runs = 0;
  const L = createCallLedger({ ttlMs: 100, max: 2, now: () => t });
  const fn = async () => ({ ok: true, result: ++runs });
  assert.equal((await L.run("a", "k", fn)).result, 1);
  assert.equal((await L.run("a", "k", fn)).result, 1);
  t = 101;
  assert.equal((await L.run("a", "k", fn)).result, 2, "expired ⇒ runs again");
  await L.run("b", "k", fn); await L.run("c", "k", fn); // max 2 ⇒ "a" evicted
  assert.equal((await L.run("a", "k", fn)).result, 5, "evicted oldest runs again");
});
