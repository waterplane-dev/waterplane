/**
 * The update check against a FAKE GitHub on localhost (never the real one): the topic filter and
 * public-only, an untagged repo tracking its branch, a catalogue row's refusals in words, the
 * installed join (manager vs local), the self info per install mode, the 10-minute floor and a
 * failed check keeping the cache. `packages/host/src/updates/`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, PLUGIN_TOPIC, updatesDue } from "@waterplane/shared";
import { fetchCatalog, joinInstalled } from "../dist/updates/catalog.js";
import { UpdatesChecker, CHECK_FLOOR_MS, CHECK_FLOOR_FAILED_MS } from "../dist/updates/checker.js";
import { installedFrom, writeInstallRecord, readInstallRecord } from "../dist/updates/installrecord.js";
import { selfBase } from "../dist/updates/self.js";

const ORG = BRAND.githubOrg;
const MANIFEST = BRAND.pluginManifest;
const okManifest = (id, extra = {}) => JSON.stringify({ id, name: `Name ${id}`, version: "1.0.0", apiVersion: "2.0", ...extra });

// repo → { repo fields, release?, files by ref }
const world = {
  repos: [],
  release: {}, // full_name → { tag_name, body } | undefined (404)
  head: {},    // full_name → sha
  files: {},   // `${full}@${ref}/${path}` → text
  down: false,
  calls: [],
};
function reset() {
  world.down = false; world.calls = [];
  world.repos = [
    { name: "good", full_name: `${ORG}/good`, html_url: `https://github.com/${ORG}/good`, description: "A good one", topics: [PLUGIN_TOPIC], private: false, default_branch: "main" },
    { name: "untagged", full_name: `${ORG}/untagged`, html_url: `https://github.com/${ORG}/untagged`, description: null, topics: [PLUGIN_TOPIC], private: false, default_branch: "main" },
    { name: "notopic", full_name: `${ORG}/notopic`, html_url: `https://github.com/${ORG}/notopic`, topics: ["other"], private: false, default_branch: "main" },
    { name: "secret", full_name: `${ORG}/secret`, html_url: `https://github.com/${ORG}/secret`, topics: [PLUGIN_TOPIC], private: true, default_branch: "main" },
    { name: "nomanifest", full_name: `${ORG}/nomanifest`, html_url: `https://github.com/${ORG}/nomanifest`, topics: [PLUGIN_TOPIC], private: false, default_branch: "main" },
    { name: "deps", full_name: `${ORG}/deps`, html_url: `https://github.com/${ORG}/deps`, topics: [PLUGIN_TOPIC], private: false, default_branch: "main" },
    { name: "future", full_name: `${ORG}/future`, html_url: `https://github.com/${ORG}/future`, topics: [PLUGIN_TOPIC], private: false, default_branch: "main" },
  ];
  world.release = {
    [`${ORG}/good`]: { tag_name: "v1.2.0", body: "notes" },
    [`${ORG}/nomanifest`]: { tag_name: "v0.1.0" },
    [`${ORG}/deps`]: { tag_name: "v0.1.0" },
    [`${ORG}/future`]: { tag_name: "v0.1.0" },
  };
  world.head = { [`${ORG}/untagged`]: "abc123" };
  world.files = {
    [`${ORG}/good@v1.2.0/${MANIFEST}`]: okManifest("good", { maturity: "preview" }),
    [`${ORG}/good@v1.2.0/package.json`]: JSON.stringify({ name: "good" }),
    [`${ORG}/untagged@main/${MANIFEST}`]: okManifest("untagged"),
    [`${ORG}/deps@v0.1.0/${MANIFEST}`]: okManifest("deps"),
    [`${ORG}/deps@v0.1.0/package.json`]: JSON.stringify({ dependencies: { left: "1.0.0" } }),
    [`${ORG}/future@v0.1.0/${MANIFEST}`]: okManifest("future", { apiVersion: "9.0" }),
  };
}

let server, dir;
before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    world.calls.push(u.pathname);
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    if (world.down) return send(500, "boom");
    const api = u.pathname.startsWith("/api/") ? u.pathname.slice(4) : null;
    if (api) {
      if (api === `/orgs/${ORG}/repos`) return send(200, world.repos);
      let m = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(api);
      if (m) return world.release[m[1]] ? send(200, world.release[m[1]]) : send(404, {});
      m = /^\/repos\/([^/]+\/[^/]+)\/commits\/main$/.exec(api);
      if (m) return world.head[m[1]] ? send(200, { sha: world.head[m[1]] }) : send(404, {});
      return send(404, {});
    }
    const m = /^\/raw\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (m) { const t = world.files[`${m[1]}@${decodeURIComponent(m[2])}/${m[3]}`]; return t === undefined ? send(404, "nope", "text/plain") : send(200, t, "text/plain"); }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.WATERPLANE_GITHUB_API = `${base}/api`;
  process.env.WATERPLANE_GITHUB_RAW = `${base}/raw`;
  delete process.env.WATERPLANE_UPDATE_CHECK;
  dir = mkdtempSync(join(tmpdir(), "wp-updates-"));
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const byName = (c, n) => c.find((e) => e.repo === `${ORG}/${n}`);

test("catalogue keeps only public repos with the plugin topic", async () => {
  reset();
  const c = await fetchCatalog();
  assert.deepEqual(c.map((e) => e.repo.split("/")[1]).sort(), ["deps", "future", "good", "nomanifest", "untagged"]);
  const good = byName(c, "good");
  assert.equal(good.name, "Name good");
  assert.equal(good.maturity, "preview");
  assert.deepEqual(good.latest, { kind: "tag", ref: "v1.2.0", notes: "notes" });
  assert.deepEqual(good.problems, []);
});

test("an untagged repo tracks its default branch head, and an absent maturity is unrated", async () => {
  reset();
  const u = byName(await fetchCatalog(), "untagged");
  assert.deepEqual(u.latest, { kind: "branch", ref: "main", commit: "abc123" });
  assert.equal(u.maturity, "unrated");
  assert.equal(u.description, "");
});

test("a missing manifest, dependencies and a too-new apiVersion each become problems", async () => {
  reset();
  const c = await fetchCatalog();
  assert.match(byName(c, "nomanifest").problems.join(" "), new RegExp(`no ${MANIFEST.replace(".", "\\.")} at v0\\.1\\.0`));
  assert.match(byName(c, "deps").problems.join(" "), /dependencies \(left\)/);
  assert.match(byName(c, "future").problems.join(" "), /apiVersion/);
});

test("installed join: manager record vs a local dir, and a clash with another repo", async () => {
  reset();
  const raw = await fetchCatalog();
  const plugins = join(dir, "plugins");
  mkdirSync(join(plugins, "good"), { recursive: true });
  mkdirSync(join(plugins, "untagged"), { recursive: true });
  writeInstallRecord(join(plugins, "good"), { url: `https://github.com/${ORG}/good`, kind: "tag", ref: "v1.0.0", installedAt: 1 });
  assert.equal(readInstallRecord(join(plugins, "good")).ref, "v1.0.0");
  const inst = installedFrom([
    { dir: join(plugins, "good"), manifest: { id: "good", version: "1.0.0" } },
    { dir: join(plugins, "untagged"), manifest: { id: "untagged", version: "0.0.1" } },
    { dir: "/b", builtin: true, manifest: { id: "vault", version: "1" } },
  ]);
  assert.equal(inst.length, 2);
  const rows = joinInstalled(raw, inst);
  const good = byName(rows, "good"), un = byName(rows, "untagged");
  assert.equal(good.installed.source, "manager");
  assert.equal(good.installed.ref, "v1.0.0");
  assert.equal(un.installed.source, "local");
  assert.equal(un.installed.ref, undefined);
  assert.equal(byName(rows, "deps").installed, null);
  // only the manager-installed one with a newer tag is an update
  assert.deepEqual(updatesDue({ self: { mode: "unknown", current: "1.0.0", canApply: false }, catalog: rows }).map((d) => d.id), ["good"]);
  // the same id installed from a different repo is named
  const clash = joinInstalled(raw, [{ id: "good", version: "1", source: "manager", ref: "v1", dir: "/x", url: "https://github.com/someone/else" }]);
  assert.match(byName(clash, "good").problems.join(" "), /already installed from someone\/else/);
});

test("self info per install mode: tarball gets the button, npm and checkout a command and a why", () => {
  const mk = (mode) => selfBase({ mode: () => mode, current: () => "0.1.4", latest: async () => "0.1.5", notes: async () => undefined, installed: () => ["0.1.3", "0.1.4"] });
  const t = mk({ kind: "tarball", dataDir: "/d", version: "0.1.4", root: "/d/versions/0.1.4" });
  assert.equal(t.canApply, true); assert.equal(t.rollbackTo, "0.1.3"); assert.equal(t.command, undefined);
  const n = mk({ kind: "npm", root: "/r" });
  assert.equal(n.canApply, false); assert.match(n.command, /^npm i -g .+@latest$/); assert.match(n.why, /npm/);
  const c = mk({ kind: "checkout", root: "/r" });
  assert.equal(c.canApply, false); assert.match(c.command, /git pull/); assert.ok(c.why);
  const u = mk({ kind: "unknown", root: "/r" });
  assert.equal(u.canApply, false); assert.equal(u.command, undefined); assert.ok(u.why);
});

function checker(stateDir, clock, over = {}) {
  const seen = [];
  const c = new UpdatesChecker({
    stateDir, installed: () => [], autoCheck: () => true, onChange: (s) => seen.push(s),
    self: { mode: () => ({ kind: "npm", root: "/r" }), current: () => "0.1.4", latest: async () => "0.1.5", notes: async () => "self notes", installed: () => [] },
    now: () => clock.t, ...over,
  });
  return { c, seen };
}

test("a check broadcasts, has a 10-minute floor on demand, and the timer ignores the floor", async () => {
  reset();
  const sd = mkdtempSync(join(tmpdir(), "wp-upd-state-"));
  const clock = { t: 1_000_000 };
  const { c, seen } = checker(sd, clock);
  assert.equal(c.status().checkedAt, undefined);
  assert.equal(await c.check(), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].checkedAt, 1_000_000);
  assert.equal(seen[0].self.latest, "0.1.5");
  assert.equal(seen[0].self.notes, "self notes");
  assert.equal(seen[0].catalog.length, 5);
  const calls = world.calls.length;
  clock.t += CHECK_FLOOR_MS - 1;
  assert.equal(await c.check(), false);            // inside the floor: no call, no broadcast
  assert.equal(world.calls.length, calls);
  assert.equal(seen.length, 1);
  clock.t += 2;
  assert.equal(await c.check(), true);
  // a restart reads the cache
  const again = checker(sd, clock).c.status();
  assert.equal(again.catalog.length, 5);
  assert.equal(again.checkedAt, clock.t);
  rmSync(sd, { recursive: true, force: true });
});

test("a failed check keeps the previous catalogue and checkedAt, and says why in a sentence", async () => {
  reset();
  const sd = mkdtempSync(join(tmpdir(), "wp-upd-state-"));
  const clock = { t: 5_000_000 };
  const { c, seen } = checker(sd, clock);
  await c.check();
  world.down = true;
  clock.t += CHECK_FLOOR_MS + 1;
  assert.equal(await c.check(), true);
  const s = seen.at(-1);
  assert.match(s.error, /^Could not read the list of plugins: GitHub answered HTTP 500\.$/);
  assert.equal(s.checkedAt, 5_000_000);            // the last GOOD check
  assert.equal(s.catalog.length, 5);               // the rows are the old ones, untouched
  world.down = false;
  clock.t += CHECK_FLOOR_MS + 1;
  await c.check();
  assert.equal(seen.at(-1).error, undefined);
  rmSync(sd, { recursive: true, force: true });
});

test("floor: 30 s after a FAILED attempt, 10 min after an ok one, and status says when the next check is possible", async () => {
  reset();
  const sd = mkdtempSync(join(tmpdir(), "wp-upd-state-"));
  const clock = { t: 9_000_000 };
  const { c } = checker(sd, clock);
  await c.check();
  assert.equal(c.status().nextCheckAt, 9_000_000 + CHECK_FLOOR_MS, "ok attempt: long floor");
  clock.t += CHECK_FLOOR_FAILED_MS + 1;
  assert.equal(await c.check(), false, "30 s is not enough after an ok attempt");
  clock.t += CHECK_FLOOR_MS;
  world.down = true;
  assert.equal(await c.check(), true);
  assert.ok(c.status().error);
  assert.equal(c.status().nextCheckAt, clock.t + CHECK_FLOOR_FAILED_MS, "failed attempt: short floor");
  clock.t += CHECK_FLOOR_FAILED_MS - 1;
  assert.equal(await c.check(), false, "still inside the short floor");
  clock.t += 2;
  world.down = false;
  assert.equal(c.status().nextCheckAt, undefined, "floor over: a check is allowed now");
  assert.equal(await c.check(), true, "a tap after a failure runs a real check");
  assert.equal(c.status().error, undefined);
  rmSync(sd, { recursive: true, force: true });
});

test("a refused or off check makes no call; the daily timer honours autoCheck, a tap does not", async () => {
  reset();
  const sd = mkdtempSync(join(tmpdir(), "wp-upd-state-"));
  const { c, seen } = checker(sd, { t: 9_000_000 }, { autoCheck: () => false });
  assert.equal(await c.check({ timer: true }), false);
  assert.equal(world.calls.length, 0);
  assert.equal(c.status().autoCheck, false);
  process.env.WATERPLANE_UPDATE_CHECK = "0";
  try {
    assert.equal(await c.check(), false);
    assert.equal(world.calls.length, 0);
    assert.match(c.status().error, /switched off/);
  } finally { delete process.env.WATERPLANE_UPDATE_CHECK; }
  assert.equal(await c.check(), true);
  assert.equal(seen.length, 1);
  rmSync(sd, { recursive: true, force: true });
});

test("the 'good' fixture is the only call-cheap path: calls per matching repo stay small", async () => {
  reset();
  await fetchCatalog();
  // org list + per repo (release, [head], manifest, package.json) — 5 repos, well under 60
  assert.ok(world.calls.length <= 1 + 5 * 4, `${world.calls.length} calls`);
});

// ── review fixes ──────────────────────────────────────────────────────────

test("the clone address comes from full_name, and a repo outside the org prefix is dropped", async () => {
  reset();
  world.repos[0].html_url = "https://evil.example/x";
  world.repos.push({ name: "stray", full_name: "someone-else/stray", html_url: "https://github.com/someone-else/stray", topics: [PLUGIN_TOPIC], private: false, default_branch: "main" });
  world.repos.push({ name: "odd", full_name: `${ORG}/odd name`, html_url: "x", topics: [PLUGIN_TOPIC], private: false, default_branch: "main" });
  const rows = await fetchCatalog();
  const good = rows.find((r) => r.repo === `${ORG}/good`);
  assert.equal(good.url, `https://github.com/${ORG}/good.git`);
  assert.equal(rows.some((r) => r.repo.startsWith("someone-else/") || r.repo.includes(" ")), false);
});

test("'from the org' is judged by host plus org (fromOrg); a non-GitHub address never reads like the org", async () => {
  const { repoLabel, isOrgUrl } = await import("../dist/updates/remote.js");
  assert.equal(isOrgUrl(`https://github.com/${ORG}/x`), true);
  assert.equal(isOrgUrl(`https://github.com/${ORG}/x.git`), true);
  for (const u of [`https://${ORG}/x`, `https://evil.example/${ORG}/x`, `https://github.com.evil.example/${ORG}/x`, `git@github.com:${ORG}/x.git`, "https://github.com/other/x"]) assert.equal(isOrgUrl(u), false, u);
  assert.equal(repoLabel(`https://${ORG}/x`).startsWith(ORG), false);
  assert.equal(repoLabel(`https://github.com/${ORG}/x`), `${ORG}/x`);
  const raw = [{ id: "a", repo: `${ORG}/a`, url: `https://github.com/${ORG}/a.git`, name: "A", description: "", maturity: "unrated", latest: null, problems: [] }];
  assert.equal(joinInstalled(raw, [])[0].fromOrg, true);
});

test("an unchanged release is not re-read: the manifest and package.json calls are skipped", async () => {
  reset();
  const first = await fetchCatalog();
  world.calls = [];
  const second = await fetchCatalog(undefined, first);
  assert.deepEqual(second.map((r) => [r.repo, r.problems, r.id]), first.map((r) => [r.repo, r.problems, r.id]));
  const raw = world.calls.filter((p) => p.startsWith("/raw/"));
  // only repos whose last read was a refusal about a missing file are retried
  assert.ok(raw.length <= 2, `${raw.length} raw reads`);
  assert.ok(world.calls.length < 1 + 5 * 4);
});

test("the catalogue, self and remote checks fail independently, each as its own sentence", async () => {
  reset();
  const sd = mkdtempSync(join(tmpdir(), "wp-upd-state-"));
  const clock = { t: 7_000_000 };
  const { c, seen } = checker(sd, clock, { self: { mode: () => ({ kind: "npm", root: "/r" }), current: () => "0.1.4", latest: async () => { throw new Error("signature refused"); }, notes: async () => undefined, installed: () => [] } });
  await c.check();
  const s = seen.at(-1);
  assert.match(s.error, /^Could not check for a newer waterplane: signature refused\.$/);
  assert.equal(s.catalog.length, 5, "the catalogue refreshed although self failed");
  assert.equal(s.checkedAt, undefined, "checkedAt moves only when everything was read");
  world.down = true;
  const { c: c2, seen: seen2 } = checker(sd, clock, { fetchCatalog: async () => { throw new Error("rate limited"); } });
  clock.t += CHECK_FLOOR_MS + 1;
  await c2.check();
  const s2 = seen2.at(-1);
  assert.match(s2.error, /Could not read the list of plugins: rate limited\./);
  assert.equal(s2.self.latest, "0.1.5", "the self reading still came in");
  assert.equal(s2.catalog.length, 5, "old rows stay");
  rmSync(sd, { recursive: true, force: true });
});
