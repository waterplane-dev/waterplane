// What run-e2e.mjs refuses to start. The scripts on its BY_HAND list need an emulator and an APK,
// which the pre-push worktree cannot have: one that slips back in fails every push.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (...args) => spawnSync(process.execPath, ["scripts/run-e2e.mjs", ...args], { cwd: root, encoding: "utf8" });

for (const name of ["e2e-android-lan", "e2e-android-oldshell"]) {
  test(`${name} is never started, and the run says so`, () => {
    const r = run(name);
    assert.equal(r.status, 1, "nothing is left to run, so the filter matched nothing");
    assert.match(r.stdout, new RegExp(`not run here: ${name}\\.mjs .*By hand: node scripts/${name}\\.mjs`));
    assert.match(r.stderr, /No e2e scripts matched/);
  });
}
