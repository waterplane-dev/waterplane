// The conditional default (`autoOn`, docs/notes/android-apps-architecture.md §6, the P1 pins of §7):
// an optional builtin whose manifest names a host probe starts from the CACHED probe, is resolved
// after listen, and a person's choice always wins. Fixture builtin through `locateBuiltin`; no
// real extension uses `autoOn` yet.
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { autoProbePath, cachedProbe, writeProbeCache } = await import("../dist/plugins/pluginauto.js");
const { androidRepoVerdict, androidReposProbe } = await import("../dist/androidenv.js");
const { hostStateDir } = await import("../dist/branddirs.js");
const { PLUGIN_API_VERSION, PLUGIN_MANIFEST, manifestProblems } = await import("@waterplane/shared");

const ID = "autofix";

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A desktop: one root (its state dir holds plugins.json + auto-probe.json) and one fixture builtin. */
const HOST = `export function activate(api) { globalThis.__autoApi = api; globalThis.__autoActs = (globalThis.__autoActs ?? 0) + 1; }
export function deactivate() { globalThis.__autoDeacts = (globalThis.__autoDeacts ?? 0) + 1; }`;
function desktop(host = HOST) {
  const root = tmp("waterplane-autoroot-");
  const ext = tmp("waterplane-autoext-");
  writeFileSync(join(ext, PLUGIN_MANIFEST), JSON.stringify({ id: ID, name: "Auto fixture", version: "1", apiVersion: PLUGIN_API_VERSION, optional: true, autoOn: "androidRepo" }));
  writeFileSync(join(ext, "host.mjs"), host);
  const stateDir = hostStateDir(root);
  return { root, ext, stateDir, enabledPath: join(stateDir, "plugins.json") };
}

/** A registry over `d`. `probe` is the androidRepo probe; `asked` counts its calls. */
function registry(d, probe, extra = {}) {
  const counter = { asked: 0, lists: [] };
  const reg = new PluginRegistry({
    root: d.root, configDir: tmp("waterplane-autocfg-"), sessions: { list: () => [], get: () => null, setPluginBadge: () => {} },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }),
    changed: () => counter.lists.push(reg.views().find((v) => v.manifest.id === ID)),
    locateBuiltin: (id) => ({ dir: d.ext, hostFile: join(d.ext, "host.mjs") }),
    probes: probe === undefined ? undefined : { androidRepo: () => { counter.asked++; return probe(); } },
    ...extra,
  });
  after(() => reg.shutdownAll());
  return { reg, counter, view: () => reg.views().find((v) => v.manifest.id === ID), entry: () => reg.byId(ID) };
}

const store = (d, enabled) => { mkdirSync(d.stateDir, { recursive: true }); writeFileSync(d.enabledPath, JSON.stringify({ enabled })); };
const bytes = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("manifest: autoOn must be a string; an unknown probe name is ignored, not refused", () => {
  const base = { id: "xx", name: "X", version: "1", apiVersion: PLUGIN_API_VERSION };
  assert.deepEqual(manifestProblems({ ...base, autoOn: "androidRepo" }), []);
  assert.deepEqual(manifestProblems({ ...base, autoOn: "somethingNewer" }), [], "a newer manifest loads on an older daemon");
  assert.match(manifestProblems({ ...base, autoOn: 3 }).join(), /autoOn must be the name of a probe/);
});

