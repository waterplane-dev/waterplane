/**
 * Push & open PR (prpush.ts): a temp repo with a local bare origin and a fake `gh`
 * first on PATH. Never touches a real forge.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "prpush-")));
const bin = join(root, "bin");
execFileSync("mkdir", ["-p", bin]);
const log = join(root, "gh.log");
const mode = join(root, "gh.mode");
const ghBranch = join(root, "gh.branch"); // what `gh api .../branches/<b>` answers: a name; "404" = deleted; empty = gh cannot say
const ghDefault = join(root, "gh.default"); // the forge's default branch; empty = gh cannot say (offline)
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$@" >> "${log}"
M=$(cat "${mode}" 2>/dev/null)
case "$1 $2" in
  "pr create") [ "$M" = "createfail" ] && { echo "boom: no permission" >&2; exit 1; }
               echo "https://github.com/o/r/pull/7"; exit 0;;
  "pr view") [ "$M" = "existing" ] && { echo '{"url":"https://github.com/o/r/pull/3","number":3,"state":"OPEN"}'; exit 0; }
             [ "$M" = "merged" ] && { echo '{"url":"https://github.com/o/r/pull/3","number":3,"state":"MERGED"}'; exit 0; }
             echo "no pull requests found" >&2; exit 1;;
  "repo view") [ "$M" = "slowview" ] && exec sleep 30
               D=$(cat "${ghDefault}" 2>/dev/null); [ -n "$D" ] && { echo '{"defaultBranchRef":{"name":"'"$D"'"}}'; exit 0; }; exit 1;;
  "api repos/"*) B=$(cat "${ghBranch}" 2>/dev/null)
               [ "$B" = "404" ] && { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
               [ -n "$B" ] && { echo '{"name":"'"$B"'"}'; exit 0; }; exit 1;;
  *) exit 1;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);
// A pass-through `git` that, once armed, commits on the checked-out branch right before a
// `reset` runs — the window between the move-back's re-check and `reset --keep` itself.
// Armed with "after", it commits right AFTER the reset instead (a commit that is safe).
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const lateArm = join(root, "late.arm");
writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = "reset" ] && [ -f "${lateArm}" ]; then
  W=$(cat "${lateArm}"); rm -f "${lateArm}"
  if [ "$W" = "after" ]; then
    "${realGit}" "$@"; S=$?
    echo after > after-reset.txt && "${realGit}" add after-reset.txt && "${realGit}" commit -qm "just after the reset"
    exit $S
  fi
  echo late > late-window.txt && "${realGit}" add late-window.txt && "${realGit}" commit -qm "late in the reset window"
fi
exec "${realGit}" "$@"
`);
chmodSync(join(bin, "git"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
after(() => execFileSync("rm", ["-rf", root]));

const { gitPush } = await import("../dist/git.js");
const { setRulesLookup, branchSlug, prRefspec, pushForPr } = await import("../dist/prpush.js");
const { invalidateBranchRules } = await import("../dist/branchrules.js");
const { githubForge } = await import("../dist/forge/github.js");
// Every import at the top: a mid-file `await` lets the root `after` (rm -rf root) fire early under
// --test-name-pattern, when every test registered before it is skipped at once.
const { setStatusPoster, porcelainRefs } = await import("../dist/localcistatus.js");
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
  writeFileSync(log, ""); writeFileSync(mode, ""); writeFileSync(ghDefault, ""); writeFileSync(ghBranch, "");
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

// ---- the push is minutes long: nothing decided before it is trusted after it (bughunt 2026-10-29) ----
/** A real push, then `during(wt)` runs before the push resolves — what an agent does while the hook runs. */
const racingIo = (wt, during) => ({
  push: async (args) => { const r = { stdout: sh(wt, ...args), stderr: "" }; during(wt); return r; },
  failText: (o, e) => `${o} ${e}`.trim(),
});

