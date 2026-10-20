// Run the e2e suite: every scripts/e2e-*.mjs (and every in-repo extension's
// packages/extensions/<id>/e2e/e2e-*.mjs, so a private extension's e2e travel
// with its folder and the public tree runs without them), in a pool of worker
// slots, with a per-script timeout and a summary at the end. Discovering the
// scripts instead of listing them is deliberate — a hand-maintained list in
// package.json silently drifted until two thirds of the suite was never running in CI.
//
//   node scripts/run-e2e.mjs            # everything, E2E_JOBS / default jobs
//   node scripts/run-e2e.mjs git origin # only scripts whose name contains these
//   node scripts/run-e2e.mjs --jobs 1   # one at a time, output streamed live
//
// Requires `npm run build` first: these drive packages/host/dist.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, homedir, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E, SLUG } from "./lib-brand.mjs";
import { killTmuxIn, makeTmuxDir, tmuxIsoEnv } from "./lib-tmuxiso.mjs";
import { portLocks } from "./lib-portlock.mjs";

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

/**
 * How many scripts run at once: `--jobs N` (or `--jobs=N`), else `E2E_JOBS`, else 60% of the
 * cores capped at 10. Not all: every script boots a host, a tmux server and a stub TUI, and
 * the scripts assert on timing windows (settle, echo, idle) that a saturated machine
 * stretches. But a script mostly WAITS on those windows — the pre-push gate showed 20% CPU at
 * the old cap of 6 on 16 cores. Past 10 the port-sharing scripts bind it anyway: e2e-settle
 * and e2e-settlesweep both own 8861, ~140 s back to back, so wider buys nothing (2026-10-16,
 * simulated off e2e-times.json: 6 → ~220 s, 10 → ~150 s, 16 → ~150 s).
 */
function jobsArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const m = /^--jobs(?:=(.*))?$/.exec(argv[i]);
    if (m) return m[1] ?? argv[i + 1];
  }
  return process.env.E2E_JOBS;
}
const cores = (() => { try { return availableParallelism(); } catch { return cpus().length || 2; } })();
const JOBS = (() => {
  const asked = jobsArg(process.argv.slice(2));
  if (asked !== undefined && asked !== "") {
    const n = Number(asked);
    if (!Number.isInteger(n) || n < 1) { console.error(`--jobs / E2E_JOBS must be a whole number >= 1, not "${asked}"`); process.exit(2); }
    return n;
  }
  return Math.max(1, Math.min(10, Math.ceil(cores * 0.6)));
})();

/**
 * Scripts that must run ALONE — nothing else from this run beside them. Each line says why;
 * a script lands here only for a measured reason that its own source cannot fix without
 * weakening what it asserts. They run after the pool has drained, one at a time.
 */
const SERIAL = new Map([
  // e2e-restore and e2e-backlog-echo were here while they booted a second host behind a fixed
  // 900 ms sleep (refused beside five other boots); since they wait for the host to answer
  // (1a470120) they run in the pool. Shape: ["e2e-x.mjs", "why"].
  ["e2e-templates.mjs", "a real Gradle build of the android-hello template: 65 s alone and CPU-bound, it ran past the 240 s limit beside five other scripts"],
]);

const argv = process.argv.slice(2);
const filters = argv.filter((a, i) => !a.startsWith("--") && !/^--jobs$/.test(argv[i - 1] ?? ""));
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

/**
 * A port the runner cannot SEE is a port it cannot keep two scripts off. `e2e-backlog-echo`
 * declared 8812 and booted two more hosts on `PORT + 1` and `PORT + 2`: the scheduler only
 * knew 8812, ran it beside e2e-restore (8813), and its retrying bind took 8813 in restore's
 * 800 ms restart gap — restore's second host was locked out and its requests were answered
 * by backlog-echo's host, an empty recent list (2026-10-16, 2 of 16 under load). So a script
 * that derives a port by arithmetic is refused before it runs: every port is a literal.
 * Comment lines are skipped so a script can still say why.
 */
