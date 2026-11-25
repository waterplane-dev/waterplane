/**
 * The links host half over recorded command output and a temp pins file — never the real lsof,
 * tailscale or gcloud. Pins: a port is a repo's only when its process works under the code root;
 * a loopback-only port gets a serve command on a free port and no URL; a served port gets its front
 * door; a Cloud Function is found but hidden; a project is tied to a repo by `.firebaserc` first,
 * then by the most mentions, and a tie is NO repo; a Firebase site that is not its project's default
 * follows its OWN mentions (none = no repo); a repo one folder down counts; a broken pins file is
 * never written over.
 *
 *     node --test packages/extensions/links/test/links.test.mjs   (after the host build)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const D = "../../../host/dist/extensions/links";
const { createEngine, serve } = await import(`${D}/host/index.mjs`);
const P = await import(`${D}/host/parse.mjs`);
const { scanCloud } = await import(`${D}/host/cloudscan.mjs`);

const LSOF = ["p100", "cnode", "f20", "n127.0.0.1:5180", "p100", "cnode", "f21", "n[::1]:5180",
  "p200", "cnode", "f9", "n127.0.0.1:8300", "p300", "cCode\\x20Helper", "f3", "n127.0.0.1:49503",
  "p400", "cpython3", "f4", "n*:8000", "p500", "cnode", "f5", "n127.0.0.1:61000", "p600", "cqemu-system-aarch64", "f6", "n127.0.0.1:5554"].join("\n");
const CWD = ["p100", "fcwd", "n/R/notes-app", "p200", "fcwd", "n/R/SurveyKit/functions",
  "p300", "fcwd", "n/Applications", "p400", "fcwd", "n/R/camview", "p500", "fcwd", "n/R/camview", "p600", "fcwd", "n/R/camview"].join("\n");
const SERVE = JSON.stringify({
  TCP: { 443: { HTTPS: true }, 8780: { HTTPS: true }, 8781: { HTTPS: true }, 8765: { TCPForward: "127.0.0.1:8765" } },
  Web: {
    "mac.tail.ts.net:8780": { Handlers: { "/": { Proxy: "http://127.0.0.1:5180" } } },
    "mac.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8477" } } },
    "mac.tail.ts.net:8781": { Handlers: { "/api": { Proxy: "http://127.0.0.1:9000" } } },
  },
});
const RUN = (p) => JSON.stringify([
  { metadata: { name: "shopfront", labels: {}, annotations: { "run.googleapis.com/ingress": "all" } }, status: { url: `https://shopfront-${p}.a.run.app` } },
  { metadata: { name: "api-stg", annotations: {} }, status: { url: `https://api-stg-${p}.a.run.app` } },
  { metadata: { name: "telemetry", labels: { "goog-managed-by": "cloudfunctions" } }, status: { url: `https://telemetry-${p}.a.run.app` } },
  { metadata: { name: "private", annotations: { "run.googleapis.com/ingress": "internal" } }, status: { url: `https://private-${p}.a.run.app` } },
  { metadata: { name: "broken" }, status: {} },
]);

test("lsof listen output: one row per pid and address, \\x20 decoded", () => {
  const rows = P.parseLsofListen(LSOF);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[1], { pid: 100, proc: "node", addr: "::1", port: 5180 });
  assert.equal(rows[3].proc, "Code Helper");
  assert.equal(P.parseLsofCwd(CWD).get(200), "/R/SurveyKit/functions");
});

test("repoOf: the deepest repo folder holding the path, by its folder name; outside every repo is none", () => {
  const repos = [{ name: "a", path: "/R/a" }, { name: "mono", path: "/R/watch/mono" }];
  assert.equal(P.repoOf("/R/a/b/c", repos), "a");
  assert.equal(P.repoOf("/R/a", repos), "a");
  assert.equal(P.repoOf("/R/watch/mono/apps/x", repos), "mono", "a repo one folder down keeps its own name");
  assert.equal(P.repoOf("/R/watch/other", repos), null, "the folder holding a repo is not one");
  assert.equal(P.repoOf("/R/ab", repos), null);
  assert.equal(P.repoOf("/Rx/a", repos), null);
});

test("serve status: the root handler's loopback target, :443 without a port, path handlers skipped", () => {
  const m = P.parseServeStatus(SERVE);
  assert.equal(m.get(5180), "https://mac.tail.ts.net:8780");
  assert.equal(m.get(8477), "https://mac.tail.ts.net");
  assert.equal(m.has(9000), false);
  assert.equal(P.parseServeStatus("not json").size, 0);
  assert.deepEqual([...P.servePortsInUse(SERVE)].sort(), [443, 8765, 8780, 8781]);
});

test("local found: repos only, front door first, tailnet bind next, else a serve command on a free port", () => {
  const rows = P.localFound({
    listeners: P.parseLsofListen(LSOF), cwd: P.parseLsofCwd(CWD), repos: ["notes-app", "SurveyKit", "camview", "ledger"].map((n) => ({ name: n, path: `/R/${n}` })), serve: P.parseServeStatus(SERVE),
    servePorts: P.servePortsInUse(SERVE), tailnetIp: "100.71.0.9", tailscale: "tailscale", selfPid: 999,
  });
  assert.deepEqual(rows.map((r) => r.key), ["local:5180", "local:5554", "local:8000", "local:8300", "local:61000"]);
  const [lh, emu, py, fb, eph] = rows;
  assert.equal(emu.hidden, true, "an emulator in a repo is not a page");
  assert.equal(lh.repo, "notes-app");
  assert.equal(lh.url, "https://mac.tail.ts.net:8780");
  assert.equal(lh.serveCmd, undefined);
  assert.equal(py.url, "http://100.71.0.9:8000", "bound to every interface: the tailnet address reaches it");
  assert.equal(fb.repo, "SurveyKit");
  assert.equal(fb.url, null);
  assert.equal(fb.serveCmd, "tailscale serve --bg --https=8782 http://127.0.0.1:8300", "8780 and 8781 are taken");
  assert.equal(eph.hidden, true);
  assert.equal(eph.serveCmd, undefined, "a hidden row takes no suggested port");
  assert.equal(emu.serveCmd, undefined);
});

test("a server in a session's scratch folder is its repo's, only behind a front door (R-onboarding-032)", () => {
  const scratch = (slug) => `/private/tmp/claude-501/${slug}/62d55cd4-6f38-40e4-8c76-618baf21c271/scratchpad/local`;
  const l = (port, pid) => ({ pid, proc: "node", port, addr: "127.0.0.1" });
  const rows = P.localFound({
    listeners: [l(5290, 1), l(5291, 2), l(5292, 3)],
    cwd: new Map([[1, scratch("-R-notes-app")], [2, scratch("-R-notes-app")], [3, scratch("-R-elsewhere")]]),
    repos: [{ name: "notes-app", path: "/R/notes-app" }], serve: new Map([[5290, "https://m:8781"], [5292, "https://m:8782"]]),
    servePorts: new Set(), tailnetIp: null, tailscale: "tailscale", selfPid: 999,
  });
  assert.deepEqual(rows.map((r) => [r.port, r.repo, r.url]), [[5290, "notes-app", "https://m:8781"]]);
  assert.match(rows[0].note, /scratch folder/);
  const twins = [{ name: "a-b", path: "/R/a-b" }, { name: "a.b", path: "/R/a.b" }];
  assert.equal(P.scratchRepoOf(scratch("-R-a-b"), twins), null, "two repos with one spelling: no repo, never a guess");
});

test("Cloud Run: functions and internal ingress are found but hidden, -stg guessed staging, no URL skipped", () => {
  const rows = P.parseRunServices(RUN("x"), "proj-1");
  assert.deepEqual(rows.map((r) => [r.label, r.kind, r.hidden, r.env]), [
    ["shopfront", "cloudrun", false, "prod"], ["api-stg", "cloudrun", false, "staging"],
    ["telemetry", "function", true, "prod"], ["private", "cloudrun", true, "prod"],
  ]);
  assert.equal(P.parseRunServices("[{", "p").length, 0);
});

test("hosting sites and project → repo: most mentions wins, a tie is no repo", () => {
  const sites = P.parseHostingSites(JSON.stringify({ sites: [{ name: "projects/p/sites/my-site", defaultUrl: "https://my-site.web.app" }, { name: "x" }] }), "p");
  assert.deepEqual(sites.map((s) => s.url), ["https://my-site.web.app"]);
  const m = P.assignProjects(new Map([["a", "p1\np1\np2\n"], ["b", "p1\np2\n"]]), ["p1", "p2", "p3"]);
  assert.equal(m.get("p1"), "a");
  assert.equal(m.get("p2"), null);
  assert.equal(m.get("p3"), null);
});

function fixture({ pins } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wp-links-")));
  const root = join(base, "dev"), file = join(base, "cfg", "links.json");
  for (const repo of ["notes-app", "SurveyKit", "camview", "shopfront", "other"]) mkdirSync(join(root, repo, ".git"), { recursive: true });
  mkdirSync(join(root, "watch", "mono", ".git"), { recursive: true });
  writeFileSync(join(root, "shopfront", ".firebaserc"), JSON.stringify({ projects: { default: "shop-prod" } }));
  if (pins !== undefined) { mkdirSync(join(base, "cfg"), { recursive: true }); writeFileSync(file, pins); }
  const lsof = LSOF.replaceAll("/R/", `${root}/`), cwd = CWD.replaceAll("/R/", `${root}/`);
  const calls = [];
  const runner = async (bin, argv, o) => {
    calls.push([bin, ...argv].join(" "));
    const ok = (stdout) => ({ code: 0, stdout, stderr: "", timedOut: false });
    if (bin === "lsof" && argv.includes("-sTCP:LISTEN")) return ok(lsof);
    if (bin === "lsof") return ok(cwd.replaceAll("/R/", `${root}/`));
    if (bin === "ts" && argv[0] === "serve") return ok(SERVE);
    if (bin === "ts" && argv[0] === "ip") return ok("100.71.0.9\n");
    if (bin === "gcloud" && argv[0] === "projects") return ok("shop-prod\nother-proj\n");
    if (bin === "gcloud" && argv[0] === "auth") return ok("tok\n");
    if (bin === "gcloud" && argv[0] === "run") {
      const p = argv.find((a) => a.startsWith("--project=")).slice(10);
      return p === "other-proj" ? { code: 1, stdout: "", stderr: "API [run.googleapis.com] not enabled on project", timedOut: false } : ok(RUN(p));
    }
    if (bin === "git") return ok(o.cwd ?? (argv[1].endsWith("/other") ? "other-proj\nother-proj\nother-site\n" : argv[1].endsWith("/watch/mono") ? "app-two\napp-two\nother-proj\n" : ""));
    return { code: 127, stdout: "", stderr: "", timedOut: false, error: "ENOENT" };
  };
  const fetched = [];
  const fakeFetch = async (url, init) => {
    fetched.push([init?.method ?? "GET", String(url)]);
    if (String(url).includes("firebasehosting")) {
      return String(url).includes("other-proj")
        ? new Response(JSON.stringify({ sites: ["other-proj", "other-site", "app-two", "lonely"].map((id) => ({ name: `projects/other-proj/sites/${id}`, defaultUrl: `https://${id}.web.app` })) }), { status: 200 })
        : new Response("{}", { status: 403 });
    }
    if (String(url).includes("api-stg")) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response(null, { status: init?.method === "HEAD" && String(url).includes("8780") ? 405 : 200 });
  };
  let pushes = 0;
  const engine = createEngine({
    root, file, lsofBin: "lsof", tailscaleBin: "ts", gcloudBin: "gcloud", gitBin: "git", run: runner, fetch: fakeFetch,
    cloudFile: join(base, "cfg", "links-cloud.json"), signInFile: join(base, "cfg", "links-signin.json"), scanCli: "cli.mjs", lookCwd: base,
    now: () => Date.now(), selfPid: 999, probeTimeoutMs: 2000,
  }, () => { pushes++; });
  return { root, file, engine, calls, fetched, pushes: () => pushes };
}

test("discover → pin a local and a cloud row → probe; repo from .firebaserc and from mentions", async () => {
  const fx = fixture();
  await fx.engine.discover({});
  await fx.engine.idle();
  let s = await fx.engine.state();
  assert.ok(fx.pushes() >= 2, "each half pushes `changed` when it finishes");
  assert.ok(s.localAt && s.cloudAt);
  const rec = s.found.find((f) => f.key === "run:shop-prod/shopfront");
  assert.equal(rec.repo, "shopfront", ".firebaserc names it");
  const fb = (id) => s.found.find((f) => f.key === `fb:${id}`).repo;
  assert.equal(fb("other-proj"), "other", "the default site goes with its project: the repo that mentions it most");
  assert.equal(fb("other-site"), "other", "a named site: the repo that mentions the site");
  assert.equal(fb("app-two"), "mono", "one project, many apps: a site follows its own mentions, in a repo one folder down");
  assert.equal(fb("lonely"), null, "a site no repo mentions has no repo, not its project's");
  assert.equal(s.notes.length, 0, "a project without Cloud Run is not a problem worth a sentence");

  s = await fx.engine.pin("local:5180");
  s = await fx.engine.pin("local:5180");
  assert.equal(s.pinned.length, 1, "pinning the same found row twice is one pin");
  s = await fx.engine.pin("run:shop-prod/shopfront");
  s = await fx.engine.pin("run:shop-prod/api-stg");
  const saved = JSON.parse(readFileSync(fx.file, "utf8")).links;
  assert.equal(saved[0].port, 5180);
  assert.equal(saved[0].url, undefined, "a local pin keeps its port, not today's URL");
  assert.equal(saved[1].url, "https://shopfront-shop-prod.a.run.app");

  s = await fx.engine.probe();
  const by = Object.fromEntries(s.pinned.map((p) => [p.label, p]));
  assert.equal(by["notes-app :5180"].openUrl, "https://mac.tail.ts.net:8780");
  assert.equal(by["notes-app :5180"].probe.state, "up", "405 on HEAD retries with GET");
  assert.deepEqual(fx.fetched.filter(([, u]) => u.includes("8780")).map(([m]) => m), ["HEAD", "GET"]);
  assert.equal(by["shopfront"].probe.state, "up");
  assert.equal(by["api-stg"].probe.state, "down");
  assert.equal(by["api-stg"].probe.error, "ECONNREFUSED");
  assert.equal(by["api-stg"].env, "staging");
});

test("served handlers: state, pin of an unknown key, add, edit, unpin — refusals in words", async () => {
  const fx = fixture();
  const handlers = new Map();
  serve({ handle: (m, fn) => { handlers.set(m, fn); return () => handlers.delete(m); }, push() {} }, fx.engine);
  await assert.rejects(handlers.get("pin")({ key: "local:1" }), /not in the last discovery/);
  await assert.rejects(handlers.get("add")({ label: "x", url: "javascript:alert(1)" }), /http/);
  await assert.rejects(handlers.get("add")({ label: " ", url: "https://x" }), /name/);
  let s = await handlers.get("add")({ label: "Console", url: "https://console.cloud.google.com", repo: "../etc" });
  assert.equal(s.pinned[0].repo, null, "a repo that is not a folder name is dropped");
  assert.equal(s.pinned[0].env, "prod");
  const id = s.pinned[0].id;
  s = await handlers.get("edit")({ id, env: "staging", repo: "camview", label: "GCP" });
  assert.deepEqual([s.pinned[0].label, s.pinned[0].env, s.pinned[0].repo], ["GCP", "staging", "camview"]);
  await assert.rejects(handlers.get("edit")({ id, env: "qa" }), /dev, staging or prod/);
  await assert.rejects(handlers.get("edit")({ id: "../x" }), /not a pin id/);
  s = await handlers.get("unpin")({ id });
  assert.equal(s.pinned.length, 0);
});

test("a pins file with a bad row is shown without it and never written over", async () => {
  const text = JSON.stringify({ links: [{ id: "p:0123456789ab", label: "ok", url: "https://ok.example", env: "prod" }, { id: "nope", label: "hand-typed" }] });
  const fx = fixture({ pins: text });
  const s = await fx.engine.state();
  assert.equal(s.pinned.length, 1);
  assert.match(s.notes[0], /did not read as a link/);
  await assert.rejects(fx.engine.add({ label: "x", url: "https://x" }), /fixed by hand/);
  assert.equal(readFileSync(fx.file, "utf8"), text, "the hand-typed row survives");

  const fx2 = fixture({ pins: "{ not json" });
  assert.match((await fx2.engine.state()).notes[0], /not JSON/);
  await assert.rejects(fx2.engine.unpin("p:0123456789ab"), /not JSON/);
  assert.equal(readFileSync(fx2.file, "utf8"), "{ not json");
});

test("a local pin whose port went quiet keeps its front door and says nothing listens", async () => {
  const fx = fixture({ pins: JSON.stringify({ links: [{ id: "p:aaaaaaaaaaaa", label: "lh", port: 5180, env: "dev", repo: "notes-app" }, { id: "p:bbbbbbbbbbbb", label: "gone", port: 4444, env: "dev", repo: null }] }) });
  let s = await fx.engine.state();
  assert.equal(s.pinned[0].why, "not looked up yet");
  await fx.engine.discover({});
  await fx.engine.idle();
  s = await fx.engine.state();
  assert.equal(s.pinned[0].listening, true);
  assert.equal(s.pinned[1].listening, false);
  assert.equal(s.pinned[1].openUrl, null);
  assert.match(s.pinned[1].why, /nothing listens on :4444/);
});

test("a desktop without tailscale or gcloud: empty sections and a sentence each, never an error", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wp-links-bare-")));
  const root = join(base, "dev");
  mkdirSync(join(root, "notes-app", ".git"), { recursive: true });
  const calls = [];
  const runner = async (bin, argv) => {
    calls.push(bin);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const engine = createEngine({
    root, file: join(base, "cfg", "links.json"), lsofBin: "lsof", tailscaleBin: null, gcloudBin: null, gitBin: "git",
    cloudFile: join(base, "cfg", "links-cloud.json"), signInFile: join(base, "cfg", "links-signin.json"), scanCli: "cli.mjs", lookCwd: base,
    run: runner, fetch: async () => { throw new Error("no network in this test"); }, now: () => Date.now(), selfPid: 999, probeTimeoutMs: 2000,
  }, () => {});
  await engine.discover({});
  await engine.idle();
  const s = await engine.state();
  assert.deepEqual(s.found, [], "nothing found is an empty list");
  assert.ok(s.localAt && s.cloudAt, "both halves finish");
  assert.ok(s.notes.some((n) => /No tailscale command/.test(n)), "the missing tailscale is said");
  assert.ok(s.notes.some((n) => /No gcloud command/.test(n)), "the missing gcloud is said");
  assert.ok(!calls.includes("gcloud") && !calls.includes("tailscale"), "a missing command is never run");
});

const SIGNED_OUT = "ERROR: (gcloud.projects.list) Your current active account [a@x.test] does not have any valid credentials\n";
const CMD = JSON.stringify({ name: "the keychain", run: ["keytool", "exec", "--", "x"] });
/** A desktop whose gcloud fails with `stderr`, and whose sign-in file holds `file` (null = none). */
function signInFixture({ stderr = SIGNED_OUT, file = CMD, exec, base = realpathSync(mkdtempSync(join(tmpdir(), "wp-links-signin-"))) } = {}) {
  const root = join(base, "dev"), cfg = join(base, "cfg");
  mkdirSync(join(root, "shopfront", ".git"), { recursive: true });
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(root, "shopfront", ".firebaserc"), JSON.stringify({ projects: { default: "shop-prod" } }));
  if (file !== null) writeFileSync(join(cfg, "links-signin.json"), file);
  const calls = [];
  const runner = async (bin, argv, o) => {
    calls.push({ bin, argv, o });
    if (bin === "gcloud") return { code: 1, stdout: "", stderr, timedOut: false };
    if (bin === "keytool") return exec();
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const engine = createEngine({
    root, file: join(cfg, "links.json"), cloudFile: join(cfg, "links-cloud.json"), signInFile: join(cfg, "links-signin.json"), lsofBin: "lsof", tailscaleBin: null, gcloudBin: "gcloud", gitBin: "git",
    scanCli: "cli.mjs", lookCwd: base, run: runner, fetch: async () => { throw new Error("no network in this test"); }, now: () => Date.now(), selfPid: 999, probeTimeoutMs: 2000,
  }, () => {});
  return { base, engine, execs: () => calls.filter((c) => c.bin === "keytool") };
}
const LOOK = { projects: ["shop-prod"], rows: [{ key: "run:shop-prod/web", kind: "cloudrun", repo: null, label: "web", url: "https://web.a.run.app", project: "shop-prod", env: "prod", hidden: false }], notes: [], failed: null };
const looked = () => ({ code: 0, stdout: `${JSON.stringify(LOOK)}\n`, stderr: "", timedOut: false });

