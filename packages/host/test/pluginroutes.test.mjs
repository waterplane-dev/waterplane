/**
 * A plugin's own HTTP routes (`api.route`, plugin API 1.2): served at
 * `/api/plugin/<id>/<pattern>` through `handleApi` — so behind the same gates
 * as every core route — matched like a core route, JSON in and out, refused in
 * words at registration, gone with the plugin. docs/notes/plugins.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { handleApi } = await import("../dist/api.js");
const { PLUGIN_API_VERSION } = await import("@waterplane/shared");

const HOST = `
export function activate(api) {
  api.route("GET", "status", (req) => ({ body: { ok: true, query: req.query } }));
  api.route("POST", "items/:id", (req) => ({ status: 201, body: { id: req.params.id, body: req.body } }));
  api.route("GET", "files/*", (req) => ({ body: { rest: req.rest } }));
  api.route("GET", "boom", () => { throw new Error("kaput"); });
  const refused = [];
  for (const [m, p] of [["GET", "hook"], ["GET", "status"], ["PATCH", "x"], ["GET", "../x"], ["GET", ""], ["GET", ":id"], ["GET", "a/*/b"]]) {
    try { api.route(m, p, () => ({})); } catch (e) { refused.push(String(e.message)); }
  }
  api.route("GET", "refused", () => ({ body: { refused } }));
}`;

async function setup() {
  const cfg = mkdtempSync(join(tmpdir(), "wp-plugroutes-cfg-"));
  const root = mkdtempSync(join(tmpdir(), "wp-plugroutes-root-"));
  const dir = join(cfg, "plugins", "echo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "waterplane-plugin.json"), JSON.stringify({ id: "echo", name: "Echo", version: "1.0.0", apiVersion: PLUGIN_API_VERSION }));
  writeFileSync(join(dir, "host.mjs"), HOST);
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: { list: () => [], get: () => null, isWatched: () => false },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
  });
  await reg.loadAll();
  const ctx = {
    root,
    pluginHook: (id, p) => reg.hook(id, p),
    pluginRoute: (id, m, parts) => reg.route(id, m, parts),
  };
  const server = createServer((req, res) => { handleApi(req, res, ctx).catch(() => { res.statusCode = 500; res.end("threw"); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const call = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  };
  return { reg, call, close: () => server.close() };
}

test("a plugin route answers at /api/plugin/<id>/<pattern>, JSON in and out", async () => {
  const { call, close } = await setup();
  try {
    assert.deepEqual(await call("GET", "/api/plugin/echo/status?a=1&a=2&b=x"), { status: 200, json: { ok: true, query: { a: "1", b: "x" } }, text: '{"ok":true,"query":{"a":"1","b":"x"}}' });
    const post = await call("POST", "/api/plugin/echo/items/x%2Fy", { n: 1 });
    assert.equal(post.status, 201);
    assert.deepEqual(post.json, { id: "x%2Fy", body: { n: 1 } }, "params are raw, the body parsed");
    assert.deepEqual((await call("POST", "/api/plugin/echo/items/z", "{not json")).json, { id: "z", body: {} });
    assert.deepEqual((await call("GET", "/api/plugin/echo/files/a/b")).json, { rest: ["a", "b"] });
    assert.deepEqual((await call("GET", "/api/plugin/echo/files")).json, { rest: [] });
  } finally { close(); }
});

test("nothing served there is the core's plain 404; a throw is a 500 in words", async () => {
  const { call, close } = await setup();
  try {
    for (const [m, p] of [["GET", "/api/plugin/echo/nope"], ["DELETE", "/api/plugin/echo/status"], ["GET", "/api/plugin/ghost/status"], ["GET", "/api/plugin/echo"], ["GET", "/api/plugin/Echo/status"]]) {
      assert.deepEqual(await call(m, p), { status: 404, json: { error: "not found" }, text: '{"error":"not found"}' }, `${m} ${p}`);
    }
    const boom = await call("GET", "/api/plugin/echo/boom");
    assert.equal(boom.status, 500);
    assert.deepEqual(boom.json, { ok: false, error: "kaput" });
    // The hook sink is still the hook sink: this plugin takes no hooks.
    const hook = await call("POST", "/api/plugin/echo/hook", {});
    assert.equal(hook.status, 404);
    assert.match(hook.json.error, /takes no hooks/);
  } finally { close(); }
});

test("api.route refuses in words: the hook sink's name, a duplicate, a verb, a malformed pattern", async () => {
  const { call, close } = await setup();
  try {
    const { refused } = (await call("GET", "/api/plugin/echo/refused")).json;
    assert.equal(refused.length, 7, refused.join("\n"));
    assert.match(refused[0], /other than "hook"/);
    assert.match(refused[1], /already serves GET status/);
    assert.match(refused[2], /answers GET, POST, PUT, DELETE, not "PATCH"/);
    assert.match(refused[3], /"\.\." is not a literal segment/);
    assert.match(refused[4], /needs a pattern/);
    assert.match(refused[5], /must start with a literal/);
    assert.match(refused[6], /"\*" is not a literal segment/);
  } finally { close(); }
});

test("a switched-off plugin serves nothing", async () => {
  const { reg, call, close } = await setup();
  try {
    assert.equal((await call("GET", "/api/plugin/echo/status")).status, 200);
    assert.equal(await reg.setEnabled("echo", false), null);
    assert.equal((await call("GET", "/api/plugin/echo/status")).status, 404);
  } finally { close(); }
});
