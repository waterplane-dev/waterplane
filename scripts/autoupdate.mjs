#!/usr/bin/env node
// Rebuild and restart the host after a `git pull` / `git merge` brings new code into this checkout.
//
//   node scripts/autoupdate.mjs install     write .git/hooks/post-merge + post-rewrite (this clone only)
//   node scripts/autoupdate.mjs remove      take them out again
//   node scripts/autoupdate.mjs hook <name> what the hooks run: decide, then hand off to `run`
//   node scripts/autoupdate.mjs run         `npm run restart`, once per batch of merges
//
// A local hook, not a tracked hooks dir: it restarts a live daemon, which only the machine that
// runs one should opt into. The hook never makes the merge wait: it decides in milliseconds and the
// build runs detached, logged to <tmp>/<slug>-autoupdate.log. `npm run restart` builds first and
// leaves the running host alone when the build fails, so a broken merge never takes the host down.
//
// Skipped, with one line saying so:
//   - a linked worktree (an agent's `.claude/worktrees/…`): hooks are shared across worktrees, and
//     only the main checkout is what the host runs from;
//   - a merge touching nothing the host runs (docs, skills, notes);
//   - a merge that changes package-lock.json: `npm ci` replaces node_modules, which the running host
//     loads from (in WSL, the same files), so that one stays a person's step.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const say = (s) => console.log(`[autoupdate] ${s}`);
const git = (...args) => (spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout ?? "").trim();

const HOOKS = ["post-merge", "post-rewrite"];
const MARK = "# installed by scripts/autoupdate.mjs";

/** Paths whose change the running host would not see without a rebuild + restart. */
export const needsRestart = (path) =>
  (/^packages\/(?!app\/)/.test(path) && !/\.md$|\/test\//i.test(path)) || /^(package\.json|tsconfig[^/]*\.json)$/.test(path);
export const needsInstall = (path) => /(^|\/)package-lock\.json$/.test(path);

async function slug() {
  try { return (await import(pathToFileURL(join(REPO, "packages/shared/dist/brand.js")).href)).BRAND.slug; }
  catch { return "host"; }
}

function hooksDir() {
  const dir = git("rev-parse", "--git-path", "hooks");
  return resolve(REPO, dir);
}

function install(remove) {
  const dir = hooksDir();
  for (const name of HOOKS) {
    const file = join(dir, name);
    const ours = existsSync(file) && readFileSync(file, "utf8").includes(MARK);
    if (remove) { if (ours) { unlinkSync(file); say(`removed ${file}`); } continue; }
    if (existsSync(file) && !ours) { say(`left ${file} alone: it is not ours — add \`node scripts/autoupdate.mjs hook ${name} "$@"\` to it by hand`); continue; }
    // Linked worktrees share this hooks dir; only the main checkout (git-dir == common dir) acts.
    writeFileSync(file, [
      "#!/bin/sh",
      MARK,
      '[ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ] || exit 0',
      `exec node "$(git rev-parse --show-toplevel)/scripts/autoupdate.mjs" hook ${name} "$@"`,
      "",
    ].join("\n"));
    try { chmodSync(file, 0o755); } catch { /* Windows: git runs it through sh regardless */ }
    say(`installed ${file}`);
  }
  if (!remove) say("a pull or merge that changes host/web/shared code now rebuilds and restarts the host in the background");
}

async function hook(name, args) {
  // post-rewrite fires for `commit --amend` too; only a rebase (`pull --rebase`) brings code in.
  if (name === "post-rewrite" && args[0] !== "rebase") return;
  const from = git("rev-parse", "-q", "--verify", "ORIG_HEAD");
  const to = git("rev-parse", "HEAD");
  if (!from || from === to) return;
  const changed = git("diff", "--name-only", from, to).split("\n").filter(Boolean);
  if (changed.some(needsInstall)) {
    say("dependencies changed (package-lock.json) — not restarting on its own. Run: npm ci, then npm run restart");
    return;
  }
  if (!changed.some(needsRestart)) return;
  const log = join(tmpdir(), `${await slug()}-autoupdate.log`);
  const fd = openSync(log, "a");
  writeFileSync(fd, `---- ${new Date().toISOString()} ${name}: ${from.slice(0, 8)}..${to.slice(0, 8)}\n`);
  spawn(process.execPath, [SELF, "run"], { cwd: REPO, detached: true, stdio: ["ignore", fd, fd], windowsHide: true }).unref();
  closeSync(fd);
  say(`code changed — rebuilding and restarting the host in the background (log: ${log})`);
}

/** One restart at a time: a merge that lands while one runs leaves a mark, and the running one
 *  goes round once more — so the host always ends on the newest code, built once per batch. */
async function run() {
  const base = join(tmpdir(), `${await slug()}-autoupdate`);
  const lock = `${base}.lock`, again = `${base}.again`;
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    if (pid && pid !== process.pid) { process.kill(pid, 0); writeFileSync(again, ""); say("a restart is already running — it will go once more"); return; }
  } catch { /* no lock, or its process is gone */ }
  writeFileSync(lock, String(process.pid));
  try {
    do {
      try { unlinkSync(again); } catch { /* none */ }
      const r = spawnSync("npm run restart", { cwd: REPO, shell: true, stdio: "inherit", windowsHide: true });
      say(r.status === 0 ? "host restarted on the new code" : `restart failed (exit ${r.status}) — the host was left as it was`);
    } while (existsSync(again));
  } finally {
    try { unlinkSync(lock); } catch { /* gone */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "install": install(false); break;
    case "remove": install(true); break;
    case "hook": await hook(rest[0], rest.slice(1)); break;
    case "run": await run(); break;
    default: console.error("usage: node scripts/autoupdate.mjs install | remove | hook <name> | run"); process.exit(1);
  }
}
