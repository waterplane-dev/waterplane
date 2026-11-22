/**
 * `local/no-raw-storage`, pinned both ways: every route to the two storage globals that slipped
 * past the old warn-level `no-restricted-properties` is refused, and what is not the global (a
 * local of the same name, a property on another object, a type) passes — and the config really
 * turns it on for web and off only for the three owners.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Linter, ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import local from "./eslint/rules.js";

const linter = new Linter({ configType: "flat" });
const config = [{
  files: ["**/*.ts", "**/*.tsx"], plugins: { local },
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
  rules: { "local/no-raw-storage": "error" },
}];
const hits = (code) => linter.verify(code, config, { filename: "x.ts" }).filter((m) => m.ruleId === "local/no-raw-storage").length;

test("every raw route to the store is refused", () => {
  for (const code of [
    `localStorage.getItem("k");`,
    `localStorage.removeItem("k");`,
    `sessionStorage.setItem("k", "v");`,
    `for (const k of Object.keys(localStorage)) {}`,
    `globalThis.localStorage?.setItem("k", "v");`,
    `window.sessionStorage.getItem("k");`,
    `const s = self["localStorage"];`,
    `const s = localStorage;`,
  ]) assert.equal(hits(code), 1, code);
});

test("what is not the global passes", () => {
  for (const code of [
    `function f(localStorage: Storage) { return localStorage.getItem("k"); }`,
    `const kv = { getItem: (k: string) => k }; kv.getItem("k");`,
    `const o = { localStorage: 1 }; o.localStorage;`,
    `let x: Storage | null = null;`,
    `// localStorage.setItem in a comment`,
    `const s = "localStorage";`,
  ]) assert.equal(hits(code), 0, code);
});

test("the repo config refuses it in web and exempts only the owners", async () => {
  const eslint = new ESLint();
  const on = async (f) => (await eslint.calculateConfigForFile(f)).rules?.["local/no-raw-storage"]?.[0];
  for (const f of ["packages/web/src/ws.ts", "packages/web/src/outbox.ts", "packages/web/src/BootGuard.tsx", "packages/extensions/vault/web/index.ts"]) {
    assert.ok([2, "error"].includes(await on(f)), `${f} must have no-raw-storage on`);
  }
  for (const f of ["packages/web/src/storage.ts", "packages/web/src/settings.ts", "packages/web/src/demo/world.ts"]) {
    assert.ok([undefined, 0, "off"].includes(await on(f)), `${f} owns the store`);
  }
});