test("the matrix: probe true/false/null × stored true/false/absent × release on/off/none — a choice always wins", async () => {
  for (const result of [true, false, null]) {
    for (const stored of [true, false, undefined]) {
      for (const rel of ["on", "off", "none"]) {
        const label = `probe ${result}, stored ${stored}, release ${rel}`;
        const d = desktop();
        if (stored !== undefined) store(d, { [ID]: stored });
        const before = bytes(d.enabledPath);
        const { reg, counter, view, entry } = registry(d, async () => result);
        await reg.loadBuiltins([ID], rel === "none" ? null : { [ID]: { on: rel === "on" } });
        assert.equal(counter.asked, 0, `${label}: boot never asks the probe`);
        await reg.resolveAuto();
        let want;
        if (stored !== undefined) want = stored;
        else if (rel === "off") want = false;
        else want = result === true;
        assert.equal(entry().enabled, want, `${label}: enabled`);
        assert.equal(entry().state, want ? "active" : "off", `${label}: state`);
        const probed = stored === undefined && rel !== "off";
        assert.equal(counter.asked, probed ? 1 : 0, `${label}: probe asked only with no choice and a release that leaves it on`);
        assert.equal(!!view().auto, probed, `${label}: PluginView.auto only while no choice exists`);
        if (probed) assert.equal(view().auto.state, want ? "on" : "off", label);
        assert.equal(bytes(d.enabledPath), before, `${label}: plugins.json bytes untouched by boot and resolveAuto`);
        assert.equal(cachedProbe(d.stateDir, "androidRepo"), probed ? result : null, `${label}: the cache holds definite answers only`);
      }
    }
  }
});

test("(a) a tap during the probe wins: setEnabled(false) while it walks ⇒ still off and inactive after it says true", async () => {
  const d = desktop();
  const gate = deferred();
  const { reg, entry, view } = registry(d, () => gate.promise);
  await reg.loadBuiltins([ID], { [ID]: { on: true } });
  const acts = globalThis.__autoActs ?? 0;
  const run = reg.resolveAuto();
  assert.equal(await reg.setEnabled(ID, false), null);
  assert.deepEqual(JSON.parse(readFileSync(d.enabledPath, "utf8")), { enabled: { [ID]: false } }, "only the person's switch wrote plugins.json");
  // Take the file away: now only the in-memory `chosen` stands between the probe and the choice
  // (the fresh `readEnabled()` re-check would find nothing).
  rmSync(d.enabledPath);
  gate.resolve(true);
  await run;
  assert.equal(entry().enabled, false);
  assert.equal(entry().state, "off");
  assert.equal(globalThis.__autoActs ?? 0, acts, "the probe's true never activated it");
  assert.equal(view().auto, undefined, "the choice removes the automatic line");
  assert.equal(existsSync(d.enabledPath), false, "the auto path never rewrites plugins.json");
});

test("(a') a choice written to plugins.json during the walk is re-read after the await and wins too", async () => {
  const d = desktop();
  const gate = deferred();
  const { reg, entry, view } = registry(d, () => gate.promise);
  await reg.loadBuiltins([ID], null);
  const run = reg.resolveAuto();
  store(d, { [ID]: false });
  const before = bytes(d.enabledPath);
  gate.resolve(true);
  await run;
  assert.equal(entry().state, "off");
  assert.equal(view().auto, undefined);
  assert.equal(bytes(d.enabledPath), before);
});

test("(b) restart with cached true: on and active at boot, the first list already says so — no off→on", async () => {
  const d = desktop();
  const first = registry(d, async () => true);
  await first.reg.loadBuiltins([ID], null);
  await first.reg.resolveAuto();
  assert.equal(first.entry().state, "active");
  first.reg.shutdownAll();

  const gate = deferred(); // the next boot's probe never answers during this test
  const second = registry(d, () => gate.promise);
  await second.reg.loadBuiltins([ID], null);
  assert.equal(second.view().enabled, true);
  assert.equal(second.view().state, "active");
  assert.deepEqual(second.view().auto, { state: "on", why: "on automatically — a repo on this desktop is an Android app" });
  second.reg.startAuto();
  await second.reg.loadAll(); // the boot broadcast
  assert.ok(second.counter.lists.length > 0);
  assert.ok(second.counter.lists.every((v) => v.enabled && v.state === "active"), "no list ever said off");
  gate.resolve(null);
});

test("(c) plugins.json bytes: boot and every resolveAuto leave them as they were (absent stays absent)", async () => {
  const d = desktop();
  store(d, { other: false });
  const before = bytes(d.enabledPath);
  let answer = true;
  const { reg } = registry(d, async () => answer);
  await reg.loadBuiltins([ID], null);
  await reg.resolveAuto();
  answer = false; await reg.resolveAuto();
  answer = null; await reg.resolveAuto();
  assert.equal(bytes(d.enabledPath), before);

  const fresh = desktop();
  const r2 = registry(fresh, async () => true);
  await r2.reg.loadBuiltins([ID], null);
  await r2.reg.resolveAuto();
  assert.equal(existsSync(fresh.enabledPath), false, "the auto path never creates plugins.json");
  assert.ok(existsSync(autoProbePath(fresh.stateDir)), "it writes its own cache instead");
});

