/**
 * The host, web and extension modules packages/vscode bundles from source may not grow an import
 * the extension cannot carry.
 *
 * packages/vscode/esbuild.mjs bundles a slice of packages/host/src, packages/web/src and two
 * extensions as they are, swapping a few of their imports for shims (host `env.ts`/`agents.ts`, the
 * web `HintChip`, the phone's socket reads). Those packages build and test fine on their own, so a
 * new impure import in one of the bundled modules broke only `npm run test:vscode` — at the push,
 * hours after the edit (architecture review 2026-11-19). esbuild writes the bundled set and its
 * shim table to packages/vscode/bundled-sources.json; this guard holds every module on that list to:
 *
 *   1. a relative import resolves to a listed module, a shimmed one, or one outside host/web/
 *      extensions (shared, tools) — anything else would pull a new module into the extension;
 *   2. no `child_process` (check-vsix allows it in the health worker only, which bundles tools/);
 *   3. no node builtin on the browser side (web/src, extensions' web/), which the webview cannot load;
 *   4. no npm package beyond the ones packages/vscode installs and the bundles already use.
 *
 * Type-only imports are skipped: esbuild drops them. Fixing a failure: drop the import, move the
 * impure part out of the bundled module, or — if the extension really should carry the new module —
 * check it against 2–4, then `node packages/vscode/esbuild.mjs --sources` and commit the list (the
 * vscode build fails on a module the list does not hold, so the list cannot fall behind silently).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIST = "packages/vscode/bundled-sources.json";
const SCOPE = /^packages\/(host\/src|web\/src|extensions\/[^/]+\/(host|web|shared))\//;
const BROWSER = /^packages\/(web\/src|extensions\/[^/]+\/web)\//;

/** A listed module that imports child_process although the bundle never reaches the call. */
const CHILD_PROCESS_OK = {
  // vscode/src/copilotquota.ts takes only parseCopilotQuota; the gh call is tree-shaken out, and
  // check-vsix still refuses child_process anywhere in the shipped bundles but the health worker.
  "packages/extensions/copilot-usage/host/ghquota.mts": "only parseCopilotQuota is bundled",
};
/** npm packages the bundled modules may name (packages/vscode resolves them; @waterplane/* are aliases). */
const PACKAGES = {
  node: ["@waterplane/shared"],
  browser: ["@waterplane/shared", "@waterplane/kit", "@waterplane/sdk", "react", "react-dom", "lucide-react"],
};
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const rel = (abs) => relative(ROOT, abs).split(sep).join("/");

