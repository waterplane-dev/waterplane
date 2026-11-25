/**
 * Only `packages/web/src/vscodeShell.ts` knows waterplane can be framed in a
 * VS Code tab. Everything else in the web half (and the extensions' web
 * halves) is the same app; `main.tsx` and `openExternal.ts` may import only
 * the installer / `openInVscode`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function* walk(d) {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.test\.[mc]?[jt]sx?$/.test(e.name)) yield p;
  }
}
const roots = [join(root, "packages/web/src")];
for (const e of existsSync(join(root, "packages/extensions")) ? readdirSync(join(root, "packages/extensions")) : []) roots.push(join(root, "packages/extensions", e, "web"));
const SHELL = join(root, "packages/web/src/vscodeShell.ts");

test("nothing but vscodeShell.ts mentions the VS Code frame", () => {
  const bad = [];
  for (const r of roots) for (const f of walk(r)) {
    if (f === SHELL) continue;
    if (/vscode-webview|vscodeParent/.test(readFileSync(f, "utf8"))) bad.push(relative(root, f));
  }
  assert.deepEqual(bad, []);
});

test("main.tsx and openExternal.ts import only the installer / openInVscode", () => {
  for (const [f, allowed] of [["main.tsx", ["installVscodeLinks"]], ["openExternal.ts", ["openInVscode"]]]) {
    const m = readFileSync(join(root, "packages/web/src", f), "utf8").match(/import\s*\{([^}]*)\}\s*from\s*"\.\/vscodeShell"/);
    assert.ok(m, `${f} imports vscodeShell`);
    assert.deepEqual(m[1].split(",").map((s) => s.trim()).filter(Boolean), allowed);
  }
});
