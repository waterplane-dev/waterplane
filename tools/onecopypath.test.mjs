/**
 * `local/one-copy-path`, pinned both ways through ESLint itself: a direct
 * `navigator.clipboard.writeText` (any spelling) is refused; copyText() and
 * reading the clipboard are not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import local from "./eslint/rules.js";

const linter = new Linter({ configType: "flat" });
const config = [{
  files: ["**/*.ts", "**/*.tsx"], plugins: { local },
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
  rules: { "local/one-copy-path": "error" },
}];
const lint = (code) => linter.verify(code, config, { filename: "packages/web/src/X.tsx" }).map((m) => m.message);

test("every spelling of a direct clipboard write is refused", () => {
  for (const code of [
    `navigator.clipboard.writeText(t);`,
    `void navigator.clipboard?.writeText(t);`,
    `navigator.clipboard?.writeText?.(t);`,
    `await window.navigator.clipboard.writeText(t);`,
    `const w = navigator.clipboard.writeText;`,
  ]) assert.equal(lint(code).length, 1, code);
  assert.match(lint(`navigator.clipboard.writeText(t)`)[0], /copyText/);
});

test("copyText, reading the clipboard and unrelated writeText calls pass", () => {
  for (const code of [
    `await copyText(t);`,
    `const t = await navigator.clipboard.readText();`,
    `files.writeText(path, body);`,
    `writeText(next);`,
  ]) assert.deepEqual(lint(code), [], code);
});
