/**
 * A failed push is a fact about ONE branch and ONE commit (bughunt 2026-10-29 PR-7).
 *
 * The failure is filed with the branch and the sha that failed to go up, and it is resolved
 * only when that sha is reachable from that branch's upstream — checked when a host-run pull
 * or push ends, never inside `GET /api/repos`. Switching to another, in-sync branch and pushing
 * or pulling there must not clear it; the commit reaching its upstream another way does. A
 * record kept before the identity existed is cleared, as it always was, by the next push that
 * succeeds (or the person).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AttentionStore, pushFailureHead } = await import("../dist/attentionstore.js");
const { reportGitOutcome } = await import("../dist/gitnotify.js");
const { pushedAlready } = await import("../dist/pushreach.js");
const { createClients } = await import("../dist/server/clients.js");
const { gitAttentionKey } = await import("@waterplane/shared");

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, stdio: "pipe" }).toString().trim();

/** origin.git + a clone `a` on main (pushed), and `feature` with one commit NOT pushed. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "wp-pushid-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const bare = join(root, "origin.git"), a = join(root, "a");
  g(root, "init", "-q", "--bare", "-b", "main", bare);
  g(root, "clone", "-q", bare, a);
  g(a, "checkout", "-q", "-b", "main");
  g(a, "commit", "-q", "--allow-empty", "-m", "one");
  g(a, "push", "-q", "-u", "origin", "main");
  g(a, "checkout", "-q", "-b", "feature");
  g(a, "push", "-q", "-u", "origin", "feature");
  g(a, "commit", "-q", "--allow-empty", "-m", "two");
  return { root, a, sha: g(a, "rev-parse", "HEAD") };
}

/** A ctx over a real (memory) attention store, as `main.ts` wires it. */
function ctxOver(store) {
  return {
    attention: store,
    notify: (_k, p) => p.outcome === "failed" && store.add({ id: Math.random().toString(36).slice(2, 10), ts: Date.now(), kind: "git", title: p.title, body: p.body, key: p.key }, { detail: p.detail, pushHead: p.pushHead }),
    resolveAttention: (k, note) => store.resolve(k, note),
  };
}
const ref = { id: "rid", name: "a" };
const key = gitAttentionKey("rid", "push");

test("pushedAlready: the sha on its branch's upstream, or not, or unknown", async () => {
  const { a, sha } = repo();
  assert.equal(await pushedAlready(a, "feature", sha), false);
  g(a, "push", "-q");
  assert.equal(await pushedAlready(a, "feature", sha), true);
  assert.equal(await pushedAlready(a, "nope", sha), undefined, "no such branch: unknown, never a yes");
  assert.equal(await pushedAlready(a, "-x", sha), undefined);
  assert.equal(await pushedAlready(a, "feature", "not-a-sha"), undefined);
});

test("a failed push is filed with its branch and sha, and a push of ANOTHER branch does not clear it", async () => {
  const { a, sha } = repo();
  const store = new AttentionStore(null), ctx = ctxOver(store);
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: false, error: "FAILED: lint", head: { branch: "feature", sha }, startedAt: 0, finishedAt: 1 }, ctx);
  assert.deepEqual(pushFailureHead(store, "rid"), { branch: "feature", sha });
  // The person switches to main (in sync) and a push there succeeds.
  g(a, "checkout", "-q", "main");
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: true, head: { branch: "main", sha: g(a, "rev-parse", "HEAD") }, startedAt: 0, finishedAt: 1 }, ctx);
  assert.equal(store.unhandled().length, 1, "feature's commit never went up — the failure stands");
  await reportGitOutcome({ repo: ref, wt: a, verb: "pull", ok: true, startedAt: 0, finishedAt: 1 }, ctx);
  assert.equal(store.unhandled().length, 1, "nor does a pull on main clear it");
});

test("the failed commit reaching its upstream another way clears it when a pull or push ends", async () => {
  const { a, sha } = repo();
  const store = new AttentionStore(null), ctx = ctxOver(store);
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: false, error: "x", head: { branch: "feature", sha }, startedAt: 0, finishedAt: 1 }, ctx);
  g(a, "push", "-q"); // from a terminal
  g(a, "checkout", "-q", "main");
  await reportGitOutcome({ repo: ref, wt: a, verb: "pull", ok: true, startedAt: 0, finishedAt: 1 }, ctx);
  assert.equal(store.unhandled().length, 0);
  assert.match(store.items()[0].handled.note, /feature.*another way/);
});

