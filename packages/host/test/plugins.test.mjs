/**
 * Plugins: where they come from, what a broken one looks like, and the
 * settings a person may set (docs/notes/plugins.md).
 *
 * The rule under test is "never skipped in silence, never taking the daemon
 * down": every way a plugin can be wrong — a missing directory, a manifest
 * that does not parse or validate, a host module that is absent, outside its
 * directory, has no activate(), or throws in it, a second copy of an id — must
 * come back LISTED with `state: "error"` and the reason in words.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const { discoverPluginDirs, importHost, readPluginDir } = await import("../dist/plugins/pluginloader.js");
const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { cleanPluginValue, pluginValues, PLUGIN_API_VERSION } = await import("@waterplane/shared");

const manifest = (over = {}) => ({
  id: "echo", name: "Echo", version: "1.0.0", apiVersion: PLUGIN_API_VERSION,
  settings: [
    { kind: "number", key: "cap", label: "Cap", default: 5, min: 0, max: 10 },
    { kind: "choice", key: "mode", label: "Mode", default: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { kind: "switch", key: "on", label: "On", default: false },
  ],
  actions: [{ id: "ping", label: "Ping", scope: "global" }],
  ...over,
});

function plugin(parent, name, m, host = 'export function activate(api) { api.on("action", () => ({ ok: true, message: "pong" })); }', legacy = false) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  if (m !== null) writeFileSync(join(dir, legacy ? "usmc-plugin.json" : "waterplane-plugin.json"), typeof m === "string" ? m : JSON.stringify(m));
  if (host !== null) writeFileSync(join(dir, "host.mjs"), host);
  return dir;
}

test("readPluginDir: a past brand's manifest name still loads and is flagged manifestLegacy", () => {
  const t = mkdtempSync(join(tmpdir(), "wp-plug-"));
  const old = readPluginDir(plugin(t, "old", manifest(), undefined, true), "x");
  assert.deepEqual(old.problems, []);
  assert.equal(old.manifestLegacy, true);
  assert.equal(readPluginDir(plugin(t, "new", manifest()), "x").manifestLegacy, undefined);
});

test("readPluginDir: every broken shape is a problem in words, never a throw", () => {
  const t = mkdtempSync(join(tmpdir(), "waterplane-plug-"));
  assert.match(readPluginDir(join(t, "nope"), "nope").problems[0], /does not exist/);
  assert.match(readPluginDir(plugin(t, "nomf", null), "x").problems[0], /no waterplane-plugin\.json/);
  assert.match(readPluginDir(plugin(t, "badjson", "{nope"), "x").problems[0], /not valid JSON/);
  const bad = readPluginDir(plugin(t, "badid", manifest({ id: "Bad Id" })), "x");
  assert.match(bad.problems.join(";"), /id must match/);
  assert.equal(bad.manifest.name, "Echo", "a broken manifest still lists by its name");
  assert.match(readPluginDir(plugin(t, "api", manifest({ apiVersion: 99 })), "x").problems[0], /apiVersion is 99/);
  assert.match(readPluginDir(plugin(t, "nohost", manifest(), null), "x").problems[0], /host module host\.mjs is missing/);
  assert.match(readPluginDir(plugin(t, "escape", manifest({ host: "../escape.mjs" })), "x").problems[0], /outside the plugin directory/);
  const ok = readPluginDir(plugin(t, "ok", manifest()), "x");
  assert.deepEqual(ok.problems, []);
  assert.ok(ok.hostFile.endsWith("host.mjs"));
});

// A release tarball carries an extension's manifest (`host: "host/index.mts"`) and only the
// COMPILED module; the `.mts` source is not shipped. It once logged "host module host/index.mts is
// missing" for every builtin and loaded none (scripts/release/build.mjs, plugins/builtin.ts).
test("readPluginDir: a manifest naming .mts loads its compiled sibling when the source is absent", async () => {
  const t = mkdtempSync(join(tmpdir(), "waterplane-plug-"));
  const src = 'export function activate(api) { api.on("action", () => ({ ok: true, message: "compiled" })); }';
  for (const ext of ["mjs", "js"]) {
    const dir = plugin(t, `only-${ext}`, manifest({ host: "host/index.mts" }), null);
    mkdirSync(join(dir, "host"));
    writeFileSync(join(dir, "host", `index.${ext}`), ext === "js" ? src.replace("export function activate", "export default { activate }; function activate") : src);
    if (ext === "js") writeFileSync(join(dir, "host", "package.json"), '{"type":"module"}');
    const d = readPluginDir(dir, "x");
    assert.deepEqual(d.problems, [], `.${ext} sibling`);
    assert.ok(d.hostFile.endsWith(join("host", `index.${ext}`)));
    assert.equal(typeof (await importHost(d.hostFile)).activate, "function");
  }
  // The source wins when both are there; neither ⇒ the same sentence as before.
  const both = plugin(t, "both", manifest({ host: "host/index.mts" }), null);
  mkdirSync(join(both, "host"));
  writeFileSync(join(both, "host", "index.mts"), src);
  writeFileSync(join(both, "host", "index.mjs"), src);
  assert.ok(readPluginDir(both, "x").hostFile.endsWith("index.mts"));
  const none = plugin(t, "none", manifest({ host: "host/index.mts" }), null);
  assert.match(readPluginDir(none, "x").problems[0], /host module host\/index\.mts is missing/);
  // Containment is unchanged: an escaping .mts is refused before any sibling is looked for.
  const esc = plugin(t, "esc", manifest({ host: "../esc.mts" }), null);
  writeFileSync(join(t, "esc.mjs"), src);
  assert.match(readPluginDir(esc, "x").problems[0], /outside the plugin directory/);
});

test("readPluginDir: a builtin's host module is where the build put it, not beside the manifest", async () => {
  // The release layout: manifest in packages/extensions/<id>/, code in packages/host/dist/extensions/<id>/host/.
  const t = mkdtempSync(join(tmpdir(), "waterplane-plug-"));
  const extDir = plugin(join(t, "packages", "extensions"), "echo", manifest({ host: "host/index.mts" }), null);
  const compiled = join(t, "packages", "host", "dist", "extensions", "echo", "host", "index.mjs");
  mkdirSync(join(compiled, ".."), { recursive: true });
  writeFileSync(compiled, 'export function activate() {}');
  const d = readPluginDir(extDir, "built in (echo)", { hostFile: compiled });
  assert.deepEqual(d.problems, []);
  assert.equal(d.hostFile, compiled);
  assert.equal(typeof (await importHost(d.hostFile)).activate, "function");
  const gone = readPluginDir(extDir, "built in (echo)", { hostFile: join(t, "nowhere", "index.mjs") });
  assert.equal(gone.hostFile, null);
  assert.match(gone.problems[0], /host module host\/index\.mts is missing \(looked for .*nowhere/);
});

test("discoverPluginDirs: the plugins dir and plugin-paths.json, ~ expanded, deduplicated", () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-plugcfg-"));
  const a = plugin(join(cfg, "plugins"), "a", manifest({ id: "aa" }));
  const elsewhere = mkdtempSync(join(tmpdir(), "waterplane-plugext-"));
  const b = plugin(elsewhere, "b", manifest({ id: "bb" }));
  const list = join(cfg, "plugin-paths.json");
  writeFileSync(list, JSON.stringify({ paths: [b, a, "~/definitely-not-a-usmc-plugin"] }));
  const { dirs, problems } = discoverPluginDirs(cfg);
  assert.deepEqual(problems, []);
  assert.deepEqual(dirs.map((d) => d.dir), [a, b, join(homedir(), "definitely-not-a-usmc-plugin")], "a is listed once");
  writeFileSync(list, "{nope");
  const bad = discoverPluginDirs(cfg).problems[0];
  assert.match(bad, /not valid JSON/);
  assert.ok(bad.startsWith(list), `the problem names the file it is about (got ${bad})`);
  writeFileSync(list, JSON.stringify({ path: [] }));
  assert.match(discoverPluginDirs(cfg).problems[0], /plugin-paths\.json: expected \{ "paths"/);
});

test("the old config-dir plugins.json is renamed to plugin-paths.json once, and read", () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-plugmig-"));
  const b = plugin(mkdtempSync(join(tmpdir(), "waterplane-plugext-")), "b", manifest({ id: "bb" }));
  const old = join(cfg, "plugins.json");
  const doc = JSON.stringify({ paths: [b] });
  writeFileSync(old, doc);
  const first = discoverPluginDirs(cfg);
  assert.deepEqual(first.dirs.map((d) => d.dir), [b], "the old file's paths still load");
  assert.deepEqual(first.problems, []);
  assert.match(first.notes.join(";"), /renamed .*plugins\.json to .*plugin-paths\.json/);
  assert.equal(existsSync(old), false);
  assert.equal(readFileSync(join(cfg, "plugin-paths.json"), "utf8"), doc, "moved byte for byte, never rewritten");
  const second = discoverPluginDirs(cfg);
  assert.deepEqual(second.notes, [], "once: nothing left to rename");
  assert.deepEqual(second.dirs.map((d) => d.dir), [b]);
});

test("an old plugins.json beside a new plugin-paths.json is kept and named as ignored", () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-plugmig-"));
  const old = join(cfg, "plugins.json");
  writeFileSync(old, JSON.stringify({ paths: ["/nowhere/old"] }));
  writeFileSync(join(cfg, "plugin-paths.json"), JSON.stringify({ paths: [] }));
  const r = discoverPluginDirs(cfg);
  assert.deepEqual(r.dirs, []);
  assert.match(r.problems.join(";"), /plugins\.json is ignored: the plugin paths are read from .*plugin-paths\.json/);
  assert.equal(existsSync(old), true, "never deleted");
});

test("a plugins.json that is the state dir's {enabled} file is left alone", () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-plugmig-"));
  const old = join(cfg, "plugins.json");
  writeFileSync(old, JSON.stringify({ enabled: { echo: false } }));
  const r = discoverPluginDirs(cfg);
  assert.deepEqual(r, { dirs: [], problems: [], notes: [] });
  assert.equal(existsSync(old), true);
  assert.equal(existsSync(join(cfg, "plugin-paths.json")), false);
});

test("cleanPluginValue refuses rather than repairs", () => {
  const [num, choice, sw] = manifest().settings;
  assert.equal(cleanPluginValue(num, 11), undefined);
  assert.equal(cleanPluginValue(num, -1), undefined);
  assert.equal(cleanPluginValue(num, "5"), undefined);
  assert.equal(cleanPluginValue(num, 7), 7);
  assert.equal(cleanPluginValue(choice, "c"), undefined);
  assert.equal(cleanPluginValue(choice, "b"), "b");
  assert.equal(cleanPluginValue(sw, 1), undefined);
  assert.deepEqual(pluginValues(manifest(), { cap: 99, mode: "b" }), { cap: 5, mode: "b", on: false }, "a stored bad value falls back to the default");
});

/** A SessionManager with just what the registry reaches for. */
function fakeSessions() {
  const infos = new Map();
  return {
    infos,
    list: () => [...infos.values()],
    get: (id) => infos.get(id) ?? null,
    isWatched: () => false,
    scrollback: () => "",
    setSuggestion: (id, s) => { const i = infos.get(id); if (i) i.suggestion = s; },
    setPluginBadge: () => {},
    setPluginToggle: (id) => infos.has(id),
    setPluginAnswer: (id, p, v) => { const i = infos.get(id); if (!i) return false; i.pluginAnswer = { ...(i.pluginAnswer ?? {}), [p]: v }; return true; },
    anyPluginAnswer: () => false,
    input: () => true,
    choosePromptBox: async () => ({ ok: true }),
  };
}

