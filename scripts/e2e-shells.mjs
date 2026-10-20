// Background shells, end to end: a stop by pid, a stop-them-all by closing the
// session, and the wire that carries both.
//
// `shells.ts` (host) reads a background shell off `ps`, matched against the
// CLI's own `~/.claude/sessions/<pid>.json`. Nothing about that fixture needs
// the real `claude` binary or its TUI — the plain-bash stub (`claude-stub.sh`)
// already gives every e2e a REAL, live PTY process to be "the CLI", and the
// wrapper shape (`… shell-snapshots/snapshot-… && eval '<cmd>' < /dev/null`)
// is just a command line, so it is typed into that live bash the same way
// `e2e-answer.mjs` types a fake choice box: as ordinary keystrokes, backed by
// job control giving the backgrounded job its OWN process group for free (no
// `setsid` needed, and macOS ships none). The CLI record file itself is
// written by hand, because nothing but the real CLI ever writes one — that
// part of the fixture cannot come from a stub, only from the test standing in
// for the CLI the way the record's own reader (`agents.ts`) expects it.
//
// Asserts: a shellList row appears once the record says "shell" and a wrapper
// exists under it; `shell.kill` stops it (ok), then refuses a second try on
// the same pid ("already ended") rather than acting on a pid the kernel may
// have since reused; `session.remove` stops a SECOND, still-live wrapper
// before tearing the session down, and reports it in `session.closed`. And —
// the gap a shellList/shell.killed reading alone cannot close — that the
// stub's own `sleep 600` is REALLY gone from the process table afterwards,
// checked by `ps` against this script's own recorded pids only, never a
// process this script did not itself spawn.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8799;
const HOME = mkdtempSync(join(tmpdir(), `${SLUG}-shells-home-`));
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-shells-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.CLAUDE_HOME]: HOME,
  // Default 5s; a poll this e2e can afford to wait out a few times over.
  [E.AGENT_POLL_MS]: "250",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;

// Every process this script itself spawns under the bash stub — swept in a
// finally, regardless of how the assertions came out. Nothing here ever
// touches a process this script did not create.
const wrapperPids = [];
const cleanup = () => {
  for (const pid of wrapperPids) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
  try { host.kill(); } catch { /* already gone */ }
};
const done = () => { cleanup(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };
// `E2E_SHELLS_DEBUG=1` dumps the PTY transcript on a failure — this fixture's
// three-way race (a real shell, real job control, a real poll interval) is
// the one thing here that is not pure logic, and "never showed up" is a much
// shorter debugging session with the screen in hand.
const screenRef = { v: "" };
const fail = (m) => { check(false, m); if (process.env.E2E_SHELLS_DEBUG) console.error("[screen]\n" + screenRef.v); done(); };

// `ps`, scoped to exactly the pgid this script itself spawned (`wrapperPids`)
// — never a system-wide search, and never touching a process this script did
// not create. True while ANY row in that group is still `sleep 600`.
const sleepStillUnder = (pgid) => {
  let out;
  try { out = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }); } catch { return false; }
  return out.split("\n").some((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m && Number(m[2]) === pgid && /sleep 600/.test(m[3]);
  });
};
const until = async (cond, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
  return false;
};

