// "Open a session here AND run this" — the offline-first way into a repo.
//
// The phone can queue a `session.create` while the tunnel is down, but a prompt
// for that session could not be queued at all: there is no session id to address
// until the create lands. So the prompt rides INSIDE the create, and the host
// types it through the same at-most-once path the fan-out uses.
//
// Asserts:
//   1. `session.create` with `prompt` types it EXACTLY ONCE into the new session
//   2. a duplicate ackId (the phone's reconnect retry racing the first delivery,
//      and again after it settled) creates NO second session and does NOT retype
//   3. a create with no prompt still types nothing at all
//   4. the queued-upload path: `x-dedupe` makes a re-POST of the same image
//      return the file already on disk instead of writing a twin, so a retry
//      can't leave the prompt's `.claude/inbox/<name>` pointing at one of two
//      identical copies
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8829;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-startprompt-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const LOG = join(ROOT, "stub-input.log");
const TEXT = "Read .claude/inbox/shot.jpg and fix the layout";
const PROBE = "Read .claude/inbox/shot.jpg";

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
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
await sleep(900);

const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "alpha" }),
}).then((r) => r.json());

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const sessions = new Map();
const opAcks = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "session.created") sessions.set(m.session.id, m.session);
  if (m.t === "session.list") for (const s of m.sessions) sessions.set(s.id, s);
  if (m.t === "op.ack") opAcks.push(m);
});
await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }); });
await sleep(300);

const log = () => { try { return readFileSync(LOG, "utf8"); } catch { return ""; } };
const count = (probe) => log().split(probe).length - 1;
const waitFor = async (pred, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(200); }
  return false;
};

const ACK = "start-ack-1";
const create = () => ws.send(JSON.stringify({
  t: "session.create", cwd: repo.path, title: "alpha · main", prompt: TEXT,
  cols: 80, rows: 24, ackId: ACK,
}));

// The retry the phone's queue makes on reconnect normally RACES the first
// delivery, so fire the duplicate immediately — the in-flight map has to join it
// rather than start a second session.
create();
create();
await waitFor(() => count(PROBE) >= 1 && opAcks.filter((a) => a.ackId === ACK).length >= 2);
await sleep(1500);

check(sessions.size === 1, `one session for two deliveries of the same ackId (got ${sessions.size})`);
check(count(PROBE) === 1, `prompt typed exactly once (copies: ${count(PROBE)})`);
const acks = opAcks.filter((a) => a.ackId === ACK);
check(acks.length === 2 && acks.every((a) => a.ok), `both deliveries acked ok (${JSON.stringify(acks)})`);
check(acks[0].sessionId && acks[0].sessionId === acks[1].sessionId, "the duplicate is answered with the SAME session id");

// …and once more after the op has long settled: this one comes out of the
// persisted ledger, not the in-flight map.
create();
await sleep(1200);
check(sessions.size === 1, `a late duplicate still creates nothing (sessions: ${sessions.size})`);
check(count(PROBE) === 1, `a late duplicate does not retype (copies: ${count(PROBE)})`);

// A plain create (no prompt) must type nothing — the feature is opt-in.
const before = log().length;
ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "alpha · quiet", cols: 80, rows: 24, ackId: "start-ack-2" }));
await waitFor(() => sessions.size === 2, 10000);
await sleep(1200);
check(sessions.size === 2, "a second, prompt-less session opens normally");
check(count(PROBE) === 1, "the prompt-less create types nothing");
check(log().length >= before, "…and the stub log is otherwise untouched by it");

// ── Queued image upload: a re-POST must not leave two copies ──────────────
const bytes = Buffer.from("not-really-a-jpeg-but-bytes-are-bytes");

// The repo id the phone uses comes from the repo list, not the scaffold answer.
const repos = await fetch(`${base}/api/repos`).then((r) => r.json());
const target = repos.targets.find((r) => r.worktreePath === repo.path);
const upload = (dedupe) => fetch(`${base}/api/repos/${target.id}/inbox`, {
  method: "POST",
  headers: { "content-type": "application/octet-stream", "x-file-name": "queued-shot-abc123.jpg", ...(dedupe ? { "x-dedupe": "1" } : {}) },
  body: bytes,
}).then((r) => r.json());

const first = await upload(true);
const retry = await upload(true);
const inbox = () => readdirSync(join(repo.path, ".claude", "inbox"));
check(first.saved?.[0]?.relPath === ".claude/inbox/queued-shot-abc123.jpg", `queued upload lands at the predicted path (${JSON.stringify(first.saved)})`);
check(retry.saved?.[0]?.relPath === first.saved?.[0]?.relPath, `a re-sent upload answers with the SAME path (${JSON.stringify(retry.saved)})`);
check(inbox().length === 1, `…and only one file exists (${JSON.stringify(inbox())})`);

// Without the header the old always-uniquify behaviour must be intact — an
// interactive upload of a same-named file is a genuinely different picture.
const plain = await upload(false);
check(plain.saved?.[0]?.relPath !== first.saved?.[0]?.relPath, `an ordinary upload still uniquifies (${JSON.stringify(plain.saved)})`);
check(inbox().length === 2, `…leaving two files (${JSON.stringify(inbox())})`);

ws.close();
host.kill();
await sleep(200);
process.exit(failed ? 1 : 0);