test("a push of the SAME branch that succeeds clears it; a failed pull checks nothing", async () => {
  const { a, sha } = repo();
  const store = new AttentionStore(null), ctx = ctxOver(store);
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: false, error: "x", head: { branch: "feature", sha }, startedAt: 0, finishedAt: 1 }, ctx);
  g(a, "push", "-q");
  await reportGitOutcome({ repo: ref, wt: a, verb: "pull", ok: false, error: "fetch failed", startedAt: 0, finishedAt: 1 }, ctx);
  assert.equal(store.unhandled().filter((r) => r.item.key === key).length, 1, "a failed pull proves nothing");
  // An amended commit pushed on the same branch: the sha is gone, the branch went up.
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: true, head: { branch: "feature", sha: "f".repeat(40) }, startedAt: 0, finishedAt: 1 }, ctx);
  assert.equal(store.unhandled().filter((r) => r.item.key === key).length, 0);
});

test("a record from before the identity (no branch/sha) is cleared by the next push that succeeds, as before", async () => {
  const { root, a } = repo();
  const file = join(root, "state");
  // The on-disk shape an older host wrote: extras with only `detail`.
  const store0 = new AttentionStore(file);
  store0.add({ id: "old1", ts: 1, kind: "git", title: "Push failed · a", body: "x", key }, { detail: "x" });
  const store = new AttentionStore(file);
  assert.equal(pushFailureHead(store, "rid"), undefined);
  const ctx = ctxOver(store);
  await reportGitOutcome({ repo: ref, wt: a, verb: "pull", ok: true, startedAt: 0, finishedAt: 1 }, ctx);
  assert.equal(store.unhandled().length, 1, "a pull cannot know which commit an old record meant");
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: true, head: { branch: "main", sha: g(a, "rev-parse", "HEAD") }, startedAt: 0, finishedAt: 1 }, ctx);
  assert.equal(store.unhandled().length, 0);
});

test("the identity is kept on disk beside the item, never on the wire item", () => {
  const root = mkdtempSync(join(tmpdir(), "wp-pushid-store-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const c = createClients({
    auth: { passive: {} }, notifyPrefs: { enabled: () => true, pushInfo: () => false, get: () => ({}) },
    push: { notify: () => {} }, sessions: { list: () => [] }, attention: new AttentionStore(root),
  });
  const sha = "a".repeat(40);
  c.notify("git", { title: "Push failed · a", body: "x", outcome: "failed", key, detail: "x", pushHead: { branch: "feature", sha } });
  assert.equal("pushHead" in c.attention.items()[0], false);
  assert.deepEqual(pushFailureHead(new AttentionStore(root), "rid"), { branch: "feature", sha });
});

test("GET /api/repos clears nothing: the listing no longer resolves attention", () => {
  const src = readFileSync(new URL("../src/routes/apihost.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /resolveAttention\(/, "a side effect inside a GET (CLAUDE.md)");
});

// Review A3b: a repo had ONE push-failure slot, so a failure on another branch handed this
// branch's off as "replaced by a newer one" while its commits never went up. The slot is per branch.
test("feature fails, fix fails, fix then pushes fine: feature's failure still stands", async () => {
  const { a, sha } = repo();
  const store = new AttentionStore(null), ctx = ctxOver(store);
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: false, error: "FAILED: lint", head: { branch: "feature", sha }, startedAt: 0, finishedAt: 1 }, ctx);
  g(a, "checkout", "-q", "-b", "fix", "main");
  g(a, "commit", "-q", "--allow-empty", "-m", "fix one");
  const fixSha = g(a, "rev-parse", "HEAD");
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: false, error: "FAILED: test", head: { branch: "fix", sha: fixSha }, startedAt: 2, finishedAt: 3 }, ctx);
  assert.equal(store.unhandled().length, 2, "two branches, two failures — neither replaces the other");
  assert.deepEqual(pushFailureHead(store, "rid"), { branch: "fix", sha: fixSha }, "the newest is the one shown");
  g(a, "push", "-q", "-u", "origin", "fix");
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: true, head: { branch: "fix", sha: fixSha }, startedAt: 4, finishedAt: 5 }, ctx);
  const left = store.unhandled();
  assert.equal(left.length, 1);
  assert.deepEqual(left[0].extras.pushHead, { branch: "feature", sha }, "feature's commit never went up");
  assert.deepEqual(pushFailureHead(store, "rid"), { branch: "feature", sha });
  assert.ok(!store.items().some((i) => i.handled?.note === "replaced by a newer one"), "nothing claimed a replacement");
});

