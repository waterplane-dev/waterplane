/**
 * Applying an update (`updates/apply.ts`): install a plugin from a LOCAL bare git repo (the clone is
 * mapped from a fake https address by an injected `git`, so the URL allowlist is exercised for real
 * and `file:` stays refused), the live load, every refusal in words, an update of a dirty tree and of a
 * local plugin, the one-at-a-time guard, and the self update / rollback / restart verdicts.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waterplane/shared";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { UpdatesChecker } = await import("../dist/updates/checker.js");
const { UpdateApplier, BUSY_SENTENCE } = await import("../dist/updates/apply.js");
const { urlProblem } = await import("../dist/updates/gitops.js");
const { readInstallRecord, installedFrom } = await import("../dist/updates/installrecord.js");
const { applyInProcess } = await import("../dist/cli/selfupdate.js");

const tmps = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const G = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, env: G, encoding: "utf8" });

const manifest = (over = {}) => ({ id: "demo", name: "Demo", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, ...over });
const HOST = 'export function activate(api) { api.on("action", () => ({ ok: true, message: "pong" })); }';

/** A work repo + the bare repo it pushes to. `release(files, tag?)` commits and pushes. */
function remote(name) {
  const base = tmp("wp-remote-");
  const work = join(base, "work"), bare = join(base, `${name}.git`);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(base, "init", "-q", "--bare", "-b", "main", bare);
  git(work, "remote", "add", "origin", bare);
  return {
    bare,
    release(files, tag) {
      for (const [f, c] of Object.entries(files)) { if (c === null) rmSync(join(work, f), { force: true }); else writeFileSync(join(work, f), typeof c === "string" ? c : JSON.stringify(c)); }
      git(work, "add", "-A"); git(work, "commit", "-q", "--allow-empty", "-m", "r");
      if (tag) git(work, "tag", tag);
      git(work, "push", "-q", "origin", "main", "--tags");
    },
  };
}

const URL_OF = (n) => `https://example.test/org/${n}`;