test("(d) boot never awaits the probe: a probe that never answers does not hold loadBuiltins or startAuto", async () => {
  const d = desktop();
  const { reg, counter, view } = registry(d, () => new Promise(() => {}));
  await reg.loadBuiltins([ID], null);
  assert.equal(counter.asked, 0);
  reg.startAuto(); // synchronous: returns while the probe walks
  assert.equal(counter.asked, 1);
  assert.equal(view().state, "off");
  assert.deepEqual(view().auto, { state: "off", why: "off until this desktop's repos are checked for an Android app; checked every 15 minutes" });
});

test("(e) null keeps state and cache — after a cached true, and after a cached false", async () => {
  for (const cached of [true, false]) {
    const d = desktop();
    writeProbeCache(d.stateDir, "androidRepo", cached, 1234);
    const cacheBefore = bytes(autoProbePath(d.stateDir));
    const { reg, entry } = registry(d, async () => null);
    await reg.loadBuiltins([ID], null);
    assert.equal(entry().state, cached ? "active" : "off");
    await reg.resolveAuto();
    assert.equal(entry().state, cached ? "active" : "off", `cached ${cached}: unknown changes nothing`);
    assert.equal(bytes(autoProbePath(d.stateDir)), cacheBefore, `cached ${cached}: the cache is not rewritten`);
  }
});

test("(f) true→false during uptime never turns it off; the next boot starts off", async () => {
  const d = desktop();
  writeProbeCache(d.stateDir, "androidRepo", true);
  const { reg, entry, view } = registry(d, async () => false);
  await reg.loadBuiltins([ID], null);
  assert.equal(entry().state, "active");
  await reg.resolveAuto();
  assert.equal(entry().state, "active", "auto-on never turns itself off while the host runs");
  assert.equal(view().auto.state, "on");
  assert.match(view().auto.why, /until the next restart/);
  assert.equal(cachedProbe(d.stateDir, "androidRepo"), false);
  reg.shutdownAll();
  const next = registry(d, async () => null);
  await next.reg.loadBuiltins([ID], null);
  assert.equal(next.entry().state, "off");
  assert.equal(next.view().auto.why, "off automatically — no repo here is an Android app; checked every 15 minutes");
});

test("an entry with no autoOn is never probed — every existing extension boots as before", async () => {
  const d = desktop();
  writeFileSync(join(d.ext, PLUGIN_MANIFEST), JSON.stringify({ id: ID, name: "Plain", version: "1", apiVersion: PLUGIN_API_VERSION, optional: true }));
  const { reg, counter, entry, view } = registry(d, async () => false);
  await reg.loadBuiltins([ID], null);
  reg.startAuto();
  await reg.resolveAuto();
  assert.equal(counter.asked, 0);
  assert.equal(entry().state, "active", "dev checkout, optional ⇒ on, as today");
  assert.equal(view().auto, undefined);
});

test("api.repoApps(): core's readiness facts, read-only; rejects in words on a host without them", async () => {
  const facts = [{ repoId: "r1", repoName: "app", module: "app" }];
  const d = desktop();
  writeProbeCache(d.stateDir, "androidRepo", true);
  const { reg } = registry(d, async () => null, { repoApps: async () => facts });
  await reg.loadBuiltins([ID], null);
  assert.deepEqual(await globalThis.__autoApi.repoApps(), facts);

  const d2 = desktop();
  writeProbeCache(d2.stateDir, "androidRepo", true);
  const r2 = registry(d2, async () => null);
  await r2.reg.loadBuiltins([ID], null);
  await assert.rejects(globalThis.__autoApi.repoApps(), /cannot read its repos/);
});