test("every branch's failure is checked when a pull or push ends, each against its own upstream", async () => {
  const { a, sha } = repo();
  const store = new AttentionStore(null), ctx = ctxOver(store);
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: false, error: "x", head: { branch: "feature", sha }, startedAt: 0, finishedAt: 1 }, ctx);
  g(a, "checkout", "-q", "-b", "fix", "main");
  g(a, "push", "-q", "-u", "origin", "fix");
  g(a, "commit", "-q", "--allow-empty", "-m", "fix one");
  const fixSha = g(a, "rev-parse", "HEAD");
  await reportGitOutcome({ repo: ref, wt: a, verb: "push", ok: false, error: "y", head: { branch: "fix", sha: fixSha }, startedAt: 2, finishedAt: 3 }, ctx);
  assert.equal(store.unhandled().length, 2);
  g(a, "checkout", "-q", "feature");
  g(a, "push", "-q"); // feature, the OLDER failure, goes up from a terminal
  await reportGitOutcome({ repo: ref, wt: a, verb: "pull", ok: true, startedAt: 4, finishedAt: 5 }, ctx);
  assert.deepEqual(store.unhandled().map((r) => r.extras.pushHead.branch), ["fix"]);
});

test("the slot is the branch: the identity key is gitPushFailureKey, the wire key stays per repo", async () => {
  const { gitPushFailureKey } = await import("@waterplane/shared");
  const { attentionIdentity } = await import("../dist/attentionstore.js");
  assert.equal(gitPushFailureKey("rid"), key);
  assert.equal(gitPushFailureKey("rid", "feature"), `${key}:feature`);
  const store = new AttentionStore(null);
  store.add({ id: "p1", ts: 1, kind: "git", title: "t", body: "b", key }, { pushHead: { branch: "feature", sha: "a".repeat(40) } });
  store.add({ id: "p0", ts: 0, kind: "git", title: "t", body: "b", key }, { pushHead: { branch: "x", sha: "nope" } });
  assert.equal(store.items()[1].key, key, "the phone reads repo and verb off the wire key");
  assert.equal(attentionIdentity(store.unhandled()[1]), gitPushFailureKey("rid", "feature"));
  assert.equal(attentionIdentity(store.unhandled()[0]), key, "a malformed head is an unknown branch");
});

test("startPush hands the outcome the branch and commit it tried to send", async () => {
  const { setGitOutcomeSink, startPush } = await import("../dist/git.js");
  const { a, sha } = repo();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(a, ".git/hooks/pre-push"), "#!/bin/sh\necho 'FAILED: lint'\nexit 1\n", { mode: 0o755 });
  const seen = [];
  setGitOutcomeSink((o) => { seen.push(o); });
  try { await startPush(a, ref).done; } finally { setGitOutcomeSink(null); }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, false);
  assert.deepEqual(seen[0].head, { branch: "feature", sha }, "dropping head would fall back to any-push-clears-it");
});

test("pushedAlready: a real branch with no upstream is unknown, never a yes or a no", async () => {
  const { a } = repo();
  g(a, "checkout", "-q", "-b", "local-only");
  g(a, "commit", "-q", "--allow-empty", "-m", "three");
  assert.equal(await pushedAlready(a, "local-only", g(a, "rev-parse", "HEAD")), undefined);
});

test("the tray tag is per branch for a push, so B's receipt never collapses A's failure", async () => {
  const tags = [];
  const ctx = { notify: (_k, p) => tags.push(p.tag), resolveAttention: () => 0 };
  await reportGitOutcome({ repo: ref, verb: "push", ok: false, error: "x", head: { branch: "feature", sha: "a".repeat(40) }, startedAt: 0, finishedAt: 1 }, ctx);
  await reportGitOutcome({ repo: ref, verb: "push", ok: true, head: { branch: "fix", sha: "b".repeat(40) }, startedAt: 0, finishedAt: 1 }, ctx);
  await reportGitOutcome({ repo: ref, verb: "push", ok: false, error: "x", startedAt: 0, finishedAt: 1 }, ctx);
  assert.deepEqual(tags, ["git-rid-push-feature", "git-rid-push-fix", "git-rid-push"]);
});

test("the branch rides the wire item as its own field; the key stays the frozen per-repo form", async () => {
  const { parseAttentionKey } = await import("@waterplane/shared");
  const store = new AttentionStore(null);
  store.add({ id: "p1", ts: 1, kind: "git", title: "t", body: "b", key }, { pushHead: { branch: "feature", sha: "a".repeat(40) } });
  store.add({ id: "p2", ts: 2, kind: "git", title: "t", body: "b", key }, { pushHead: { branch: "x:y", sha: "a".repeat(40) } });
  store.add({ id: "p3", ts: 3, kind: "git", title: "t", body: "b", key });
  const byId = Object.fromEntries(store.items().map((i) => [i.id, i]));
  assert.equal(byId.p1.branch, "feature");
  assert.equal(byId.p2.branch, undefined, "a head the host would not file under is no branch on the wire");
  assert.equal(byId.p3.branch, undefined, "detached / older: absent, never a guess");
  for (const i of store.items()) assert.deepEqual(parseAttentionKey(i.key), { kind: "git", repoId: "rid", verb: "push" });
});