// The fake https addresses are mapped to local bare repos. realGit blocks the file protocol (right for production); the tests' bare repos need it, so the
// mapped runner talks to git directly instead.
const testGit = (map) => async (args, cwd) => {
  try { return execFileSync("git", args.map((x) => map[x] ?? x), { cwd, env: { ...G, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(String(e.stderr || e.message).trim().split("\n").pop()); }
};

function world({ map = {}, catalog = [], restarts = [], supervised = true, selfApply, selfMode, remoteLatest } = {}) {
  const cfg = tmp("wp-cfg-");
  const root = tmp("wp-root-");
  const pluginsDir = join(cfg, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: { list: () => [], setPluginBadge() {}, setSuggestion() {}, get: () => undefined },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
  });
  const broadcasts = [];
  const checker = new UpdatesChecker({
    stateDir: tmp("wp-state-"), installed: () => installedFrom(reg.entries), remoteLatest, autoCheck: () => false, onChange: (s) => broadcasts.push(s),
    fetchCatalog: async () => catalog,
    self: {
      mode: () => selfMode ?? { kind: "tarball", dataDir: "/x", version: "1.0.0" },
      current: () => "1.0.0", latest: async () => "1.0.0", notes: async () => undefined, installed: () => ["0.9.0", "1.0.0"],
    },
  });
  const a = new UpdateApplier({ pluginsDir, plugins: reg, checker, git: testGit(map), restart: (r) => { restarts.push(r); return "auto"; }, supervised: () => supervised, selfApply });
  return { a, reg, checker, pluginsDir, broadcasts, restarts };
}

const good = (extra = {}) => ({ "waterplane-plugin.json": manifest(extra), "host.mjs": HOST });

test("urlProblem: only https, ssh and git@host:path pass; options, file:, ext:: and the rest are refused in words", () => {
  for (const ok of ["https://github.com/waterplane-dev/copilot", "ssh://git@host.example/org/repo.git", "git@github.com:org/repo.git"]) assert.equal(urlProblem(ok), null, ok);
  const bad = {
    "-u./evil": /dash/, "--upload-pack=x": /dash/, "file:///etc": /local path or file:/, "/tmp/repo": /local path or file:/, "./x": /local path/,
    "ext::sh -c id": /spaces|ext::/, "ext::sh%20id": /ext::/, "http://insecure.example/x": /Only https/, "git://x.example/y": /Only https/,
    "https://": /Only https/, "": /Name a repository/, "https://a b/c": /spaces/, "ftp://x/y": /Only https/,
  };
  for (const [u, re] of Object.entries(bad)) assert.match(urlProblem(u) ?? "", re, JSON.stringify(u));
  assert.equal(urlProblem(undefined) !== null, true);
});

test("install by URL: clones the newest tag, writes the record, loads it LIVE; a second install of it is refused", async () => {
  const r = remote("demo");
  r.release(good(), "v0.9.0");
  r.release(good({ version: "1.0.0" }), "v1.0.0");
  const w = world({ map: { [URL_OF("demo")]: r.bare } });
  const res = await w.a.apply({ kind: "plugin-install", url: URL_OF("demo") });
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /Installed Demo v1\.0\.0/);
  const dest = join(w.pluginsDir, "demo");
  const rec = readInstallRecord(dest);
  assert.equal(rec.kind, "tag"); assert.equal(rec.ref, "v1.0.0"); assert.equal(rec.url, URL_OF("demo")); assert.match(rec.commit, /^[0-9a-f]{40}$/);
  const e = w.reg.byId("demo");
  assert.equal(e.state, "active", "live, no restart");
  assert.equal(readdirSync(w.pluginsDir).filter((n) => n.startsWith(".incoming")).length, 0);
  const again = await w.a.apply({ kind: "plugin-install", url: URL_OF("demo") });
  assert.equal(again.ok, false);
  assert.match(again.message, /already installed/);
  assert.equal(readdirSync(w.pluginsDir).filter((n) => n.startsWith(".incoming")).length, 0, "a refusal removes the temp dir");
  assert.ok(w.broadcasts.length >= 2, "status re-broadcast after every apply");
});

test("install by URL of an untagged repo uses the default branch and says so in the record", async () => {
  const r = remote("untagged");
  r.release(good({ id: "untagged" }));
  const w = world({ map: { [URL_OF("untagged")]: r.bare } });
  const res = await w.a.apply({ kind: "plugin-install", url: URL_OF("untagged") });
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /untagged/);
  const rec = readInstallRecord(join(w.pluginsDir, "untagged"));
  assert.deepEqual([rec.kind, rec.ref], ["branch", "main"]);
});

test("install from the catalogue uses the cached row's tag", async () => {
  const r = remote("fromcat");
  r.release(good({ id: "fromcat" }), "v2.0.0");
  const row = { id: "fromcat", repo: "org/fromcat", url: URL_OF("fromcat"), name: "Fromcat", description: "", maturity: "unrated", latest: { kind: "tag", ref: "v2.0.0" }, problems: [] };
  const w = world({ map: { [URL_OF("fromcat")]: r.bare }, catalog: [row] });
  await w.checker.check();
  const res = await w.a.apply({ kind: "plugin-install", repo: "org/fromcat" });
  assert.equal(res.ok, true, res.message);
  assert.equal(readInstallRecord(join(w.pluginsDir, "fromcat")).ref, "v2.0.0");
  const missing = await w.a.apply({ kind: "plugin-install", repo: "org/nope" });
  assert.match(missing.message, /org\/nope is not in the list of plugins/);
});

