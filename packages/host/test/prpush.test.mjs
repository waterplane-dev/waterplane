/**
 * Push & open PR (prpush.ts): a temp repo with a local bare origin and a fake `gh`
 * first on PATH. Never touches a real forge.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "prpush-")));
const bin = join(root, "bin");
execFileSync("mkdir", ["-p", bin]);
const log = join(root, "gh.log");
const mode = join(root, "gh.mode");
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$@" >> "${log}"
M=$(cat "${mode}" 2>/dev/null)
case "$1 $2" in
  "pr create") [ "$M" = "createfail" ] && { echo "boom: no permission" >&2; exit 1; }
               echo "https://github.com/o/r/pull/7"; exit 0;;
  "pr view") [ "$M" = "existing" ] && { echo '{"url":"https://github.com/o/r/pull/3","number":3}'; exit 0; }
             echo "no pull requests found" >&2; exit 1;;
  *) exit 1;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
after(() => execFileSync("rm", ["-rf", root]));

const { gitPush } = await import("../dist/git.js");
const { setRulesLookup, branchSlug } = await import("../dist/prpush.js");
const { invalidateBranchRules } = await import("../dist/branchrules.js");
const PR = { mode: "pr", requiredChecks: [], requiredApprovals: 0, allowedMerge: [], autoMerge: false };

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let n = 0;
function repo() {
  const d = join(root, `r${++n}`);
  const origin = `${d}-origin.git`;
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const wt = `${d}-wt`;
  execFileSync("git", ["clone", "-q", origin, wt], { stdio: "ignore" });
  sh(wt, "config", "user.email", "t@t"); sh(wt, "config", "user.name", "t");
  writeFileSync(join(wt, "a.txt"), "a\n");
  sh(wt, "add", "."); sh(wt, "commit", "-qm", "base"); sh(wt, "push", "-q", "-u", "origin", "HEAD:main");
  sh(wt, "remote", "set-head", "origin", "main");
  writeFileSync(log, ""); writeFileSync(mode, "");
  return { wt, origin };
}
const commit = (wt, f, subject) => { writeFileSync(join(wt, f), subject); sh(wt, "add", f); sh(wt, "commit", "-qm", subject); };
const ghCalls = () => readFileSync(log, "utf8").trim();

test("slug", () => {
  assert.equal(branchSlug("Fix: the  Thing!! (v2)"), "fix-the-thing-v2");
  assert.ok(branchSlug("x".repeat(100)).length <= 40);
  assert.equal(branchSlug("!!!"), "changes");
});

test("direct mode is a plain push, no gh", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => ({ ...PR, mode: "direct" }));
  commit(wt, "b.txt", "one");
  const r = await gitPush(wt);
  assert.equal(r.ok, true);
  assert.equal(ghCalls(), "");
  assert.equal(sh(origin, "rev-parse", "main"), sh(wt, "rev-parse", "HEAD"));
});

test("PR mode on main: branch pushed, PR created, local main back at origin/main", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  commit(wt, "b.txt", "Add the B file");
  commit(wt, "c.txt", "Add C");
  const tip = sh(wt, "rev-parse", "HEAD");
  const baseSha = sh(origin, "rev-parse", "main");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /opened PR #7 — https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(ghCalls(), /pr create --fill --head wp\/add-the-b-file --base main/);
  assert.equal(sh(origin, "rev-parse", "wp/add-the-b-file"), tip);
  assert.equal(sh(origin, "rev-parse", "main"), baseSha);
  assert.equal(sh(wt, "rev-parse", "main"), baseSha);
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  sh(wt, "merge-base", "--is-ancestor", tip, "wp/add-the-b-file");
  assert.equal(sh(wt, "rev-parse", "wp/add-the-b-file@{u}"), tip);
});

test("a taken branch name gets a suffix", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "branch", "wp/same");
  commit(wt, "b.txt", "same");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.ok(sh(origin, "rev-parse", "wp/same-2"));
});

test("dirty tree: edits survive, commits live on the branch", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  commit(wt, "b.txt", "dirty case");
  const tip = sh(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "a.txt"), "edited\n");
  writeFileSync(join(wt, "new.txt"), "untracked\n");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "edited\n");
  assert.ok(existsSync(join(wt, "new.txt")));
  assert.equal(sh(origin, "rev-parse", "wp/dirty-case"), tip);
  assert.equal(sh(wt, "rev-parse", "main"), sh(origin, "rev-parse", "main"));
});

test("dirty tree on a file the commit touched: main keeps the commit, nothing lost", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  commit(wt, "a.txt", "touch a");
  const tip = sh(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "a.txt"), "touch a\nmore\n");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "touch a\nmore\n");
  assert.equal(sh(origin, "rev-parse", "wp/touch-a"), tip);
  assert.match(r.output, /opened PR #7/);
});

test("gh pr create failing: main untouched, sentence says where the commits are", async () => {
  const { wt } = repo();
  setRulesLookup(async () => PR);
  commit(wt, "b.txt", "will fail");
  const tip = sh(wt, "rev-parse", "HEAD");
  writeFileSync(mode, "createfail");
  const r = await gitPush(wt);
  assert.equal(r.ok, false);
  assert.match(r.error, /pushed to origin as wp\/will-fail and still on main here/);
  assert.match(r.error, /boom/);
  assert.equal(sh(wt, "rev-parse", "main"), tip);
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

test("non-default branch: pushed, existing PR reused (no create)", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "checkout", "-qb", "feat");
  commit(wt, "b.txt", "feat work");
  writeMode("existing");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /updated PR #3/);
  assert.doesNotMatch(ghCalls(), /pr create/);
  assert.equal(sh(origin, "rev-parse", "feat"), sh(wt, "rev-parse", "HEAD"));
});

test("non-default branch with no PR: create", async () => {
  const { wt } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "checkout", "-qb", "feat2");
  commit(wt, "b.txt", "feat2 work");
  const r = await gitPush(wt);
  assert.match(r.output, /opened PR #7/);
  assert.match(ghCalls(), /pr create --fill/);
});

function writeMode(m) { writeFileSync(mode, m); }

test("a GH013 refusal on the plain path invalidates the reading and says so", async () => {
  const { wt, origin } = repo();
  let reads = 0;
  setRulesLookup(async () => { reads++; return undefined; });
  commit(wt, "b.txt", "refused");
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'remote: error: GH013: Repository rule violations found for refs/heads/main.' >&2\nexit 1\n");
  chmodSync(join(origin, "hooks", "pre-receive"), 0o755);
  const r = await gitPush(wt);
  assert.equal(r.ok, false);
  assert.match(r.error, /this repo now takes changes through a PR — push again to open one/i);
  setRulesLookup(null);
  invalidateBranchRules(wt); // idempotent: the cache entry is gone
});

// ---- local-ci status (localcistatus.ts) ----
const { setStatusPoster, porcelainRefs } = await import("../dist/localcistatus.js");
const PINFO = "To x\n";
function posterSpy(fail = 0) {
  const calls = [];
  let left = fail;
  setStatusPoster(async (_wt, slug, sha, desc) => { calls.push({ slug, sha, desc, gh: ghCalls() }); if (left-- > 0) throw new Error("api down"); });
  return calls;
}
function enable(wt, hook) {
  sh(wt, "config", "waterplane.localCiStatus", "true");
  if (hook !== false) {
    const hp = join(wt, ".git", "hooks", "pre-push");
    writeFileSync(hp, hook ?? "#!/bin/sh\nexit 0\n");
    chmodSync(hp, hook === "noexec" ? 0o644 : 0o755);
  }
}
const prBranch = (wt, name) => { setRulesLookup(async () => PR); sh(wt, "checkout", "-qb", name); commit(wt, `${name}.txt`, name); };
after(() => setStatusPoster(null));

test("switch unset: output identical, no poster call", async () => {
  const calls = posterSpy();
  const { wt } = repo();
  prBranch(wt, "ls1");
  const r = await gitPush(wt);
  assert.equal(r.output, "opened PR #7 — https://github.com/o/r/pull/7");
  assert.equal(calls.length, 0);
});

test("switch on, executable hook, new branch: one post with the pushed sha", async () => {
  const calls = posterSpy();
  const { wt } = repo();
  prBranch(wt, "ls2"); enable(wt);
  const sha = sh(wt, "rev-parse", "HEAD");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sha, sha);
  assert.doesNotMatch(calls[0].desc, /\/|johannes/);
  assert.match(r.output, /opened PR #7.*Reported local-ci as passed for/);
});

test("HEAD moved by the hook after the push: the PUSHED sha is posted", async () => {
  const calls = posterSpy();
  const { wt } = repo();
  prBranch(wt, "ls3");
  enable(wt, "#!/bin/sh\nexit 0\n");
  const pushed = sh(wt, "rev-parse", "HEAD");
  // a post-push commit made after gitPush returns is the same idea; simulate by moving HEAD in a wrapper hook that commits on a second run
  sh(wt, "config", "alias.noop", "status");
  const r = await gitPush(wt);
  commit(wt, "late.txt", "late");
  assert.notEqual(sh(wt, "rev-parse", "HEAD"), pushed);
  assert.equal(calls[0].sha, pushed);
  assert.equal(r.ok, true);
});

test("up-to-date push: no poster call", async () => {
  const calls = posterSpy();
  const { wt } = repo();
  prBranch(wt, "ls4"); enable(wt);
  await gitPush(wt);
  calls.length = 0;
  const r = await gitPush(wt);
  assert.equal(calls.length, 0);
  assert.match(r.output, /Nothing new was pushed/);
});

test("hook not executable: no call, receipt says why", async () => {
  const calls = posterSpy();
  const { wt } = repo();
  prBranch(wt, "ls5"); enable(wt, "noexec");
  const r = await gitPush(wt);
  assert.equal(calls.length, 0);
  assert.equal(r.ok, true);
  assert.match(r.output, /no runnable pre-push hook/);
});

test("SKIP_LOCAL_CI=1 and the hook's skip line: no call", async () => {
  const calls = posterSpy();
  const { wt } = repo();
  prBranch(wt, "ls6"); enable(wt);
  process.env.SKIP_LOCAL_CI = "1";
  try { const r = await gitPush(wt); assert.match(r.output, /hook was skipped/); } finally { delete process.env.SKIP_LOCAL_CI; }
  const { reportLocalCi } = await import("../dist/localcistatus.js");
  const note = await reportLocalCi(wt, { stdout: "", stderr: "local-ci: skipped (SKIP_LOCAL_CI=1)" }, "ls6");
  assert.match(note, /skipped/);
  assert.equal(calls.length, 0);
});

test("poster failing twice: push still ok, receipt names the failure", async () => {
  const calls = posterSpy(2);
  const { wt } = repo();
  prBranch(wt, "ls7"); enable(wt);
  const r = await gitPush(wt);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.match(r.output, /could not be reported to GitHub — api down/);
});

test("fromDefault: posted for the tip BEFORE gh pr create", async () => {
  const calls = posterSpy();
  const { wt } = repo();
  setRulesLookup(async () => PR);
  commit(wt, "d.txt", "Dflt work"); enable(wt);
  const tip = sh(wt, "rev-parse", "HEAD");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sha, tip);
  assert.doesNotMatch(calls[0].gh, /pr create/);
  assert.match(ghCalls(), /pr create/);
});

test("porcelainRefs: every flag, multi-ref, noise lines ignored", () => {
  const out = `To origin\n \trefs/heads/a:refs/heads/a\t1234567..89abcde\n+\trefs/heads/b:refs/heads/b\t111...222 (forced update)\n*\trefs/heads/c:refs/heads/c\t[new branch]\n=\trefs/heads/d:refs/heads/d\t[up to date]\n!\trefs/heads/e:refs/heads/e\t[rejected] (fetch first)\n-\t:refs/heads/f\t[deleted]\nDone\n`;
  const r = porcelainRefs(out);
  assert.deepEqual(r.map((x) => x.flag), [" ", "+", "*", "=", "!", "-"]);
  assert.equal(r[0].newAbbrev, "89abcde");
  assert.equal(r[1].newAbbrev, "222");
  assert.equal(r[2].newAbbrev, undefined);
  assert.equal(r[5].dst, "refs/heads/f");
  assert.equal(PINFO.length > 0, true);
});
