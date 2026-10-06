// PTYs are released, by the daemon and by `npm run doctor` (2026-09-25).
//
// The machine ran out of pseudo-terminals: the live host held 248 `/dev/ptmx`
// masters for 67 live sessions (node-pty 1.1.0 leaked one master and one slave
// fd into the parent per spawn), and a `main.js --doctor` was still alive 25 h
// after it printed its report — its module body had started the usage poll,
// which spawned a `claude` probe in a PTY every 8 minutes into a process that
// never exited. Asserted here, end to end:
//
//   1. `--doctor` EXITS, promptly, on its own.
//   2. Sessions that end — by exiting and by `session.kill` — hand their PTY
//      fds back: `/api/health`'s `ptys` gauge returns to its baseline.
//
// Needs free PTYs for part 2; with the table full it says so and fails.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8901;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-ptyleak-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. The doctor exits ───────────────────────────────────────────────
const DOCTOR_BOUND_MS = 60_000;
await new Promise((resolve) => {
  const t0 = Date.now();
  const d = spawn("node", ["packages/host/dist/main.js", "--doctor"], { env: { ...env, [E.PORT]: String(PORT + 1) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  d.stdout.on("data", (b) => (out += b));
  d.stderr.on("data", (b) => (out += b));
  const guard = setTimeout(() => { d.kill("SIGKILL"); }, DOCTOR_BOUND_MS);
  d.on("exit", (code, sig) => {
    clearTimeout(guard);
    const ms = Date.now() - t0;
    check(sig == null, `--doctor exited by itself (signal ${sig ?? "none"}, ${ms} ms)`);
    check(code === 0 || code === 1, `--doctor exit code 0/1 — 1 means a check failed (got ${code})`);
    check(/node-pty/.test(out), "--doctor printed its report");
    resolve();
  });
});

// ── 2. Ended sessions release their PTYs ──────────────────────────────
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };
setTimeout(() => { check(false, "timeout"); done(); }, 45_000);

const health = () => fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json());

bootWait(PORT, 800, async () => {
  const base = (await health()).ptys;
  if (base == null) { console.log("SKIP: no pty gauge on this platform"); done(); return; }
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ptyleak" }),
  }).then((r) => r.json());
  check(!!repo.path, "repo created");

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  const exits = new Set();
  const created = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created") created.push(m.session.id);
    else if (m.t === "session.exit") exits.add(m.id);
    else if (m.t === "error") console.log("host error:", m.message ?? JSON.stringify(m));
  });

  const N = 4;
  for (let i = 0; i < N; i++) {
    const want = created.length + 1;
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 }));
    for (let k = 0; k < 100 && created.length < want; k++) await sleep(50);
  }
  check(created.length === N, `${N} sessions created (got ${created.length}) — fewer usually means the pty table is full`);
  if (created.length === 0) { console.log("(the system pty table is full — `lsof /dev/ptmx` names the holders)"); done(); return; }
  await sleep(500);
  const during = (await health()).ptys;
  check(during.masters === base.masters + created.length, `one master per live session while they run (${base.masters} + ${created.length} → ${during.masters})`);

  // Half end themselves, half are killed.
  created.forEach((id, i) => {
    if (i % 2 === 0) ws.send(JSON.stringify({ t: "session.input", id, data: "exit\r" }));
    else ws.send(JSON.stringify({ t: "session.kill", id }));
  });
  for (let k = 0; k < 200 && exits.size < created.length; k++) await sleep(50);
  check(exits.size === created.length, `every session reported its exit (${exits.size}/${created.length})`);

  let after = (await health()).ptys;
  for (let k = 0; k < 30 && after.masters > base.masters; k++) { await sleep(100); after = (await health()).ptys; }
  check(after.masters === base.masters, `masters back to baseline after exit/kill (${base.masters} → ${after.masters})`);
  check(after.slaves === base.slaves, `no slave fds left behind (${base.slaves} → ${after.slaves})`);
  ws.close();
  done();
});