function hiddenPortsOf(file) {
  let src = "";
  try { src = readFileSync(join(repoRoot, where.get(file)), "utf8"); } catch { return null; }
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const m = /\b(?:[A-Z_]*PORT|port|[a-z]\w*Port)\s*[+-]\s*\d+/.exec(code);
  return m ? m[0] : null;
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
 * **A port is OWNED for the length of one script — across every run on this
 * machine — before `freePort` may clear it.**
 *
 * `freePort` cannot tell a stale host of ours from a LIVE host of another run:
 * both are `packages/host/dist/main.js` on the port. Two `git push`es run two
 * full suites at once (one pre-push hook each), and the suites drift through the
 * alphabet independently — so suite B starting `e2e-submit` (8836) SIGKILLed
 * suite A's host in the middle of `e2e-smartpick` (8836 too; a script since
 * removed with the smart pick). A then reported
 * 123/124 with smartpick failing, B passed, and the one failure read as a flaky
 * feature under load. Reproduced by starting `run-e2e submit` eight seconds into
 * `run-e2e smartpick`: submit passes, smartpick fails every time.
 *
 * So each script first takes a lock file per declared port, in ascending order
 * (no two runs can then wait on each other in a cycle), and gives them all back
 * before the next script takes its own — a run never holds one port while
 * waiting for its next script's. The other run is simply waited for: its script
 * ends within `TIMEOUT_MS`. A lock whose owner is gone (crashed, kill -9) is
 * taken over, so a dead run never wedges the next one. The dir is `/tmp` rather
 * than `tmpdir()`, because `with-tmp.mjs` gives every run a TMPDIR of its own.
 */
