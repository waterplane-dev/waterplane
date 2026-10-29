/**
 * Repo discovery without a git process per repo, and the launcher's listing. A `.git` directory
 * with no `worktrees/` is read off `HEAD` (no spawn: from WSL on `/mnt/c` that was ~1.6 s a repo);
 * concurrent scans share one; the listing answers a fresh scan when it is quick, so a repo made a
 * moment ago is listed. No real git needed — the fixtures are bare `.git` dirs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverTargets, listTargets } from "../dist/repos.js";

function fakeRepo(dir, head) {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), head);
}

test("repolist: a single-worktree repo is read off HEAD, branch and detached alike", async () => {
  const root = mkdtempSync(join(tmpdir(), "repolist-"));
  fakeRepo(join(root, "a"), "ref: refs/heads/feature/x\n");
  fakeRepo(join(root, "group", "b"), "0123456789abcdef0123456789abcdef01234567\n");
  const ts = await discoverTargets(root);
  const by = Object.fromEntries(ts.map((t) => [t.repoName, t]));
  assert.equal(by.a.branch, "feature/x");
  assert.equal(by.a.worktreePath, realpathSync(join(root, "a")));
  assert.equal(by.a.isPrimary, true);
  assert.equal(by.b.branch, "(detached)");
});

test("repolist: two clones with one folder name carry `where`, the shortest parent tail that tells them apart", async () => {
  const root = mkdtempSync(join(tmpdir(), "repolist-"));
  fakeRepo(join(root, "garmin", "ciqkit"), "ref: refs/heads/main\n");
  fakeRepo(join(root, "rewrite", "out-ciqkit", "ciqkit"), "ref: refs/heads/main\n");
  fakeRepo(join(root, "alone"), "ref: refs/heads/main\n");
  const ts = await discoverTargets(root);
  const where = (dir) => ts.find((t) => t.worktreePath === realpathSync(dir))?.where;
  assert.equal(where(join(root, "garmin", "ciqkit")), "garmin/");
  assert.equal(where(join(root, "rewrite", "out-ciqkit", "ciqkit")), "out-ciqkit/");
  assert.equal(where(join(root, "alone")), undefined);
});

test("repolist: concurrent scans share one, and each caller gets its own copies", async () => {
  const root = mkdtempSync(join(tmpdir(), "repolist-"));
  fakeRepo(join(root, "a"), "ref: refs/heads/main\n");
  const [x, y] = await Promise.all([discoverTargets(root), discoverTargets(root)]);
  assert.deepEqual(x, y);
  x[0].changedCount = 99;
  assert.equal(y[0].changedCount, 0);
});

test("repolist: the listing shows a repo made a moment ago (a quick scan is never answered stale)", async () => {
  const root = mkdtempSync(join(tmpdir(), "repolist-"));
  fakeRepo(join(root, "a"), "ref: refs/heads/main\n");
  assert.equal((await listTargets(root)).length, 1);
  fakeRepo(join(root, "b"), "ref: refs/heads/main\n");
  assert.deepEqual((await listTargets(root)).map((t) => t.repoName).sort(), ["a", "b"]);
});
