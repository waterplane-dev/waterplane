/**
 * `local/extension-boundary`, pinned both ways: what an extension may import,
 * what core may import of an extension, and that ESLint really wires it on
 * the .mts host files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import local, { extensionBoundary, coreExtensionImport } from "./eslint/rules.js";

const W = "packages/extensions/req/web/a.ts";
const H = "packages/extensions/req/host/a.mts";
const ok = (f, s) => assert.equal(extensionBoundary(f, s), null, `${f} -> ${s}`);
const no = (f, s, re) => { const w = extensionBoundary(f, s); assert.ok(w, `${f} -> ${s} should be refused`); if (re) assert.match(w, re); };

test("web half: sdk, kit, shared, react, lucide and its own folder", () => {
  for (const s of ["@waterplane/sdk", "@waterplane/kit", "@waterplane/shared", "react", "react-dom", "react-dom/client", "lucide-react", "./b.ts", "../shared/m.mts"]) ok(W, s);
  no(W, "../../../web/src/format.ts", /@waterplane\/sdk/);
  no(W, "../../other/web/index.ts", /leaves/);
  no(W, "node:fs", /node builtin/);
  no(W, "lodash", /not allowed/);
  no(W, "@waterplane/host", /not allowed/);
});

test("host half: shared, node builtins and its own folder only", () => {
  for (const s of ["@waterplane/shared", "node:fs", "node:path", "./b.mjs", "../shared/m.mjs"]) ok(H, s);
  no(H, "../../../host/src/paths.ts", /leaves/);
  no(H, "@waterplane/sdk", /HostPluginApi/);
  no(H, "lodash", /not allowed/);
});

test("core reaches an extension only through its entry", () => {
  const reg = "packages/web/src/features/registry.ts";
  const bi = "packages/host/src/plugins/builtin.ts";
  assert.equal(coreExtensionImport(reg, "packages/extensions/req/web/index.ts"), null);
  assert.equal(coreExtensionImport(bi, "packages/extensions/req/host/index.mjs"), null);
  assert.ok(coreExtensionImport(reg, "packages/extensions/req/web/data.ts"));
  assert.ok(coreExtensionImport("packages/web/src/App.tsx", "packages/extensions/req/web/index.ts"));
  assert.ok(coreExtensionImport(bi, "packages/extensions/req/host/list.mjs"));
  assert.equal(coreExtensionImport("packages/web/src/App.tsx", "packages/web/src/format.ts"), null);
});

test("ESLint reports on web, .mts host and core files", () => {
  const linter = new Linter({ configType: "flat" });
  const config = [{ files: ["**/*.{ts,mts}"], plugins: { local }, languageOptions: { parser: tsParser }, rules: { "local/extension-boundary": "error" } }];
  const lint = (f, c) => linter.verify(c, config, { filename: f }).map((m) => m.message);
  assert.deepEqual(lint(W, `import { core } from "@waterplane/sdk"; import { x } from "./b.ts";`), []);
  assert.equal(lint(W, `import { f } from "../../../web/src/format.ts"; import fs from "node:fs";`).length, 2);
  assert.deepEqual(lint(H, `import { readFileSync } from "node:fs"; import type { HostPluginApi } from "@waterplane/shared";`), []);
  const bad = lint(H, `import { p } from "../../../host/src/paths.js"; const x = import("../../other/host/index.mjs");`);
  assert.equal(bad.length, 2, bad.join("\n"));
  assert.equal(lint("packages/web/src/App.tsx", `import { m } from "../../extensions/req/web/data.ts";`).length, 1);
  assert.deepEqual(lint("packages/web/src/features/registry.ts", `import { manifest } from "../../../extensions/req/web/index.ts";`), []);
  assert.equal(lint("packages/host/src/x.ts", `import { a } from "../../extensions/req/host/list.mjs";`).length, 1);
});