test("the androidRepo probe: true on any hit, null when a repo ran out of budget, false only when all were walked whole", async () => {
  const app = tmp("waterplane-apprepo-");
  mkdirSync(join(app, "app", "src", "main"), { recursive: true });
  writeFileSync(join(app, "app", "src", "main", "AndroidManifest.xml"), "<manifest/>");
  const plain = tmp("waterplane-plainrepo-");
  writeFileSync(join(plain, "README.md"), "x");
  const wide = tmp("waterplane-widerepo-");
  for (let i = 0; i < 420; i++) mkdirSync(join(wide, `d${i}`));
  assert.equal(await androidRepoVerdict(app), true);
  assert.equal(await androidRepoVerdict(plain), false);
  assert.equal(await androidRepoVerdict(wide), null, "400 directories ran out: unknown, never no");
  assert.equal(await androidReposProbe(async () => [plain, wide, app]), true);
  assert.equal(await androidReposProbe(async () => [plain, wide]), null);
  assert.equal(await androidReposProbe(async () => [plain]), false);
  assert.equal(await androidReposProbe(async () => { throw new Error("no listing"); }), null);
});

/** A host module whose import waits on `globalThis.__importGate` and says it started. */
const GATED_HOST = `globalThis.__importStarted?.(); await globalThis.__importGate;
${HOST}`;

test("(M3) a tap during auto's activation window: OFF ends inactive, ON never activates twice", async () => {
  for (const tap of [false, true]) {
    const d = desktop(GATED_HOST);
    const imp = deferred();
    const started = deferred();
    globalThis.__importGate = imp.promise;
    globalThis.__importStarted = () => started.resolve();
    const { reg, entry } = registry(d, async () => true);
    await reg.loadBuiltins([ID], null);
    const acts = globalThis.__autoActs ?? 0;
    const deacts = globalThis.__autoDeacts ?? 0;
    const run = reg.resolveAuto();
    await started.promise; // runAuto is inside the cold importHost now
    assert.equal(entry().state, "off", "still off while the import runs");
    const tapped = reg.setEnabled(ID, tap);
    imp.resolve();
    await Promise.all([run, tapped]);
    assert.equal(entry().enabled, tap, `tap ${tap}: the person's choice`);
    assert.equal(entry().state, tap ? "active" : "off", `tap ${tap}: state follows the choice`);
    assert.equal((globalThis.__autoActs ?? 0) - acts, 1, `tap ${tap}: activate() ran once, never twice`);
    assert.equal((globalThis.__autoDeacts ?? 0) - deacts, tap ? 0 : 1, `tap ${tap}: an OFF deactivates what the import started`);
    assert.equal(entry().gen > 0, true);
    delete globalThis.__importStarted;
  }
});

test("(L1) shutdownAll during the probe: its later true activates nothing, and resolveAuto is a no-op after", async () => {
  const d = desktop();
  const gate = deferred();
  const { reg, counter, entry } = registry(d, () => gate.promise);
  await reg.loadBuiltins([ID], null);
  const acts = globalThis.__autoActs ?? 0;
  const run = reg.resolveAuto();
  reg.shutdownAll();
  gate.resolve(true);
  await run;
  assert.equal(entry().state, "off");
  assert.equal(entry().enabled, false);
  assert.equal(globalThis.__autoActs ?? 0, acts);
  await reg.resolveAuto();
  reg.startAuto();
  assert.equal(counter.asked, 1, "nothing asked after shutdown");
});

test("(L3) single flight: two concurrent resolveAuto calls ask the probe once", async () => {
  const d = desktop();
  const gate = deferred();
  const { reg, counter } = registry(d, () => gate.promise);
  await reg.loadBuiltins([ID], null);
  const a = reg.resolveAuto();
  const b = reg.resolveAuto();
  assert.equal(a, b, "the second call joins the run in flight");
  gate.resolve(null);
  await Promise.all([a, b]);
  assert.equal(counter.asked, 1);
});

