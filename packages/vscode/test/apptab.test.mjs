// R-integrations-007. The app tab (`src/apptab.ts`): loopback only and never on a remote, framed only when a waterplane
// host answers, and the one message the framed app may send — a link, and nothing that is not a link.
import { test } from "node:test";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import { SRC, data } from "./helpers.mjs";

const BASE = "http://127.0.0.1:8770";
const URL_OK = "https://example.com/a?b=1";
const HEALTH = { ok: true, protocol: 2, root: "/Users/x/dev" };

test("openableUrl: http(s) only, no sign-in in it, nothing invisible, not endless", () => {
  assert.equal(data.openableUrl(URL_OK), URL_OK);
  assert.equal(data.openableUrl("http://127.0.0.1:5173/"), "http://127.0.0.1:5173/");
  // A sign-in link's encoded redirect must survive as it is.
  const oauth = "https://example.com/o?redirect_uri=https%3A%2F%2Fy%2F%3Fa%3D1%26b%3D2";
  assert.equal(data.openableUrl(oauth), oauth);
  for (const bad of [
    "javascript:alert(1)", "file:///etc/passwd", "vscode://x/y", "command:workbench.action.quit", "data:text/html,x", "mailto:a@example.com",
    "https://user:pw@example.com/", "https://user@example.com/", "example.com", "", " ", "https://",
    "https://example.com/\nx", "https://example.com/\tx", "java\nscript:alert(1)", "\u0000https://example.com", "https://example.com/\u007f", "https://example.com/\u0085",
    null, undefined, 7, {}, ["https://example.com"],
  ]) assert.equal(data.openableUrl(bad), null, JSON.stringify(bad));
  const at = (n) => "https://example.com/".padEnd(n, "a");
  assert.ok(data.openableUrl(at(2048)));
  assert.equal(data.openableUrl(at(2049)), null);
  assert.equal(data.openableUrl("https://example.com/" + "é".repeat(1000)), null, "too long once it is encoded");
});

test("openMessage: exactly { op: open, url }", () => {
  assert.equal(data.openMessage({ op: "open", url: URL_OK }), URL_OK);
  for (const bad of [
    null, "open", [], {}, { op: "open" }, { url: URL_OK }, { op: "close", url: URL_OK }, { op: "open", url: "file:///x" },
    { op: "open", url: URL_OK, extra: 1 }, { shell: "vscode", v: 1, op: "open", url: URL_OK },
  ]) assert.equal(data.openMessage(bad), null, JSON.stringify(bad));
});

test("stopMessage: only a button the page drew", () => {
  assert.equal(data.stopMessage({ op: "check" }, ["check", "install"]), "check");
  assert.equal(data.stopMessage({ op: "browser" }, ["check", "install"]), null);
  for (const bad of [null, "check", {}, { op: "check", url: "x" }, { op: undefined }]) assert.equal(data.stopMessage(bad, ["check"]), null);
});

test("OpenGate: one open per 500 ms, the rest dropped", () => {
  const g = new data.OpenGate();
  assert.deepEqual([0, 100, 499, 500, 900, 1000].map((t) => g.allow(t)), [true, false, false, true, false, true]);
});

test("remoteRefusal: any remote, or VS Code in a browser; never a plain local window", () => {
  assert.equal(data.remoteRefusal(undefined, false), null);
  for (const name of ["ssh-remote", "wsl", "dev-container", "codespaces"]) {
    assert.match(data.remoteRefusal(name, false), /shared with everyone who has an account/);
    assert.ok(data.remoteRefusal(name, false).includes(name));
  }
  assert.match(data.remoteRefusal(undefined, true), /not opened from here/);
});

test("the tab refuses a remote before it reads the setting or opens a socket", () => {
  const src = readFileSync(join(SRC, "apppanel.ts"), "utf8");
  const check = src.slice(src.indexOf("private async check()"), src.indexOf("private stop("));
  const refuse = check.indexOf("this.stop(no");
  assert.ok(refuse > 0 && refuse < check.indexOf("appBase(") && refuse < check.indexOf("probeHost("));
  assert.match(check, /if \(no\) \{[^}]*return; \}/);
});

