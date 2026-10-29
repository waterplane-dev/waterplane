/**
 * The public plugin API reference cannot drift from the contract.
 *
 * `docs/plugins-api.md` is GENERATED from `packages/shared/src/plugin.ts` by
 * `scripts/gen-plugin-docs.mjs`; this runs it with `--check`, so a change to the
 * contract that did not regenerate the reference fails here, naming the fix
 * (`npm run docs:plugins`). The reference is published (`deploy/public-allowlist.txt`),
 * which is checked too: a reference forks cannot read is no contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("docs/plugins-api.md is what scripts/gen-plugin-docs.mjs makes of plugin.ts (--check)", () => {
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts/gen-plugin-docs.mjs"), "--check"], { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    assert.fail(String(e.stderr || e.message).trim());
  }
});

test("the reference names the API version plugin.ts declares", () => {
  const src = readFileSync(join(ROOT, "packages/shared/src/plugin/version.ts"), "utf8");
  const v = /export const PLUGIN_API_VERSION = "([^"]+)"/.exec(src)?.[1];
  assert.ok(v, "plugin/version.ts declares PLUGIN_API_VERSION as a string literal");
  assert.match(readFileSync(join(ROOT, "docs/plugins-api.md"), "utf8"), new RegExp(`API version: \`${v.replace(/\./g, "\\.")}\``));
});

test("the reference is on the public allow-list", () => {
  const lines = readFileSync(join(ROOT, "deploy/public-allowlist.txt"), "utf8").split("\n").map((l) => l.trim());
  assert.ok(lines.includes("docs/plugins-api.md"), "deploy/public-allowlist.txt lists docs/plugins-api.md");
});
