// Proves tmux-hosted sessions SURVIVE a host restart:
//   boot host → create session → round-trip → HARD-KILL host (SIGKILL, no cleanup)
//   → boot a fresh host on the same root → the session is rediscovered, same id,
//   still alive, round-trips again.
//
// …and that the INTENT STORE knows it. A session id used to be per-boot for a plain
// PTY and is not per-boot under tmux, so the store used to drop every id on load on the
// general rule — and a fan-out could not be followed up after a restart, because
// `fanout.followUp()` re-drives EXISTING sessions and never spawns: the agents
// were sitting right there in tmux and the run had forgotten their names. The
// id is now reconciled against what `rediscover()` actually found, which is a
// fact rather than an assumption, and a session that genuinely did not come back
// still loses its id.
//
// …and that a row DELIVERED before the restart, whose turn is still running in
// a session that came back, is RE-ADOPTED rather than settled `done` off the
// conversation log. The log proves the words arrived, and a turn still running
// writes the same line: on 2026-09-24 a restart settled nine of twelve backlog
// items `done` while their logs kept growing. Here a busy loop plays the turn,
// and the row must stay `running` until it has ended and the session has gone
// quiet — and nothing may be typed again.
// Isolated: private tmux server (-L <slug>-e2e-<pid>), throwaway root, bash as claude.
// Requires tmux; SKIPs cleanly if absent.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

if (spawnSync("tmux", ["-V"]).status !== 0) { console.log("SKIP: tmux not installed"); process.exit(0); }

