// A `live/` record whose tmux session is provably gone is reclaimed at boot —
// and nothing else is.
//
// A record is how a restart finds its pane, and it used to be deleted only while
// the daemon watched the session end. A pane that ended while the daemon was
// down kept its record for good: 162 of 277 on the owner's desktop, and every
// one of them read as "alive" by the orphan sweep, protecting that session's
// history and summary for ever. `rediscover()` now deletes such a record — but
// only past a `tmux ls` that succeeded, only for a record stamped with this
// server, and only once it is older than the age gate.
//
//   boot → three sessions (A, B, D) → stop the host → kill A's and D's tmux
//   sessions → backdate A's record past the gate, freshen D's, hand-write an
//   UNSTAMPED old record C with no session → reboot with a 30 s gate →
//     A gone (old, stamped, no session)            — the one case that goes
//     B kept and still rediscovered (session alive)
//     D kept (no session, but younger than the gate — a spawn in flight)
//     C kept (unstamped, and this host is not on the default socket)
//   and the host said so in one line.
// Isolated: private socket dir (lib-tmuxiso), its own -L name, throwaway root.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BRAND } from "../packages/shared/dist/brand.js";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";
import { freePort, waitForHost } from "./lib-e2e.mjs";

if (spawnSync("tmux", ["-V"]).status !== 0) { console.log("SKIP: tmux not installed"); process.exit(0); }

const PORT = await freePort();
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-livereclaim-`));
const SERVER = `${SLUG}-e2e-lr-${process.pid}`;
const LIVE = join(ROOT, STATE, "live");
const env = {
  ...process.env, [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.PREFLIGHT]: "0", [E.TMUX_SERVER]: SERVER,
  // The age gate, down from an hour: long enough that D's freshly touched record
  // is inside it, far shorter than A's backdated one.
  [E.STALE_LIVE_MIN_AGE_MS]: "30000",
};
const tmuxName = (id) => `${BRAND.tmuxServer}_${id}`;
const killServer = () => { try { execFileSync("tmux", ["-L", SERVER, "kill-server"], { stdio: "ignore" }); } catch { /* gone */ } };

let host = null, log = "";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const cleanup = () => { try { host?.kill("SIGKILL"); } catch { /* gone */ } killServer(); try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* the runner's temp dir takes it */ } };
const fail = (m) => { console.error("FAIL:", m); cleanup(); process.exit(1); };

const bootHost = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stdout.on("data", (d) => { log += d; process.stdout.write("[host] " + d); });
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return h;
};
const stopHost = async () => {
  const exited = new Promise((r) => host.once("exit", r));
  host.kill();
  await exited;
};
const create = (cwd, title) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") ws.send(JSON.stringify({ t: "session.create", cwd, title, cols: 80, rows: 24 }));
    else if (m.t === "session.created") { ws.close(); resolve(m.session.id); }
  });
  ws.on("error", (e) => fail("ws error " + e.message));
});
const listed = () => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.list") { ws.close(); resolve(m.sessions.map((s) => s.id)); }
  });
  ws.on("error", (e) => fail("ws error " + e.message));
});
const hasSession = (id) => spawnSync("tmux", ["-L", SERVER, "has-session", "-t", tmuxName(id)]).status === 0;
const rec = (id) => join(LIVE, `${id}.json`);
const age = (p, ms) => { const t = new Date(Date.now() - ms); utimesSync(p, t, t); };

(async () => {
  host = bootHost();
  await waitForHost(PORT);
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "lr" }),
  }).then((r) => r.json());
  if (!repo.path) fail("repo create failed");

  const A = await create(repo.path, "gone");
  const B = await create(repo.path, "alive");
  const D = await create(repo.path, "young");
  for (const id of [A, B, D]) if (!existsSync(rec(id))) fail(`no live record for ${id}`);
  const stamp = JSON.parse(readFileSync(rec(A), "utf8")).tmuxSocket;
  check(typeof stamp === "string" && stamp.endsWith(`/${SERVER}`), `a new record carries its tmux server (${stamp})`);

  // Stop the host the ordinary way: a detach, not a close — every pane survives
  // and every record stays, which is what makes the next boot's question real.
  await stopHost();
  check([A, B, D].every(hasSession), "the panes outlived the host");
  check([A, B, D].every((id) => existsSync(rec(id))), "…and so did their records");

  // A pane dying while nobody watches: kill-session at the desk.
  execFileSync("tmux", ["-L", SERVER, "kill-session", "-t", tmuxName(A)]);
  execFileSync("tmux", ["-L", SERVER, "kill-session", "-t", tmuxName(D)]);
  age(rec(A), 10 * 60_000);
  age(rec(D), 0);
  // A record from before records were stamped, whose pane is gone too.
  const C = "c0ffee00";
  writeFileSync(rec(C), JSON.stringify({ id: C, cwd: repo.path, title: "legacy", launch: {}, createdAt: Date.now() - 86_400_000 }));
  age(rec(C), 10 * 60_000);

  log = "";
  host = bootHost();
  await waitForHost(PORT);

  check(!existsSync(rec(A)), "an old, stamped record with no tmux session is reclaimed");
  check(existsSync(rec(B)), "a record whose session is alive is kept");
  check(existsSync(rec(D)), "a record younger than the gate is kept, its session gone or not");
  check(existsSync(rec(C)), "an unstamped record is kept by a host that is not on the default socket");
  check(/swept 1 stale live record\(s\)/.test(log), "the host said what it reclaimed, in one line");
  const ids = await listed();
  check(ids.includes(B), "the live session was rediscovered");
  check(!ids.includes(A) && !ids.includes(D), "no gone session came back");

  await stopHost();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => fail(String(e?.stack ?? e)));

setTimeout(() => fail("timeout"), 60_000);
