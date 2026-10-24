// `manifest.assets` (`plugins/pluginassets.ts`): a flat name resolved by realpath inside the
// extension's assets folder, else a refusal in words; MIME by extension; the manifest field's shape.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveAsset, assetMime } = await import("../dist/plugins/pluginassets.js");
const { manifestProblems } = await import("@waterplane/shared");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wp-assets-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "core.wasm"), Buffer.alloc(10, 1));
  writeFileSync(join(dir, "secret.txt"), "no");
  symlinkSync(join(dir, "secret.txt"), join(dir, "assets", "link.txt"));
  return dir;
}

test("a flat file inside the assets folder resolves, with size and MIME", () => {
  const dir = fixture();
  const r = resolveAsset("OCR", dir, "assets", "core.wasm");
  assert.equal(r.ok, true);
  assert.equal(r.size, 10);
  assert.equal(r.mime, "application/wasm");
});

test("traversal, a slash, a dot-name, a symlink out, a missing file and no `assets` are 404 in words", () => {
  const dir = fixture();
  for (const n of ["../secret.txt", "..%2Fsecret.txt", "a/b", ".hidden", "link.txt", "nope.bin", "assets", ""]) {
    const r = resolveAsset("OCR", dir, "assets", n);
    assert.equal(r.ok, false, n);
    assert.equal(r.status, 404, n);
    assert.match(r.error, /OCR/);
  }
  assert.equal(resolveAsset("OCR", dir, undefined, "core.wasm").status, 404);
  assert.equal(resolveAsset("OCR", dir, "../x", "core.wasm").status, 404);
  assert.equal(resolveAsset("OCR", dir, "/etc", "passwd").status, 404);
});

test("MIME map", () => {
  assert.equal(assetMime("a.js"), "text/javascript");
  assert.equal(assetMime("a.traineddata.gz"), "application/gzip");
  assert.equal(assetMime("m.json"), "application/json");
  assert.equal(assetMime("a.bin"), "application/octet-stream");
});

test("the manifest's assets field must be a relative folder inside the extension", () => {
  const base = { id: "ocr", name: "OCR", version: "1.0.0", apiVersion: "2.0", description: "d" };
  const problems = (assets) => manifestProblems({ ...base, assets }).filter((p) => /assets/.test(p));
  assert.deepEqual(problems("assets"), []);
  assert.equal(problems("../x").length, 1);
  assert.equal(problems("/etc").length, 1);
  assert.equal(problems(3).length, 1);
});

// The route itself, through `handleApi` and a real registry: served while on, 403 in words once
// the person switched the plugin off (never the bytes), 404 in words for an unknown plugin.
test("GET /api/plugin/<id>/asset/<file>: served while on, 403 '<name> is turned off' once off", async () => {
  const { createServer } = await import("node:http");
  const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
  const { handleApi } = await import("../dist/api.js");
  const { PLUGIN_API_VERSION } = await import("@waterplane/shared");
  const cfg = mkdtempSync(join(tmpdir(), "wp-assets-cfg-"));
  const root = mkdtempSync(join(tmpdir(), "wp-assets-root-"));
  const dir = join(cfg, "plugins", "reader");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "waterplane-plugin.json"), JSON.stringify({ id: "reader", name: "Reader", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, assets: "assets" }));
  writeFileSync(join(dir, "host.mjs"), "export function activate() {}");
  writeFileSync(join(dir, "assets", "core.wasm"), Buffer.alloc(10, 7));
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: { list: () => [], get: () => null, isWatched: () => false },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
  });
  await reg.loadAll();
  const ctx = { root, pluginAsset: (id, f) => reg.assetFile(id, f) };
  const server = createServer((req, res) => { handleApi(req, res, ctx).catch(() => { res.statusCode = 500; res.end("threw"); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`);
  try {
    const on = await get("/api/plugin/reader/asset/core.wasm");
    assert.equal(on.status, 200);
    assert.equal(on.headers.get("content-type"), "application/wasm");
    assert.equal((await on.arrayBuffer()).byteLength, 10);

    assert.equal(await reg.setEnabled("reader", false), null);
    const off = await get("/api/plugin/reader/asset/core.wasm");
    assert.equal(off.status, 403);
    assert.deepEqual(await off.json(), { error: "Reader is turned off" });
    const head = await fetch(`http://127.0.0.1:${server.address().port}/api/plugin/reader/asset/core.wasm`, { method: "HEAD" });
    assert.equal(head.status, 403, "HEAD is refused the same way");

    const ghost = await get("/api/plugin/ghost/asset/core.wasm");
    assert.equal(ghost.status, 404);
    assert.match((await ghost.json()).error, /no such plugin/);
  } finally {
    server.close();
  }
});
