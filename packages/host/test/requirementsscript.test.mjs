/**
 * The requirements extension finds `scripts/requirements/update.mjs` from BOTH
 * places its host half runs: the compiled copy under
 * `packages/host/dist/extensions/` (the daemon) and the `.mts` source under
 * `packages/extensions/requirements/host/` (tsx dev). They sit at different
 * depths, so a path relative to one module is wrong for the other — the row
 * would then say "cannot find its build script" on a machine that has it.
 * Also: the builtin loader points at a host module that exists in both layouts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");
const SCRIPT = join(REPO_ROOT, "scripts", "requirements", "update.mjs");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

const viaTsx = (code) => execFileSync(TSX, ["--eval", code], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

test("built: the compiled extension resolves the build script", async () => {
  const m = await import("../dist/extensions/requirements/host/requirements.mjs");
  assert.equal(m.UPDATE_SCRIPT, SCRIPT);
  assert.equal(m.UPDATE_CMD, `node ${SCRIPT} .`);
});

test("dev (tsx): the .mts source resolves the same build script", () => {
  const src = pathToFileURL(join(REPO_ROOT, "packages/extensions/requirements/host/requirements.mts")).href;
  assert.equal(viaTsx(`import(${JSON.stringify(src)}).then((m) => console.log(m.UPDATE_SCRIPT))`), SCRIPT);
});

test("the builtin loader names a host module that exists, built and under tsx", async () => {
  const b = await import("../dist/plugins/builtin.js");
  for (const id of b.BUILTIN_EXTENSIONS) {
    assert.ok(existsSync(join(b.builtinDir(id), "waterplane-plugin.json")), `${id}: manifest`);
    assert.ok(existsSync(b.builtinHostModule(id)), `${id}: built host module ${b.builtinHostModule(id)}`);
  }
  const src = pathToFileURL(join(REPO_ROOT, "packages/host/src/plugins/builtin.ts")).href;
  const paths = JSON.parse(viaTsx(`import(${JSON.stringify(src)}).then((b) => console.log(JSON.stringify(b.BUILTIN_EXTENSIONS.map(b.builtinHostModule))))`));
  for (const p of paths) {
    assert.ok(p.endsWith(".mts"), `tsx loads the source: ${p}`);
    assert.ok(existsSync(p), p);
  }
});