function registry(cfg, root) {
  let changes = 0;
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: fakeSessions(),
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }),
    changed: () => { changes++; },
  });
  return { reg, changes: () => changes };
}

test("registry: a good plugin is active, broken ones are listed with the reason", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-regcfg-"));
  const root = mkdtempSync(join(tmpdir(), "waterplane-regroot-"));
  const pd = join(cfg, "plugins");
  plugin(pd, "1-echo", manifest());
  plugin(pd, "2-dup", manifest({ name: "Echo copy" }));
  plugin(pd, "3-throws", manifest({ id: "throws", name: "Throws" }), 'export function activate() { throw new Error("boom at start"); }');
  plugin(pd, "4-noactivate", manifest({ id: "noact", name: "No activate" }), "export const x = 1;");
  plugin(pd, "5-badmf", manifest({ id: "badmf", settings: [{ kind: "number", key: "n", label: "N", default: 50, min: 0, max: 10 }] }));
  const { reg, changes } = registry(cfg, root);
  await reg.loadAll();
  const by = Object.fromEntries(reg.views().map((v) => [v.source.split("/").pop(), v]));
  assert.equal(by["1-echo"].state, "active");
  assert.deepEqual(by["1-echo"].values, { cap: 5, mode: "a", on: false });
  assert.equal(by["2-dup"].state, "error");
  assert.match(by["2-dup"].error, /duplicate id "echo"/);
  assert.equal(by["3-throws"].state, "error");
  assert.match(by["3-throws"].error, /boom at start/);
  assert.match(by["4-noactivate"].error, /no activate\(\) function/);
  assert.match(by["5-badmf"].error, /default is outside min\.\.max/);
  assert.ok(changes() >= 1, "the list is broadcast after boot");

  // Actions answer in words.
  assert.deepEqual(await reg.action("echo", "ping"), { ok: true, message: "pong" });
  assert.match((await reg.action("echo", "nope")).message, /no action "nope"/);
  assert.match((await reg.action("throws", "ping")).message, /not running: failed to start: boom/);
  assert.match((await reg.action("ghost", "ping")).message, /no plugin "ghost"/);
});

