// Tier 3: git status, diff, stage, commit, push from the API.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 15000);
