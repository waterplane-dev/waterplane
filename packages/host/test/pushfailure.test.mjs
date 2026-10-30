import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushState, startPush } from "../dist/git.js";
import { pushFailureText, pushRefusedByRule, refsLockedAt } from "../dist/pushverdict.js";

test("a refused push names the hook step from STDOUT, not only git's stderr", () => {
  const stdout = "local CI: myrepo\n\n\x1b[1m> npm run lint\x1b[0m\n  901:1  error  File has too many lines\n\n\x1b[31mFAILED: npm run lint (exit 1)\x1b[0m\nPush aborted. Fix it, or bypass with: git push --no-verify\n";
  const stderr = "(node:1) [MODULE_TYPELESS_PACKAGE_JSON] Warning: noise\nReparsing as ES module because module syntax was detected.\nerror: failed to push some refs to 'x'\n";
  const t = pushFailureText(stdout, stderr);
  assert.match(t, /^The pre-push check stopped it — npm run lint \(exit 1\)/);
  assert.match(t, /File has too many lines/);
  assert.match(t, /failed to push some refs/);
  assert.doesNotMatch(t, /MODULE_TYPELESS|Reparsing|\x1b/);
});

test("a green check then a refused push says the remote moved, ahead of 20k of e2e chatter", () => {
  const stdout = "To https://github.com/x/y.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone\n";
  const noise = Array.from({ length: 200 }, () => "[host] [waterplane] client speaks protocol 1, this host speaks 2").join("\n");
  const stderr = `local CI: myrepo\n${noise}\nlocal CI passed in 1427s\nerror: failed to push some refs to 'x'\n`;
  const t = pushFailureText(stdout, stderr);
  assert.match(t, /^The pre-push check passed, but the remote refused main — main moved on the remote while this ran\. Pull, then push again\./);
  assert.match(t, /\[rejected\] \(fetch first\)/);
});

test("a refusal without a hook names git's reason", () => {
  const t = pushFailureText("To x\n!\trefs/heads/dev:refs/heads/dev\t[remote rejected] (protected branch hook declined)\nDone\n", "error: failed to push some refs to 'x'\n");
  assert.match(t, /^The remote refused dev — a branch rule on the remote blocks this push\. Nothing changed there; your commits are still here\./);
  assert.match(t, /\[remote rejected\] \(protected branch hook declined\)/);
});

test("a ruleset refusal (GH013) names the remote's rules and the page that lists them", () => {
  const stdout = "To github.com:x/y.git\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (push declined due to repository rule violations)\nDone\n";
  const stderr = "remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: Review all repository rules at https://github.com/x/y/rules?ref=refs%2Fheads%2Fmain\nremote: \nremote: - Changes must be made through a pull request.\nremote: \nremote: - Required status check \"local-ci\" is expected.\nremote: \nerror: failed to push some refs to 'github.com:x/y.git'\n";
  const t = pushFailureText(stdout, stderr);
  assert.match(t, /^The remote refused main — a branch rule on the remote blocks this push: Changes must be made through a pull request; Required status check "local-ci" is expected \(rules: https:\/\/github\.com\/x\/y\/rules\?ref=refs%2Fheads%2Fmain\)\. Nothing changed there/);
});

test("classic protection (GH006) names its rule, not the GH006 header", () => {
  const stdout = "!\trefs/heads/main:refs/heads/main\t[remote rejected] (protected branch hook declined)\n";
  const stderr = "remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Changes must be made through a pull request.\n";
  const t = pushFailureText(stdout, stderr);
  assert.match(t, /blocks this push: Changes must be made through a pull request\. Nothing changed/);
  assert.doesNotMatch(t.split("\n")[0], /GH006/);
});

test("no hook: git's own words, unchanged", () => {
  assert.equal(pushFailureText("", "error: failed to push some refs to 'x'\n"), "error: failed to push some refs to 'x'");
});