const PORT_LOCKS = join(existsSync("/tmp") ? "/tmp" : tmpdir(), `${SLUG}-e2e-ports`);
// The lock itself — atomic creation, and a takeover exactly one run can win —
// is `lib-portlock.mjs`, where the two races the first version had are written
// down and `tools/portlock.test.mjs` pins them.
//
// The lock's owner is a PID, so it says nothing about two workers of THIS run: both are
// the same pid, and `tryAcquire` hands a port back to its own owner. Inside one run the
// exclusion is the scheduler's instead — a script is only started when none of its ports
// is in `busyPorts` (`nextRunnable`), so two scripts sharing 8813 serialize, never collide.
const locks = portLocks({ dir: PORT_LOCKS });
/** Every port some script of this run holds right now (the in-process half). */
const busyPorts = new Set();
async function acquirePorts(ports, file, heldPorts, say) {
  const deadline = Date.now() + TIMEOUT_MS + 30_000;
  for (const port of [...ports].sort((a, b) => a - b)) {
    let said = false;
    for (;;) {
      const got = locks.tryAcquire(port);
      if (got.held) { heldPorts.add(port); break; }
      if (Date.now() > deadline) {
        throw new Error(`port ${port} is still held by another e2e run (pid ${got.owner || "unknown"}) after ${(TIMEOUT_MS + 30_000) / 1000}s — not killing its host`);
      }
      // owner 0: a takeover is in flight right now — look again in a moment.
      if (!got.owner) { await new Promise((r) => setTimeout(r, 50)); continue; }
      if (!said) { say(`[run-e2e] ${file}: port ${port} is in use by another e2e run (pid ${got.owner}) — waiting for it, not killing it\n`); said = true; }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
function releasePorts(heldPorts) {
  for (const port of heldPorts) locks.release(port);
  heldPorts.clear();
}
/** Every script's held set, so an exit mid-run gives all of them back. */
const allHeld = new Set();
process.on("exit", () => { for (const h of allHeld) releasePorts(h); });

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
/** All three dirs are PER SCRIPT: with scripts running side by side, one shared config dir
 *  would be one script's secrets and plugins showing up in another's host. */
const envFor = (file) => isolate
  ? {
      ...process.env,
      [E.CONFIG_DIR]: join(SANDBOX, "config", file),
      XDG_DATA_HOME: join(SANDBOX, "data", file),
      XDG_STATE_HOME: join(SANDBOX, "state", file),
    }
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

if (SANDBOX) for (const d of ["config", "data", "state"]) mkdirSync(join(SANDBOX, d), { recursive: true });

/**
 * One script, start to finish: its ports (this run's scheduler already made sure no
 * sibling holds them; the lock files keep OTHER runs off them), the ground cleared, the
 * child run, everything given back. `say` is where its lines go — the script's own buffer
 * in a pool, the terminal at `--jobs 1`.
 */
async function runOne(file, say) {
  const hidden = hiddenPortsOf(file);
  if (hidden) { say(`[run-e2e] ${file}: derives a port by arithmetic (\`${hidden}\`) — the scheduler reads ports from the literals, so this one could land on a sibling's. Give it a literal of its own.\n`); return 1; }
  const ports = portsOf(file);
  const held = new Set();
  allHeld.add(held);
  try {
    try { await acquirePorts(ports, file, held, say); } catch (e) { say(`[run-e2e] ${e.message}\n`); return 1; }
    for (const port of ports) freePort(port);
    return await runChild(file, say);
  } finally {
    releasePorts(held);
    allHeld.delete(held);
  }
}

function runChild(file, say) {
  return new Promise((resolve) => {
    const tmuxDir = makeTmuxDir();
    tmuxDirs.add(tmuxDir);
    const env = tmuxIsoEnv(envFor(file), tmuxDir);
    const live = JOBS === 1;
    const child = spawn(process.execPath, [where.get(file)], { cwd: repoRoot, env, stdio: live ? "inherit" : ["ignore", "pipe", "pipe"], detached: true });
    // stdout and stderr into ONE buffer in arrival order, so a FAIL line sits where it was
    // printed, between the lines around it — two buffers would print every error at the end.
    const drained = live ? Promise.resolve() : Promise.all([child.stdout, child.stderr].map((s) => new Promise((r) => {
      s.on("data", (d) => say(d));
      s.on("close", r);
    })));
    liveGroups.add(child.pid);
    const reap = () => {
      liveGroups.delete(child.pid);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone — the good case */ }
      killTmuxIn(tmuxDir);
      tmuxDirs.delete(tmuxDir);
    };
    const timer = setTimeout(() => {
      say(`\n[run-e2e] ${file} exceeded ${TIMEOUT_MS / 1000}s — killing it.\n`);
      reap();
    }, TIMEOUT_MS);
    // `exit`, not `close`: with piped stdio, `close` waits for EVERY holder of the pipe, and a
    // host the script spawned with inherited stdio holds it until the reap below kills it —
    // so `close` would wait for the timeout. The pipes are drained after the reap instead.
    child.on("exit", async (code) => {
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
      // A daemonized grandchild that left the group could still hold a pipe: never wait on it long.
      await Promise.race([drained, new Promise((r) => setTimeout(r, 2000))]);
      resolve(code ?? 1);
    });
    child.on("error", (err) => { clearTimeout(timer); say(`[run-e2e] ${file} failed to start: ${err?.message ?? err}\n`); resolve(1); });
  });
}

/**
 * Longest first, by the last run's times: the pool's wall time is bounded below by its
 * slowest script, and a 3-minute script started last is 3 minutes of one busy worker while
 * the rest sit idle. Only ORDER comes from this file — never what runs — so a missing or
 * stale file costs a little wall time, nothing else. `E2E_TIMES=0` turns it off.
 */
const TIMES_FILE = process.env.E2E_TIMES === "0" ? null
  : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), SLUG, "e2e-times.json");
const lastTimes = (() => { try { return JSON.parse(readFileSync(TIMES_FILE, "utf8")) || {}; } catch { return {}; } })();
const thisTimes = {};

const pooled = scripts.filter((f) => !SERIAL.has(f))
  .sort((a, b) => (lastTimes[b] ?? 60) - (lastTimes[a] ?? 60) || a.localeCompare(b));