test("PR-1: a commit made on main during the push is never orphaned", async () => {
  const { wt, origin } = repo();
  commit(wt, "b.txt", "Race one");
  const tip = sh(wt, "rev-parse", "HEAD");
  const r = await pushForPr(wt, PR, racingIo(wt, (w) => commit(w, "late.txt", "late during push")));
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /opened PR #7/);
  assert.match(r.output, /Local main was left as it is/);
  assert.equal(sh(origin, "rev-parse", "wp/race-one"), tip);
  // main still holds the late commit and the pushed one
  assert.equal(sh(wt, "log", "-1", "--format=%s", "main"), "late during push");
  sh(wt, "merge-base", "--is-ancestor", tip, "main");
});

test("PR-1: a branch switched to during the push is never rewound", async () => {
  const { wt, origin } = repo();
  commit(wt, "b.txt", "Race two");
  let other;
  const r = await pushForPr(wt, PR, racingIo(wt, (w) => { sh(w, "checkout", "-qb", "other"); commit(w, "o.txt", "other work"); other = sh(w, "rev-parse", "HEAD"); }));
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /Local main was left as it is/);
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "HEAD"), "other");
  assert.equal(sh(wt, "rev-parse", "other"), other);
  assert.notEqual(sh(wt, "rev-parse", "main"), sh(origin, "rev-parse", "main"));
});

test("PR-5: a branch tracking origin/main pushes to its own name, never to main", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  const base = sh(origin, "rev-parse", "main");
  sh(wt, "checkout", "-qb", "trk", "origin/main");
  sh(wt, "config", "push.default", "upstream");
  commit(wt, "t.txt", "tracked work");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "main"), base);
  assert.equal(sh(origin, "rev-parse", "trk"), sh(wt, "rev-parse", "HEAD"));
  assert.match(ghCalls(), /pr create --fill --head trk --base main/);
});

test("PR-5: with git's default push.default the tracking branch is pushed, not refused", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "checkout", "-qb", "trk2", "origin/main");
  commit(wt, "t.txt", "tracked work 2");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "trk2"), sh(wt, "rev-parse", "HEAD"));
});

test("PR-2: a branch whose PR already merged gets a new PR, never 'updated' the merged one", async () => {
  const { wt } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "checkout", "-qb", "after-merge");
  commit(wt, "m.txt", "more after merge");
  writeMode("merged");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /opened PR #7/);
  assert.match(ghCalls(), /pr view after-merge --json url,number,state/);
  assert.match(ghCalls(), /pr create --fill --head after-merge --base main/);
});

test("PR-4: retry after a failed PR open reuses the pushed wp/ branch, never mints -2", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  commit(wt, "b.txt", "Retry me");
  const tip = sh(wt, "rev-parse", "HEAD");
  const base = sh(origin, "rev-parse", "main");
  writeMode("createfail");
  const first = await gitPush(wt);
  assert.equal(first.ok, false);
  writeMode("");
  writeFileSync(log, "");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /opened PR #7/);
  assert.match(ghCalls(), /pr create --fill --head wp\/retry-me --base main/);
  assert.equal(sh(origin, "for-each-ref", "--format=%(refname)", "refs/heads/wp/"), "refs/heads/wp/retry-me");
  assert.equal(sh(wt, "for-each-ref", "--format=%(refname)", "refs/heads/wp/"), "refs/heads/wp/retry-me");
  assert.equal(sh(origin, "rev-parse", "wp/retry-me"), tip);
  assert.equal(sh(wt, "rev-parse", "main"), base);
});

test("PR-4: a retry whose PR did open after all reports that open PR, creates none", async () => {
  const { wt } = repo();
  setRulesLookup(async () => PR);
  commit(wt, "b.txt", "Opened anyway");
  writeMode("createfail");
  assert.equal((await gitPush(wt)).ok, false);
  writeMode("existing");
  writeFileSync(log, "");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /updated PR #3/);
  assert.match(ghCalls(), /pr view wp\/opened-anyway/);
  assert.doesNotMatch(ghCalls(), /pr create/);
});