test("gitFailuresFor: every unhandled failure of the worktree, newest first, each with its branch — the git view picks the tapped one", async () => {
  const { gitFailuresFor, gitFailedFor } = await import("../dist/attentionstore.js");
  const store = new AttentionStore(null);
  store.add({ id: "P", ts: 0, kind: "git", title: "t", body: "p", key: gitAttentionKey("rid", "pull") });
  store.add({ id: "A", ts: 1, kind: "git", title: "t", body: "a", key }, { detail: "A's log", pushHead: { branch: "feature", sha: "a".repeat(40) } });
  store.add({ id: "B", ts: 2, kind: "git", title: "t", body: "b", key }, { detail: "B's log", pushHead: { branch: "fix", sha: "b".repeat(40) } });
  store.add({ id: "O", ts: 3, kind: "git", title: "t", body: "o", key: gitAttentionKey("other", "push") });
  assert.deepEqual(gitFailuresFor(store, "rid"), [
    { verb: "push", at: 2, error: "B's log", id: "B", branch: "fix" },
    { verb: "push", at: 1, error: "A's log", id: "A", branch: "feature" },
    { verb: "pull", at: 0, error: "p", id: "P" },
  ]);
  assert.deepEqual(gitFailedFor(store, "rid"), gitFailuresFor(store, "rid")[0], "the chip's one record is the list's head");
});

// A branchless failure (a push from a detached HEAD, or a record an older host kept) sits in the
// tray under the bare tag, and a successful push clears it — the git view's sentence for it is
// "A push that goes through clears it", so words and behaviour agree (review A3c ML2). The
// receipt takes the tray tag of the slot it cleared: the branch's own when it cleared that, the
// bare one when the bare record was all it cleared.
function tagged(store) {
  const tags = [];
  const base = ctxOver(store);
  return { tags, ctx: { ...base, notify: (k, p) => { tags.push(`${p.outcome} ${p.tag}`); base.notify(k, p); } } };
}

test("a successful push clears the branchless record, and its receipt replaces that tray entry", async () => {
  for (const head of [undefined, { branch: "fix", sha: "b".repeat(40) }]) {
    const store = new AttentionStore(null);
    const { tags, ctx } = tagged(store);
    await reportGitOutcome({ repo: ref, verb: "push", ok: false, error: "x", startedAt: 0, finishedAt: 1 }, ctx);
    assert.equal(store.unhandled().length, 1);
    await reportGitOutcome({ repo: ref, verb: "push", ok: true, ...(head ? { head } : {}), startedAt: 2, finishedAt: 3 }, ctx);
    assert.equal(store.unhandled().length, 0, `cleared by a ${head ? "branch" : "detached"} push`);
    assert.deepEqual(tags, ["failed git-rid-push", "ok git-rid-push"], "the receipt took the failure's tray slot");
  }
});

test("with its own branch's failure open too, a push clears BOTH; the receipt takes the branch's tray slot", async () => {
  const store = new AttentionStore(null);
  const { tags, ctx } = tagged(store);
  const fix = { branch: "fix", sha: "b".repeat(40) };
  await reportGitOutcome({ repo: ref, verb: "push", ok: false, error: "x", startedAt: 0, finishedAt: 1 }, ctx);
  await reportGitOutcome({ repo: ref, verb: "push", ok: false, error: "y", head: fix, startedAt: 0, finishedAt: 1 }, ctx);
  await reportGitOutcome({ repo: ref, verb: "push", ok: true, head: fix, startedAt: 2, finishedAt: 3 }, ctx);
  assert.equal(store.unhandled().length, 0, "the branchless one went with it: 'a push that goes through clears it'");
  assert.deepEqual(tags, ["failed git-rid-push", "failed git-rid-push-fix", "ok git-rid-push-fix"]);
});

test("another branch's failure is never cleared by the bare rule", async () => {
  const store = new AttentionStore(null);
  const { ctx } = tagged(store);
  await reportGitOutcome({ repo: ref, verb: "push", ok: false, error: "x", head: { branch: "feature", sha: "a".repeat(40) }, startedAt: 0, finishedAt: 1 }, ctx);
  await reportGitOutcome({ repo: ref, verb: "push", ok: false, error: "x", startedAt: 0, finishedAt: 1 }, ctx);
  await reportGitOutcome({ repo: ref, verb: "push", ok: true, head: { branch: "fix", sha: "b".repeat(40) }, startedAt: 2, finishedAt: 3 }, ctx);
  assert.deepEqual(store.unhandled().map((r) => r.extras?.pushHead?.branch), ["feature"]);
});
