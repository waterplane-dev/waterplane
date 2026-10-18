/**
 * Pins for splitting the image annotator (docs/notes/charts-architecture.md, "The annotator").
 *
 * `ImageAnnotator.tsx` (one 1340-line component) becomes a composer over `annotator/`: ONE state
 * hook, handler factories, region components, pure geometry and drawing. A move can DROP an export
 * an importer needs, reorder an effect, or change what the sheet draws. So:
 *
 *  1. The EXPORT SURFACE of the facade, read off the type checker (types included).
 *  2. The sheet SERVER-RENDERED over five prop combinations (single, batch, with and without the
 *     skip / send-all / dispatch verbs) and hashed per case, compared with the golden recorded
 *     BEFORE the move — byte-identical markup. Regenerate with
 *     `WATERPLANE_REGOLDEN=1 node --test tools/annotatorpins.test.mjs` only for a deliberate change.
 *  3. The never-do list as TEXT over the facade and `annotator/`: no `window.confirm`/`prompt`, no
 *     second socket, no emoji icon, and the tracked sends stay exactly where they were.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "packages", "web", "src");
const FACADE = join(SRC, "ImageAnnotator.tsx");
const GOLDEN = fileURLToPath(new URL("./annotatorpins.golden.json", import.meta.url));
const REGOLDEN = process.env.WATERPLANE_REGOLDEN === "1";
const GOLDEN_DOC = (() => { try { return JSON.parse(readFileSync(GOLDEN, "utf8")); } catch { return {}; } })();

const SURFACE = ["AnnDispatch:type", "AnnSend:type", "AnnSource:type", "ImageAnnotator:value"];

test("ImageAnnotator.tsx exports exactly its pinned surface", () => {
  const program = ts.createProgram([FACADE], {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(FACADE));
  const got = checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
  assert.deepEqual(got, SURFACE);
});

test("the sheet's server-rendered markup is byte-identical to the golden", async () => {
  const dir = join(ROOT, "node_modules", ".ssr");
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "annotatorpins-entry.tsx");
  writeFileSync(entry, `
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ImageAnnotator } from ${JSON.stringify(FACADE)};
const noop = () => {};
const src = { url: "blob:x", name: "shot.png" };
const cases = [
  { source: src, repoId: "r", onUploaded: noop, onClose: noop },
  { source: src, repoId: "r", index: 2, total: 3, facts: "f", onUploaded: noop, onClose: noop, onSkip: noop, onSendAll: noop, onDispatch: noop },
  { source: src, repoId: "r", index: 3, total: 3, onUploaded: noop, onClose: noop, onSendAll: noop },
  { source: src, repoId: "r", total: 1, onUploaded: noop, onClose: noop, onDispatch: noop, onSkip: noop },
  { source: src, repoId: "r", onUploaded: noop, onClose: noop, onDispatch: noop },
];
export default cases.map((p) => renderToStaticMarkup(createElement(ImageAnnotator, p)));
`);
  const out = join(dir, "annotatorpins-bundle.mjs");
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, jsx: "automatic", logLevel: "error",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
    external: ["react", "react-dom", "lucide-react"], nodePaths: [join(ROOT, "node_modules")], define: { "import.meta.env": "{}" },
  });
  const htmls = (await import(`${pathToFileURL(out).href}?t=${Date.now()}`)).default;
  const digests = htmls.map((h) => createHash("sha256").update(h).digest("hex").slice(0, 16));
  assert.ok(htmls.every((h) => h.startsWith('<div class="sheet">') && h.includes("annot-canvas")), "the sheet did not render");
  if (REGOLDEN) { writeFileSync(GOLDEN, JSON.stringify({ digests, lengths: htmls.map((h) => h.length) }, null, 1) + "\n"); return; }
  assert.deepEqual({ digests, lengths: htmls.map((h) => h.length) }, GOLDEN_DOC);
});

function sheetText() {
  const dir = join(SRC, "annotator");
  const files = [FACADE, ...(existsSync(dir) ? readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f)) : [])];
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}
const count = (text, re) => (text.match(re) ?? []).length;

test("the annotator's never-do list and tracked sends hold, file-agnostically", () => {
  const text = sheetText();
  assert.equal(count(text, /window\.(confirm|prompt)\s*\(/g), 0);
  assert.equal(count(text, /new WebSocket\(/g), 0);
  assert.equal(count(text, /track\("action:image\.queue"\)|track\(mode === "queue" \? "action:image\.queue" : "action:image\.send"\)/g), 2);
  // The highlighter reads nothing by itself (2026-10-18): no call off the phone for a band.
  assert.equal(count(text, /track\("action:image\.readtext"\)/g), 0);
  assert.equal(count(text, /api\.uploadInbox\(/g), 1);
  assert.equal(count(text, /api\.readText\(/g), 0);
  assert.equal(count(text, /lsSetBool\(LS\.annKnobs/g), 1);
  assert.equal(count(text, /new ResizeObserver\(/g), 1);
  assert.equal(count(text, /<UploadScalePicker/g), 1);
});