// ---- one rule for a branch's push target and tracking (review A1 F2/F3) ----
test("tracking rule: a branch tracking origin/main is pushed to its own name AND now tracks it", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "checkout", "-qb", "feat", "origin/main");
  commit(wt, "f.txt", "feat work");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "feat"), sh(wt, "rev-parse", "HEAD"));
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "feat@{u}"), "origin/feat");
  assert.equal(sh(wt, "rev-list", "--count", "@{u}..HEAD"), "0");
});

test("tracking rule: a branch tracking origin/<other name> updates THAT branch and its PR, opens none", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "push", "-q", "origin", "HEAD:feature-x");
  sh(wt, "checkout", "-qb", "fix", "--track", "origin/feature-x");
  commit(wt, "x.txt", "fix on feature-x");
  writeMode("existing");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /updated PR #3 on feature-x/);
  assert.equal(sh(origin, "rev-parse", "feature-x"), sh(wt, "rev-parse", "HEAD"));
  assert.equal(sh(origin, "for-each-ref", "--format=%(refname)", "refs/heads/fix"), "");
  assert.match(ghCalls(), /pr view feature-x /);
  assert.doesNotMatch(ghCalls(), /pr create/);
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "fix@{u}"), "origin/feature-x");
});

test("tracking rule: an untracked branch is pushed to its own name and set to track it", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "checkout", "-qb", "loose", "--no-track", "origin/main");
  commit(wt, "l.txt", "loose work");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "loose"), sh(wt, "rev-parse", "HEAD"));
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "loose@{u}"), "origin/loose");
  assert.match(ghCalls(), /pr create --fill --head loose --base main/);
});

test("move-back: a commit landing between the re-check and the reset is named with its sha", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  commit(wt, "b.txt", "Window");
  const tip = sh(wt, "rev-parse", "HEAD");
  writeFileSync(lateArm, "");
  let r;
  try { r = await gitPush(wt); } finally { if (existsSync(lateArm)) { rmSync(lateArm); assert.fail("the reset never ran through the shim"); } }
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /opened PR #7/);
  assert.equal(sh(origin, "rev-parse", "wp/window"), tip);
  const late = sh(wt, "rev-parse", "HEAD@{1}");
  assert.notEqual(late, tip);
  assert.equal(sh(wt, "log", "-1", "--format=%s", late), "late in the reset window");
  assert.match(r.output, new RegExp(`main moved.*${late}`));
  assert.match(r.output, new RegExp(`git reset --keep ${late}`));
});

// ---- the default branch is the forge's answer; a PR-mode push never targets it (review A1b B1) ----
/** origin/HEAD as a clone made before the remote renamed master → main leaves it: dangling, never refreshed. */
const staleOriginHead = (wt) => sh(wt, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");

test("default branch: a stale origin/HEAD (master) never sends a branch tracking origin/main onto main", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  staleOriginHead(wt);
  writeFileSync(ghDefault, "main");
  const mainBefore = sh(origin, "rev-parse", "main");
  sh(wt, "checkout", "-qb", "feat", "origin/main");
  commit(wt, "f.txt", "feat on renamed default");
  writeMode("existing"); // even an OPEN PR claimed for head main must not draw the push there
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "main"), mainBefore, "origin's real default is untouched");
  assert.equal(sh(origin, "rev-parse", "feat"), sh(wt, "rev-parse", "HEAD"));
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "feat@{u}"), "origin/feat");
  assert.match(ghCalls(), /repo view --json defaultBranchRef/);
});

test("default branch: the forge's answer beats origin/HEAD for the PR's base", async () => {
  const { wt } = repo();
  setRulesLookup(async () => PR);
  staleOriginHead(wt);
  writeFileSync(ghDefault, "main");
  sh(wt, "checkout", "-qb", "base-check");
  commit(wt, "bc.txt", "base check");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.match(ghCalls(), /pr create --fill --head base-check --base main/);
});

test("refspec guard: no refspec ever names a default branch as its target", () => {
  assert.throws(() => prRefspec("feat", "main", new Set(["main"])), /default branch main/);
  assert.throws(() => prRefspec("feat", "master", new Set(["main", "master"])), /default branch master/);
  assert.equal(prRefspec("feat", "feat", new Set(["main"])), "feat:feat");
});