const PORT = 8796;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-tmux-`));
const SERVER = `${SLUG}-e2e-${process.pid}`;
// The CLI's conversation log lives under a throwaway home: the test writes the
// record `logVerdict` reads, without touching the developer's.
const CLAUDE_HOME = mkdtempSync(join(tmpdir(), `${SLUG}-tmux-home-`));
// A MINIMAL environment on purpose — this is what the daemon really runs in.
// launchd hands it a handful of variables and no locale whatsoever, and a tmux
// client that cannot conclude its terminal is UTF-8 does not forward UTF-8: it
// redraws the box characters as ACS line-drawing and rewrites every other
// non-ASCII glyph as "_". That is how the "\u276f" selection cursor vanished in
// the field, taking prompt detection with it. Inheriting this shell's env
// instead would quietly re-supply the locale and the check below would pass
// whether or not the fix is present.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SHELL: process.env.SHELL,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR, // the private socket dir (`lib-tmuxiso.mjs`) — minimal is not unisolated
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.PREFLIGHT]: "0", [E.TMUX_SERVER]: SERVER,
  [E.CLAUDE_HOME]: CLAUDE_HOME,
  // The silence sweep's window. Well above the busy loop's 0.5 s beat, so a
  // turn still printing is never read as ended.
  [E.IDLE_MS]: "3000",
};

/** The claude CLI's own conversation log for a cwd — `e2e-settle.mjs`'s shape. */
function writeConversation(home, cwd, cid, prompts, at = Date.now()) {
  const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines = prompts.map((p, i) => JSON.stringify({
    type: "user",
    uuid: `u${i}`,
    timestamp: new Date(at).toISOString(),
    message: { role: "user", content: [{ type: "text", text: p }] },
  }));
  writeFileSync(join(dir, cid + ".jsonl"), lines.join("\n") + "\n");
}

const killServer = () => { try { execFileSync("tmux", ["-L", SERVER, "kill-server"]); } catch { /* gone */ } };
let host = null;
const cleanup = () => { try { host?.kill("SIGKILL"); } catch {} killServer(); };
const fail = (m) => { console.error("FAIL:", m); cleanup(); process.exit(1); };

const bootHost = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stdout.on("data", (d) => process.stdout.write("[host] " + d));
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return h;
};
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitPortFree = async () => { for (let i = 0; i < 40; i++) { if (spawnSync("lsof", ["-tiTCP:" + PORT, "-sTCP:LISTEN"]).status !== 0) return; await sleep(150); } };

/** Open a WS, run `fn(ws, done)`, resolve with whatever done() is called with. */
const withWs = (fn) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const done = (v) => { try { ws.close(); } catch {} resolve(v); };
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => fn(ws, done, JSON.parse(raw.toString())));
  ws.on("error", (e) => fail("ws error " + e.message));
});

(async () => {
  host = bootHost();
  await waitForHost(PORT);

  // Create a repo + session, capture its id, and round-trip an echo.
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "t" }),
  }).then((r) => r.json());
  if (!repo.path) fail("repo create failed");
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());
  const cwd = repos.targets[0].worktreePath;

  const sid = await withWs((ws, done, m) => {
    if (m.t === "welcome") ws.send(JSON.stringify({ t: "session.create", cwd, cols: 80, rows: 24 }));
    else if (m.t === "session.created") done(m.session.id);
  });
  console.log("created session", sid);

  const rt1 = await withWs((ws, done, m) => {
    if (m.t === "welcome") { ws.send(JSON.stringify({ t: "session.attach", id: sid })); ws._cap = ""; setTimeout(() => ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo MARK_$((6*7))\r", ackId: "a1" })), 500); }
    else if (m.t === "pty" && m.id === sid) { ws._cap += b64(m.dataB64); if (ws._cap.includes("MARK_42")) done(true); }
  });
  if (!rt1) fail("no round-trip before restart");
  console.log("round-trip before restart OK");

  // The client must speak UTF-8 even with no locale in the environment. Without
  // it tmux forwards "_" in place of every non-ACS glyph, so what reaches the
  // phone (and the prompt detector) has had its cursor and icons flattened —
  // invisible unless you look at the bytes, which is why it is asserted here.
  const utf8 = execFileSync("tmux", ["-L", SERVER, "list-clients", "-F", "#{client_utf8}"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  if (!utf8.length) fail("no tmux client attached — cannot check UTF-8");
  if (utf8.some((f) => f !== "1")) fail(`tmux client is not UTF-8 (client_utf8=${utf8.join(",")}) — glyphs will arrive as "_"`);
  console.log("PASS: tmux client forwards UTF-8 with no locale in the environment");

  // A second session in the same cwd, busy with a "turn" that outlives the
  // restart: forty half-second beats, then a marker, then silence.
  const busy = await withWs((ws, done, m) => {
    if (m.t === "welcome") ws.send(JSON.stringify({ t: "session.create", cwd, cols: 80, rows: 24 }));
    else if (m.t === "session.created") done(m.session);
  });
  if (!busy?.claudeSessionId) fail(`the busy session has no conversation id to write a log for (${JSON.stringify(busy)})`);
  const bid = busy.id;
  await withWs((ws, done, m) => {
    if (m.t === "welcome") {
      ws.send(JSON.stringify({ t: "session.attach", id: bid }));
      setTimeout(() => ws.send(JSON.stringify({ t: "session.input", id: bid, data: "for i in $(seq 1 40); do echo tick $i; sleep 0.5; done; echo TURN_$((6*7))_OVER\r", ackId: "b1" })), 500);
    } else if (m.t === "pty" && m.id === bid && b64(m.dataB64).includes("tick 2")) done(true);
  });
  const loopStartedAt = Date.now();
  writeConversation(CLAUDE_HOME, cwd, busy.claudeSessionId, ["sweep this repo"]);
  console.log("busy session", bid, "mid-turn");

  // ── HARD kill the host (simulate a crash/restart with zero cleanup) ──
  console.log("SIGKILL host (simulating restart)…");
  host.kill("SIGKILL");
  await sleep(500);
  await waitPortFree();

  // Two settled rows written while nothing is running: one pointing at the
  // session that is about to be rediscovered, one pointing at a session that
  // never existed. Written here rather than driven through the wire because the
  // question is only about what LOAD + reconcile do with an id, and a hand-
  // written row is the same thing a crash leaves behind.
  mkdirSync(join(ROOT, STATE), { recursive: true });
  const done = (id, sessionId) => ({
    id, cwd, sessionId,
    payload: { kind: "prompt", steps: ["sweep this repo"] },
    target: { kind: "repo" }, trigger: { kind: "now" },
    title: "t · sweep", origin: "fanout:target", groupId: "run-1",
    state: "done", createdAt: Date.now() - 60_000, settledAt: Date.now() - 30_000,
    result: { at: Date.now() - 30_000, ok: true, detail: "delivered" },
  });
  // …and a third that was mid-turn: delivered (the log above has its words)
  // into the busy session, which is still running under tmux.
  const midTurn = {
    id: "busy-1", cwd, sessionId: bid,
    payload: { kind: "prompt", steps: ["sweep this repo"] },
    target: { kind: "repo", fresh: true }, trigger: { kind: "now" },
    title: "backlog · t · sweep", origin: "backlog", auto: true,
    state: "running", createdAt: Date.now() - 60_000, startedAt: Date.now() - 5000,
  };
  writeFileSync(join(ROOT, STATE, "intents.json"),
    JSON.stringify([done("kept-1", sid), done("gone-1", "sess_never_existed"), midTurn], null, 2));

  // Fresh host, same root — must rediscover the tmux session.
  host = bootHost();
  await waitForHost(PORT);

  // Watch the busy session from the moment the host is back: every intent
  // frame (the row's transitions), every session it creates (a re-run would
  // open one), and the pane's own output (when the turn really ended).
  const watch = { row: null, doneAt: null, overAt: null, created: 0, pane: "" };
  const watcher = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  watcher.on("open", () => watcher.send(JSON.stringify({ t: "hello", protocol: 1 })));
  watcher.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") { watcher.send(JSON.stringify({ t: "session.attach", id: bid })); watcher.send(JSON.stringify({ t: "intent.list" })); }
    if (m.t === "session.created") watch.created++;
    if (m.t === "pty" && m.id === bid) {
      watch.pane += b64(m.dataB64);
      if (watch.overAt == null && watch.pane.includes("TURN_42_OVER")) watch.overAt = Date.now();
    }
    const rows = m.t === "intent.list" ? m.intents : m.t === "intent.changed" && m.intent ? [m.intent] : [];
    const row = rows.find((r) => r.id === "busy-1");
    if (row) {
      watch.row = row;
      if (row.state === "done" && watch.doneAt == null) watch.doneAt = Date.now();
      if (row.state === "done" && watch.overAt == null) fail(`the mid-turn row was settled done before its turn ended (${row.result?.detail})`);
    }
  });
  const until = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return pred(); };
  if (!(await until(() => watch.row, 3000))) fail("the mid-turn row was not listed after the restart");
  if (watch.row.state !== "running") fail(`the mid-turn row was not re-adopted: ${watch.row.state} (${watch.row.result?.detail ?? watch.row.blockDetail})`);
  if (!/restarted after this was delivered/.test(watch.row.blockDetail ?? "")) fail(`the re-adopted row does not say why it is running (${watch.row.blockDetail})`);
  console.log("PASS: a row delivered before the restart is re-adopted running while its turn is still going");

  const listed = await withWs((ws, done, m) => {
    if (m.t === "session.list") { const s = m.sessions.find((x) => x.id === sid); if (s) done(s); }
  });
  if (!listed) fail("session NOT rediscovered after restart — it died");
  if (!listed.running) fail("rediscovered session not marked running");
  console.log("session rediscovered after restart:", listed.id, "cwd:", listed.title);

  // Prove it's genuinely ALIVE: attach + round-trip a new echo.
  const rt2 = await withWs((ws, done, m) => {
    if (m.t === "welcome") { ws.send(JSON.stringify({ t: "session.attach", id: sid })); ws._cap = ""; setTimeout(() => ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo MARK2_$((7*8))\r", ackId: "a2" })), 500); }
    else if (m.t === "pty" && m.id === sid) { ws._cap += b64(m.dataB64); if (ws._cap.includes("MARK2_56")) done(true); }
  });
  if (!rt2) fail("reattached session did not round-trip — not truly alive");

  console.log("PASS: session survived a host restart in tmux and is still live");

  // The store's half of the same fact.
  const rows = await withWs((ws, done2, m) => {
    if (m.t === "welcome") ws.send(JSON.stringify({ t: "intent.list" }));
    else if (m.t === "intent.list") done2(m.intents);
  });
  const kept = rows.find((r) => r.id === "kept-1");
  const gone = rows.find((r) => r.id === "gone-1");
  if (!kept || !gone) fail("the intent rows did not survive the restart at all");
  if (kept.sessionId !== sid) {
    fail(`a row whose session was rediscovered lost its handle (${kept.sessionId}) — a finished fan-out can no longer be followed up`);
  }
  if (gone.sessionId) fail(`a row whose session did NOT come back kept a dead id (${gone.sessionId})`);
  console.log("PASS: intent rows keep the session ids that survived, and drop the ones that did not");

  // The turn ends; the session goes quiet; the silence sweep settles it.
  const settled = await until(() => watch.doneAt != null, 40_000);
  if (!settled) {
    watcher.send(JSON.stringify({ t: "intent.list" }));
    await sleep(500);
    fail(`the re-adopted row never settled after its turn ended (${watch.row?.state}: ${watch.row?.blockDetail ?? watch.row?.result?.detail}; turn over: ${watch.overAt != null}; waited ${Date.now() - loopStartedAt} ms from the loop)`);
  }
  if (!/gone quiet since/.test(watch.row.result?.detail ?? "")) fail(`settled with the wrong sentence (${watch.row.result?.detail})`);
  if (watch.doneAt - watch.overAt < 2000) fail(`settled ${watch.doneAt - watch.overAt} ms after the turn ended — sooner than the 3 s silence window`);
  if (watch.created !== 0) fail(`a session was opened after the restart (${watch.created}) — the delivered row was run again`);
  if (watch.pane.includes("sweep this repo")) fail("the row's words were typed into the busy session again");
  console.log(`PASS: it settled done ${watch.doneAt - watch.overAt} ms after its turn ended, and nothing was typed again`);
  watcher.close();

  cleanup();
  process.exit(0);
})().catch((e) => fail(String(e)));

setTimeout(() => fail("timeout"), 75_000);
