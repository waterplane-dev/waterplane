// Run the e2e suite: every scripts/e2e-*.mjs (and every in-repo extension's
// packages/extensions/<id>/e2e/e2e-*.mjs, so a private extension's e2e travel
// with its folder and the public tree runs without them), sequentially, with a per-script
// timeout and a summary at the end. Discovering the scripts instead of listing
// them is deliberate — a hand-maintained list in package.json silently drifted
// until two thirds of the suite was never running in CI.
//
//   node scripts/run-e2e.mjs            # everything
//   node scripts/run-e2e.mjs git origin # only scripts whose name contains these
//
// Requires `npm run build` first: these drive packages/host/dist.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E } from "./lib-brand.mjs";
import { killTmuxIn, makeTmuxDir, tmuxIsoEnv } from "./lib-tmuxiso.mjs";

// Re-run under `with-tmp.mjs` so the whole run's temp files live in one dir that
// is removed at the end (and anything left in it is named). Not re-entered.
if (!process.env.WP_TMP_SWEPT) {
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, [join(dirname(self), "with-tmp.mjs"), process.execPath, self, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptsDir = join(repoRoot, "scripts");
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 240_000);

if (!existsSync(join(repoRoot, "packages/host/dist/main.js"))) {
  console.error("packages/host/dist is missing — run `npm run build` first.");
  process.exit(1);
}

const filters = process.argv.slice(2).filter((a) => !a.startsWith("--"));
/** Script name → its path relative to the repo root. */
const where = new Map();
const isE2e = (f) => f.startsWith("e2e-") && f.endsWith(".mjs");
for (const f of readdirSync(scriptsDir).filter(isE2e)) where.set(f, join("scripts", f));
const extRoot = join(repoRoot, "packages", "extensions");
for (const id of existsSync(extRoot) ? readdirSync(extRoot).sort() : []) {
  const dir = join(extRoot, id, "e2e");
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter(isE2e)) {
    if (where.has(f)) { console.error(`${f} exists in scripts/ and in packages/extensions/${id}/e2e/ — names must be unique`); process.exit(1); }
    where.set(f, join("packages", "extensions", id, "e2e", f));
  }
}
const scripts = [...where.keys()]
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)))
  .sort();

if (!scripts.length) {
  console.error(`No e2e scripts matched ${filters.join(", ")}`);
  process.exit(1);
}

/**
 * Run one script, streaming its output; resolve with its exit code.
 *
 * **Each script gets its own PROCESS GROUP, and the group is killed after it.**
 *
 * Not tidiness — the suite was unreliable without it, and the failure looked
 * exactly like a broken feature. Seventy of these scripts stop their host with
 * a bare `host.kill()` (SIGTERM) and do not wait for it to die; three already
 * escalate to SIGKILL, which is the fossil of somebody hitting this before. A
 * host that does not exit on SIGTERM — the `deaf` stub swallows Return, so
 * shutdown can sit in a pty write — is reparented to init and **keeps its
 * port**. The next run of that script then reports
 *
 *     [host] port 8814 already in use — exiting
 *     FAIL: swallowed Return: instruction still written exactly once (copies: 0)
 *
 * which reads as the feature being broken and is a stale process. It is
 * self-perpetuating: every run leaves one more orphan, so a script passes
 * first, then fails for ever after.
 *
 * Killing the GROUP fixes all seventy at once and needs no edit to any of
 * them — the alternative was a wait-then-SIGKILL helper threaded through every
 * script, i.e. seventy chances for number seventy-one to forget. `detached`
 * makes the child a group leader; `-pid` addresses the group. The kill is best
 * effort: a group that has already gone throws ESRCH, which is the good case.
 */
/**
 * Groups currently alive, so a signal to the RUNNER takes them with it.
 *
 * The other side of `detached`: the child is no longer in our group, so a
 * ctrl-C or an external kill of this process no longer reaches its script or
 * the hosts that script spawned — they survive, holding their ports, and the
 * next run fails to bind. That is the very failure the detaching was added to
 * fix, arriving through the other door.
 */
const liveGroups = new Set();
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    for (const pid of liveGroups) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
    process.exit(130);
  });
}

/** Resolve once no process in `pgid` answers signal 0 — or the deadline passes,
 *  which is not worth failing the run over: the next script's own bind error is
 *  a better message than one invented here. */