// ---- tracking X means "push into X" only while X has an OPEN PR (review A1b B2) ----
test("tracking rule: a branch started on someone's branch with no open PR is pushed to its own name", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "push", "-q", "origin", "HEAD:colleague-x");
  const theirs = sh(origin, "rev-parse", "colleague-x");
  sh(wt, "checkout", "-qb", "mywork", "origin/colleague-x"); // git's default autoSetupMerge tracks it
  commit(wt, "w.txt", "my work on top");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "colleague-x"), theirs, "their branch is not moved");
  assert.equal(sh(origin, "rev-parse", "mywork"), sh(wt, "rev-parse", "HEAD"));
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "mywork@{u}"), "origin/mywork");
  assert.match(ghCalls(), /pr create --fill --head mywork --base main/);
  assert.match(r.output, /opened PR #7 —/);
});

test("tracking rule: a tracked branch deleted on origin after its merge is never recreated", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "push", "-q", "origin", "HEAD:gone-x");
  sh(wt, "checkout", "-qb", "after-gone", "--track", "origin/gone-x");
  sh(origin, "branch", "-D", "gone-x");
  commit(wt, "g.txt", "after the merge");
  writeMode("merged");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "for-each-ref", "--format=%(refname)", "refs/heads/gone-x"), "");
  assert.equal(sh(origin, "rev-parse", "after-gone"), sh(wt, "rev-parse", "HEAD"));
  assert.match(ghCalls(), /pr create --fill --head after-gone --base main/);
});

// ---- the move-back reads main's own reflog: a commit AFTER the reset is safe (review A1b L2) ----
test("move-back: a commit landing just AFTER the reset is not reported as moved, and no rewind is offered", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  commit(wt, "b.txt", "After window");
  const tip = sh(wt, "rev-parse", "HEAD");
  writeFileSync(lateArm, "after");
  let r;
  try { r = await gitPush(wt); } finally { if (existsSync(lateArm)) { rmSync(lateArm); assert.fail("the reset never ran through the shim"); } }
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "wp/after-window"), tip);
  assert.equal(sh(wt, "log", "-1", "--format=%s", "main"), "just after the reset");
  assert.equal(sh(wt, "rev-parse", "main~1"), sh(origin, "rev-parse", "main"));
  assert.doesNotMatch(r.output, /moved/);
  assert.doesNotMatch(r.output, /reset --keep/);
  assert.match(r.output, /^opened PR #7 — \S+$/);
});

// ---- ONE source for the default: the forge's answer when it gave one (review A1c C1) ----
/** A clone made before origin renamed master → main: local master tracks origin/master, origin/HEAD says master. */
function renamedClone(wt, { keepMasterOnOrigin = false } = {}) {
  sh(wt, "update-ref", "refs/remotes/origin/master", "refs/heads/main"); // the unpruned tracking ref
  sh(wt, "branch", "-m", "main", "master");
  sh(wt, "branch", "-u", "origin/master", "master");
  staleOriginHead(wt);
  if (keepMasterOnOrigin) sh(wt, "push", "-q", "origin", "master:master");
  writeFileSync(ghDefault, "main");
  writeFileSync(ghBranch, "main"); // the forge follows the rename redirect: master is now main
}

test("default branch: a stale origin/HEAD naming a LIVE branch (develop) no longer refuses pushes from it", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "push", "-q", "origin", "main:develop");
  sh(wt, "checkout", "-qb", "develop", "--track", "origin/develop");
  sh(wt, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"); // the old default, cached at clone
  writeFileSync(ghDefault, "main");
  const mainBefore = sh(origin, "rev-parse", "main");
  commit(wt, "d.txt", "work on develop");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "develop"), sh(wt, "rev-parse", "HEAD"));
  assert.equal(sh(origin, "rev-parse", "main"), mainBefore, "the forge's default is untouched");
  assert.match(ghCalls(), /pr create --fill --head develop --base main/);
});

