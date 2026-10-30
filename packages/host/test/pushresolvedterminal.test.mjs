/**
 * A failed push is resolved by git STATE, wherever the push came from (design round 4).
 *
 * A push from a terminal is invisible to the host: it is not a host-run outcome, and before this
 * the stored failure stood until the person dismissed it. Two shapes it hid behind:
 * - `git push origin <b>` with no `-u`: the branch has no upstream, so "is the sha on the
 *   upstream" was unknown forever — the branch's remote-tracking ref is what that push moved;
 * - `--amend` after the failure: the failed sha is no longer on the branch at all, so it never
 *   reaches the remote — but the branch's current tip does.
 * One rule (`pushedAlready`) decides, and a host-side tick (`settlePushFailures`) asks it for
 * every open push failure — never a GET.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AttentionStore } = await import("../dist/attentionstore.js");
const { reportGitOutcome, settlePushFailures } = await import("../dist/gitnotify.js");
const { pushedAlready } = await import("../dist/pushreach.js");
const { gitAttentionKey } = await import("@waterplane/shared");

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, stdio: "pipe" }).toString().trim();

/** origin.git + a clone `a` on main (pushed with -u), and `nou`, a branch with no upstream and one commit. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "wp-pushterm-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const bare = join(root, "origin.git"), a = join(root, "a");
  g(root, "init", "-q", "--bare", "-b", "main", bare);
  g(root, "clone", "-q", bare, a);
  g(a, "checkout", "-q", "-b", "main");
  g(a, "commit", "-q", "--allow-empty", "-m", "one");
  g(a, "push", "-q", "-u", "origin", "main");
  g(a, "checkout", "-q", "-b", "nou");
  g(a, "commit", "-q", "--allow-empty", "-m", "two");
  return { root, a, sha: g(a, "rev-parse", "HEAD") };
}

function ctxOver(store) {
  return {
    attention: store,
    notify: (_k, p) => p.outcome === "failed" && store.add({ id: Math.random().toString(36).slice(2, 10), ts: Date.now(), kind: "git", title: p.title, body: p.body, key: p.key }, { detail: p.detail, pushHead: p.pushHead }),
    resolveAttention: (k, note) => store.resolve(k, note),
  };
}
const ref = { id: "rid", name: "a" };
const fail = (ctx, a, head) => reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: false, error: "FAILED: lint", head, startedAt: 0, finishedAt: 1 }, ctx);

test("pushedAlready: a branch with no upstream, pushed without -u, is on its remote", async () => {
  const { a, sha } = repo();
  assert.equal(await pushedAlready(a, "nou", sha), undefined, "nothing to compare against yet: unknown");
  g(a, "push", "-q", "origin", "nou");
  assert.equal(await pushedAlready(a, "nou", sha), true);
});

test("pushedAlready: after --amend, the branch's tip on its remote resolves the old sha", async () => {
  const { a, sha } = repo();
  g(a, "push", "-q", "-u", "origin", "nou");
  g(a, "commit", "-q", "--allow-empty", "-m", "three");
  const failed = g(a, "rev-parse", "HEAD");
  assert.equal(await pushedAlready(a, "nou", failed), false);
  g(a, "commit", "-q", "--amend", "--allow-empty", "-m", "three, amended");
  g(a, "push", "-q", "-f");
  assert.notEqual(g(a, "rev-parse", "HEAD"), failed);
  assert.equal(await pushedAlready(a, "nou", failed), true, "the branch went up; the failed commit is moot");
  assert.ok(sha);
});

test("pushedAlready: a reset BACK onto the remote is not a push — the failed commit stays open", async () => {
  const { a } = repo();
  g(a, "push", "-q", "-u", "origin", "nou");
  g(a, "commit", "-q", "--allow-empty", "-m", "three");
  const failed = g(a, "rev-parse", "HEAD");
  g(a, "reset", "-q", "--soft", "HEAD~1"); // tip is now the commit origin/nou already holds
  assert.equal(await pushedAlready(a, "nou", failed), false, "F is uncommitted and unpushed");
  g(a, "reset", "-q", "--hard", "HEAD");
  assert.equal(await pushedAlready(a, "nou", failed), false);
});

test("settlePushFailures: a reset back after the failure leaves it standing; the amend still clears", async () => {
  const { a } = repo();
  g(a, "push", "-q", "-u", "origin", "nou");
  g(a, "commit", "-q", "--allow-empty", "-m", "three");
  const failed = g(a, "rev-parse", "HEAD");
  const store = new AttentionStore(null), ctx = ctxOver(store);
  await fail(ctx, a, { branch: "nou", sha: failed });
  const deps = { ...ctx, worktrees: async () => new Map([["rid", a]]) };
  g(a, "reset", "-q", "--soft", "HEAD~1");
  await settlePushFailures(deps);
  assert.equal(store.unhandled().length, 1, "the work is not on the remote");
  g(a, "commit", "-q", "--allow-empty", "-m", "three, again");
  g(a, "push", "-q");
  await settlePushFailures(deps);
  assert.equal(store.unhandled().length, 0, "a replacement of F went up");
});

test("pushedAlready: a branch tracking a DIFFERENT name reads where its pushes go (push.default=current)", async () => {
  const { a } = repo();
  g(a, "checkout", "-q", "-b", "feat", "main");
  g(a, "branch", "-q", "--set-upstream-to=origin/main", "feat");
  g(a, "config", "push.default", "current");
  g(a, "commit", "-q", "--allow-empty", "-m", "f");
  const f = g(a, "rev-parse", "HEAD");
  assert.equal(await pushedAlready(a, "feat", f), undefined, "nothing at origin/feat yet");
  g(a, "push", "-q"); // current: lands on origin/feat, never origin/main
  assert.equal(await pushedAlready(a, "feat", f), true);
});

test("pushedAlready: a triangular branch (pushRemote) reads its PUSH remote, not its upstream", async () => {
  const { root, a } = repo();
  const fork = join(root, "fork.git");
  g(root, "init", "-q", "--bare", "-b", "main", fork);
  g(a, "remote", "add", "fork", fork);
  g(a, "push", "-q", "-u", "origin", "nou");
  g(a, "config", "branch.nou.pushRemote", "fork");
  g(a, "commit", "-q", "--allow-empty", "-m", "three");
  const f = g(a, "rev-parse", "HEAD");
  g(a, "push", "-q"); // simple + triangular: fork/nou
  assert.equal(g(a, "rev-parse", "origin/nou") === f, false, "the upstream did not move");
  assert.equal(await pushedAlready(a, "nou", f), true);
});

test("pushedAlready: a LOCAL upstream (branch.X.remote = .) is not a remote — never a yes off it", async () => {
  const { a, sha } = repo();
  g(a, "checkout", "-q", "main");
  g(a, "merge", "-q", "--ff-only", "nou"); // main now holds nou's commit, locally only
  g(a, "branch", "-q", "--set-upstream-to=main", "nou");
  assert.notEqual(await pushedAlready(a, "nou", sha), true);
});

test("settlePushFailures: a terminal push clears the failure with no host-run git outcome at all", async () => {
  const { a, sha } = repo();
  const store = new AttentionStore(null), ctx = ctxOver(store);
  await fail(ctx, a, { branch: "nou", sha });
  assert.equal(store.unhandled().length, 1);
  const asked = [];
  const deps = { ...ctx, worktrees: async () => { asked.push(1); return new Map([["rid", a]]); } };
  await settlePushFailures(deps);
  assert.equal(store.unhandled().length, 1, "not pushed yet: it stands");
  g(a, "push", "-q", "origin", "nou"); // from a terminal, no -u
  await settlePushFailures(deps);
  assert.equal(store.unhandled().length, 0);
  assert.match(store.items()[0].handled.note, /nou/);
});

test("settlePushFailures: amend + force-push from a terminal clears it", async () => {
  const { a } = repo();
  g(a, "push", "-q", "-u", "origin", "nou");
  g(a, "commit", "-q", "--allow-empty", "-m", "three");
  const failed = g(a, "rev-parse", "HEAD");
  const store = new AttentionStore(null), ctx = ctxOver(store);
  await fail(ctx, a, { branch: "nou", sha: failed });
  g(a, "commit", "-q", "--amend", "--allow-empty", "-m", "three, amended");
  g(a, "push", "-q", "-f");
  await settlePushFailures({ ...ctx, worktrees: async () => new Map([["rid", a]]) });
  assert.equal(store.unhandled().length, 0);
});

test("settlePushFailures: nothing open ⇒ no worktree lookup, no git", async () => {
  const store = new AttentionStore(null);
  let asked = 0;
  await settlePushFailures({ ...ctxOver(store), worktrees: async () => { asked++; return new Map(); } });
  assert.equal(asked, 0);
  // A pull failure is not a push failure: still nothing to look up.
  store.add({ id: "p", ts: 1, kind: "git", title: "t", body: "b", key: gitAttentionKey("rid", "pull") });
  await settlePushFailures({ ...ctxOver(store), worktrees: async () => { asked++; return new Map(); } });
  assert.equal(asked, 0);
});