test("R-navigation-024: gcloud signed out, a sign-in command named: offered, run only by a tap, kept past a restart", async () => {
  const fx = signInFixture({ exec: looked });
  await fx.engine.discover({ cloud: true });
  await fx.engine.idle();
  let s = await fx.engine.state();
  assert.deepEqual(s.signIn, { name: "the keychain", looking: false });
  assert.equal(s.cloudAt, null, "a look that could not sign in is not a look");
  assert.ok(!s.notes.some((n) => /gcloud/.test(n)), "the offer stands in for gcloud's error");
  assert.equal(fx.execs().length, 0, "opening or refreshing never runs the command");

  assert.equal((await fx.engine.lookSignIn()).signIn.looking, true);
  await fx.engine.lookSignIn();
  await fx.engine.idle();
  assert.equal(fx.execs().length, 1, "a second tap while it looks is the same look");
  s = await fx.engine.state();
  assert.equal(s.found.find((f) => f.key === "run:shop-prod/web").repo, "shopfront");
  const { argv, o } = fx.execs()[0];
  assert.deepEqual(argv, ["exec", "--", "x", process.execPath, "cli.mjs", "gcloud"]);
  assert.ok("TMUX_PANE" in o.env && o.env.TMUX_PANE === undefined, "no session is named as the asker");

  const again = signInFixture({ base: fx.base });
  await again.engine.discover({ cloud: true });
  await again.engine.idle();
  const s2 = await again.engine.state();
  assert.equal(s2.cloudAt, s.cloudAt, "a restart keeps the look and its age, and a failing gcloud does not wipe it");
  assert.equal(s2.found.length, 1);
});

