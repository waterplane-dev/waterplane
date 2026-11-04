// Tier 3: git status, diff, stage, commit, pull, push from the API.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8799;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-git-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT) };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
const post = (p, body) => j(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

bootWait(PORT, 900, async () => {
  try {
    const repo = await post("/api/repo", { name: "gitdemo" });
    const id = (await j("/api/repos")).targets[0].id;

    // create an untracked file
    writeFileSync(join(repo.path, "hello.txt"), "line one\nline two\n");

    let st = await j(`/api/repos/${id}/git/status`);
    check(st.files.some((f) => f.path === "hello.txt" && f.code === "??"), "status shows untracked file");
    check(st.clean === false, "tree reported dirty");

    // untracked diff = added-file synthesis
    const d0 = await j(`/api/repos/${id}/git/diff?path=hello.txt`);
    check(d0.diff.includes("+line one"), "untracked file shows added-line diff");

    // stage it
    const stg = await post(`/api/repos/${id}/git/stage`, { path: "hello.txt" });
    check(stg.ok, "stage ok");
    st = await j(`/api/repos/${id}/git/status`);
    check(st.files.some((f) => f.path === "hello.txt" && f.staged), "file now staged");

    // staged diff
    const d1 = await j(`/api/repos/${id}/git/diff?path=hello.txt&staged=1`);
    check(d1.diff.includes("+line two"), "staged diff shows content");

    // commit
    const c = await post(`/api/repos/${id}/git/commit`, { message: "add hello", all: true });
    check(c.ok, "commit ok");
    st = await j(`/api/repos/${id}/git/status`);
    check(st.clean === true, "tree clean after commit");

    // push fails gracefully (no remote configured)
    const p = await post(`/api/repos/${id}/git/push`, {});
    check(p.ok === false && !!p.error, "push fails gracefully without a remote");

    // pull: no upstream is a sentence, not a throw
    const noUp = await post(`/api/repos/${id}/git/pull`, {});
    check(noUp.ok === false && /no upstream/.test(noUp.error ?? ""), "pull without an upstream says so");

    // A bare remote outside ROOT, and a second clone that moves it on. Hooks
    // off: a global hooksPath must not run anyone's CI inside this test.
    const g = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "pipe" }).toString().trim();
    const remote = mkdtempSync(join(tmpdir(), `${SLUG}-gitremote-`));
    g(remote, "init", "--bare", "-q");
    g(repo.path, "remote", "add", "origin", remote);
    g(repo.path, "push", "-q", "-u", "origin", "HEAD");
    const other = join(mkdtempSync(join(tmpdir(), `${SLUG}-gitother-`)), "c");
    g(remote, "clone", "-q", remote, other);
    const moveOn = (file, body) => { writeFileSync(join(other, file), body); g(other, "add", file); g(other, "commit", "-qm", `remote ${file}`); g(other, "push", "-q"); };

    moveOn("remote.txt", "from elsewhere\n");
    const ff = await post(`/api/repos/${id}/git/pull`, {});
    check(ff.ok === true && /Pulled 1 commit/.test(ff.output ?? ""), `pull fast-forwards (${ff.output ?? ff.error})`);
    st = await j(`/api/repos/${id}/git/status`);
    check(st.behind === 0 && st.ahead === 0, "nothing behind or ahead after the pull");

    // both sides moved, clean tree → local commits replayed on top
    moveOn("remote2.txt", "again\n");
    writeFileSync(join(repo.path, "local.txt"), "mine\n");
    g(repo.path, "add", "local.txt"); g(repo.path, "commit", "-qm", "local");
    const rb = await post(`/api/repos/${id}/git/pull`, {});
    check(rb.ok === true && /replayed/.test(rb.output ?? ""), `diverged pull replays local commits (${rb.output ?? rb.error})`);
    st = await j(`/api/repos/${id}/git/status`);
    check(st.ahead === 1 && st.behind === 0, "one local commit left to push after the replay");

    // a conflicting replay is undone: HEAD where it was, no rebase left open
    moveOn("hello.txt", "line one\ntheirs\n");
    writeFileSync(join(repo.path, "hello.txt"), "line one\nours\n");
    g(repo.path, "commit", "-qam", "ours");
    const before = g(repo.path, "rev-parse", "HEAD");
    const cf = await post(`/api/repos/${id}/git/pull`, {});
    check(cf.ok === false && /undone/.test(cf.error ?? ""), "conflicting pull refuses in words");
    check(g(repo.path, "rev-parse", "HEAD") === before, "conflicting pull leaves HEAD where it was");
    st = await j(`/api/repos/${id}/git/status`);
    check(st.clean === true, "no half-done rebase left in the tree");
    rmSync(remote, { recursive: true, force: true });
    rmSync(dirname(other), { recursive: true, force: true });

    // the pre-push hook without a push: a job like a push, a verdict on the commit, then a push
    // of only the commits up to it
    const demo = await post("/api/repo", { name: "checkdemo" });
    const cid = (await j("/api/repos")).targets.find((t) => t.repoName === "checkdemo").id;
    const bare = mkdtempSync(join(tmpdir(), `${SLUG}-checkbare-`));
    g(bare, "init", "-q", "--bare", "-b", "main");
    g(demo.path, "config", "user.email", "t@t"); g(demo.path, "config", "user.name", "t");
    const commitFile = (n) => { writeFileSync(join(demo.path, n), n); g(demo.path, "add", n); g(demo.path, "commit", "-qm", n); return g(demo.path, "rev-parse", "HEAD"); };
    commitFile("base");
    g(demo.path, "branch", "-M", "main");
    g(demo.path, "remote", "add", "origin", bare);
    g(demo.path, "push", "-q", "-u", "origin", "main");
    const [one, two] = [commitFile("one"), commitFile("two")];
    const hook = join(demo.path, ".git/hooks/pre-push");
    writeFileSync(hook, "#!/bin/sh\ncat >/dev/null\nexit 0\n"); chmodSync(hook, 0o755);
    g(demo.path, "config", `${SLUG}.prePushTestsCommit`, "true");
    const ended = async () => { for (;;) { const { push } = await j(`/api/repos/${cid}/git/push`); if (push && !push.running) return push; await new Promise((r) => setTimeout(r, 100)); } };
    const started = await post(`/api/repos/${cid}/git/check`, { sha: one });
    check(started.check === true, "a check is a job that says it is one");
    const checked = await ended();
    check(checked.result?.ok === true && checked.check === true, "the check ends passed");
    check(g(bare, "rev-parse", "main") !== one, "a check pushes nothing");
    const clog = await j(`/api/repos/${cid}/git/log`);
    check(clog.prePush?.testsCommit === true, "the log says the hook tests the commit");
    check(clog.outgoing.find((c) => c.sha === one)?.check?.ok === true && !clog.outgoing.find((c) => c.sha === two)?.check, "only the checked commit wears the verdict");
    const notSha = await fetch(`${base}/api/repos/${cid}/git/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: "--upload-pack=x" }) });
    check(notSha.status === 400, "a check of something that is no commit id is refused");
    await post(`/api/repos/${cid}/git/pushto`, { sha: one });
    const pushedTo = await ended();
    check(pushedTo.result?.ok === true && !pushedTo.check, "the push up to it ends well");
    check(g(bare, "rev-parse", "main") === one && g(demo.path, "rev-parse", "HEAD") === two, "the older commit went, the newer one stayed");
    rmSync(bare, { recursive: true, force: true });

    // file read + traversal guard
    const fr = await j(`/api/repos/${id}/git/file?path=hello.txt`);
    check(fr.body?.includes("line one"), "git file read returns content");
    const evil = await fetch(`${base}/api/repos/${id}/git/file?path=../../../etc/passwd`);
    check(evil.status === 404, "git file traversal rejected");

    // The secret sheet promises it never shows a value back, so the file viewer
    // must not be the hole in that promise.
    writeFileSync(join(repo.path, ".env"), "API_KEY=super-secret\n");
    writeFileSync(join(repo.path, ".env.local"), "OTHER=also-secret\n");
    const dotenv = await fetch(`${base}/api/repos/${id}/git/file?path=.env`);
    check(dotenv.status === 403, "git file read refuses .env");
    const dotenvLocal = await fetch(`${base}/api/repos/${id}/git/file?path=.env.local`);
    check(dotenvLocal.status === 403, "git file read refuses .env.local");
    // A committed template holds no secrets and exists to be read.
    writeFileSync(join(repo.path, ".env.example"), "API_KEY=\n");
    const example = await j(`/api/repos/${id}/git/file?path=.env.example`);
    check(example.body?.includes("API_KEY="), "git file read still shows .env.example");

    // ── Branches: list, create+switch, switch back, delete ──────────────
    let br = (await j(`/api/repos/${id}/git/branches`)).branches;
    const mainName = br.find((b) => b.current)?.name;
    check(!!mainName, "branches list has a current branch");

    const cr = await post(`/api/repos/${id}/git/branch`, { name: "feature/x" });
    check(cr.ok, "create+switch branch ok");
    st = await j(`/api/repos/${id}/git/status`);
    check(st.branch === "feature/x", "now on the new branch");

    const co = await post(`/api/repos/${id}/git/checkout`, { branch: mainName });
    check(co.ok, "checkout back to main ok");
    st = await j(`/api/repos/${id}/git/status`);
    check(st.branch === mainName, "switched back to main branch");

    const del = await j(`/api/repos/${id}/git/branch`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "feature/x", force: true }) });
    check(del.ok, "delete branch ok");
    br = (await j(`/api/repos/${id}/git/branches`)).branches;
    check(!br.some((b) => b.name === "feature/x"), "deleted branch gone from list");

    // bad branch name rejected (flag-injection guard)
    const bad = await post(`/api/repos/${id}/git/checkout`, { branch: "--orphan" });
    check(bad.ok === false, "invalid branch name rejected");
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  host.kill();
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
});

watchdog(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); });