test("install refusals: no manifest, dependencies, a broken manifest, an id clash, bad URLs, unreachable remote", async () => {
  const none = remote("none"); none.release({ "README.md": "x" }, "v1.0.0");
  const deps = remote("deps"); deps.release({ ...good({ id: "deps" }), "package.json": { dependencies: { left: "1.0.0", right: "1" } } }, "v1.0.0");
  const broken = remote("broken"); broken.release({ "waterplane-plugin.json": "{nope", "host.mjs": HOST }, "v1.0.0");
  const clash = remote("clash"); clash.release(good({ id: "demo" }), "v1.0.0");
  const w = world({ map: { [URL_OF("none")]: none.bare, [URL_OF("deps")]: deps.bare, [URL_OF("broken")]: broken.bare, [URL_OF("clash")]: clash.bare } });
  const m = await w.a.apply({ kind: "plugin-install", url: URL_OF("none") });
  assert.equal(m.ok, false); assert.match(m.message, /no waterplane-plugin\.json/); assert.match(m.message, /Nothing was installed/);
  const d = await w.a.apply({ kind: "plugin-install", url: URL_OF("deps") });
  assert.match(d.message, /deps has dependencies \(left, right\); only plugins without dependencies can be installed\. Nothing was installed/);
  const b = await w.a.apply({ kind: "plugin-install", url: URL_OF("broken") });
  assert.match(b.message, /not valid JSON/);
  // the id "demo" is taken by a plugin already on disk and loaded
  const dir = join(w.pluginsDir, "hand");
  mkdirSync(dir); writeFileSync(join(dir, "waterplane-plugin.json"), JSON.stringify(manifest())); writeFileSync(join(dir, "host.mjs"), HOST);
  await w.reg.loadOne(dir);
  const c = await w.a.apply({ kind: "plugin-install", url: URL_OF("clash") });
  assert.match(c.message, /A plugin with the id "demo" is already installed/);
  for (const url of ["file:///tmp/x", "-oProxyCommand=x", "ext::sh -c id", "http://x.test/y", ""]) {
    const r = await w.a.apply({ kind: "plugin-install", url });
    assert.equal(r.ok, false, url); assert.match(r.message, /Nothing was installed/);
  }
  const gone = await w.a.apply({ kind: "plugin-install", url: URL_OF("unmapped") });
  assert.equal(gone.ok, false); assert.match(gone.message, /Could not read https:\/\/example\.test\/org\/unmapped/);
  assert.equal(readdirSync(w.pluginsDir).filter((n) => n.startsWith(".incoming")).length, 0);
  assert.deepEqual(readdirSync(w.pluginsDir).sort(), ["hand"], "nothing but the hand-placed plugin is left");
});

test("plugin update: moves to the new tag, keeps the record honest, asks for a restart; same tag is refused", async () => {
  const r = remote("up");
  r.release(good({ id: "up", version: "1.0.0" }), "v1.0.0");
  const w = world({ map: { [URL_OF("up")]: r.bare } });
  assert.equal((await w.a.apply({ kind: "plugin-install", url: URL_OF("up") })).ok, true);
  assert.match((await w.a.apply({ kind: "plugin-update", id: "up" })).message, /already at v1\.0\.0/);
  r.release(good({ id: "up", version: "1.1.0" }), "v1.1.0");
  const res = await w.a.apply({ kind: "plugin-update", id: "up" });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.restart, "offer");
  assert.match(res.message, /Updated Demo to v1\.1\.0\. Restart the desktop to run it/);
  const dest = join(w.pluginsDir, "up");
  assert.equal(JSON.parse(readFileSync(join(dest, "waterplane-plugin.json"), "utf8")).version, "1.1.0");
  assert.equal(readInstallRecord(dest).ref, "v1.1.0");
  assert.equal(git(dest, "status", "--porcelain").trim().replace(/.*waterplane-install.*/, ""), "", "the record never makes the tree dirty");
  const unsupervised = world({ map: { [URL_OF("up")]: r.bare }, supervised: false });
  assert.equal((await unsupervised.a.apply({ kind: "plugin-install", url: URL_OF("up") })).ok, true);
  r.release(good({ id: "up", version: "1.2.0" }), "v1.2.0");
  assert.equal((await unsupervised.a.apply({ kind: "plugin-update", id: "up" })).restart, "manual");
});