test("registry: settings are refused whole, in words, and persisted when accepted", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-regcfg-"));
  const root = mkdtempSync(join(tmpdir(), "waterplane-regroot-"));
  plugin(join(cfg, "plugins"), "echo", manifest());
  const { reg } = registry(cfg, root);
  await reg.loadAll();
  assert.match(reg.setValues("echo", { cap: 3, mode: "zzz" }), /"Mode" cannot be "zzz" \(allowed: a, b\)/);
  assert.match(reg.setValues("echo", { cap: 11 }), /"Cap" cannot be 11 \(allowed 0–10\)/);
  assert.match(reg.setValues("echo", { nope: 1 }), /has no setting "nope"/);
  assert.equal(reg.views()[0].values.cap, 5, "a refused change applies nothing");
  assert.equal(reg.setValues("echo", { cap: 7 }), null);
  assert.equal(reg.views()[0].values.cap, 7);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".waterplane", "plugins", "echo", "settings.json"), "utf8")), { cap: 7 });
  // Disabled is persisted too, and a disabled plugin is `off`.
  assert.equal(await reg.setEnabled("echo", false), null);
  assert.equal(reg.views()[0].state, "off");
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".waterplane", "plugins.json"), "utf8")), { enabled: { echo: false } });
  const again = registry(cfg, root).reg;
  await again.loadAll();
  assert.equal(again.views()[0].enabled, false);
  assert.equal(again.views()[0].values.cap, 7);
});