/** Value imports of a module: [specifier, line]. `import type`, `export type` and all-`type` braces are skipped. */
export function valueImports(src) {
  const out = [];
  const stmt = /^[ \t]*(import|export)\b([^;'"`]*?)\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
  for (const m of src.matchAll(stmt)) {
    const spec = m[3] ?? m[4] ?? m[5];
    const head = m[2] ?? "";
    if (/^\s*type\b/.test(head)) continue;
    const braces = head.trim().match(/^\{([^}]*)\}$/); // `import { type A, type B } from` only
    const names = braces ? braces[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (names.length && names.every((n) => /^type\s/.test(n))) continue;
    out.push([spec, src.slice(0, m.index).split("\n").length]);
  }
  return out;
}

/** Resolve a relative specifier the way esbuild does here (.js → .ts/.tsx, .mjs → .mts, bare dir → index). */
function resolveRel(importer, spec) {
  const p = resolve(dirname(importer), spec);
  const tries = /\.js$/.test(p) ? [p.replace(/\.js$/, ".ts"), p.replace(/\.js$/, ".tsx"), p]
    : /\.mjs$/.test(p) ? [p.replace(/\.mjs$/, ".mts"), p]
    : /\.(tsx?|mts|css|json)$/.test(p) ? [p]
    : [".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"].map((x) => p + x);
  return tries.find((t) => existsSync(t)) ?? null;
}

const pkgName = (spec) => spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

/** Every rule broken by one listed module, as sentences. */
export function problems(file, src, list) {
  const listed = new Set(list.files), shimmed = new Set(list.shimmed);
  const swaps = list.swaps.filter((s) => s.importer === file).map((s) => new RegExp(s.spec));
  const browser = BROWSER.test(file);
  const out = [];
  for (const [spec, line] of valueImports(src)) {
    const at = `${file}:${line} imports "${spec}"`;
    if (spec.startsWith(".")) {
      if (swaps.some((re) => re.test(spec))) continue;
      const hit = resolveRel(join(ROOT, file), spec);
      if (!hit) continue; // unresolvable: tsc's to report, not this guard's
      const target = rel(hit);
      if (listed.has(target) || shimmed.has(target) || !SCOPE.test(target)) continue;
      out.push(`${at} → ${target}, which the VS Code extension does not bundle yet: it would ship there from now on`);
    } else if (/^(node:)?child_process$/.test(spec)) {
      if (!CHILD_PROCESS_OK[file]) out.push(`${at}: the extension may not start a process (check-vsix refuses it outside the health worker)`);
    } else if (NODE_BUILTINS.has(spec)) {
      if (browser) out.push(`${at}: a node builtin in a module the webview bundles for the browser`);
    } else if (!PACKAGES[browser ? "browser" : "node"].includes(pkgName(spec))) {
      out.push(`${at}: a package the ${browser ? "webview" : "extension"} bundle does not carry (tools/vscodebundle.test.mjs PACKAGES)`);
    }
  }
  return out;
}

const list = JSON.parse(readFileSync(join(ROOT, LIST), "utf8"));

test("every bundled module imports only what the VS Code extension carries", () => {
  const bad = [];
  for (const file of list.files) {
    const abs = join(ROOT, file);
    if (!existsSync(abs)) { bad.push(`${file} is listed in ${LIST} but gone: run \`node packages/vscode/esbuild.mjs --sources\``); continue; }
    if (/\.css$/.test(file)) continue;
    bad.push(...problems(file, readFileSync(abs, "utf8"), list));
  }
  assert.deepEqual(bad, [], "\n" + bad.join("\n") + "\n\nDrop or move the import, or — if the extension should carry it — check it, then"
    + " `node packages/vscode/esbuild.mjs --sources` and commit the list. Why: the header of tools/vscodebundle.test.mjs.\n");
});

test("the shim table and exceptions name files that exist", () => {
  for (const f of [...list.shimmed, ...list.swaps.map((s) => s.importer), ...Object.keys(CHILD_PROCESS_OK)]) {
    assert.ok(existsSync(join(ROOT, f)), `${f} is gone: update packages/vscode/esbuild.mjs or this guard`);
  }
});

test("the checks fire (each rule, on a made-up module)", () => {
  const fake = { files: ["packages/host/src/costwindow.ts", "packages/host/src/pricegap.ts"], shimmed: ["packages/host/src/env.ts"], swaps: [] };
  const host = "packages/host/src/costwindow.ts";
  assert.deepEqual(problems(host, `import { a } from "./pricegap.js";\nimport { e } from "./env.js";\nimport type { S } from "./sessions.js";\n`, fake), []);
  assert.match(problems(host, `import {\n  spawnThing,\n} from "./sessions.js";\n`, fake).join(), /sessions\.ts, which the VS Code extension does not bundle/);
  assert.match(problems(host, `import { execFile } from "node:child_process";\n`, fake).join(), /may not start a process/);
  assert.deepEqual(problems(host, `import { readFileSync } from "node:fs";\n`, fake), []);
  assert.match(problems("packages/web/src/x.ts", `import { readFileSync } from "node:fs";\n`, fake).join(), /node builtin/);
  assert.match(problems(host, `import WebSocket from "ws";\n`, fake).join(), /does not carry/);
  assert.deepEqual(problems(host, `import { type A, type B } from "./sessions.js";\n`, fake), []);
  assert.match(problems(host, `const m = await import("./sessions.js");\n`, fake).join(), /does not bundle/);
});
