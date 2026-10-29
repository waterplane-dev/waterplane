/**
 * The forge seam (docs/notes/forge.md): `gh` is spawned in ONE file under packages/host/src —
 * `forge/github.ts`. `protectmain.ts` is owner tooling (sync, pre-existing) and is the only other.
 * A new PR/status/rules call goes on the `Forge` interface, never a fresh `execFile("gh", …)`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(new URL("..", import.meta.url).pathname, "packages", "host", "src");
/** A spawn-family call whose first argument is the literal command "gh". */
const SPAWN_GH = /\b(?:execFile|execFileSync|execFileP|spawn|spawnSync|execa)\w*\(\s*["'`]gh["'`]/;
const ALLOWED = new Set(["forge/github.ts", "protectmain.ts"]);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(e.name)) yield p;
  }
}

test("only forge/github.ts (and protectmain.ts) spawns gh", () => {
  const bad = [];
  for (const f of walk(SRC)) {
    const rel = relative(SRC, f);
    if (ALLOWED.has(rel)) continue;
    if (SPAWN_GH.test(readFileSync(f, "utf8"))) bad.push(rel);
  }
  assert.deepEqual(bad, [], `these files spawn "gh" — put the call on the Forge interface:\n${bad.join("\n")}`);
});

test("github.ts is where the allowed spawn lives", () => {
  assert.match(readFileSync(join(SRC, "forge", "github.ts"), "utf8"), /execFileP\("gh"/);
});