test("registry: a throwing event handler is the plugin's status, not the daemon's problem", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-regcfg-"));
  const root = mkdtempSync(join(tmpdir(), "waterplane-regroot-"));
  plugin(join(cfg, "plugins"), "echo", manifest(), 'export function activate(api) { api.on("prompt", () => { throw new Error("handler blew up"); }); }');
  const { reg } = registry(cfg, root);
  await reg.loadAll();
  reg.firePrompt("s1", { kind: "select", question: "Which?", options: [{ index: 1, label: "One" }] });
  const v = reg.views()[0];
  assert.equal(v.state, "active");
  assert.equal(v.status.tone, "bad");
  assert.match(v.status.text, /prompt handler failed: handler blew up/);
});

test("registry: a corrupt plugins.json / settings.json is moved aside, not read as 'nothing' and overwritten", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-regcfg-"));
  const root = mkdtempSync(join(tmpdir(), "waterplane-regroot-"));
  plugin(join(cfg, "plugins"), "echo", manifest());
  const state = join(root, ".waterplane");
  mkdirSync(join(state, "plugins", "echo"), { recursive: true });
  writeFileSync(join(state, "plugins.json"), '{"enabled":{"echo":fal'); // torn write
  writeFileSync(join(state, "plugins", "echo", "settings.json"), "[1,2]"); // parses, not an object
  const orig = console.error;
  console.error = () => {};
  const { reg } = registry(cfg, root);
  try { await reg.loadAll(); } finally { console.error = orig; }
  const v = reg.views()[0];
  assert.equal(v.enabled, true, "an unreadable switch file is the default, loudly, not a crash");
  assert.equal(v.values.cap, 5, "settings fall back to the defaults");
  assert.equal(readdirSync(state).filter((n) => n.startsWith("plugins.json.corrupt-")).length, 1);
  assert.ok(!readdirSync(state).includes("plugins.json"));
  assert.equal(readdirSync(join(state, "plugins", "echo")).filter((n) => n.startsWith("settings.json.corrupt-")).length, 1);
});

test("registry: an urgent plugin notify lands on the approval kind, tagged with the plugin; otherwise it stays quiet", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-regcfg-"));
  const root = mkdtempSync(join(tmpdir(), "waterplane-regroot-"));
  plugin(join(cfg, "plugins"), "echo", manifest(),
    'export function activate(api) { api.on("action", () => { api.notify({ title: "a", body: "b", urgent: true }); api.notify({ title: "c", body: "d" }); return { ok: true, message: "sent" }; }); }');
  const notes = [];
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: fakeSessions(),
    decision: () => {}, meter: () => {}, notify: (k, p) => notes.push([k, p]), usage: () => ({ ok: false }),
    changed: () => {},
  });
  await reg.loadAll();
  await reg.action("echo", "ping");
  assert.deepEqual(notes.map(([k, p]) => [k, p.plugin, p.title]), [["approval", "echo", "a"], ["plugin", "echo", "c"]]);
});