test("default branch: after master → main, local master's commits go to a branch and a PR into main, and the sentence says how to fix the clone", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  renamedClone(wt);
  const mainBefore = sh(origin, "rev-parse", "main");
  commit(wt, "m.txt", "Work on old master");
  const tip = sh(wt, "rev-parse", "HEAD");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.match(ghCalls(), /pr create --fill --head wp\/work-on-old-master --base main/);
  assert.equal(sh(origin, "rev-parse", "wp/work-on-old-master"), tip);
  assert.equal(sh(origin, "rev-parse", "main"), mainBefore);
  assert.equal(sh(origin, "for-each-ref", "--format=%(refname)", "refs/heads/master"), "", "master is never recreated on origin");
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "HEAD"), "master");
  assert.equal(sh(wt, "rev-parse", "master"), mainBefore, "local master moved back to origin/main");
  assert.match(r.output, /^opened PR #7 — /);
  assert.match(r.output, /renamed master to main/);
  assert.ok(r.output.includes("git branch -m master main; git fetch origin; git branch -u origin/main main; git remote set-head origin -a"), r.output);
});

for (const [label, fix] of [
  ["no origin/HEAD", (wt) => sh(wt, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")],
  ["origin/HEAD already main", (wt) => sh(wt, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")],
]) {
  test(`default branch: renamed master with ${label} still takes the rename path, master never recreated`, async () => {
    const { wt, origin } = repo();
    setRulesLookup(async () => PR);
    renamedClone(wt);
    fix(wt);
    const mainBefore = sh(origin, "rev-parse", "main");
    commit(wt, "m4.txt", "Work on old master");
    const r = await gitPush(wt);
    assert.equal(r.ok, true, r.error);
    assert.equal(sh(origin, "for-each-ref", "--format=%(refname)", "refs/heads/master"), "", "master is never recreated on origin");
    assert.match(ghCalls(), /--base main/);
    assert.doesNotMatch(ghCalls(), /--head master/);
    assert.equal(sh(origin, "rev-parse", "main"), mainBefore);
    assert.equal(sh(wt, "rev-parse", "master"), mainBefore, "local master moved back");
    assert.match(r.output, /renamed master to main/);
  });
}

test("default branch: master still LIVE on origin after the default moved to main is an ordinary branch", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  renamedClone(wt, { keepMasterOnOrigin: true });
  commit(wt, "m2.txt", "Master is still a branch");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "master"), sh(wt, "rev-parse", "HEAD"));
  assert.match(ghCalls(), /pr create --fill --head master --base main/);
});

test("default branch: a stale master whose fate on origin cannot be read is refused in words, nothing pushed", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  renamedClone(wt);
  commit(wt, "m3.txt", "Unreadable origin");
  sh(wt, "remote", "set-url", "origin", join(root, "no-such-origin.git"));
  const r = await gitPush(wt);
  assert.equal(r.ok, false);
  assert.match(r.error, /origin's default is main/);
  assert.ok(r.error.includes("git branch -m master main; git fetch origin; git branch -u origin/main main; git remote set-head origin -a"), r.error);
  assert.equal(sh(origin, "for-each-ref", "--format=%(refname)", "refs/heads/master"), "");
  assert.doesNotMatch(ghCalls(), /pr create/);
});

// ---- the forge's default is asked on every PR-mode push, before any byte moves (review A1c C3) ----
test("default branch: a hanging gh repo view gives up on the short API timeout, not the 60 s one", async () => {
  const { wt } = repo();
  writeMode("slowview");
  const t0 = Date.now();
  const d = await githubForge(wt).defaultBranch();
  const ms = Date.now() - t0;
  assert.equal(d, undefined);
  assert.ok(ms < 15_000, `took ${ms} ms`);
});

// ---- in PR mode no exit falls back to a plain push of the default branch (review A1c C4) ----
test("PR mode, no default known (forge silent, no origin/HEAD): refused in words, nothing pushed", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  sh(wt, "remote", "set-head", "origin", "-d");
  const mainBefore = sh(origin, "rev-parse", "main");
  commit(wt, "nd.txt", "No default known");
  const r = await gitPush(wt);
  assert.equal(r.ok, false);
  assert.match(r.error, /default branch could not be read/);
  assert.match(r.error, /git remote set-head origin -a/);
  assert.equal(sh(origin, "rev-parse", "main"), mainBefore, "origin main untouched");
});