test("plugin update refusals: a dirty tree, a local plugin, a new version with dependencies (checked back out)", async () => {
  const r = remote("dirty");
  r.release(good({ id: "dirty" }), "v1.0.0");
  const w = world({ map: { [URL_OF("dirty")]: r.bare } });
  await w.a.apply({ kind: "plugin-install", url: URL_OF("dirty") });
  const dest = join(w.pluginsDir, "dirty");
  writeFileSync(join(dest, "host.mjs"), `${HOST}\n// edited\n`);
  r.release(good({ id: "dirty", version: "1.1.0" }), "v1.1.0");
  const d = await w.a.apply({ kind: "plugin-update", id: "dirty" });
  assert.equal(d.ok, false);
  assert.match(d.message, /Demo has changes of its own in .*dirty\. Commit or discard them first; nothing was changed\./);
  assert.equal(readInstallRecord(dest).ref, "v1.0.0");
  git(dest, "checkout", "--", "host.mjs");

  r.release({ ...good({ id: "dirty", version: "2.0.0" }), "package.json": { dependencies: { x: "1" } } }, "v2.0.0");
  const before = git(dest, "rev-parse", "HEAD").trim();
  const dep = await w.a.apply({ kind: "plugin-update", id: "dirty" });
  assert.equal(dep.ok, false);
  assert.match(dep.message, /v2\.0\.0 of Demo was refused: dirty has dependencies.*It is still at v1\.0\.0/);
  assert.equal(git(dest, "rev-parse", "HEAD").trim(), before, "checked back out");
  assert.equal(readInstallRecord(dest).ref, "v1.0.0");

  const hand = join(w.pluginsDir, "byhand");
  mkdirSync(hand); writeFileSync(join(hand, "waterplane-plugin.json"), JSON.stringify(manifest({ id: "byhand", name: "ByHand" }))); writeFileSync(join(hand, "host.mjs"), HOST);
  await w.reg.loadOne(hand);
  const l = await w.a.apply({ kind: "plugin-update", id: "byhand" });
  assert.equal(l.ok, false);
  assert.match(l.message, /ByHand was put on this desktop by hand/);
  assert.match((await w.a.apply({ kind: "plugin-update", id: "ghost" })).message, /No plugin "ghost" is installed/);
});

test("one apply at a time: a second while one runs is refused in words", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = world({ selfApply: async () => { await gate; return { code: 0, version: "1.0.0" }; } });
  const first = w.a.apply({ kind: "self" });
  assert.equal(w.a.busy, true);
  const second = await w.a.apply({ kind: "restart" });
  assert.deepEqual(second, { ok: false, message: BUSY_SENTENCE, restart: "none" });
  assert.equal(BUSY_SENTENCE, "another update is running");
  release();
  await first;
  assert.equal(w.a.busy, false);
});

test("self update: refused with the command for npm/checkout installs; a tarball one switches, writes the receipt, then restarts", async () => {
  const calls = [];
  const npm = world({ selfMode: { kind: "npm" }, selfApply: async () => { calls.push("ran"); return { code: 0, version: "9.9.9" }; } });
  const refused = await npm.a.apply({ kind: "self" });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /npm updates it.*Run: npm i -g waterplane@latest/);
  assert.deepEqual(calls, [], "nothing ran");

  const restarts = [];
  const ok = world({ restarts, selfApply: async (what, say) => { say.log("  current → 1.1.0"); return { code: 0, version: "1.1.0" }; } });
  const res = await ok.a.apply({ kind: "self" });
  assert.deepEqual(res, { ok: true, message: "updated to 1.1.0", restart: "restarting" });
  assert.deepEqual(restarts, ["updating waterplane to 1.1.0"]);
  assert.equal(ok.checker.status().self.lastResult.message, "updated to 1.1.0", "the receipt is stored for the reconnect");

  const un = world({ supervised: false, restarts: [], selfApply: async () => ({ code: 0, version: "1.1.0" }) });
  const m = await un.a.apply({ kind: "self" });
  assert.deepEqual(m, { ok: true, message: "installed 1.1.0, restart the desktop to switch", restart: "manual" });
  assert.deepEqual(un.restarts, []);

  const bad = world({ restarts: [], selfApply: async (w, say) => { say.error("Checksum mismatch for x.tar.gz (expected a, got b) — refusing; nothing changed."); return { code: 1, version: null }; } });
  const f = await bad.a.apply({ kind: "self" });
  assert.deepEqual(f, { ok: false, message: "Checksum mismatch for x.tar.gz (expected a, got b) — refusing; nothing changed.", restart: "none" });
  assert.equal(bad.restarts.length, 0, "a failure restarts nothing");
  assert.equal(bad.checker.status().self.lastResult.ok, false);

  const same = world({ selfApply: async () => ({ code: 0, version: "1.0.0" }) });
  assert.match((await same.a.apply({ kind: "self" })).message, /1\.0\.0 is already the newest version/);
});

