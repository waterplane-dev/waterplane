// Browsing the worktree as a tree, and writing one file back.
//
// The gallery lists DELIVERABLES; this lists what is actually in the repo. The
// browse half is mostly cheap (a lazy `readdir`), and the pins below are about
// what it must NOT do: descend `node_modules` on a search, hand back a `.env`,
// or let a caller name a path outside the worktree.
//
// The write half is the sharp one, and every rule here exists because the
// SECOND writer is normal, not exotic: an agent is working in the same repo
// while a file sits open on a phone. So a save carries `baseSha`, the sha of
// the bytes it read, and a mismatch is refused with NOTHING written — a
// last-write-wins editor would silently delete a turn's work. Its corollary is
// the one that is easy to lose in a refactor: a body we could not show in full
// (binary, or past MAX_EDIT_BYTES) comes back with NO `sha` at all, so a
// truncated buffer can never be armed and written over the rest of the file.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8813;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-tree-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
const put = (p, body) => fetch(base + p, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const sha = (s) => createHash("sha256").update(s).digest("hex");

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

bootWait(PORT, 1500, async () => {
  try {
    const repo = await j("/api/repo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "treedemo" }) });
    const wt = repo.path;
    const id = (await j("/api/repos")).targets[0].id;

    mkdirSync(join(wt, "src"), { recursive: true });
    mkdirSync(join(wt, "node_modules", "leftpad"), { recursive: true });
    writeFileSync(join(wt, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(join(wt, "src", "notes.md"), "# notes\n");
    writeFileSync(join(wt, "node_modules", "leftpad", "app.ts"), "module.exports = 1;\n");
    writeFileSync(join(wt, "logo.png"), Buffer.from("89504e470d0a1a0a00000000", "hex"));
    writeFileSync(join(wt, ".env"), "SECRET=hunter2\n");
    writeFileSync(join(wt, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(wt, "ignored.txt"), "build output\n");

    // ── Listing ─────────────────────────────────────────────────────
    const root = await j(`/api/repos/${id}/tree`);
    const names = root.entries.map((e) => e.name);
    check(names.includes("src") && names.includes("logo.png"), "root listing has the dir and the file");
    check(root.entries.findIndex((e) => e.name === "src") < root.entries.findIndex((e) => e.name === "logo.png"),
      "directories sort before files");
    check(names.includes(".gitignore"), "dotfiles are listed — a browser that hides them can't show a .gitignore");
    // The gallery deliberately does NOT discover source extensions (they would
    // flood a deliverables grid). A tree browser that skipped them would be
    // showing everything except the code.
    check(names.includes("node_modules"), "node_modules is SHOWN (lazily) — listing it costs one readdir");
    const srcDir = root.entries.find((e) => e.name === "src");
    check(srcDir?.dir === true && srcDir.count === 2, "a directory row carries its child count");

    const ignored = root.entries.find((e) => e.name === "ignored.txt");
    check(ignored?.ignored === true, "a gitignored file is flagged, not hidden — build output is exactly what you want to read");
    check(root.entries.find((e) => e.name === ".gitignore")?.ignored !== true, "a tracked file is not flagged ignored");

    const sub = await j(`/api/repos/${id}/tree?path=src`);
    check(sub.path === "src" && sub.entries.length === 2, "listing descends one directory at a time");

    // ── Search ──────────────────────────────────────────────────────
    const hits = await j(`/api/repos/${id}/tree?q=app.ts`);
    check(hits.query === "app.ts" && hits.entries.some((e) => e.path === "src/app.ts"), "recursive name search finds the file");
    check(!hits.entries.some((e) => e.path.startsWith("node_modules/")),
      "search never walks node_modules — the answer nobody wants is fifty copies of app.ts");
    const scoped = await j(`/api/repos/${id}/tree?path=src&q=notes`);
    check(scoped.entries.length === 1 && scoped.entries[0].path === "src/notes.md", "search is rooted at the folder you are in");

    // ── Containment + secrets ───────────────────────────────────────
    const esc = await fetch(`${base}/api/repos/${id}/tree?path=${encodeURIComponent("../..")}`);
    check(esc.status === 404, "a path escaping the worktree is refused, not listed");
    const dotenvRead = await fetch(`${base}/api/repos/${id}/tree/file?path=.env`);
    check(dotenvRead.status === 403, "reading .env is refused — the secret sheet promises these never come back");
    const dotenvWrite = await put(`/api/repos/${id}/tree/file`, { path: ".env", body: "X=1\n", baseSha: sha("SECRET=hunter2\n") });
    check(dotenvWrite.ok === false && dotenvWrite.code === "refused", "writing .env is refused too, base or no base");
    check(readFileSync(join(wt, ".env"), "utf8") === "SECRET=hunter2\n", "…and the file on disk is untouched");
    const escWrite = await put(`/api/repos/${id}/tree/file`, { path: "../outside.txt", body: "x", baseSha: sha("x") });
    check(escWrite.ok === false && escWrite.code === "refused", "a write escaping the worktree is refused");

    // ── Reading a file ──────────────────────────────────────────────
    const f = await j(`/api/repos/${id}/tree/file?path=src/app.ts`);
    check(f.body === "export const a = 1;\n" && f.editable === true, "a text file comes back whole and editable");
    check(f.sha === sha("export const a = 1;\n"), "the sha is over the bytes on disk — that is what a save has to echo");

    const bin = await j(`/api/repos/${id}/tree/file?path=logo.png`);
    check(bin.binary === true && bin.body === undefined && bin.sha === undefined,
      "a binary file has no body AND no sha — no sha is what makes it unsavable, not a UI flag");

    // Past MAX_EDIT_BYTES (512 KB) the body is a PREFIX, so handing back a sha
    // would arm a save that writes the prefix over the whole file.
    writeFileSync(join(wt, "big.txt"), "x".repeat(600 * 1024));
    const big = await j(`/api/repos/${id}/tree/file?path=big.txt`);
    check(big.truncated === true && big.sha === undefined && big.editable === false,
      "a truncated file carries no sha — a prefix can never be written back over the rest");
    const bigWrite = await put(`/api/repos/${id}/tree/file`, { path: "big.txt", body: "short", baseSha: "" });
    check(bigWrite.ok === false && bigWrite.code === "refused" && statSync(join(wt, "big.txt")).size === 600 * 1024,
      "…and a save with no base is refused outright");

    // ── Writing ─────────────────────────────────────────────────────
    const ok = await put(`/api/repos/${id}/tree/file`, { path: "src/app.ts", body: "export const a = 2;\n", baseSha: f.sha });
    check(ok.ok === true && readFileSync(join(wt, "src", "app.ts"), "utf8") === "export const a = 2;\n", "a save with the right base lands");
    check(ok.sha === sha("export const a = 2;\n"), "the answer carries the NEW base, so a second save needs no re-read");

    // The whole point: someone else wrote the file while it was open here.
    const stale = await put(`/api/repos/${id}/tree/file`, { path: "src/app.ts", body: "export const a = 3;\n", baseSha: f.sha });
    check(stale.status === 409 && stale.code === "stale", "a save against the base we already replaced is refused 409 stale");
    check(readFileSync(join(wt, "src", "app.ts"), "utf8") === "export const a = 2;\n",
      "…and NOTHING was written — a stale save must never be a partial one");
    check(stale.sha === ok.sha, "the refusal names the base that is actually on disk, so the client can re-read deliberately");

    const gone = await put(`/api/repos/${id}/tree/file`, { path: "src/nope.ts", body: "x", baseSha: sha("x") });
    check(gone.ok === false && gone.code === "missing", "this is an editor, not a file creator: a missing path is refused");

    // A rename installs the tmp file's inode, so the mode has to be carried
    // over explicitly — otherwise saving a hook script silently removes its +x.
    writeFileSync(join(wt, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(wt, "run.sh"), 0o755);
    const shFile = await j(`/api/repos/${id}/tree/file?path=run.sh`);
    await put(`/api/repos/${id}/tree/file`, { path: "run.sh", body: "#!/bin/sh\necho bye\n", baseSha: shFile.sha });
    check((statSync(join(wt, "run.sh")).mode & 0o777) === 0o755, "an executable file is still executable after a save");

    // Git marks come from the same porcelain the review sheet reads.
    const after = await j(`/api/repos/${id}/tree?path=src`);
    check(after.entries.find((e) => e.name === "app.ts")?.status !== undefined,
      "a file changed since the last commit is marked in the listing");
  } catch (err) {
    console.log("FAIL: threw", err);
    failed = true;
  }
  done();
});
