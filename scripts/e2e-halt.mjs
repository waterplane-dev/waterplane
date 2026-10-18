// The emergency halt (`host/src/halt.ts`, `routes/system.ts` `host.halt`):
//  - every agent session ends, its whole process tree included, and a CLI that
//    ignores SIGTERM is forced (the stub here traps TERM, as a busy tool might)
//  - while halted a session.create is REFUSED in the halt's own sentence
//  - the latch survives a host restart (it is persisted, not a variable)
//  - lifting lets a create through again, and brings nothing back by itself
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait, waitForHost } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8958;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-halt-`));
// A stub whose path is unique to this run (so `pgrep -f` counts only ours) and
// which ignores SIGTERM — inherited by the shell it runs, so only SIGKILL ends it.
// A session's stub (launched with --session-id) drops a marker in READY once its
// trap is set. `ours()` alone also counts the host's own probes of the stub
// (`--version`, `auth status`, a headless run), and under the full parallel
// suite those met the count while the panes' shells had not reached the trap
// yet — the SIGTERM then ended them and nothing was forced.
const STUB = join(ROOT, "claude-halt-stub.sh");
const READY = mkdtempSync(join(tmpdir(), `${SLUG}-halt-ready-`));
writeFileSync(STUB, `#!/bin/sh\n[ "$1" = "--version" ] && { echo "2.1.0 (Claude Code)"; exit 0; }\ntrap '' TERM\ncase "$*" in *--session-id*) : > "${READY}/$$";; esac\n"${process.cwd()}/scripts/claude-stub.sh" "$@"\n`);
chmodSync(STUB, 0o755);
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "600", [E.IDLE_PING_MS]: "400" };
const boot = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return h;
};
let host = boot();
let failed = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ours = () => { try { return execFileSync("pgrep", ["-f", STUB], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length; } catch { return 0; } };
// This only flakes under the full parallel suite, where the run's log is all
// there is — so every FAIL prints what of ours is still running, and when.
const t0 = Date.now();
const psOurs = () => { try { return execFileSync("sh", ["-c", `ps -Ao pid,ppid,stat,etime,command | grep -F "${STUB}" | grep -v grep || true`], { encoding: "utf8" }); } catch { return ""; } };
const check = (c, l) => {
  console.log(`${c ? "PASS" : "FAIL"}: ${l}`);
  if (!c) { failed = true; console.log(`  at +${Date.now() - t0} ms; processes on the stub path:\n${psOurs() || "  (none)"}`); }
};

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  // Generous: under the full parallel suite (Gradle beside nine other scripts) a
  // tmux-backed create or the halt's grace-then-SIGKILL can take several seconds;
  // a passing run returns as soon as the frame lands.
  const until = async (pred, ms = 20000) => {
    for (let t = 0; t < ms; t += 50) { const f = frames.find(pred); if (f) return f; await sleep(50); }
    return null;
  };
  return { ws, frames, until, send: (m) => ws.send(JSON.stringify(m)) };
}

bootWait(PORT, 800, async () => {
  let c;
  try {
    c = await connect();
    check(!!(await c.until((f) => f.t === "halt.state" && f.halt.on === false)), "hello says the latch is off");
    const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "halt" }) }).then((r) => r.json());
    for (const ackId of ["c1", "c2"]) c.send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24, ackId });
    check(!!(await c.until((f) => f.t === "op.ack" && f.ackId === "c2" && f.ok)), "two sessions created");
    const ready = () => readdirSync(READY).length;
    for (let i = 0; i < 150 && ready() < 2; i++) await sleep(100);
    check(ready() >= 2, `both sessions' stubs are running with TERM trapped (${ready()})`);

    c.send({ t: "host.halt", on: true });
    const done = await c.until((f) => f.t === "halt.state" && f.halt.on && f.halt.receipt);
    check(!!done, "the halt finishes with a receipt");
    check(done?.halt.receipt.sessions === 2, `receipt counts both sessions (${done?.halt.receipt.sessions})`);
    check((done?.halt.receipt.forced ?? 0) >= 1, `the TERM-ignoring stub was forced (${done?.halt.receipt.forced})`);
    // `ours()` also counts the tmux server and the pty's tmux clients (their
    // command lines carry the stub path), and those exit only once kill-session's
    // teardown lands — a fixed 300 ms lost that race under a full parallel suite,
    // and 3 s was still tight beside a Gradle build.
    // A process that truly survived the SIGKILL is still there at the deadline.
    for (let t = 0; t < 10000 && ours(); t += 100) await sleep(100);
    check(ours() === 0, `no stub process survives the halt (${ours()})`);

    c.send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24, ackId: "c3" });
    const refused = await c.until((f) => f.t === "op.ack" && f.ackId === "c3");
    check(refused && !refused.ok && /halted/i.test(refused.reason ?? ""), `create refused while halted: ${refused?.reason}`);
    check(ours() === 0, "nothing was spawned by the refused create");
    c.ws.close();

    // A restart comes back halted.
    host.kill("SIGTERM");
    await new Promise((r) => host.on("exit", r));
    host = boot();
    await waitForHost(PORT);
    c = await connect();
    check(!!(await c.until((f) => f.t === "halt.state" && f.halt.on === true)), "the latch survives a host restart");

    c.send({ t: "host.halt", on: false });
    check(!!(await c.until((f) => f.t === "halt.state" && f.halt.on === false)), "lift is broadcast");
    check(ours() === 0, "lifting brings nothing back by itself");
    c.send({ t: "session.create", cwd: repo.path, cols: 80, rows: 24, ackId: "c4" });
    check(!!(await c.until((f) => f.t === "op.ack" && f.ackId === "c4" && f.ok)), "after the lift a create goes through");
    c.ws.close();
  } catch (e) {
    console.log("FAIL: threw", e); failed = true;
  } finally {
    try { c?.ws.close(); } catch { /* closed */ }
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  }
});
