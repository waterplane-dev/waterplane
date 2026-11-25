// New-project scaffolding: POST /api/repo seeds a repo that is ready for phone
// use (branch main, first commit, gitignore/README/CLAUDE.md, inbox+outbox),
// `setup: false` still gives the bare git init, and the root guard holds.
import { watchdog } from "./lib-watchdog.mjs";
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
    check([`${STATE}/`, "\n.claude/inbox\n", "\n.claude/outbox\n", "\n.outbox\n"].every((l) => ignore.includes(l)), "gitignore covers the working dirs");
    check(git(r.path, "status", "--porcelain") === "", "working tree clean after the initial commit");

    const readme = readFileSync(join(r.path, "README.md"), "utf8");
    check(readme.startsWith("# fresh-proj") && readme.includes("A test project."), "README carries the slugged name + description");
    const claudeMd = readFileSync(join(r.path, "CLAUDE.md"), "utf8");
    check(claudeMd.includes(".claude/outbox/"), "CLAUDE.md documents the outbox convention");
    // The seeded file is the agent's first context in this repo — an unnamed
    // "this repository" tells it nothing the path didn't already say.
    check(claudeMd.includes("fresh-proj"), "CLAUDE.md names the project");

    // Ticked options need the token the sheet's own read minted, from a browser's Origin.
    const opts = await fetch(base + "/api/repo/options").then((x) => x.json());
    check(opts.options.some((o) => o.id === "auto-compact") && !!opts.confirm, "the desktop lists its set-up options");
    const create = (body, headers = { origin: base }) => fetch(base + "/api/repo", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, ...(await x.json()) }));
    const noTok = await create({ name: "ticked", options: ["auto-compact"] });
    const noOrigin = await create({ name: "ticked", options: ["auto-compact"], confirm: opts.confirm }, {});
    check(noTok.status === 403 && noOrigin.status === 403 && !existsSync(join(ROOT, "ticked")), "options without the token or an Origin are refused and nothing is created");
    const ticked = await create({ name: "ticked", options: ["auto-compact"], confirm: opts.confirm });
    check(ticked.notes?.length === 1 && !ticked.warning, "the ticked option is reported");
    check(git(ticked.path, "ls-files").split("\n").includes(".claude/settings.json"), "what it wrote is in the first commit");
    const again = await create({ name: "ticked2", options: ["auto-compact"], confirm: opts.confirm });
    check(again.status === 403, "the token works once");

    // R-onboarding-033: the repo it made says this desktop has a set-up page, the listing offers it, and the
    // mark (Back, skip, done) ends the offer. Idempotent, for an unknown repo a 404, never a GET.
    check(r.setupPage === true, "a created repo says the desktop has a set-up page");
    const listed = async () => (await (await fetch(base + "/api/repos")).json()).targets.find((t) => t.worktreePath === realpathSync(r.path) || t.worktreePath === r.path);
    const offered = await listed();
    check(offered?.setupUnseen === true, "the new repo is listed as unseen");
    check(offered?.worktreePath === r.path, `the create answers the path the listing has (${r.path} / ${offered?.worktreePath})`);
    const seen = (id, method = "POST") => fetch(`${base}/api/repos/${id}/optins/seen`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
    check((await seen(offered.id, "GET")).status === 404, "the mark is not a GET");
    check((await listed()).setupUnseen === true, "a GET marked nothing");
    for (const n of ["marked", "marked again"]) { const s = await seen(offered.id); check(s.status === 200 && (await s.json()).ok === true, `the page is ${n}`); }
    check((await listed()).setupUnseen === undefined, "a seen repo is offered nothing");
    check((await seen("no-such-repo")).status === 404, "an unknown repo is a 404");

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

watchdog(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); });