test("(L3) startAuto twice arms ONE 15-minute timer; shutdownAll clears it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const d = desktop();
  const { reg, counter } = registry(d, async () => null);
  await reg.loadBuiltins([ID], null);
  reg.startAuto();
  reg.startAuto();
  await reg.resolveAuto();
  assert.equal(counter.asked, 1, "the first run, once");
  t.mock.timers.tick(15 * 60_000);
  await reg.resolveAuto();
  assert.equal(counter.asked, 2, "one interval ticked, not two");
  t.mock.timers.tick(15 * 60_000);
  await reg.resolveAuto();
  assert.equal(counter.asked, 3);
  reg.shutdownAll();
  t.mock.timers.tick(45 * 60_000);
  await reg.resolveAuto();
  assert.equal(counter.asked, 3, "no tick after shutdownAll");
});

test("(L4) a probe that cannot tell says so and names the switch — never 'until checked' for ever", async () => {
  const d = desktop();
  let answer = null;
  const { reg, view, counter } = registry(d, async () => answer);
  await reg.loadBuiltins([ID], null);
  assert.match(view().auto.why, /until this desktop's repos are checked/, "before any probe");
  await reg.resolveAuto();
  assert.equal(view().auto.state, "off");
  assert.equal(view().auto.why, "off — a repo here is too big to look through whole, so this desktop cannot tell; turn it on if a repo here builds an Android app");
  assert.ok(counter.lists.some((v) => /cannot tell/.test(v.auto?.why ?? "")), "the change was broadcast");
  answer = false;
  await reg.resolveAuto();
  assert.match(view().auto.why, /^off automatically — no repo here is an Android app/, "a definite answer replaces it");
});

test("(L5) an auto-on entry whose start failed carries no 'on automatically' line", async () => {
  const d = desktop(`export function activate() { throw new Error("boom"); }`);
  writeProbeCache(d.stateDir, "androidRepo", true);
  const { reg, view } = registry(d, async () => null);
  await reg.loadBuiltins([ID], null);
  assert.equal(view().state, "error");
  assert.equal(view().auto, undefined);
});

test("(L6) concurrent api.repoApps() calls share one walk; each caller gets its own copy", async () => {
  const gate = deferred();
  let walks = 0;
  const d = desktop();
  writeProbeCache(d.stateDir, "androidRepo", true);
  const { reg } = registry(d, async () => null, { repoApps: () => { walks++; return gate.promise; } });
  await reg.loadBuiltins([ID], null);
  const api = globalThis.__autoApi;
  const a = api.repoApps();
  const b = api.repoApps();
  gate.resolve([{ repoId: "r1", repoName: "app", module: "app" }]);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(walks, 1);
  assert.deepEqual(ra, rb);
  assert.notEqual(ra, rb, "a copy each");
  await api.repoApps();
  assert.equal(walks, 2, "a call after the walk settled walks again — nothing is cached");
});

test("(L7) api.repoApps() rejects in words once the plugin is switched off", async () => {
  const d = desktop();
  writeProbeCache(d.stateDir, "androidRepo", true);
  const { reg } = registry(d, async () => null, { repoApps: async () => [] });
  await reg.loadBuiltins([ID], null);
  const api = globalThis.__autoApi;
  assert.deepEqual(await api.repoApps(), []);
  assert.equal(await reg.setEnabled(ID, false), null);
  await assert.rejects(api.repoApps(), /Auto fixture is not running/);
});

test("(L7) an EXTERNAL plugin's autoOn is ignored by loadAll: booted per plugins.json, never probed", async () => {
  const d = desktop();
  const configDir = tmp("waterplane-autoextcfg-");
  const dir = join(configDir, "plugins", "outside");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PLUGIN_MANIFEST), JSON.stringify({ id: "outside", name: "Outside", version: "1", apiVersion: PLUGIN_API_VERSION, optional: true, autoOn: "androidRepo" }));
  writeFileSync(join(dir, "host.mjs"), "export function activate() {}");
  const { reg, counter } = registry(d, async () => false, { configDir });
  await reg.loadAll();
  reg.startAuto();
  await reg.resolveAuto();
  const v = reg.views().find((x) => x.manifest.id === "outside");
  assert.equal(counter.asked, 0, "no probe for an outside plugin");
  assert.equal(v.state, "active", "absent from plugins.json ⇒ on, as today");
  assert.equal(v.auto, undefined);
});