const serial = scripts.filter((f) => SERIAL.has(f));

/** The first queued script none of whose ports a running sibling holds. */
function nextRunnable(queue) {
  const i = queue.findIndex((f) => portsOf(f).every((p) => !busyPorts.has(p)));
  return i < 0 ? null : queue.splice(i, 1)[0];
}

const failures = [];
/** A failed script's whole output, for the recap at the very end. */
const failedOutput = new Map();
const wallStart = Date.now();

async function runAndReport(file) {
  const ports = portsOf(file);
  for (const p of ports) busyPorts.add(p);
  const started = Date.now();
  const live = JOBS === 1;
  const out = [];
  const keep = (d) => out.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
  const say = live ? (d) => { process.stdout.write(d); keep(d); } : keep;
  if (live) console.log(`\n──────── ${file} ────────`);
  let code = 1;
  try { code = await runOne(file, say); } finally { for (const p of ports) busyPorts.delete(p); }
  const secs = (Date.now() - started) / 1000;
  thisTimes[file] = Math.round(secs);
  const verdict = code === 0 ? `[run-e2e] ${file} passed (${secs.toFixed(1)}s)` : `[run-e2e] ${file} FAILED with exit ${code} (${secs.toFixed(1)}s)`;
  const tail = Buffer.concat(out).toString("utf8");
  if (code !== 0) { failures.push(file); failedOutput.set(file, tail); }
  if (live) { (code === 0 ? console.log : console.error)(verdict); return; }
  // One block per script, whole, in the order scripts FINISH — never two scripts' lines mixed.
  process.stdout.write(`\n──────── ${file} ────────\n${tail}${tail.endsWith("\n") || !tail ? "" : "\n"}${verdict}\n`);
}

/**
 * A machine already this loaded (1-minute load average) gets no NEW script until it falls —
 * one always keeps running, so this throttles toward serial, never to a halt. The suite's
 * failures under someone else's load spike are hosts that had not bound yet when a script's
 * first request went out; adding five more boots to a load of 150 only makes more of them.
 * Default twice the cores (the pool alone stays well under it); `E2E_MAX_LOAD=0` turns it off.
 */
const MAX_LOAD = process.env.E2E_MAX_LOAD !== undefined && process.env.E2E_MAX_LOAD !== ""
  ? Number(process.env.E2E_MAX_LOAD) : cores * 2;
const overloaded = () => MAX_LOAD > 0 && loadavg()[0] > MAX_LOAD;

/** Run `queue` on `width` workers; a worker with nothing runnable waits for a sibling to finish. */
async function pool(queue, width) {
  const running = new Set();
  let wake = () => {};
  const finished = () => { const w = wake; wake = () => {}; w(); };
  let throttled = false;
  while (queue.length || running.size) {
    let file = null;
    const hot = width > 1 && queue.length > 0 && overloaded();
    if (hot !== throttled) {
      console.log(hot
        ? `[run-e2e] load average ${loadavg()[0].toFixed(0)} > ${MAX_LOAD} — one script at a time until it falls`
        : `[run-e2e] load average back to ${loadavg()[0].toFixed(0)} — up to ${width} at a time again`);
      throttled = hot;
    }
    const busy = hot && running.size > 0;
    if (!busy && running.size < width && queue.length) file = nextRunnable(queue);
    if (file) {
      const p = runAndReport(file).finally(() => { running.delete(p); finished(); });
      running.add(p);
      continue;
    }
    // Throttled: look at the load again in a couple of seconds even if nobody finishes.
    await new Promise((r) => { wake = r; if (busy) setTimeout(finished, 2000); });
  }
}

console.log(`[run-e2e] ${scripts.length} script(s), ${Math.min(JOBS, pooled.length) || 1} at a time${serial.length ? ` + ${serial.length} alone afterwards (${serial.join(", ")})` : ""} — ${cores} cores`);
await pool(pooled, JOBS);
for (const file of serial) {
  if (JOBS > 1) console.log(`\n[run-e2e] ${file} runs alone: ${SERIAL.get(file)}`);
  await runAndReport(file);
}