test("a refusal is said, and what was found stays", async () => {
  let exec = looked;
  const fx = signInFixture({ exec: () => exec() });
  await fx.engine.discover({});
  await fx.engine.idle();
  await fx.engine.lookSignIn();
  await fx.engine.idle();
  exec = () => ({ code: 77, stdout: "", stderr: "denied on the phone\n", timedOut: false });
  await fx.engine.lookSignIn();
  await fx.engine.idle();
  const s = await fx.engine.state();
  assert.equal(s.found.length, 1);
  assert.ok(s.notes.some((n) => /the keychain: denied on the phone/.test(n)));
});

test("no offer without a reason for one: no file, a broken file, or gcloud failing for another reason", async () => {
  for (const [o, said] of [[{ file: null }, /gcloud did not list projects/], [{ file: "{" }, /needs "name" and "run"/], [{ stderr: "ERROR: network is unreachable\n" }, /gcloud did not list projects/]]) {
    const fx = signInFixture(o);
    await fx.engine.discover({});
    await fx.engine.idle();
    const s = await fx.engine.state();
    assert.equal(s.signIn, undefined);
    assert.ok(s.notes.some((n) => said.test(n)));
    await assert.rejects(fx.engine.lookSignIn());
  }
});

test("a handed-in token reaches gcloud by environment only", async () => {
  const seen = [];
  const run = async (bin, argv, o) => { seen.push({ argv, env: o.env }); return { code: 0, stdout: argv[0] === "projects" ? "shop-prod\n" : "[]", stderr: "", timedOut: false }; };
  const auth = [];
  await scanCloud({ run, gcloudBin: "gcloud", fetch: async (_u, i) => { auth.push(i.headers.authorization); return new Response("{}"); } }, "tok-x");
  assert.ok(seen.every((c) => c.env.CLOUDSDK_AUTH_ACCESS_TOKEN === "tok-x" && !c.argv.join(" ").includes("tok-x")));
  assert.deepEqual(auth, ["Bearer tok-x"]);
});
