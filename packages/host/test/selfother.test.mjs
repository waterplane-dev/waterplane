/**
 * The npm and checkout update buttons (`updates/selfother.ts`), against real git repos: every refusal
 * in words with nothing changed, the fast-forward, and a failed build that says where the checkout is.
 * npm and the build are an injected runner, so nothing is installed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { checkoutUpdate, checkoutBehind, npmPrefix, npmUpdate } = await import("../dist/updates/selfother.js");

const tmps = [];
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const G = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, env: G, encoding: "utf8" });
// realGit refuses the file protocol (right in production); the local bare remote needs it here.
const git = async (args, cwd) => {
  try { return execFileSync("git", args, { cwd, env: G, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(String(e.stderr || e.message).trim().split("\n").pop()); }
};

/** A bare upstream, a `pub` clone that pushes to it, and the `co` checkout under test. */
function repos() {
  const base = mkdtempSync(join(tmpdir(), "wp-co-")); tmps.push(base);
  const bare = join(base, "up.git"), pub = join(base, "pub"), co = join(base, "co");
  sh(base, "init", "-q", "--bare", "-b", "main", bare);
  mkdirSync(pub); sh(pub, "init", "-q", "-b", "main"); sh(pub, "remote", "add", "origin", bare);
  const commit = (dir, f, c) => { writeFileSync(join(dir, f), c); sh(dir, "add", f); sh(dir, "commit", "-q", "-m", f); };
  commit(pub, "a.txt", "1"); sh(pub, "push", "-q", "origin", "main");
  sh(base, "clone", "-q", bare, co);
  return { pub, co, commit, push: () => sh(pub, "push", "-q", "origin", "main") };
}

const okRun = (log) => async (cmd, args, cwd) => { log.push(args.join(" ")); return ""; };

test("checkout: up to date, behind, the fast-forward with npm ci + build, and behind is read after a fetch", async () => {
  const r = repos(), log = [];
  assert.deepEqual(await checkoutUpdate(r.co, git, okRun(log)), { ok: true, changed: false, message: "already at the newest commit on origin/main" });
  r.commit(r.pub, "b.txt", "2"); r.commit(r.pub, "c.txt", "3"); r.push();
  assert.deepEqual(await checkoutBehind(r.co, git), { behind: 2, upstream: "origin/main" });
  const res = await checkoutUpdate(r.co, git, okRun(log));
  assert.equal(res.ok, true); assert.equal(res.changed, true);
  assert.match(res.message, /^pulled 2 commits from origin\/main \(\w+ → \w+\) and rebuilt$/);
  assert.deepEqual(log, ["ci", "run build"]);
  assert.equal(sh(r.co, "rev-parse", "HEAD"), sh(r.pub, "rev-parse", "HEAD"));
});

test("checkout refusals change nothing: uncommitted changes, own commits, a detached HEAD, no upstream", async () => {
  const r = repos(), log = [];
  r.commit(r.pub, "b.txt", "2"); r.push();
  const head = sh(r.co, "rev-parse", "HEAD");
  writeFileSync(join(r.co, "a.txt"), "edited");
  const dirty = await checkoutUpdate(r.co, git, okRun(log));
  assert.equal(dirty.ok, false); assert.match(dirty.message, /uncommitted changes \(a\.txt\).*Nothing was changed\.$/);
  sh(r.co, "checkout", "-q", "--", "a.txt");
  writeFileSync(join(r.co, "new.txt"), "untracked is fine to leave");
  r.commit(r.co, "mine.txt", "x");
  const ahead = await checkoutUpdate(r.co, git, okRun(log));
  assert.equal(ahead.ok, false); assert.match(ahead.message, /1 commit not on origin\/main/);
  sh(r.co, "checkout", "-q", "--detach");
  assert.match((await checkoutUpdate(r.co, git, okRun(log))).message, /not on a branch/);
  sh(r.co, "checkout", "-q", "-b", "loose");
  assert.match((await checkoutUpdate(r.co, git, okRun(log))).message, /follows no remote branch/);
  assert.deepEqual(log, [], "npm never ran");
  assert.notEqual(sh(r.co, "rev-parse", "main"), head, "own commit kept"); // the local commit is still there, untouched
});

test("checkout: a failed build after the pull says so, where the checkout is, and that nothing restarted", async () => {
  const r = repos();
  r.commit(r.pub, "b.txt", "2"); r.push();
  const res = await checkoutUpdate(r.co, git, async (cmd, args) => { if (args[0] === "run") throw new Error("tsc: 3 errors"); return ""; });
  assert.equal(res.ok, false); assert.equal(res.changed, true);
  assert.match(res.message, /but the build failed: tsc: 3 errors\. The desktop keeps running the old code and was not restarted; the checkout is now at \w+ \(it was \w+\)\./);
});

test("npm: prefix from the install root, the pinned version, refusals in words", async () => {
  assert.equal(npmPrefix("/usr/local/lib/node_modules/waterplane"), "/usr/local");
  assert.equal(npmPrefix("C:/Users/x/AppData/Roaming/npm/node_modules/waterplane".split("/").join("/")), "C:/Users/x/AppData/Roaming/npm");
  const log = [];
  const ok = await npmUpdate("/usr/local/lib/node_modules/waterplane", "1.2.3", async (cmd, args) => { log.push(args.join(" ")); return ""; });
  assert.deepEqual(ok, { ok: true, changed: true, message: "installed 1.2.3 with npm" });
  assert.deepEqual(log, ["install --global --prefix /usr/local waterplane@1.2.3"]);
  assert.match((await npmUpdate("/r", "--registry=evil", async () => { throw new Error("ran"); })).message, /not a version/);
  const f = await npmUpdate("/r", "1.2.3", async () => { throw new Error("EACCES: permission denied"); });
  assert.equal(f.ok, false); assert.match(f.message, /EACCES.*keeps running the version it has/);
});
