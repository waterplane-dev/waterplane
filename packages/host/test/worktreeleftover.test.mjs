// A worktree nobody is using: offered for removal only when nothing lives only
// in it, and the remove re-checks. Real git, in a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { worktreeLeftover, removeLeftover, LEFTOVER_IDLE_MIN } = await import("../dist/worktreeleftover.js");

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** A repo on `main` with one worktree `wt` on branch `b`, aged past the idle line. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wp-leftover-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "a");
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "b", wt, "main");
  return { root, repo, wt };
}

/** Push the worktree's git activity back past the idle line. */
function age(wt) {
  const admin = git(wt, "rev-parse", "--absolute-git-dir").trim();
  const old = new Date(Date.now() - (LEFTOVER_IDLE_MIN + 5) * 60_000);
  for (const f of ["HEAD", "index", "logs/HEAD"]) { const p = join(admin, f); if (existsSync(p)) utimesSync(p, old, old); }
}

const input = (wt, extra = {}) => ({ wt, branch: "b", sessions: [], ownerLive: false, ...extra });

test("a clean worktree at main, untouched for an hour, is safe — and the remove takes it and its branch", async () => {
  const { root, repo, wt } = fixture();
  try {
    age(wt);
    const v = await worktreeLeftover(input(wt));
    assert.deepEqual(v.blockers, []);
    assert.equal(v.base, "main");
    const r = await removeLeftover(input(wt));
    assert.equal(r.ok, true);
    assert.equal(r.branchDeleted, true);
    assert.equal(existsSync(wt), false);
    assert.equal(git(repo, "branch", "--list", "b").trim(), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fresh worktree is kept: a wave of agents gets clean worktrees a moment before it starts", async () => {
  const { root, wt } = fixture();
  try {
    const v = await worktreeLeftover(input(wt));
    assert.equal(v.blockers.length, 1);
    assert.match(v.blockers[0], /about to work in it/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a commit only the worktree holds is a blocker, and the remove refuses with the same words", async () => {
  const { root, wt } = fixture();
  try {
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-qm", "b");
    age(wt);
    const v = await worktreeLeftover(input(wt));
    assert.equal(v.unlanded, 1);
    assert.match(v.blockers.join(" "), /1 commit on b is not on main/);
    const r = await removeLeftover(input(wt));
    assert.equal(r.ok, false);
    assert.equal(existsSync(wt), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a commit cherry-picked onto main counts as landed; the branch goes with -D", async () => {
  const { root, repo, wt } = fixture();
  try {
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-qm", "b");
    // A different committer: with the same identity, tree, parent and message, a pick inside the
    // same clock second is byte-identical to `b` (same sha), so nothing would be "ahead" at all.
    git(repo, "-c", "user.name=picker", "cherry-pick", "b");
    age(wt);
    const v = await worktreeLeftover(input(wt));
    assert.equal(v.ahead, 1);
    assert.equal(v.unlanded, 0);
    assert.deepEqual(v.blockers, []);
    const r = await removeLeftover(input(wt));
    assert.equal(r.ok, true);
    assert.equal(r.branchDeleted, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uncommitted work, transport files, a session inside and a live owner each block, in words", async () => {
  const { root, wt } = fixture();
  try {
    writeFileSync(join(wt, "new.txt"), "x\n");
    mkdirSync(join(wt, ".claude", "outbox"), { recursive: true });
    writeFileSync(join(wt, ".claude", "outbox", "shot.png"), "x");
    age(wt);
    const v = await worktreeLeftover(input(wt, { sessions: [{ cwd: join(wt, "sub") }, { cwd: wt + "-other" }], ownerLive: true }));
    // `.claude/` is not ignored in this fixture, so it counts as untracked too.
    assert.ok(v.uncommitted >= 1);
    assert.equal(v.transport, 1);
    assert.equal(v.sessions, 1, "a sibling path sharing the prefix is not inside");
    assert.equal(v.ownerLive, true);
    const all = v.blockers.join(" ");
    for (const re of [/not committed/, /outbox or \.claude\/inbox/, /1 session running/, /still open/]) assert.match(all, re);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
