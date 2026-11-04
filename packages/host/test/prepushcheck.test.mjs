// The pre-push hook run without a push, on a real repo with a real hook: what the hook is fed,
// which commit a verdict lands on, and that nothing reaches the remote.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookVerdict, prePushFacts, readChecks, runCheck, withVerdict } from "../dist/prepushcheck.js";
import { gitPush } from "../dist/git.js";
import { gitLog } from "../dist/gitlog.js";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

/** A clone with three outgoing commits a, b, c; `verdict` is the file the hook exits by. */
function repo(hook = `#!/bin/sh\ncat > "$(git rev-parse --git-common-dir)/seen"\necho "$1 $2" >> "$(git rev-parse --git-common-dir)/seen"\nexit "$(cat exit-code 2>/dev/null || echo 0)"\n`) {
  const root = mkdtempSync(join(tmpdir(), "prepush-"));
  dirs.push(root);
  const bare = join(root, "origin.git"), wt = join(root, "wt");
  g(root, "init", "-q", "--bare", "-b", "main", bare);
  g(root, "clone", "-q", bare, wt);
  g(wt, "config", "user.email", "t@t"); g(wt, "config", "user.name", "t");
  g(wt, "checkout", "-q", "-b", "main");
  writeFileSync(join(wt, ".gitignore"), "exit-code\n");
  g(wt, "add", "."); g(wt, "commit", "-qm", "base"); g(wt, "push", "-q", "-u", "origin", "main");
  const shas = ["a", "b", "c"].map((n) => { writeFileSync(join(wt, n), n); g(wt, "add", n); g(wt, "commit", "-qm", n); return g(wt, "rev-parse", "HEAD"); });
  if (hook) { const p = join(wt, ".git/hooks/pre-push"); writeFileSync(p, hook); chmodSync(p, 0o755); }
  return { wt, bare, shas, remoteTip: () => g(bare, "rev-parse", "main"), base: g(bare, "rev-parse", "main") };
}

test("a run feeds the hook what a push would, pushes nothing, and marks HEAD", async () => {
  const r = repo();
  const out = await runCheck(r.wt, undefined);
  assert.equal(out.ok, true);
  assert.match(out.output, /Nothing was pushed/);
  assert.equal(r.remoteTip(), r.base);
  const seen = readFileSync(join(r.wt, ".git/seen"), "utf8");
  assert.ok(seen.startsWith(`refs/heads/main ${r.shas[2]} refs/heads/main ${r.base}\n`), seen);
  assert.match(seen, /^origin .*origin\.git$/m);
  assert.equal((await readChecks(r.wt))[r.shas[2]].ok, true);
  const log = await gitLog(r.wt);
  assert.equal(log.outgoing[0].check.ok, true);
  assert.equal(log.outgoing[1].check, undefined);
  assert.deepEqual(log.prePush, { testsCommit: false });
});

test("a failing hook marks the commit failed and returns its words", async () => {
  const r = repo();
  writeFileSync(join(r.wt, "exit-code"), "1");
  const out = await runCheck(r.wt, undefined);
  assert.equal(out.ok, false);
  assert.equal((await readChecks(r.wt))[r.shas[2]].ok, false);
});

test("a hook that tests the tree: uncommitted changes mark nothing, an older commit is refused", async () => {
  const r = repo();
  writeFileSync(join(r.wt, "dirty"), "x");
  const out = await runCheck(r.wt, undefined);
  assert.equal(out.ok, true);
  assert.match(out.output, /no commit got this verdict/);
  assert.deepEqual(await readChecks(r.wt), {});
  const older = await runCheck(r.wt, r.shas[0]);
  assert.equal(older.ok, false);
  assert.match(older.error, /working tree/);
  assert.deepEqual(await readChecks(r.wt), {});
});

test("a hook that tests the commit: a chosen commit gets its verdict, dirty tree or not", async () => {
  const r = repo();
  g(r.wt, "config", "waterplane.prePushTestsCommit", "true");
  writeFileSync(join(r.wt, "dirty"), "x");
  assert.equal((await runCheck(r.wt, r.shas[0])).ok, true);
  assert.ok(readFileSync(join(r.wt, ".git/seen"), "utf8").startsWith(`refs/heads/main ${r.shas[0]} `));
  assert.deepEqual(Object.keys(await readChecks(r.wt)), [r.shas[0]]);
});

test("a commit already on the remote is not checkable", async () => {
  const r = repo();
  g(r.wt, "config", "waterplane.prePushTestsCommit", "true");
  const out = await runCheck(r.wt, r.base);
  assert.equal(out.ok, false);
  assert.match(out.error, /no longer waiting/);
});

test("no hook: said, and nothing is marked", async () => {
  const r = repo(null);
  assert.equal(await prePushFacts(r.wt), undefined);
  const out = await runCheck(r.wt, undefined);
  assert.match(out.output, /no pre-push hook/);
  assert.deepEqual(await readChecks(r.wt), {});
});

test("a push up to a commit sends it and the older ones, through the hook, and leaves the rest", async () => {
  const r = repo();
  g(r.wt, "config", "waterplane.prePushTestsCommit", "true");
  const out = await gitPush(r.wt, undefined, r.shas[1]);
  assert.equal(out.ok, true, out.error);
  assert.equal(r.remoteTip(), r.shas[1]);
  assert.equal(g(r.wt, "rev-parse", "HEAD"), r.shas[2]);
  assert.equal(g(r.wt, "rev-list", "--count", "@{u}..HEAD"), "1");
  assert.ok(readFileSync(join(r.wt, ".git/seen"), "utf8").includes(r.shas[1]), "the hook ran");
});

test("a push up to a commit: refused where the hook would judge the wrong code, and when not outgoing", async () => {
  const r = repo();
  const tree = await gitPush(r.wt, undefined, r.shas[1]);
  assert.equal(tree.ok, false);
  assert.match(tree.error, /working tree/);
  assert.equal(r.remoteTip(), r.base);
  g(r.wt, "config", "waterplane.prePushTestsCommit", "true");
  const gone = await gitPush(r.wt, undefined, r.base);
  assert.equal(gone.ok, false);
  assert.match(gone.error, /no longer waiting/);
});

test("a run that was stopped is no verdict either way", () => {
  assert.equal(hookVerdict(0, "local CI passed"), true);
  assert.equal(hookVerdict(1, "FAILED: unit (exit 1)"), false);
  assert.equal(hookVerdict(0, "local-ci: skipped (SKIP_LOCAL_CI=1)\n"), null);
  assert.equal(hookVerdict(1, "\x1b[33mlocal-ci: superseded -- a newer push\x1b[0m\n"), null);
  assert.equal(hookVerdict(130, "local-ci: interrupted"), null);
  assert.equal(hookVerdict(null, ""), null);
});

test("the store keeps the newest", () => {
  const all = withVerdict({ old: { ok: true, at: 1 }, mid: { ok: true, at: 2 } }, "new", { ok: false, at: 3 }, 2);
  assert.deepEqual(Object.keys(all).sort(), ["mid", "new"]);
});
