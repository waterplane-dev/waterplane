// The sent-command audit log — "what did this app type into my sessions?".
//
// Automation drives a session through the same PTY a human does, so a backlog
// item, a fan-out prompt, an oracle answer and a usage-limit `continue` are
// indistinguishable from typed text in the scrollback. This log is the record
// that says who sent what; these assertions are what make it trustworthy.
//
// Asserts:
//   1. a `session.create` prompt is logged ONCE (source "create") even though
//      delivery writes text and Return separately and may re-press Return —
//      one entry per COMMAND, not per PTY write
//   2. a compose `session.input` with `submit` is logged as source "compose",
//      actor "user", carrying the delivery verdict
//   3. a fan-out prompt is logged as source "fanout", actor "auto"
//   4. `sent.get` with a sessionId filters to that session
//   5. every entry survives a host RESTART (the question is asked afterwards,
//      and `npm run restart` is routine)
//   6. `sent.clear` empties it
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8846;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-sent-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const LOG = join(ROOT, "stub-input.log");
const base = `http://127.0.0.1:${PORT}`;

const CREATE_TEXT = "Audit me: the first prompt of a new session";
const COMPOSE_TEXT = "Audit me: a prompt I typed myself";
const FANOUT_TEXT = "Audit me: a fan-out sweep";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(LOG, "");
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
  STUB_MODE: "repaint", STUB_LOG: LOG,
};

let host = null;
function boot() {
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
}
const stop = async () => { host?.kill(); await sleep(700); };

boot();
await sleep(900);

const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "audited" }),
}).then((r) => r.json());

/** One connected client: sends messages, collects the log frames. */
async function connect() {
  const ws = new WebSocket(`ws://${"127.0.0.1"}:${PORT}/ws`);
  const state = { sessions: new Map(), sentLog: [], live: [], acks: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created") state.sessions.set(m.session.id, m.session);
    if (m.t === "session.list") for (const s of m.sessions) state.sessions.set(s.id, s);
    if (m.t === "sent.log") state.sentLog = m.entries;
    if (m.t === "sent.new") state.live.push(m.entry);
    if (m.t === "input.ack" || m.t === "op.ack") state.acks.push(m);
  });
  await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }); });
  await sleep(300);
  return { ws, state, send: (m) => ws.send(JSON.stringify(m)) };
}

const waitFor = async (pred, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(200); }
  return false;
};

let c = await connect();

// ── 1. A create's prompt: exactly one entry, source "create" ──────────────
c.send({ t: "session.create", cwd: repo.path, title: "audited · main", prompt: CREATE_TEXT, cols: 80, rows: 24, ackId: "sent-create-1" });
await waitFor(() => c.state.live.some((e) => e.text === CREATE_TEXT));
await sleep(1200);

const createEntries = c.state.live.filter((e) => e.text === CREATE_TEXT);
check(createEntries.length === 1, `create prompt logged exactly once (got ${createEntries.length}) — one entry per command, not per PTY write`);
const created = createEntries[0];
check(created?.source === "create", `…with source "create" (got ${created?.source})`);
check(created?.actor === "user", `…and actor "user" (got ${created?.actor})`);
check(created?.result === "ok", `…and the delivery verdict (got ${created?.result})`);
check(!!created?.sessionTitle && !!created?.repoDir, "…stamped with the session title and repo it went to");

const sid = created?.sessionId;
check(!!sid && c.state.sessions.has(sid), "…naming a session the client knows about (the row can link to it)");

// ── 2. A compose send (session.input + submit) is logged as the user's ────
c.send({ t: "session.input", id: sid, data: COMPOSE_TEXT, submit: true, ackId: "sent-compose-1" });
await waitFor(() => c.state.live.some((e) => e.text === COMPOSE_TEXT), 30000);
await sleep(500);
const composed = c.state.live.filter((e) => e.text === COMPOSE_TEXT);
check(composed.length === 1, `compose send logged exactly once (got ${composed.length})`);
check(composed[0]?.source === "compose" && composed[0]?.actor === "user",
  `…as source "compose" / actor "user" (got ${composed[0]?.source} / ${composed[0]?.actor})`);

// ── 3. A fan-out prompt is logged as automation ───────────────────────────
c.send({ t: "fanout.run", dirs: [repo.path], text: FANOUT_TEXT, ackId: "sent-fanout-1" });
await waitFor(() => c.state.live.some((e) => e.text === FANOUT_TEXT), 40000);
await sleep(1000);
const fan = c.state.live.filter((e) => e.text === FANOUT_TEXT);
check(fan.length >= 1, `fan-out prompt logged (got ${fan.length})`);
check(fan[0]?.source === "fanout" && fan[0]?.actor === "auto",
  `…as source "fanout" / actor "auto" — the whole point of the log (got ${fan[0]?.source} / ${fan[0]?.actor})`);
check(fan[0]?.sessionId !== sid, "…against the session the fan-out spawned, not the one already open");

// ── 4. Filtering to one session ───────────────────────────────────────────
c.send({ t: "sent.get" });
await waitFor(() => c.state.sentLog.length >= 3);
const all = c.state.sentLog.length;
c.state.sentLog = [];
c.send({ t: "sent.get", sessionId: sid });
await waitFor(() => c.state.sentLog.length > 0);
await sleep(300);
check(c.state.sentLog.every((e) => e.sessionId === sid), "sent.get with a sessionId returns only that session's commands");
check(c.state.sentLog.length < all, `…and fewer than the unfiltered list (${c.state.sentLog.length} < ${all})`);

// ── 5. Survives a host restart ────────────────────────────────────────────
c.ws.close();
await stop();
boot();
await sleep(1200);
c = await connect();
c.send({ t: "sent.get" });
await waitFor(() => c.state.sentLog.length > 0, 10000);
await sleep(300);
const texts = c.state.sentLog.map((e) => e.text);
check(texts.includes(CREATE_TEXT) && texts.includes(COMPOSE_TEXT) && texts.includes(FANOUT_TEXT),
  `the log survives a host restart (${c.state.sentLog.length} entries back)`);
check(c.state.sentLog[0].ts >= c.state.sentLog[c.state.sentLog.length - 1].ts, "…newest first");

// ── 6. Clearing ───────────────────────────────────────────────────────────
c.state.sentLog = [null];
c.send({ t: "sent.clear" });
await waitFor(() => Array.isArray(c.state.sentLog) && c.state.sentLog.length === 0, 8000);
check(c.state.sentLog.length === 0, "sent.clear empties the log");

c.ws.close();
await stop();
console.log(failed ? "\nFAILED" : "\nAll sent-command log assertions passed.");
process.exit(failed ? 1 : 0);