test("appBase: the default when unset, the setting when loopback, its sentence when not", () => {
  assert.deepEqual(data.appBase(""), { base: BASE });
  assert.deepEqual(data.appBase(" http://localhost:9000/x "), { base: "http://localhost:9000" });
  assert.match(data.appBase("http://100.64.0.10:8770").off, /only this machine/);
  assert.equal(data.appBase("http://100.64.0.10:8770").off, data.desktopBase("http://100.64.0.10:8770").off);
  assert.match(data.appBase("http://[::1]:9000").off, /http:\/\/127\.0\.0\.1:9000/, "a CSP source cannot name an IPv6 literal");
});

test("isHostHealth: what every host version answers, and nothing else's health page", () => {
  assert.ok(data.isHostHealth(HEALTH));
  assert.ok(data.isHostHealth({ ...HEALTH, version: "0.1.36", ptys: 3 }));
  for (const bad of [null, "ok", [], {}, { ok: true }, { status: "ok" }, { ...HEALTH, ok: false }, { ...HEALTH, protocol: "2" }, { ok: true, protocol: 2 }]) {
    assert.equal(data.isHostHealth(bad), false, JSON.stringify(bad));
  }
});

test("probeHost: one GET of /api/health; no answer, another server, a redirect and a slow one are sentences", async (t) => {
  let mode = "ok";
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (mode === "slow") return;
    if (mode === "redirect") { res.writeHead(302, { location: "/elsewhere" }); res.end(); return; }
    if (mode === "html") { res.setHeader("content-type", "text/html"); res.end("<p>hi"); return; }
    if (mode === "500") { res.statusCode = 500; res.end(JSON.stringify(HEALTH)); return; }
    res.end(JSON.stringify(mode === "ok" ? HEALTH : { status: "up" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}`;

  assert.deepEqual(await data.probeHost(base), { ok: true });
  assert.deepEqual(seen, ["GET /api/health"]);
  for (mode of ["json", "html", "500", "redirect"]) {
    const r = await data.probeHost(base);
    assert.equal(r.ok, false, mode);
    assert.equal(r.answered, true, mode);
    assert.match(r.why, /is not a waterplane desktop/);
  }
  assert.ok(!seen.some((s) => s.includes("elsewhere")), "a redirect is never followed");
  mode = "slow";
  const slow = await data.probeHost(base, 300);
  assert.equal(slow.answered, false);
  assert.match(slow.why, /did not answer/);

  const dead = createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const gone = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((r) => dead.close(r));
  const none = await data.probeHost(gone);
  assert.equal(none.answered, false);
  assert.ok(none.why.includes(gone));
});

test("appHtml: a closed CSP, one frame of the origin, no padding, only clipboard-write", () => {
  const html = data.appHtml(`${BASE}/some/path?x=1`, "n0nce");
  const csp = html.match(/Content-Security-Policy" content="([^"]*)"/)[1].replaceAll("&#39;", "'");
  assert.equal(csp, "default-src 'none'; frame-src http://127.0.0.1:8770; style-src 'nonce-n0nce'; script-src 'nonce-n0nce'");
  assert.equal(html.match(/<iframe/g).length, 1);
  assert.match(html, /src="http:\/\/127\.0\.0\.1:8770\/" allow="clipboard-write"><\/iframe>/);
  assert.match(html, /html,body\{margin:0;padding:0;[^}]*overflow:hidden\}/);
  assert.ok(!/ style="| on[a-z]+="/.test(html), "nothing inline that the CSP would drop");
});

test("only a parsed origin reaches either page, and a sentence is escaped", () => {
  const html = data.appHtml(`${BASE}/"><script>alert(1)</script>`, "n");
  assert.ok(!html.includes("alert(1)"));
  assert.throws(() => data.appHtml("\"><script>", "n"));
  assert.ok(!data.bridgeScript("</script><b>").includes("</script>"));

  const stop = data.stopHtml("<b>\"x\" & 'y'</b>", ["check", "install"], "n");
  assert.ok(!stop.includes("<b>"));
  assert.ok(stop.includes("&#60;b&#62;&#34;x&#34; &#38; &#39;y&#39;"));
  assert.match(stop, /Content-Security-Policy" content="default-src &#39;none&#39;;/);
  assert.ok(!stop.includes("frame-src"));
  assert.deepEqual([...stop.matchAll(/data-op="([a-z]+)"/g)].map((m) => m[1]), ["check", "install"]);
  assert.ok(!/disabled/.test(stop));
  assert.ok(!data.stopHtml("Looking", [], "n").includes("<script"), "nothing to tap, no script");
});

test("the page's script takes the one message from its own frame and origin only", () => {
  const sent = [];
  let on;
  const frame = { contentWindow: { name: "the app" } };
  vm.runInNewContext(data.bridgeScript(BASE), {
    acquireVsCodeApi: () => ({ postMessage: (m) => sent.push(m) }),
    document: { getElementById: (id) => (id === "app" ? frame : null) },
    window: { addEventListener: (type, fn) => { assert.equal(type, "message"); on = fn; } },
  });
  const ok = { shell: "vscode", v: 1, op: "open", url: URL_OK };
  const from = { source: frame.contentWindow, origin: BASE };
  for (const e of [
    { ...from, source: {}, data: ok }, { ...from, origin: "http://127.0.0.1:9999", data: ok }, { ...from, origin: "null", data: ok },
    { ...from, data: null }, { ...from, data: "open" }, { ...from, data: { ...ok, v: 2 } }, { ...from, data: { ...ok, op: "copy" } },
    { ...from, data: { ...ok, shell: "x" } }, { ...from, data: { ...ok, url: 7 } }, { ...from, data: { ...ok, more: 1 } },
    { ...from, data: { op: "open", url: URL_OK } },
  ]) on(e);
  assert.deepEqual(sent, []);
  on({ ...from, data: ok });
  assert.equal(JSON.stringify(sent), JSON.stringify([{ op: "open", url: URL_OK }]));
});

test("package.json: both commands, and the browser one only while the app tab has something to open", () => {
  const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));
  const ids = pkg.contributes.commands.map((c) => c.command);
  assert.ok(ids.includes("waterplane.openApp") && ids.includes("waterplane.openAppInBrowser"));
  const { menus } = pkg.contributes;
  // The way out of a frame that stayed blank, only while the tab is the active one.
  for (const menu of ["editor/title", "commandPalette"]) {
    assert.match(menus[menu].find((x) => x.command === "waterplane.reloadApp").when, /activeWebviewPanelId == 'waterplane.app'/);
  }
  // A workspace's own settings never choose which local port the tab frames.
  assert.equal(pkg.contributes.configuration.properties["waterplane.desktopUrl"].scope, "machine");
  // Its way in is the tree's first row (below), once: not also an icon in the view's title.
  assert.ok(!menus["view/title"].some((m) => m.command === "waterplane.openApp"));
  for (const menu of ["editor/title", "commandPalette"]) {
    const m = menus[menu].find((x) => x.command === "waterplane.openAppInBrowser");
    assert.match(m.when, /activeWebviewPanelId == 'waterplane\.app'/);
  }
});

test("the tree's first row opens the app, live or idle (R-integrations-008)", async () => {
  const VSCODE = `
    class EventEmitter { event = () => {}; fire() {} dispose() {} }
    class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
    class ThemeIcon { constructor(id) { this.id = id; } }
    const off = () => ({ dispose() {} });
    const window = { createTreeView: () => ({ visible: false, onDidCollapseElement: off, onDidExpandElement: off, onDidChangeVisibility: off, dispose() {} }) };
    module.exports = { EventEmitter, TreeItem, ThemeIcon, window, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 } };`;
  const stub = { name: "vscode-stub", setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: VSCODE, loader: "js" }));
  } };
  const out = await build({ entryPoints: [join(SRC, "navtree.ts")], bundle: true, write: false, format: "cjs", platform: "node", plugins: [stub], logLevel: "silent" });
  const mod = { exports: {} };
  vm.runInThisContext(`(function (module, exports, require) {${out.outputFiles[0].text}\n})`)(mod, mod.exports, createRequire(import.meta.url));
  for (const live of [true, false]) {
    const tree = new mod.exports.NavTree(() => ({ folders: [], live }), () => {}, { get: () => undefined, update: async () => {} });
    const [first, ...rest] = tree.getChildren();
    const item = tree.getTreeItem(first);
    assert.equal(item.label, "Open waterplane");
    assert.equal(item.command.command, "waterplane.openApp");
    assert.ok(rest.every((n) => n.kind !== "app"));
    tree.dispose();
  }
});