test("self rollback and the restart target", async () => {
  const restarts = [];
  const w = world({ restarts, selfApply: async (what, say) => { say.log("Rolled back 1.0.0 → 0.9.0. Its state is used as it is."); return { code: 0, version: "0.9.0" }; } });
  const r = await w.a.apply({ kind: "self-rollback" });
  assert.equal(r.ok, true); assert.equal(r.restart, "restarting"); assert.match(r.message, /^Rolled back 1\.0\.0 → 0\.9\.0/);
  assert.deepEqual(restarts, ["rolling waterplane back to 0.9.0"]);
  const rs = await w.a.apply({ kind: "restart" });
  assert.deepEqual(rs, { ok: true, message: "Restarting the desktop.", restart: "restarting" });
  const un = world({ supervised: false });
  const nr = await un.a.apply({ kind: "restart" });
  assert.equal(nr.ok, false); assert.equal(nr.restart, "manual"); assert.match(nr.message, /not run by a service/);
});

test("applyInProcess on a non-tarball install refuses in words and switches nothing", async () => {
  const lines = { out: [], err: [] };
  const r = await applyInProcess("update", { log: (m) => lines.out.push(m), error: (m) => lines.err.push(m) });
  assert.equal(r.code, 1);
  assert.match(lines.err[0], /only the release tarball install can/);
});

test("a plugin installed by URL (outside the org catalogue) shows as manager-installed, with its remote's newest or why not", async () => {
  const r = remote("outside");
  r.release(good({ id: "outside" }), "v1.0.0");
  const asked = [];
  const w = world({ map: { [URL_OF("outside")]: r.bare }, remoteLatest: async (url) => { asked.push(url); return { kind: "tag", ref: "v1.1.0" }; } });
  assert.equal((await w.a.apply({ kind: "plugin-install", url: URL_OF("outside") })).ok, true);
  let row = w.checker.status().catalog.find((c) => c.installed?.id === "outside");
  assert.equal(row.installed.source, "manager");
  assert.equal(row.latest, null, "before any check: no latest, and it says so");
  assert.deepEqual(row.problems, ["Not checked yet."]);
  assert.equal(row.repo, "other: example.test/org/outside");
  assert.equal(await w.checker.check(), true);
  row = w.checker.status().catalog.find((c) => c.installed?.id === "outside");
  assert.deepEqual(row.latest, { kind: "tag", ref: "v1.1.0" });
  assert.deepEqual(row.problems, []);
  assert.deepEqual(asked, [URL_OF("outside")]);

  const down = world({ map: { [URL_OF("outside")]: r.bare }, remoteLatest: async () => { throw new Error("connection refused"); } });
  await down.a.apply({ kind: "plugin-install", url: URL_OF("outside") });
  await down.checker.check();
  const bad = down.checker.status().catalog.find((c) => c.installed?.id === "outside");
  assert.equal(bad.latest, null);
  assert.match(bad.problems[0], /Could not check https:\/\/example\.test\/org\/outside for a newer version: connection refused\./);
  assert.equal(down.checker.status().error, undefined, "one unreadable remote never fails the check");
});