bootWait(PORT, 900, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "shells" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null;
    let info = null;
    let screen = "";
    const closedMsgs = [];
    const killedMsgs = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid)) info = m.session;
      if (m.t === "session.list") { const s = m.sessions.find((x) => x.id === sid); if (s) info = s; }
      if (m.t === "pty" && m.id === sid) { screen += Buffer.from(m.dataB64, "base64").toString("utf8"); screenRef.v = screen; }
      if (m.t === "session.closed" && m.id === sid) closedMsgs.push(m);
      if (m.t === "shell.killed" && m.id === sid) killedMsgs.push(m);
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(150);
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 }));

    if (!(await until(() => sid))) return fail("session never created");
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));
    if (!(await until(() => info?.claudeSessionId))) return fail("session never minted a claude session id (needed to match the CLI record)");
    const claudeSessionId = info.claudeSessionId;

    // The stub is an INTERACTIVE bash, and interactive bash has history
    // expansion on by default — "$!" (the pid this whole fixture is built
    // around) is read as an event designator and blows up with
    // `bash: !": event not found` unless this is off.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "set +H\r" }));
    await sleep(150);

    // ── Learn the stub's own pid — it stands in for "the CLI" ────────────
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "printf 'BASHPID %s\\n' \"$$\"\r" }));
    if (!(await until(() => /BASHPID (\d+)/.test(screen)))) return fail("never read the stub's own pid back off the PTY");
    const cliPid = Number(/BASHPID (\d+)/.exec(screen)[1]);
    check(cliPid > 0, `learned the stub's pid (${cliPid}) — this is the fixture's "CLI"`);

    // ── The CLI record only the real CLI would normally write ────────────
    // `readCliRecord` matches it by conversation id (tmux is off in this
    // suite), so `sessionId` here must be the SAME id the session minted.
    const sessionsDir = join(HOME, ".claude", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const recordPath = join(sessionsDir, `${cliPid}.json`);
    writeFileSync(recordPath, JSON.stringify({ pid: cliPid, sessionId: claudeSessionId, status: "shell" }));

    // A fresh watch is what makes `checkAgents` read again — the FIRST read
    // (on the attach above) ran before this file existed and, finding
    // nothing, did not re-arm its own poll. Detach/reattach re-triggers it.
    ws.send(JSON.stringify({ t: "session.detach", id: sid }));
    await sleep(100);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));

    // ── Spawn a wrapper shaped exactly like the CLI's own ─────────────────
    // No `setsid` (macOS ships none): an INTERACTIVE shell backgrounding a
    // job already gives it its own process group, which is the one thing the
    // discriminator (`isShellWrapper`) requires.
    const spawnWrapper = (marker) => {
      const cmd = `/bin/zsh -c "source ~/.claude/shell-snapshots/snapshot-zsh-stub.sh 2>/dev/null || true `
        + `&& eval 'sleep 600' < /dev/null && pwd -P >| /tmp/claude-e2e-shells-cwd" &\r`
        + `printf '${marker} %s\\n' "$!"\r`;
      ws.send(JSON.stringify({ t: "session.input", id: sid, data: cmd }));
    };
    spawnWrapper("WRAP1");
    if (!(await until(() => /WRAP1 (\d+)/.test(screen)))) return fail("wrapper #1 never backgrounded");
    const wrap1 = Number(/WRAP1 (\d+)/.exec(screen)[1]);
    wrapperPids.push(wrap1);

    // ── shellList picks it up ─────────────────────────────────────────────
    if (!(await until(() => info?.shellList?.length === 1))) return fail(`shellList never showed the wrapper (last: ${JSON.stringify(info?.shellList)})`);
    let row = info.shellList[0];
    check(row.pid === wrap1, `the row names the wrapper's own pid (${row.pid} vs ${wrap1})`);
    check(row.command === "sleep 600", `the row's command is the eval'd text, unwrapped (got ${JSON.stringify(row.command)})`);

    // ── shell.kill: ok, then refused on the same pid ──────────────────────
    ws.send(JSON.stringify({ t: "shell.kill", id: sid, pid: row.pid, startedAt: row.startedAt }));
    if (!(await until(() => killedMsgs.length === 1))) return fail("no shell.killed for the first kill");
    check(killedMsgs[0].ok === true, `shell.kill stops a live wrapper (reason: ${killedMsgs[0].reason})`);
    if (!(await until(() => info?.shellList?.length === 0))) return fail("shellList did not clear after the kill");
    // `ok: true` from `shell.kill` is a claim about the real process table,
    // not just the wire — checked here against `ps`, scoped to this wrapper's
    // OWN pgid (`wrap1`) and nothing else on the machine.
    check(!sleepStillUnder(wrap1), "the stub's `sleep 600` is actually gone from the process table after shell.kill");

    ws.send(JSON.stringify({ t: "shell.kill", id: sid, pid: row.pid, startedAt: row.startedAt }));
    if (!(await until(() => killedMsgs.length === 2))) return fail("no shell.killed for the repeat kill");
    check(killedMsgs[1].ok === false, "a repeat kill on the same pid is refused, not re-signalled");
    check(killedMsgs[1].reason === "that shell has already ended", `refused in words (got ${JSON.stringify(killedMsgs[1].reason)})`);

    // ── session.remove stops a still-live wrapper before tearing down ─────
    spawnWrapper("WRAP2");
    if (!(await until(() => /WRAP2 (\d+)/.test(screen)))) return fail("wrapper #2 never backgrounded");
    const wrap2 = Number(/WRAP2 (\d+)/.exec(screen)[1]);
    wrapperPids.push(wrap2);
    if (!(await until(() => info?.shellList?.length === 1))) return fail("shellList never showed wrapper #2");

    ws.send(JSON.stringify({ t: "session.remove", id: sid }));
    if (!(await until(() => closedMsgs.length === 1, 10_000))) return fail("no session.closed after session.remove");
    check(closedMsgs[0].shellsStopped === 1, `session.remove stopped the live wrapper (shellsStopped: ${closedMsgs[0].shellsStopped})`);
    check(closedMsgs[0].shellsLeft === 0, `nothing was left behind (shellsLeft: ${closedMsgs[0].shellsLeft})`);
    check(!sleepStillUnder(wrap2), "the stub's second `sleep 600` is actually gone from the process table after session.remove");

    ws.close();
    done();
  } catch (e) {
    fail(`unhandled: ${e?.stack || e}`);
  }
});

watchdog(() => fail("timeout (shells flow didn't complete)"));