async function groupGone(pgid, deadlineMs = 3000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try { process.kill(-pgid, 0); } catch { return; } // ESRCH — nobody left
    if (Date.now() > until) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The ports a script declares in its own source.
 *
 * The scripts hand-assign them as literals (`const PORT = 8813`) and **they
 * collide**: four scripts sit on 8813, five on 8796. That is fine for a
 * sequential runner and fine only for as long as each host is provably gone
 * before its successor binds — and reaping alone did not get there, because a
 * script's host can outlive the reap by more than the wait, or hold the port in
 * a state a fresh bind is refused. So the runner clears the ground first.
 *
 * Read from the source rather than declared centrally because that is where the
 * numbers actually are; a table here would be a second copy to keep in step.
 */
function portsOf(file) {
  let src = "";
  try { src = readFileSync(join(repoRoot, where.get(file)), "utf8"); } catch { return []; }
  const found = new Set();
  for (const m of src.matchAll(/\b(8[0-9]{3})\b/g)) {
    const n = Number(m[1]);
    // Never the daemon's own port: this runner must not be able to take down
    // the host the developer is using, whatever a script happens to contain.
    if (n >= 8790 && n <= 8960 && n !== DAEMON_PORT) found.add(n);
  }
  return [...found];
}

/** The port the developer's own daemon listens on — off limits, always. */
const DAEMON_PORT = Number(process.env[E.PORT] || 8770);

/** Kill whatever is listening on a port, if it is one of OUR hosts. The command
 *  check is the safety rail: an unrelated process that happens to hold 8813 is
 *  left alone and the script's own bind error reports it. */
function freePort(port) {
  try {
    const pids = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const pid of pids) {
      let cmd = "";
      try { cmd = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }); } catch { continue; }
      if (!cmd.includes("packages/host/dist/main.js")) continue;
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* raced us to it */ }
    }
  } catch { /* lsof found nothing, or is not here — the bind error will say */ }
}

/**
 * A host a script boots must never read or MOVE the developer's own per-user
 * dirs: the boot renames a legacy `~/.config/<old>` and `~/.local/share/<old>`
 * to the current name, and reads secrets and plugins from the config dir. So
 * every script runs with a throwaway config dir and data home unless it set
 * its own (the scripts that test those dirs do). `--keep-user-dirs` opts out.
 *
 * Same for the host's global STATE dir (acks, sessions, settings — default
 * `~/.local/state/<name>`): every script pins it per host with `rootEnv(root)`
 * (`lib-brand.mjs`), and this is the belt for one that forgot — a fresh
 * `XDG_STATE_HOME` PER SCRIPT, so a missed pin lands in a throwaway dir no
 * other script shares, never in the developer's real state.
 */
const isolate = !process.argv.includes("--keep-user-dirs");
const SANDBOX = isolate ? mkdtempSync(join(tmpdir(), "e2e-userdirs-")) : null;
const childEnv = isolate
  ? { ...process.env, [E.CONFIG_DIR]: join(SANDBOX, "config"), XDG_DATA_HOME: join(SANDBOX, "data") }
  : process.env;
process.on("exit", () => { if (SANDBOX) try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });

/**
 * **Each script gets its own tmux socket DIRECTORY, and every server in it is
 * killed after it.** Sessions run inside tmux (there is no other substrate), and
 * a tmux server daemonizes out of the script's process group, so the group kill
 * above never reaches it: a script that died, timed out or forgot to clean up
 * would leave its stub panes running for ever. A private `TMUX_TMPDIR` also
 * means no `-L` name a script or its host picks can resolve to the owner's live
 * server (`lib-tmuxiso.mjs`).
 */
const tmuxDirs = new Set();
process.on("exit", () => { for (const d of tmuxDirs) killTmuxIn(d); });

function runOne(file) {
  for (const port of portsOf(file)) freePort(port);
  return new Promise((resolve) => {
    const tmuxDir = makeTmuxDir();
    tmuxDirs.add(tmuxDir);
    const env = tmuxIsoEnv(isolate ? { ...childEnv, XDG_STATE_HOME: join(SANDBOX, "state", file) } : childEnv, tmuxDir);
    const child = spawn(process.execPath, [where.get(file)], { cwd: repoRoot, env, stdio: "inherit", detached: true });
    liveGroups.add(child.pid);
    const reap = () => {
      liveGroups.delete(child.pid);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone — the good case */ }
      killTmuxIn(tmuxDir);
      tmuxDirs.delete(tmuxDir);
    };
    const timer = setTimeout(() => {
      console.error(`\n[run-e2e] ${file} exceeded ${TIMEOUT_MS / 1000}s — killing it.`);
      reap();
    }, TIMEOUT_MS);
    child.on("close", async (code) => {
      clearTimeout(timer);
      // The script is done; anything still alive in its group is a host it
      // failed to stop, and it is holding the port the NEXT run needs.
      reap();
      // …and WAIT for the group to actually be gone before the next script
      // starts. Killing is asynchronous, and the ports here are shared — five
      // scripts sit on 8796 alone, which is fine for a sequential runner and
      // fine only for as long as each host is provably dead before its
      // successor binds. Without this the next script boots into
      // `port 8796 already in use`, exits, and its assertions fail against a
      // host that never existed.
      await groupGone(child.pid);
      resolve(code ?? 1);
    });
    child.on("error", (err) => { clearTimeout(timer); console.error(`[run-e2e] ${file} failed to start:`, err); resolve(1); });
  });
}

const failures = [];
for (const file of scripts) {
  console.log(`\n──────── ${file} ────────`);
  const started = Date.now();
  const code = await runOne(file);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (code === 0) console.log(`[run-e2e] ${file} passed (${secs}s)`);
  else { console.error(`[run-e2e] ${file} FAILED with exit ${code} (${secs}s)`); failures.push(file); }
}

console.log(`\n════════ ${scripts.length - failures.length}/${scripts.length} e2e scripts passed ════════`);
for (const f of failures) console.error(`  FAILED  ${f}`);
process.exit(failures.length ? 1 : 0);
