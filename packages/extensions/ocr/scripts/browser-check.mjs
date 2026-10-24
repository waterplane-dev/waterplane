#!/usr/bin/env node
/**
 * The OCR reader, end to end in a real Chromium, in the HARDEST of its three homes: a plain-http
 * page on a non-loopback name — not a secure context, so no service worker, no Cache API and no
 * `crypto.subtle` (the APK has no service worker either). Asserts all three are absent, then:
 *
 *   assets/ (the built folder) → fetched → sha256-checked with the PLAIN-JS hash → stored in
 *   IndexedDB → read back as Blobs → `createEngine` (web/engine.ts, the shipped code, types
 *   stripped) starts tesseract from blob URLs → reads canvas-rendered PNGs of known English and
 *   German text; plus a blank picture (null) and an aborted read (null).
 *
 *     node packages/extensions/ocr/scripts/browser-check.mjs        # exits 0 / 1, prints a JSON line
 *
 * A script, not a test-runner entry: it needs the built assets (`npm run build:ext-assets`) and a
 * Playwright Chromium, and no host.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");
const assets = join(ext, "assets");
if (!existsSync(join(assets, "manifest.json"))) execFileSync(process.execPath, [join(here, "build-assets.mjs")], { stdio: "inherit" });

const strip = (file) => ts.transpileModule(readFileSync(join(ext, "web", file), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
}).outputText;

const PAGE = `<!doctype html><meta charset="utf-8"><title>ocr check</title><body></body>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }
  const mod = /^\/m\/(engine|logic)\.ts$/.exec(url.pathname);
  if (mod) { res.writeHead(200, { "content-type": "text/javascript" }); res.end(strip(`${mod[1]}.ts`)); return; }
  const a = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(url.pathname);
  if (a && existsSync(join(assets, a[1]))) { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(readFileSync(join(assets, a[1]))); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP wp-ocr.test 127.0.0.1"] });
let code = 1;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(`http://wp-ocr.test:${port}/`);
  const out = await page.evaluate(async () => {
    const logic = await import("/m/logic.ts");
    const { createEngine } = await import("/m/engine.ts");
    const env = { secure: isSecureContext, sw: "serviceWorker" in navigator, caches: typeof caches !== "undefined", subtle: !!globalThis.crypto?.subtle };

    // assets → verified → IndexedDB → Blobs
    const m = logic.parseManifest(await (await fetch("/assets/manifest.json")).json());
    const simd = WebAssembly.validate(logic.SIMD_PROBE);
    const want = logic.wantedFiles(m, simd);
    const db = await new Promise((ok, no) => { const r = indexedDB.open("ocr-check", 1); r.onupgradeneeded = () => r.result.createObjectStore("a"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const tx = (mode, fn) => new Promise((ok, no) => { const t = db.transaction("a", mode); const q = fn(t.objectStore("a")); t.oncomplete = () => ok(q.result); t.onerror = () => no(t.error); });
    const t0 = performance.now();
    for (const f of want) {
      const b = await (await fetch(`/assets/${f.file}`)).blob();
      const sha = await logic.sha256Hex(new Uint8Array(await b.arrayBuffer()));
      if (sha !== f.sha256) throw new Error(`sha mismatch ${f.file}`);
      await tx("readwrite", (s) => s.put(b, f.file));
    }
    const verifyMs = Math.round(performance.now() - t0);
    const get = (f) => tx("readonly", (s) => s.get(f.file));
    const files = async () => ({
      worker: await get(want.find((f) => f.role === "worker")),
      core: await get(want.find((f) => f.role.startsWith("core"))),
      langs: await Promise.all(want.filter((f) => f.role === "lang").map(async (f) => ({ code: f.lang, data: await get(f) }))),
    });
    const engine = createEngine(files, 5_000);

    const picture = (lines, w = 900) => new Promise((ok) => {
      const c = document.createElement("canvas");
      c.width = w; c.height = 40 + lines.length * 70;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#111"; g.font = "48px Helvetica, Arial, sans-serif"; g.textBaseline = "top";
      lines.forEach((l, i) => g.fillText(l, 24, 20 + i * 70));
      c.toBlob(ok, "image/png");
    });
    const read = async (blob) => { const s = performance.now(); const text = await engine.read(blob, new AbortController().signal); return { text, ms: Math.round(performance.now() - s) }; };

    const english = await read(await picture(["The quick brown fox", "jumps over the lazy dog"]));
    const german = await read(await picture(["Die Größe der Straße", "Übermorgen fährt Jürgen"]));
    const blank = await read(await picture([]));
    const ac = new AbortController(); ac.abort();
    const aborted = await engine.read(await picture(["never read"]), ac.signal);
    const warmBefore = engine.warm();
    await new Promise((r) => setTimeout(r, 5_600));
    const warmAfter = engine.warm();
    // The fallback core (a phone without wasm SIMD) reads the same picture.
    const plainCore = m.files.find((f) => f.role === "core");
    const pb = await (await fetch(`/assets/${plainCore.file}`)).blob();
    if ((await logic.sha256Hex(new Uint8Array(await pb.arrayBuffer()))) !== plainCore.sha256) throw new Error("sha mismatch plain core");
    const plainEngine = createEngine(async () => ({ ...(await files()), core: pb }), 1_000);
    const plain = await (async () => { const s = performance.now(); const text = await plainEngine.read(await picture(["The quick brown fox"]), new AbortController().signal); plainEngine.stop(); return { text, ms: Math.round(performance.now() - s) }; })();
    return { env, simd, plain, files: want.map((f) => f.file), bytes: logic.totalBytes(want), verifyMs, english, german, blank, aborted, warmBefore, warmAfter };
  });

  const words = (s) => (s ?? "").toLowerCase();
  const checks = {
    "not a secure context": out.env.secure === false,
    "no service worker": out.env.sw === false,
    "no Cache API": out.env.caches === false,
    "no crypto.subtle (plain-JS sha256 used)": out.env.subtle === false,
    "english words": ["quick", "brown", "fox", "jumps", "lazy", "dog"].every((w) => words(out.english.text).includes(w)),
    "german words": ["größe", "straße", "übermorgen", "fährt", "jürgen"].every((w) => words(out.german.text).includes(w)),
    "plain (non-SIMD) core reads too": ["quick", "brown", "fox"].every((w) => words(out.plain.text).includes(w)),
    "blank is null": out.blank.text === null,
    "aborted is null": out.aborted === null,
    "warm after reading": out.warmBefore === true,
    "stopped after the warm window": out.warmAfter === false,
  };
  console.log(JSON.stringify({ ...out, checks }, null, 1));
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length) console.error(`FAILED: ${failed.join(", ")}`);
  else { console.log("ocr browser check: all passed"); code = 0; }
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
