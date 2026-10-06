/**
 * A plugin's BACKEND (docs/analysis/backends-design.md §3, docs/notes/plugins.md
 * "Backends"): `api.backend` refuses in words and leaves with the plugin,
 * `/api/plugin/<id>/hook`'s hold answers `{}` at the cap and on switch-off, and
 * a live pane whose backend is not registered yet is PARKED, not dropped.
 * The end-to-end half is scripts/e2e-pluginbackend.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { pluginDescriptor } = await import("../dist/plugins/pluginapi.js");
const { knownBackend, resolveBackend } = await import("../dist/backends/index.js");
const { adoptOrPark, parkedLive, retryParked, settleParked, unadoptedReason } = await import("../dist/sessions/tmux.js");
const { manifestProblems, PLUGIN_API_VERSION, PLUGIN_HOOK_HOLD_MAX_MS } = await import("@waterplane/shared");

const fakeSessions = () => ({ list: () => [], get: () => null, setPluginBadge: () => {}, setSuggestion: () => {}, isWatched: () => false });

function setup(id, hostSrc, extra = {}) {
  const cfg = mkdtempSync(join(tmpdir(), "wp-pbcfg-"));
  const root = mkdtempSync(join(tmpdir(), "wp-pbroot-"));
  const dir = join(cfg, "plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "waterplane-plugin.json"), JSON.stringify({ id, name: `P ${id}`, version: "1", apiVersion: PLUGIN_API_VERSION, ...extra }));
  writeFileSync(join(dir, "host.mjs"), hostSrc);
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: fakeSessions(), hookPort: 9123,
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
  });
  return reg;
}

const def = (id, over = "") => `{ id: "${id}", label: "L", bin: () => "/bin/true", launchArgs: () => ({ args: [] }),
  caps: { hooks: "plugin-inject", promptBoxes: false, transcript: "none" ${over} }, models: async () => ({ aliases: [], ids: [] }) }`;

test("manifest: backends must be a list of short lowercase ids", () => {
  const base = { id: "pp", name: "P", version: "1", apiVersion: PLUGIN_API_VERSION };
  assert.deepEqual(manifestProblems({ ...base, backends: ["copilot", "a-1"] }), []);
  assert.match(manifestProblems({ ...base, backends: "copilot" }).join(";"), /backends must be a list/);
  assert.match(manifestProblems({ ...base, backends: ["Copilot CLI"] }).join(";"), /"Copilot CLI" is not a short lowercase word/);
});

test("api.backend: registered while on, refused in words when undeclared or naming an unknown reader, gone when switched off", async () => {
  const ok = setup("pbok", `export function activate(api) { api.backend(${def("pbok-cli")}); api.setStatus({ tone: "ok", text: api.hookSink() }); }`, { backends: ["pbok-cli"] });
  await ok.loadAll();
  const e = ok.byId("pbok");
  assert.equal(e.state, "active", e.error);
  assert.equal(knownBackend("pbok-cli"), true);
  assert.equal(e.status.text, "http://127.0.0.1:9123/api/plugin/pbok/hook", "hookSink is the loopback route on the daemon's port");
  assert.equal(resolveBackend("pbok-cli").healthScope, false, "a plugin backend is never on the claude health board");
  assert.equal(await ok.setEnabled("pbok", false), null);
  assert.equal(knownBackend("pbok-cli"), false, "switching the plugin off removes its backend");
  assert.throws(() => resolveBackend("pbok-cli"), /no backend called "pbok-cli"/);
  await ok.setEnabled("pbok", true);
  assert.equal(knownBackend("pbok-cli"), true, "…and back on registers it again");
  await ok.setEnabled("pbok", false);

  const undeclared = setup("pbund", `export function activate(api) { api.backend(${def("pbund-cli")}); }`);
  await undeclared.loadAll();
  assert.equal(undeclared.byId("pbund").state, "error");
  assert.match(undeclared.byId("pbund").error, /lists no "backends" in its manifest, so it may not register "pbund-cli"/);
  assert.equal(knownBackend("pbund-cli"), false);

  const reader = setup("pbrd", `export function activate(api) { api.backend(${def("pbrd-cli", ', promptBoxes: "copilot-numbered"')}); }`, { backends: ["pbrd-cli"] });
  await reader.loadAll();
  assert.match(reader.byId("pbrd").error, /no screen reader called `copilot-numbered`; this host has: claude-numbered\b/);
  assert.equal(knownBackend("pbrd-cli"), false, "nothing is half-added");

  const taken = setup("pbtk", `export function activate(api) { api.backend(${def("claude")}); }`, { backends: ["claude"] });
  await taken.loadAll();
  assert.match(taken.byId("pbtk").error, /a backend called "claude" is already registered/);
  assert.equal(resolveBackend("claude").healthScope, true, "core's claude is untouched");
});

test("pluginDescriptor: missing pieces are named; a bad launch plan is refused; a bad catalogue is empty", async () => {
  assert.throws(() => pluginDescriptor({ id: "x" }, "P"), /P's backend "x" is missing label, bin\(\), launchArgs\(\), models\(\), caps/);
  const d = pluginDescriptor({
    id: "pd", label: " PD ", bin: () => "/bin/x", launchArgs: () => ({ args: [1] }),
    caps: { hooks: "none", promptBoxes: false, transcript: "none" }, models: async () => ({ ids: "nope" }),
  }, "P");
  assert.equal(d.label, "PD");
  assert.equal(d.delivery.submitKey, "\r");
  assert.equal(d.delivery.composerCursorRe, null, "no anchor ⇒ deliver.ts's own fallback");
  assert.equal(d.caps.contextMeter, false);
  assert.throws(() => d.launchArgs({ launch: {}, hookPort: 1 }), /did not answer a launch as a list of arguments/);
  assert.deepEqual(await d.models(), { aliases: [], ids: [] });
});

test("pluginDescriptor: delivery, caps and sources are READ THROUGH a def's getters, never copied; exec and the launch request pass", () => {
  let hybrid = true;
  const src = { attach: () => ({ close() {} }) };
  const seen = [];
  const DL = [{ requiresChannel: true }, {}];
  const CP = [{ hooks: "none", promptBoxes: false, transcript: "none", forkVia: "server" }, { hooks: "none", promptBoxes: false, transcript: "none" }];
  const d = pluginDescriptor({
    id: "pg", label: "PG", bin: () => "/bin/x", models: async () => ({ aliases: [], ids: [] }),
    launchArgs: (req) => { seen.push(req); return { args: ["-c", "x"], exec: "/bin/sh", backendSessionId: "ses_1" }; },
    get delivery() { return DL[hybrid ? 0 : 1]; },
    get caps() { return CP[hybrid ? 0 : 1]; },
    get sources() { return hybrid ? src : undefined; },
  }, "P", { experimental: true });
  assert.equal(d.delivery.requiresChannel, true);
  assert.equal(d.caps.forkVia, "server");
  assert.equal(d.sources, src);
  assert.equal(d.delivery, d.delivery, "an unchanged answer is the same normalised object");
  hybrid = false;
  assert.equal(d.delivery.requiresChannel, undefined, "the knob flipped ⇒ the descriptor follows");
  assert.equal(d.caps.forkVia, undefined);
  assert.equal(d.sources, undefined);
  assert.equal(d.experimental, true);
  const plan = d.launchArgs({ launch: {}, hookPort: 1, cwd: "/tmp", hostSessionId: "h1", forkAtTurn: "t3" });
  assert.equal(plan.exec, "/bin/sh");
  assert.equal(plan.backendSessionId, "ses_1");
  assert.deepEqual([seen[0].cwd, seen[0].hostSessionId, seen[0].forkAtTurn], ["/tmp", "h1", "t3"]);
});

test("hook: 404s in words, answers sync, HOLDS a promise, expires to {} and calls onExpired, a throw is {}", async () => {
  const reg = setup("pbhk", `
    let expired = 0;
    export function activate(api) {
      api.handle("expired", () => expired);
      api.onHook((p, hold) => {
        if (p.kind === "sync") return { echo: p.n };
        if (p.kind === "throw") throw new Error("bad hook");
        if (p.kind === "late") { hold.onExpired(() => { expired++; }); return new Promise(() => {}); }
        return new Promise((r) => setTimeout(() => r({ held: hold.maxHoldMs }), 30));
      }, { maxHoldMs: 150 });
    }`);
  assert.deepEqual(await reg.hook("pbhk", {}), { status: 404, body: { ok: false, error: 'no plugin "pbhk" is installed' } });
  await reg.loadAll();
  assert.deepEqual(await reg.hook("pbhk", { kind: "sync", n: 3 }), { status: 200, body: { echo: 3 } });
  assert.deepEqual(await reg.hook("pbhk", { kind: "held" }), { status: 200, body: { held: 150 } });
  const t0 = Date.now();
  assert.deepEqual(await reg.hook("pbhk", { kind: "late" }), { status: 200, body: {} });
  assert.ok(Date.now() - t0 >= 140, "held until the cap");
  assert.deepEqual(await reg.call("pbhk", "expired", null), { ok: true, result: 1 }, "onExpired ran once");
  assert.deepEqual(await reg.hook("pbhk", { kind: "throw" }), { status: 200, body: {} });
  assert.match(reg.byId("pbhk").status.text, /hook handler failed: bad hook/);

  const pending = reg.hook("pbhk", { kind: "late" });
  await reg.setEnabled("pbhk", false);
  assert.deepEqual(await pending, { status: 200, body: {} }, "switching off releases a held response");
  assert.deepEqual(await reg.hook("pbhk", {}), { status: 404, body: { ok: false, error: "P pbhk is turned off" } });

  const none = setup("pbnone", "export function activate() {}");
  await none.loadAll();
  assert.match((await none.hook("pbnone", {})).body.error, /takes no hooks/);
  assert.equal(PLUGIN_HOOK_HOLD_MAX_MS, 60_000);
});

test("parking: an unknown backend's live record is parked, closed with its plugin named once settled, adopted when it registers", async () => {
  const closed = [], dropped = [], attached = [];
  let published = 0;
  const core = {
    sessions: new Map(),
    reattach: (m) => { attached.push(m.id); core.sessions.set(m.id, {}); },
    hasLiveTmux: () => true,
    pushClosed: (r) => closed.push(r),
    dropClosed: (id) => dropped.push(id),
    publishClosed: () => { published++; },
  };
  const meta = (id, backend) => ({ id, cwd: "/w", title: id, launch: backend ? { backend } : {}, createdAt: 1 });
  assert.equal(adoptOrPark(core, meta("a", undefined)), "attached", "absent backend is claude");
  assert.equal(adoptOrPark(core, meta("b", "pkcli")), "parked");
  assert.deepEqual([...parkedLive(core).keys()], ["b"]);
  assert.deepEqual(closed, [], "nothing closed before the plugins settle");
  assert.equal(settleParked(core, (b) => (b === "pkcli" ? "the plugin Parky" : null)), 1);
  assert.equal(closed[0].id, "b");
  assert.equal(closed[0].alive, true);
  assert.equal(closed[0].unadopted, unadoptedReason("pkcli", "the plugin Parky"));
  assert.match(closed[0].unadopted, /which the plugin Parky provides; switch that plugin on/);
  assert.equal(adoptOrPark(core, meta("c", "ghost")), "parked");
  assert.match(closed[1].unadopted, /"ghost", which no installed plugin provides/, "found after settling ⇒ closed at once");

  const reg = setup("parky", `export function activate(api) { api.backend(${def("pkcli")}); }`, { backends: ["pkcli"] });
  await reg.loadAll();
  assert.deepEqual(retryParked(core), ["b"]);
  assert.deepEqual(attached, ["a", "b"]);
  assert.deepEqual(dropped, ["b"], "its closed row is taken away");
  assert.equal(published, 1);
  assert.deepEqual([...parkedLive(core).keys()], ["c"], "the other stays parked");
  await reg.setEnabled("parky", false);
});

test("parking: a re-attach that THROWS keeps the pane parked with a closed row saying so — never neither live nor listed", async () => {
  const closed = [], dropped = [];
  let fail = true, published = 0;
  const core = {
    sessions: new Map(),
    reattach: (m) => { if (fail) throw new Error("tmux said no"); core.sessions.set(m.id, {}); },
    hasLiveTmux: () => true,
    pushClosed: (r) => closed.push(r),
    dropClosed: (id) => dropped.push(id),
    publishClosed: () => { published++; },
  };
  const meta = { id: "t1", cwd: "/w", title: "t1", launch: { backend: "pkthrow" }, createdAt: 1 };
  assert.equal(adoptOrPark(core, meta), "parked");
  settleParked(core, () => "the plugin Thrower");
  assert.equal(closed.length, 1, "parked ⇒ a closed row naming the plugin");
  const reg = setup("thrower", `export function activate(api) { api.backend(${def("pkthrow")}); }`, { backends: ["pkthrow"] });
  await reg.loadAll();
  assert.deepEqual(retryParked(core), [], "nothing adopted");
  assert.deepEqual([...parkedLive(core).keys()], ["t1"], "…but still parked, so the next backends change tries again");
  assert.deepEqual(dropped, ["t1"], "the row that said to switch the plugin on is replaced…");
  assert.equal(closed.length, 2);
  assert.equal(closed[1].alive, true);
  assert.match(closed[1].unadopted, /taking it back failed: tmux said no/, "…by one saying what went wrong");
  assert.equal(published, 1);
  fail = false;
  assert.deepEqual(retryParked(core), ["t1"], "a later try adopts it");
  assert.deepEqual(dropped, ["t1", "t1"], "and takes its row away");
  assert.deepEqual([...parkedLive(core).keys()], []);
  await reg.setEnabled("thrower", false);
});
