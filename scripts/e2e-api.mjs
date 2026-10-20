// Exercises the P2–P5 HTTP + backlog API against a throwaway root.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8794;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_MS]: "1500",
  // Blanked so a key on this desktop cannot reach anything this suite runs.
  GEMINI_API_KEY: "" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

bootWait(PORT, 900, async () => {
  try {
    check((await j("/api/health")).ok, "health");

    // new repo
    const repo = await j("/api/repo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "demo" }) });
    check(!!repo.path && existsSync(join(repo.path, ".git")), "new repo created with .git");

    // discovered now
    let repos = (await j("/api/repos")).targets;
    check(repos.length === 1 && repos[0].repoName === "demo", "repo discovered");
    const id = repos[0].id;

    // slash
    const slash = await j(`/api/slash?cwd=${encodeURIComponent(repo.path)}`);
    check(slash.commands.some((c) => c.name === "/btw") && slash.commands.some((c) => c.name === "/context"), "slash includes /btw and /context");

    // worktree
    const wt = await j("/api/worktree", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: id, branch: "feature-x" }) });
    check(!!wt.path && existsSync(wt.path), "worktree created");
    repos = (await j("/api/repos")).targets;
    check(repos.length === 2, "worktree shows as second target");

    // upload to inbox (raw + X-File-Name)
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // tiny png header-ish
    const up = await fetch(`${base}/api/repos/${id}/inbox`, { method: "POST", headers: { "x-file-name": "shot.png", "content-type": "image/png" }, body: png }).then((r) => r.json());
    check(up.saved?.[0]?.relPath === ".claude/inbox/shot.png", "upload returns inbox relpath");

    // The highlighter reads nothing off the desktop any more: its route is gone.
    const ocrGone = await fetch(`${base}/api/host/readtext`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
    check(ocrGone.status === 404, `the highlighter's old reader route is gone (got ${ocrGone.status})`);

    // list inbox
    const inbox = await j(`/api/repos/${id}/inbox`);
    check(inbox.files.length === 1 && inbox.files[0].name === "shot.png", "inbox lists file");

    // Marking read is a POST, not a side effect of the listing GET — no /api
    // GET may change state, since a cross-origin GET carries no Origin.
    const seen = await j(`/api/repos/${id}/inbox/seen`, { method: "POST" });
    check(seen.ok === true, "inbox marked read via POST");

    // fetch raw
    const raw = await fetch(`${base}/api/repos/${id}/inbox/shot.png`);
    check(raw.status === 200 && raw.headers.get("content-type")?.includes("image/png"), "inbox file served as png");

    // artifacts: write a file into the worktree, see it in repo scope
    writeFileSync(join(repo.path, "diagram.svg"), "<svg/>");
    const arts = await j(`/api/repos/${id}/artifacts?scope=repo`);
    check(arts.files.some((f) => f.relPath === "diagram.svg"), "artifact discovered in repo scope");

    // type + name filters
    writeFileSync(join(repo.path, "report.pdf"), "%PDF-1.4");
    const imgs = await j(`/api/repos/${id}/artifacts?scope=repo&kind=image`);
    check(imgs.files.some((f) => f.name === "diagram.svg") && !imgs.files.some((f) => f.name === "report.pdf"), "kind=image excludes docs");
    const docs = await j(`/api/repos/${id}/artifacts?scope=repo&kind=doc`);
    check(docs.files.some((f) => f.name === "report.pdf") && !docs.files.some((f) => f.name === "diagram.svg"), "kind=doc excludes images");
    const named = await j(`/api/repos/${id}/artifacts?scope=repo&q=report`);
    check(named.files.length === 1 && named.files[0].name === "report.pdf", "q=report matches by name");

    // cross-repo search: pdf lives in repo.path only; search all repos for it
    const search = await j(`/api/search?scope=repo&kind=doc&q=report`);
    check(search.hits.some((h) => h.name === "report.pdf" && h.repoId === id && h.repoName === "demo"), "cross-repo search tags hit with repo");
    const scoped = await j(`/api/search?scope=repo&repos=nonexistent`);
    check(scoped.hits.length === 0, "search repos= filter restricts to given ids");

    // cross-repo search must include inbox uploads (the .png case)
    await fetch(`${base}/api/repos/${id}/inbox`, { method: "POST", headers: { "x-file-name": "snap.png", "content-type": "image/png" }, body: png }).then((r) => r.json());
    const pngHits = await j(`/api/search?scope=repo&kind=image&q=.png`);
    check(pngHits.hits.some((h) => h.relPath === ".claude/inbox/snap.png"), "search finds inbox images (.png)");

    // A text artifact must be servable INLINE (the gallery renders .md in place)
    // and, with download=1, as an attachment — same file, two contracts.
    writeFileSync(join(repo.path, "notes.md"), "# Title\n\nbody\n");
    const mdInline = await fetch(`${base}/api/repos/${id}/artifact?path=notes.md`);
    const mdBody = await mdInline.text();
    check(
      mdInline.status === 200 &&
      mdInline.headers.get("content-type")?.includes("text/markdown") &&
      !mdInline.headers.get("content-disposition") &&
      mdBody.includes("# Title"),
      "md artifact served inline as text/markdown",
    );
    const mdDl = await fetch(`${base}/api/repos/${id}/artifact?path=notes.md&download=1`);
    check(mdDl.status === 200 && /attachment; filename="notes.md"/.test(mdDl.headers.get("content-disposition") || ""), "download=1 forces attachment");
    const inboxDl = await fetch(`${base}/api/repos/${id}/inbox/shot.png?download=1`);
    check(/attachment; filename="shot.png"/.test(inboxDl.headers.get("content-disposition") || ""), "inbox download=1 forces attachment");

    // path traversal guard
    const evil = await fetch(`${base}/api/repos/${id}/artifact?path=../../etc/passwd`);
    check(evil.status === 404, "path traversal rejected");

    // worktree basePath must stay inside the root: it comes off the request
    // body, so an unguarded one would plant a checkout anywhere writable.
    const escape = await j("/api/worktree", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: id, branch: "escape", basePath: join(tmpdir(), `${SLUG}-escape-me`) }),
    });
    check(escape.error === "path escapes root", "worktree basePath outside root rejected");
    check(!existsSync(join(tmpdir(), `${SLUG}-escape-me`)), "escaping worktree was not created");

    // delete inbox
    const del = await j(`/api/repos/${id}/inbox/shot.png`, { method: "DELETE" });
    check(del.ok === true, "inbox delete ok");

    // backlog over WS
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      let seen = false;
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
      ws.on("message", (rawMsg) => {
        const m = JSON.parse(rawMsg.toString());
        if (m.t === "backlog.list" && !seen) {
          seen = true;
          ws.send(JSON.stringify({ t: "backlog.add", text: "do a thing", repoDir: repo.path, label: "thing" }));
        } else if (m.t === "backlog.list" && m.items.length === 1) {
          check(m.items[0].text === "do a thing" && m.items[0].repoDir === repo.path, "backlog add round-trips over WS");
          ws.close();
          resolve();
        }
      });
      setTimeout(resolve, 3000);
    });
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  done();
});

watchdog(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); });