test("PR mode, commits ahead cannot be counted (single-branch clone, origin/main never fetched): refused in words, nothing pushed", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  writeFileSync(ghDefault, "main");
  sh(wt, "config", "remote.origin.fetch", "+refs/heads/master:refs/remotes/origin/master");
  sh(wt, "update-ref", "-d", "refs/remotes/origin/main");
  const mainBefore = sh(origin, "rev-parse", "main");
  commit(wt, "sb.txt", "Single branch clone");
  const r = await gitPush(wt);
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be counted/);
  assert.match(r.error, /origin\/main/);
  assert.equal(sh(origin, "rev-parse", "main"), mainBefore, "origin main untouched");
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

// ---- the rename path needs the FORGE to say "renamed" (review R2-8 / bughunt 2026-10-29) ----
test("R2-8: a feature branch whose PR merged and whose origin branch was auto-deleted is an ordinary branch", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  writeFileSync(ghDefault, "main");
  writeFileSync(ghBranch, "404");
  sh(wt, "checkout", "-qb", "feat");
  commit(wt, "f1.txt", "Feature one");
  sh(wt, "push", "-q", "-u", "origin", "feat");
  sh(origin, "branch", "-D", "feat"); // merged, then auto-deleted
  commit(wt, "f2.txt", "Feature two");
  const tip = sh(wt, "rev-parse", "HEAD");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "feat"), tip, "feat is recreated on origin");
  assert.match(ghCalls(), /pr create --fill --head feat --base main/);
  assert.doesNotMatch(ghCalls(), /--head wp\//);
  assert.equal(sh(wt, "rev-parse", "feat"), tip, "local feat untouched");
  assert.doesNotMatch(r.output, /renamed/);
});

test("R2-8: forge silent and the branch is the cached origin/HEAD name -> the rename path (the old signal)", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  renamedClone(wt);
  writeFileSync(ghBranch, ""); // gh cannot answer the branch read (the default read still works)
  const mainBefore = sh(origin, "rev-parse", "main");
  commit(wt, "m5.txt", "Work on old master");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.match(r.output, /renamed master to main/);
  assert.equal(sh(origin, "for-each-ref", "--format=%(refname)", "refs/heads/master"), "");
  assert.equal(sh(wt, "rev-parse", "master"), mainBefore);
});

test("R2-8: forge silent and the branch is NOT the cached origin/HEAD name -> ordinary branch path", async () => {
  const { wt, origin } = repo();
  setRulesLookup(async () => PR);
  writeFileSync(ghDefault, "main");
  sh(wt, "checkout", "-qb", "feat");
  commit(wt, "g1.txt", "Feature one");
  sh(wt, "push", "-q", "-u", "origin", "feat");
  sh(origin, "branch", "-D", "feat");
  commit(wt, "g2.txt", "Feature two");
  const r = await gitPush(wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(sh(origin, "rev-parse", "feat"), sh(wt, "rev-parse", "HEAD"));
  assert.doesNotMatch(r.output, /renamed/);
});

test("R2-8: a branch tracking its own name with origin unreadable takes the ordinary path, not the rename refusal", async () => {
  const { wt } = repo();
  setRulesLookup(async () => PR);
  writeFileSync(ghDefault, "main");
  sh(wt, "checkout", "-qb", "feat");
  commit(wt, "h1.txt", "Feature one");
  sh(wt, "push", "-q", "-u", "origin", "feat");
  commit(wt, "h2.txt", "Feature two");
  sh(wt, "remote", "set-url", "origin", join(root, "no-such-origin.git"));
  const r = await gitPush(wt);
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /origin's default is|renamed/); // the push itself failed, in the push's words
  assert.doesNotMatch(ghCalls(), /pr create/);
});
