/**
 * `plainFolders` / `initFolder` — a folder dragged under the root with no `.git` is
 * skipped by the repo scan; rescan names it and offers `git init`. Only direct
 * children of the root count, a grouping folder holding a repo is not one, and
 * `initFolder` touches nothing but `.git` and refuses a path outside the root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTargets, plainFolders } from "../dist/repos.js";
import { initFolder } from "../dist/scaffold.js";

test("a direct child with no git is listed; a repo and a folder holding one are not", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wp-plain-")));
  mkdirSync(join(root, "drop", "Utility"), { recursive: true });
  writeFileSync(join(root, "drop", "Setup.txt"), "x");
  mkdirSync(join(root, "org", "inner", ".git"), { recursive: true });
  mkdirSync(join(root, ".hidden"));
  mkdirSync(join(root, "node_modules"));
  const f = await plainFolders(root, [{ worktreePath: join(root, "org", "inner") }]);
  assert.deepEqual(f.map((x) => x.name), ["drop"]);
});

test("initFolder adds only .git, then the scan lists it and plainFolders drops it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wp-plain-")));
  mkdirSync(join(root, "drop"));
  writeFileSync(join(root, "drop", "Setup.txt"), "x");
  const r = await initFolder(root, join(root, "drop"));
  assert.equal(r.error, undefined);
  assert.ok(existsSync(join(root, "drop", ".git")));
  assert.deepEqual(readdirSync(join(root, "drop")).sort(), [".git", "Setup.txt"]);
  const targets = await discoverTargets(root);
  assert.ok(targets.some((t) => t.repoName === "drop"));
  assert.deepEqual(await plainFolders(root, targets), []);
  assert.match((await initFolder(root, join(root, "drop"))).error, /already a git repo/);
});

test("initFolder refuses a path outside the root", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wp-plain-")));
  const other = realpathSync(mkdtempSync(join(tmpdir(), "wp-other-")));
  assert.match((await initFolder(root, other)).error, /escapes root/);
  assert.ok(!existsSync(join(other, ".git")));
});
