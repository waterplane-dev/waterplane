// The pre-close check: how many commits would closing this session leave unlanded, measured against
// which base. Real git, in a temp dir. A base that cannot be found or a count that cannot be read is
// UNKNOWN (`unmergedUnknown`), never "nothing unmerged".
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { gitCloseCheck, gitReviewDiff } = await import("../dist/git.js");

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const commit = (cwd, file, text = file) => { writeFileSync(join(cwd, file), text + "\n"); git(cwd, "add", file); git(cwd, "commit", "-qm", file); };

/** A repo whose only branch is `base`, with a worktree `wt` on branch `feat` carrying `n` commits. */
function fixture(base, n = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wp-close-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", base);
  commit(repo, "a.txt");
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "feat", wt, base);
  for (let i = 0; i < n; i++) commit(wt, `f${i}.txt`);
  return { root, repo, wt };
}

test("main-default repo: two unmerged commits are counted against main", async () => {
  const { root, wt } = fixture("main");
  try {
    const c = await gitCloseCheck(wt);
    assert.equal(c.mainBranch, "main");
    assert.equal(c.unmerged, 2);
    assert.equal(c.isMain, false);
    assert.notEqual(c.unmergedUnknown, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the main checkout itself is main, with nothing to warn about", async () => {
  const { root, repo } = fixture("main");
  try {
    const c = await gitCloseCheck(repo);
    assert.equal(c.isMain, true);
    assert.equal(c.unmerged, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a repo whose default is develop: the two commits are counted, not read as nothing unmerged", async () => {
  const { root, wt } = fixture("develop");
  try {
    const c = await gitCloseCheck(wt);
    assert.equal(c.mainBranch, "develop");
    assert.equal(c.unmerged, 2);
    assert.notEqual(c.unmergedUnknown, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("origin/HEAD names the base when the clone has one", async () => {
  const { root, repo, wt } = fixture("trunk");
  try {
    git(repo, "branch", "other");
    git(repo, "update-ref", "refs/remotes/origin/trunk", "trunk");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    git(repo, "checkout", "-q", "other");
    const c = await gitCloseCheck(wt);
    assert.equal(c.mainBranch, "trunk");
    assert.equal(c.unmerged, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a cherry-picked commit is landed: only the commit whose patch is not on the base counts", async () => {
  const { root, repo, wt } = fixture("main");
  try {
    const sha = git(wt, "rev-parse", "HEAD~1").trim(); // f0
    git(repo, "cherry-pick", "-x", sha); // -x: a new SHA, the same patch
    const c = await gitCloseCheck(wt);
    assert.equal(c.unmerged, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a count git could not read is unknown, never 0", async () => {
  const { root, repo, wt } = fixture("main");
  try {
    const tip = git(repo, "rev-parse", "main").trim();
    unlinkSync(join(repo, ".git", "objects", tip.slice(0, 2), tip.slice(2))); // main's tip commit is gone
    const c = await gitCloseCheck(wt);
    assert.equal(c.unmergedUnknown, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the review diff is against the real base too (develop)", async () => {
  const { root, wt } = fixture("develop", 1);
  try {
    const r = await gitReviewDiff(wt);
    assert.match(r.diff, /f0\.txt/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
