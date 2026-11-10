import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { idsIn, isTestFile, liveIds, measure } from "./reqpinned.mjs";

const md = [
  "### R-a-001 · shipped\nx\n",
  "### R-a-002 · requested\nx\n",
  "### R-read-mode-003 · shipped\nx\n",
  "### R-a-004 · superseded\nx\n",
  "### R-a-005 · dropped\nx\n",
  "### R-a-006 · built\nx\n",
].join("\n");

test("only shipped requirements are live, hyphenated areas included", () => {
  assert.deepEqual(liveIds(md), ["R-a-001", "R-read-mode-003"]);
});
test("a test names an ID anywhere in its text", () => {
  assert.deepEqual([...idsIn("// R-a-001 and test('R-read-mode-003: x')")].sort(), ["R-a-001", "R-read-mode-003"]);
});
test("share counts live IDs that some test names; an ID in no test is unpinned", () => {
  assert.deepEqual(measure(liveIds(md), ["R-a-001", "R-a-002 R-zzz-999"]), { live: 2, pinned: 1 });
});
test("which files are tests", () => {
  for (const f of ["tools/x.test.mjs", "packages/web/src/a.test.tsx", "scripts/e2e-halt.mjs", "scripts/ui/journey.mjs", "packages/host/test/a.mjs", "packages/extensions/vault/e2e/a.mjs"]) assert.ok(isTestFile(f), f);
  for (const f of ["packages/web/src/a.tsx", "docs/requirements/a.md", "scripts/run-e2e.mjs"]) assert.ok(!isTestFile(f), f);
});
test("run in this repo it prints one percentage", () => {
  const r = spawnSync("node", [new URL("./reqpinned.mjs", import.meta.url).pathname], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
  // The pre-commit guard runs this in a plain temp copy of the staged tree: no git there, and the
  // reading must then be ABSENT with its reason, never a crash or a number.
  if (r.status !== 0) { assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /not a git checkout/); return; }
  assert.match(r.stdout.trim(), /^\d+(\.\d)?$/);
});