test("a push is a job: a second start joins it, and its end stays readable after", async () => {
  // A repo with no remote: the push fails at once, which is all a job needs to end.
  const wt = mkdtempSync(join(tmpdir(), "wp-pushjob-"));
  try {
    execFileSync("git", ["init", "-q", wt]);
    assert.equal(pushState(wt), null);
    const a = startPush(wt);
    assert.equal(startPush(wt), a, "a start while one runs joins it");
    assert.equal(pushState(wt).running, true);
    const r = await a.done;
    assert.equal(r.ok, false);
    const s = pushState(wt);
    assert.equal(s.running, false);
    assert.equal(s.startedAt, a.startedAt);
    assert.equal(s.result.ok, false);
    assert.ok(s.result.finishedAt >= s.startedAt);
    const b = startPush(wt);
    assert.notEqual(b, a, "an ended push is not joined; the next tap starts a new one");
    await b.done;
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("a running push's progress reads the hook's steps, the e2e count and the last lines", async () => {
  const { PushProgress } = await import("../dist/pushprogress.js");
  const p = new PushProgress();
  const out = "local CI: myrepo\n\n\x1b[1m> npm run build\x1b[0m\n\x1b[32m  ok (41s)\x1b[0m\n\n- tmux skipped (not installed)\n\n> npm run lint (advisory)\n  failed -- advisory in CI too, not blocking the push\n\n> e2e suite\n[run-e2e] 3 script(s), 2 at a time\n";
  // Split mid-line: a chunk boundary must not make two lines of one.
  p.feed("err", out.slice(0, 30));
  p.feed("err", out.slice(30));
  p.feed("err", "\n──────── e2e-a.mjs ────────\n[run-e2e] e2e-a.mjs passed (3.1s)\n[run-e2e] e2e-b.mjs FAILED with exit 1 (2.0s)\nprogress 10%\rprogress 90%\n");
  const s = p.snapshot();
  assert.deepEqual(s.steps, [
    { name: "npm run build", state: "ok", secs: 41 },
    { name: "tmux", state: "skipped", why: "not installed" },
    { name: "npm run lint", state: "failed" },
    { name: "e2e suite", state: "running" },
  ]);
  assert.deepEqual(s.e2e, { done: 2, failed: 1, total: 3 });
  assert.equal(s.tail.at(-1), "progress 90%");
  assert.equal(s.tail.length, 4);
});

test("a hook the reader does not know yields its lines and no made-up steps", async () => {
  const { PushProgress } = await import("../dist/pushprogress.js");
  const p = new PushProgress();
  p.feed("out", "running husky\nchecking things\n");
  assert.deepEqual(p.snapshot(), { steps: [], tail: ["running husky", "checking things"] });
});

test("startPush streams a hook's output into the job's progress while it runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-pushprog-"));
  try {
    const sh = (c, cwd) => execFileSync("sh", ["-c", c], { cwd });
    sh("git init -q --bare remote.git && git init -q wt && cd wt && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m one && git remote add origin ../remote.git && git push -q -u origin HEAD 2>/dev/null && git commit -q --allow-empty -m two", dir);
    const wt = join(dir, "wt");
    // The hook holds "step two" open until the test releases it, so the mid-run read never races a
    // fixed sleep (a loaded pre-push run once read the job before the hook had printed a line).
    const go = join(dir, "go");
    sh(`printf '#!/bin/sh\\necho "> step one"\\necho "  ok (1s)"\\necho "> step two"\\nwhile [ ! -e "${go}" ]; do sleep 0.05; done\\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push`, wt);
    const job = startPush(wt);
    const steps = () => (pushState(wt)?.progress?.steps ?? []).map((s) => [s.name, s.state]);
    for (const end = Date.now() + 15_000; steps().length < 2 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
    const mid = pushState(wt);
    assert.equal(mid.running, true);
    assert.deepEqual(steps(), [["step one", "ok"], ["step two", "running"]]);
    writeFileSync(go, "");
    const r = await job.done;
    assert.equal(r.ok, true, r.error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// bughunt 2026-10-29 PR-10: the pre-push hook's own log is not git's verdict. This repo's tests
// print "set-upstream" and "GH013" — a failing hook must not read as either.
const hookRepo = (dir, hookBody) => {
  const sh = (c, cwd) => execFileSync("sh", ["-c", c], { cwd });
  sh("git init -q --bare remote.git && git init -q wt && cd wt && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m one && git remote add origin ../remote.git && git push -q -u origin HEAD 2>/dev/null && git commit -q --allow-empty -m two", dir);
  const wt = join(dir, "wt");
  writeFileSync(join(wt, ".git/hooks/pre-push"), `#!/bin/sh\n${hookBody}\n`, { mode: 0o755 });
  return wt;
};

test("a failing hook that prints 'set-upstream' and GH013 is the hook's failure: one run, no PR-mode sentence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-pushhooktext-"));
  try {
    const runs = join(dir, "runs");
    const wt = hookRepo(dir, `echo run >> "${runs}"\necho "use git push --set-upstream origin x (no upstream)" >&2\necho "remote: error: GH013: Repository rule violations found" >&2\necho "FAILED: npm test (exit 1)"\nexit 1`);
    const r = await startPush(wt).done;
    assert.equal(r.ok, false);
    assert.equal(readFileSync(runs, "utf8").trim().split("\n").length, 1, "the hook ran once — no --set-upstream retry");
    assert.doesNotMatch(r.error, /takes changes through a PR/);
    assert.match(r.error, /^The pre-push check stopped it — npm test/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a branch with no upstream is pushed once with --set-upstream, decided by rev-parse not by text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-pushnoup-"));
  try {
    const runs = join(dir, "runs");
    const wt = hookRepo(dir, `echo run >> "${runs}"\nexit 0`);
    execFileSync("sh", ["-c", "git checkout -q -b feature && git commit -q --allow-empty -m three"], { cwd: wt });
    const r = await startPush(wt).done;
    assert.equal(r.ok, true, r.error);
    assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "@{u}"], { cwd: wt }).toString().trim(), "origin/feature");
    assert.equal(readFileSync(runs, "utf8").trim().split("\n").length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rule refusal is read off git's porcelain line only", () => {
  const hookLog = "remote: error: GH013: Repository rule violations found\nprotected branch\n";
  assert.equal(pushRefusedByRule(hookLog, hookLog), false, "hook text alone is not a remote refusal");
  assert.equal(pushRefusedByRule("!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\n", ""), false);
  assert.equal(pushRefusedByRule("To x\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (push declined due to repository rule violations)\nDone\n", ""), true);
  assert.equal(pushRefusedByRule("!\trefs/heads/main:refs/heads/main\t[remote rejected] (protected branch hook declined)\n", ""), true);
  assert.equal(pushRefusedByRule("!\trefs/heads/main:refs/heads/main\t[remote rejected] (pre-receive hook declined)\n", "remote: error: GH013: Repository rule violations found\n"), true, "a refused ref beside the remote's anchored GH013 line");
  assert.equal(pushRefusedByRule("", "FAILED: npm test\n  remote: error: GH013: x\n"), false, "an indented GH013 in a hook log with no refused ref");
});

test("a lock refusal names the sha the remote is at; any other refusal beside it is not one", () => {
  const sha = "2b3262d02288aa54bbf21dfd47d47a3095a34e98", old = "531426142f6b54c592125f114c2b881441fa66ac";
  const lock = `!\trefs/heads/main:refs/heads/main\t[remote rejected] (cannot lock ref 'refs/heads/main': is at ${sha} but expected ${old})`;
  assert.deepEqual(refsLockedAt(`To x\n${lock}\nDone\n`, "error: failed to push some refs to 'x'\n"), { to: "x", refs: [{ src: "refs/heads/main", dst: "refs/heads/main", at: sha }] });
  assert.deepEqual(refsLockedAt("To ../r.git\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (incorrect old value provided)\nDone\n", ""), { to: "../r.git", refs: [{ src: "refs/heads/main", dst: "refs/heads/main" }] });
  assert.equal(refsLockedAt(`To x\n${lock}\n!\trefs/heads/dev:refs/heads/dev\t[remote rejected] (protected branch hook declined)\nDone\n`, ""), null);
  assert.equal(refsLockedAt("To x\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone\n", ""), null);
  // the hook's own log quoting the phrase is not git's porcelain line
  assert.equal(refsLockedAt(`  ${lock.replace(/\t/g, " ")}\n`, ""), null);
});

// 2026-10-30: two pushes of one commit raced (the phone's and another session's); the other landed
// during this one's 4-minute hook, and the remote refused with "cannot lock ref … is at <ours>".
test("a push whose commit another push already landed is done, not refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-pushlanded-"));
  try {
    const wt = hookRepo(dir, `git push -q --no-verify "${join(dir, "remote.git")}" HEAD:refs/heads/$(git rev-parse --abbrev-ref HEAD) </dev/null`);
    const r = await startPush(wt).done;
    assert.equal(r.ok, true, r.error);
    assert.match(r.output, /^Already on the remote — another push of the same commit landed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a lock refusal where the remote moved to someone else's commit stays a refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-pushmoved-"));
  try {
    const wt = hookRepo(dir, `R="${join(dir, "remote.git")}"\nC=$(git --git-dir="$R" commit-tree -p $(git --git-dir="$R" rev-parse HEAD) -m other $(git --git-dir="$R" rev-parse 'HEAD^{tree}'))\ngit --git-dir="$R" update-ref refs/heads/$(git rev-parse --abbrev-ref HEAD) $C`);
    const r = await startPush(wt).done;
    assert.equal(r.ok, false);
    assert.match(r.error, /remote refused/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