if (TIMES_FILE && Object.keys(thisTimes).length) {
  try {
    mkdirSync(dirname(TIMES_FILE), { recursive: true });
    writeFileSync(TIMES_FILE, JSON.stringify({ ...lastTimes, ...thisTimes }, null, 1) + "\n");
  } catch { /* an ordering hint; never worth failing a run over */ }
}

/**
 * Each script that failed in the pool runs ONCE more, alone, so the summary can say which kind
 * of failure it was: one that fails alone too is a plain break; one that passes alone failed
 * only beside its siblings — a timing window in the test or the code that load stretched.
 * That second kind STILL fails the run. Passing alone does not make it right (e2e-search's
 * was a real race in the test that load exposed), and a gate that waved it through would let
 * it be pushed and never looked at again; the verdict exists so nobody spends the first ten
 * minutes re-running it by hand to find out which kind it is.
 * Only for a few: more than RETRY_MAX failing at once is a break, and re-running them would
 * only make the refused push slower. `E2E_RETRY_ALONE=0` turns it off.
 */
const RETRY_MAX = 3;
const aloneVerdict = new Map(); // file → true passed alone / false failed alone too
const retrying = JOBS > 1 && failures.length > 0 && failures.length <= RETRY_MAX && process.env.E2E_RETRY_ALONE !== "0";
if (retrying) {
  for (const file of failures) {
    console.log(`\n[run-e2e] ${file} failed beside other scripts — running it once more alone, to tell a load flake from a break`);
    const out = [];
    const started = Date.now();
    const code = await runOne(file, (d) => out.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    aloneVerdict.set(file, code === 0);
    if (code === 0) { console.log(`[run-e2e] ${file} passed alone (${secs}s)`); continue; }
    const text = Buffer.concat(out).toString("utf8");
    failedOutput.set(file, text); // the alone run's lines: no sibling's load in them
    process.stdout.write(`\n──────── ${file} (alone) ────────\n${text}${text.endsWith("\n") || !text ? "" : "\n"}[run-e2e] ${file} FAILED alone too with exit ${code} (${secs}s)\n`);
  }
}

/**
 * The lines that say WHY, out of a failed script's output: every FAIL line with the indented
 * lines under it (e2e-halt prints what survived there), the runner's own kill notice, or the
 * last few lines when the script died without a FAIL. Printed in the summary because a push
 * refused from the phone shows only the last lines of the output — the script's own block
 * had scrolled out of that view, and with it the one line that named the cause.
 */
const RECAP_LINES = 12;
function whyLines(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length && out.length < RECAP_LINES; i++) {
    if (!/^\s*FAIL\b|exceeded \d+s — killing|failed to start|^\[run-e2e\] .*: derives a port/.test(lines[i])) continue;
    out.push(lines[i]);
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && j <= i + 6 && out.length < RECAP_LINES; j++) out.push(lines[j]);
  }
  if (!out.length) out.push(...lines.filter((l) => l.trim()).slice(-5));
  return out.map((l) => (l.length > 200 ? l.slice(0, 199) + "…" : l));
}
const kindOf = (file) => !aloneVerdict.has(file) ? ""
  : aloneVerdict.get(file) ? " — passes alone: fails only beside other scripts, a timing window load stretched (still a failure)"
  : " — fails alone too";

const wall = Math.round((Date.now() - wallStart) / 1000);
console.log(`\n════════ ${scripts.length - failures.length}/${scripts.length} e2e scripts passed in ${wall}s (jobs ${JOBS}) ════════`);
if (failures.length > RETRY_MAX && JOBS > 1) console.error(`  (${failures.length} failed at once — not re-run alone; that many is a break, not load)`);
for (const f of failures.sort()) {
  console.error(`  FAILED  ${f}${kindOf(f)}`);
  for (const l of whyLines(failedOutput.get(f) ?? "")) console.error(`      ${l}`);
}
process.exit(failures.length ? 1 : 0);
