// New-project scaffolding: POST /api/repo seeds a repo that is ready for phone
// use (branch main, first commit, gitignore/README/CLAUDE.md, inbox+outbox),
// `setup: false` still gives the bare git init, and the root guard holds.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8809;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-scaffold-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

bootWait(PORT, 900, async () => {
  try {
    const r = await post("/api/repo", { name: "fresh proj", description: "A test project." });
    check(!!r.path && existsSync(join(r.path, ".git")), "repo created with .git");
    check(r.branch === "main", `default branch is main (got ${r.branch})`);
    check(git(r.path, "rev-list", "--count", "HEAD") === "1", "has an initial commit (worktrees work immediately)");

    for (const f of [".gitignore", "README.md", "CLAUDE.md"]) {
      check(existsSync(join(r.path, f)), `seeded ${f}`);
      check(r.files.includes(f), `${f} reported in files[]`);
    }
    for (const d of [".claude/inbox", ".claude/outbox", STATE]) {
      check(existsSync(join(r.path, d)), `created ${d}/`);
    }

    const ignore = readFileSync(join(r.path, ".gitignore"), "utf8");
    check([`${STATE}/`, ".claude/inbox/", ".claude/outbox/"].every((l) => ignore.includes(l)), "gitignore covers the working dirs");
    check(git(r.path, "status", "--porcelain") === "", "working tree clean after the initial commit");

    const readme = readFileSync(join(r.path, "README.md"), "utf8");
    check(readme.startsWith("# fresh-proj") && readme.includes("A test project."), "README carries the slugged name + description");
    const claudeMd = readFileSync(join(r.path, "CLAUDE.md"), "utf8");
    check(claudeMd.includes(".claude/outbox/"), "CLAUDE.md documents the outbox convention");
    // The seeded file is the agent's first context in this repo — an unnamed
    // "this repository" tells it nothing the path didn't already say.
    check(claudeMd.includes("fresh-proj"), "CLAUDE.md names the project");

    // Opting out keeps the old bare behaviour.
    const bare = await post("/api/repo", { name: "bare", setup: false });
    check(bare.files?.length === 0, "setup:false seeds nothing");
    check(!existsSync(join(bare.path, "README.md")) && !existsSync(join(bare.path, ".gitignore")), "bare repo has no scaffold files");
    check(git(bare.path, "rev-list", "--count", "HEAD") === "1", "bare repo still gets the empty init commit");

    // Containment: the name is slugged, so a traversal can't escape the root.
    const evil = await post("/api/repo", { name: "../escape" });
    // (paths come back realpath-resolved — on macOS ROOT is under /var → /private/var)
    check(!evil.path || evil.path.startsWith(realpathSync(ROOT)), "traversal name cannot escape the root");
    check(!existsSync(join(ROOT, "..", "escape")), "no repo created outside the root");
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  host.kill();
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
});

setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 20000);