// ── review fixes ──────────────────────────────────────────────────────────

test("every apply is kept as lastApply (and broadcast), a malformed target stores nothing", async () => {
  const r = remote("kept");
  r.release(good({ id: "kept" }), "v1.0.0");
  const w = world({ map: { [URL_OF("kept")]: r.bare } });
  const res = await w.a.apply({ kind: "plugin-install", url: URL_OF("kept") });
  const last = w.checker.status().lastApply;
  assert.deepEqual({ ok: last.ok, message: last.message, restart: last.restart, kind: last.target.kind }, { ok: true, message: res.message, restart: "none", kind: "plugin-install" });
  assert.ok(w.broadcasts.at(-1).lastApply, "broadcast with the status, so a reconnecting phone reads it");
  for (const bad of [null, undefined, 5, { kind: "plugin-update", id: 5 }, { kind: "plugin-install", repo: 5, url: { x: 1 } }, { kind: "nope" }]) {
    const before = w.checker.status().lastApply.at;
    const out = await w.a.apply(bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.equal(out.restart, "none");
    if (bad === null || bad === undefined || typeof bad !== "object") assert.equal(w.checker.status().lastApply.at, before, "no target, no receipt");
  }
});

test("an injection-shaped version name never reaches git", async () => {
  const row = (ref) => ({ id: "inj", repo: "org/inj", url: URL_OF("inj"), name: "Inj", description: "", maturity: "unrated", latest: { kind: "tag", ref }, problems: [] });
  for (const ref of ["--upload-pack=touch x", "-x", "a..b", "v1 2"]) {
    const w = world({ catalog: [row(ref)] });
    const calls = [];
    const a = new UpdateApplier({ pluginsDir: w.pluginsDir, plugins: w.reg, checker: w.checker, git: async (args) => { calls.push(args); return ""; }, restart: () => "auto", supervised: () => true });
    await w.checker.check();
    const res = await a.apply({ kind: "plugin-install", repo: "org/inj" });
    assert.equal(res.ok, false, ref);
    assert.deepEqual(calls, [], `git was never called for ${JSON.stringify(ref)}`);
    assert.equal(readdirSync(w.pluginsDir).filter((n) => n.startsWith(".incoming-")).length, 0);
  }
});

test("loadOne throwing after the rename removes the folder and says so; a boot error is 'installed but not running'", async () => {
  const r = remote("boom");
  r.release(good({ id: "boom" }), "v1.0.0");
  const w = world({ map: { [URL_OF("boom")]: r.bare } });
  w.reg.loadOne = async () => { throw new Error("kaboom"); };
  const res = await w.a.apply({ kind: "plugin-install", url: URL_OF("boom") });
  assert.equal(res.ok, false);
  assert.match(res.message, /could not be started: kaboom\. It was removed again; nothing is installed\./);
  assert.doesNotMatch(res.message, /Nothing else was changed/);
  assert.equal(existsSync(join(w.pluginsDir, "boom")), false, "the folder is gone");

  const w2 = world({ map: { [URL_OF("boom")]: r.bare } });
  w2.reg.loadOne = async () => "activate() threw";
  const res2 = await w2.a.apply({ kind: "plugin-install", url: URL_OF("boom") });
  assert.equal(res2.ok, false);
  assert.match(res2.message, /is installed but not running: activate\(\) threw/);
  assert.equal(existsSync(join(w2.pluginsDir, "boom")), true, "and it says it IS installed");
});

test("a plugin update is refused when its catalogue row has problems / another repo, and when the target is not newer", async () => {
  const r = remote("rowp");
  r.release(good({ id: "rowp", version: "2.0.0" }), "v2.0.0");
  const asked = { ref: "v2.0.0" };
  const w = world({ map: { [URL_OF("rowp")]: r.bare }, remoteLatest: async () => ({ kind: "tag", ref: asked.ref }) });
  assert.equal((await w.a.apply({ kind: "plugin-install", url: URL_OF("rowp") })).ok, true);
  asked.ref = "v1.0.0"; // a stale or crafted answer: the manager must not move back
  await w.checker.check();
  const res = await w.a.apply({ kind: "plugin-update", id: "rowp" });
  assert.equal(res.ok, false);
  assert.match(res.message, /v1\.0\.0 is not newer than v2\.0\.0/);
  assert.equal(readInstallRecord(join(w.pluginsDir, "rowp")).ref, "v2.0.0");

  // The org row of the same id belongs to ANOTHER repo: the join says so as a problem; no update from it.
  const orgRow = { id: "rowp", repo: "org/rowp", url: "https://github.com/org/rowp.git", name: "Rowp", description: "", maturity: "unrated", latest: { kind: "tag", ref: "v3.0.0" }, problems: [] };
  const w2 = world({ map: { [URL_OF("rowp")]: r.bare }, catalog: [orgRow] });
  assert.equal((await w2.a.apply({ kind: "plugin-install", url: URL_OF("rowp") })).ok, true);
  await w2.checker.check();
  const calls = [];
  const a2 = new UpdateApplier({ pluginsDir: w2.pluginsDir, plugins: w2.reg, checker: w2.checker, git: async (args) => { calls.push(args[0]); return args[0] === "status" ? "" : "x"; }, supervised: () => true });
  const res2 = await a2.apply({ kind: "plugin-update", id: "rowp" });
  assert.equal(res2.ok, false);
  assert.match(res2.message, /cannot be updated from here: .*already installed from/);
  assert.deepEqual(calls.filter((c) => c === "fetch" || c === "checkout"), [], "nothing was fetched from the wrong repo");
});

test("stale .incoming-* dirs are swept at construction and at the start of an install, and nothing else is touched", async () => {
  const r = remote("sweep");
  r.release(good({ id: "sweep" }), "v1.0.0");
  const w = world({ map: { [URL_OF("sweep")]: r.bare } });
  mkdirSync(join(w.pluginsDir, ".incoming-dead1"));
  writeFileSync(join(w.pluginsDir, ".incoming-dead1", "x"), "x");
  mkdirSync(join(w.pluginsDir, "keepme"));
  mkdirSync(join(w.pluginsDir, ".other"));
  new UpdateApplier({ pluginsDir: w.pluginsDir, plugins: w.reg, checker: w.checker });
  assert.deepEqual(readdirSync(w.pluginsDir).sort(), [".other", "keepme"]);
  mkdirSync(join(w.pluginsDir, ".incoming-dead2"));
  assert.equal((await w.a.apply({ kind: "plugin-install", url: URL_OF("sweep") })).ok, true);
  assert.deepEqual(readdirSync(w.pluginsDir).sort(), [".other", "keepme", "sweep"]);
});

test("skip-signature: the self update's receipt carries the warning", async () => {
  const WARN = "WARNING: INSECURE_SKIP_SIG=1 - NOT checking who published this release.";
  const w = world({ selfApply: async () => ({ code: 0, version: "1.1.0", warning: WARN }) });
  const res = await w.a.apply({ kind: "self" });
  assert.equal(res.ok, true);
  assert.equal(res.restart, "restarting");
  assert.ok(res.message.includes(WARN), res.message);
  assert.ok(w.checker.status().self.lastResult.message.includes(WARN));
});

test("a rollback whose state was NOT restored is a failure and restarts nothing", async () => {
  const w = world({ selfApply: async (what, say) => { say.log("Rolled back 1.0.0 → 0.9.0. Its state from before the update is NOT restored yet: stop the host."); return { code: 0, version: "0.9.0" }; } });
  const res = await w.a.apply({ kind: "self-rollback" });
  assert.equal(res.ok, false); assert.equal(res.restart, "none");
  assert.deepEqual(w.restarts, []);
  assert.equal(w.checker.status().self.lastResult.ok, false);
});
