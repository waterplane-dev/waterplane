// The handover: a session whose prompt names a file that has not arrived yet is
// the HOST's problem, not the phone's.
//
// What this pins is the inversion. Before, the ordering lived in the browser:
// the image was parked in the send queue and the `session.create` was parked
// BEHIND it, so a tunnel that stayed down for thirty minutes failed the upload
// and took the create — and every prompt queued behind it — with it, while the
// desktop never learned that any of it was supposed to happen. Now the create
// carries `needs`, goes over FIRST, and the host holds the session open-ready
// until the last file lands.
//
// Asserts:
//   1. a create carrying `needs` for an absent file spawns NOTHING, and is acked
//      `ok` with a `launchId` and deliberately no `sessionId` (accepted ≠ open)
//   2. `launch.list` says what it is waiting for, by name
//   3. replaying the same ackId parks nothing twice and opens nothing
//   4. the file landing OPENS the session — with no client action at all — and
//      the first prompt is typed exactly once
//   5. `launch.opened` names the session, so the prompts the phone queued behind
//      the create have something to bind to
//   6. a create whose files are ALREADY there is not parked: it opens instantly,
//      the way an ordinary create always did
//   7. `launch.cancel` settles a waiting launch and never opens it
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { readIntents } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8843;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-launchwait-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const LOG = join(ROOT, "stub-input.log");
const REL = ".claude/inbox/held-shot.jpg";
const TEXT = `Read ${REL} and fix the layout`;
const PROBE = `Read ${REL}`;

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(LOG, "");
const env = {
  ...process.env,
  // e2e must never touch the shared tmux server, and the boot doctor must never
  // print into output these scripts assert on.
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
  // Fast tick: the file landing kicks the gate directly, but assertion 6's
  // "already there" path and the deadline both go through it.
  [E.INTENT_TICK_MS]: "300",
  STUB_MODE: "repaint", STUB_LOG: LOG,
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
await sleep(900);

const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "alpha" }),
}).then((r) => r.json());
const repos = await fetch(`${base}/api/repos`).then((r) => r.json());
const target = repos.targets.find((r) => r.worktreePath === repo.path);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const sessions = new Map();
const opAcks = [];
const opened = [];
let launches = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "session.created") sessions.set(m.session.id, m.session);
  if (m.t === "session.list") for (const s of m.sessions) sessions.set(s.id, s);
  if (m.t === "op.ack") opAcks.push(m);
  if (m.t === "launch.list") launches = m.launches;
  if (m.t === "launch.opened") opened.push(m);
});
await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }); });
await sleep(300);

const log = () => { try { return readFileSync(LOG, "utf8"); } catch { return ""; } };
const count = (probe) => log().split(probe).length - 1;
const waitFor = async (pred, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(150); }
  return false;
};
const upload = (name, dedupe = true) => fetch(`${base}/api/repos/${target.id}/inbox`, {
  method: "POST",
  headers: { "content-type": "application/octet-stream", "x-file-name": name, ...(dedupe ? { "x-dedupe": "1" } : {}) },
  body: Buffer.from("not-really-a-jpeg-but-bytes-are-bytes"),
}).then((r) => r.json());

// ── 1–2. Parked, not spawned ─────────────────────────────────────────────
const ACK = "launch-ack-1";
const create = () => ws.send(JSON.stringify({
  t: "session.create", cwd: repo.path, title: "alpha · main", prompt: TEXT,
  cols: 80, rows: 24, ackId: ACK, needs: [REL],
}));
create();
await waitFor(() => opAcks.some((a) => a.ackId === ACK));
await sleep(1200); // long enough that a spawn would have shown up

const ack = opAcks.find((a) => a.ackId === ACK);
check(!!ack?.ok, "a create that names a missing file is ACCEPTED (ok)");
check(!!ack?.launchId, `…and answered with a launchId (${ack?.launchId})`);
check(!ack?.sessionId, "…and with NO sessionId — accepted is not open");
check(sessions.size === 0, `nothing was spawned (sessions: ${sessions.size})`);
check(count(PROBE) === 0, "…and nothing was typed");

ws.send(JSON.stringify({ t: "launch.list" }));
await waitFor(() => launches.length > 0, 5000);
const held = launches.find((l) => l.id === ack.launchId);
check(held?.state === "waiting", `the launch is listed as waiting (${held?.state})`);
check(held?.missing?.includes(REL), `…and names the file it is short of (${JSON.stringify(held?.missing)})`);

// ── 3. Replay must not park or open twice ────────────────────────────────
create();
await sleep(900);
ws.send(JSON.stringify({ t: "launch.list" }));
await sleep(400);
check(launches.filter((l) => l.state === "waiting").length === 1,
  `a replayed ackId parks nothing twice (waiting: ${launches.filter((l) => l.state === "waiting").length})`);
check(sessions.size === 0, "…and still opens nothing");

// ── 4–5. The file lands → the host opens it, on its own ──────────────────
await upload("held-shot.jpg");
const cameUp = await waitFor(() => sessions.size === 1 && count(PROBE) >= 1, 20000);
check(cameUp, "the file landing opens the session and delivers the prompt — no client action");
await sleep(1500);
check(count(PROBE) === 1, `the prompt is typed exactly once (copies: ${count(PROBE)})`);
check(opened.length === 1 && !!opened[0].sessionId,
  `launch.opened names the session the phone's queued prompts bind to (${JSON.stringify(opened)})`);
check(opened[0]?.cwd === repo.path, "…and the lane (cwd) they were queued under");

ws.send(JSON.stringify({ t: "launch.list" }));
await waitFor(() => launches.some((l) => l.id === ack.launchId && l.state === "done"), 5000);
const doneRow = launches.find((l) => l.id === ack.launchId);
check(doneRow?.state === "done" && doneRow.sessionId === opened[0]?.sessionId,
  `the row settles as done against that session (${doneRow?.state})`);
// …and it does NOT still name the file it waited for. `missing` is the list a
// launch went WITHOUT, and "a launch that went without its files says so for
// ever" is a deliberate rule — so a row that waited, got its upload and then
// ran perfectly must carry nothing here. It used to keep the list it had been
// blocked on, because the field was only ever written when a new value arrived,
// and the UI then said the launch had gone without a file that was sitting
// right there: a false positive in the one place the user was promised the
// truth.
check(!doneRow?.missing?.length,
  `a launch that waited and then got its file does not claim it went without it (${JSON.stringify(doneRow?.missing)})`);
check(!/without/.test(doneRow?.reason ?? ""), `…and the row's own sentence says so ("${doneRow?.reason ?? ""}")`);

// ── 6. Files already present ⇒ not parked at all ─────────────────────────
await upload("ready-shot.jpg");
const before = sessions.size;
ws.send(JSON.stringify({
  t: "session.create", cwd: repo.path, title: "alpha · ready", prompt: "Read .claude/inbox/ready-shot.jpg",
  cols: 80, rows: 24, ackId: "launch-ack-2", needs: [".claude/inbox/ready-shot.jpg"],
}));
await waitFor(() => sessions.size === before + 1, 10000);
const readyAck = opAcks.find((a) => a.ackId === "launch-ack-2");
check(sessions.size === before + 1, "a create whose files are already there opens immediately");
check(!!readyAck?.sessionId && !readyAck?.launchId,
  `…and is acked with a sessionId, not a launchId (${JSON.stringify(readyAck)})`);

// ── 7. Cancel ────────────────────────────────────────────────────────────
const held2 = sessions.size;
ws.send(JSON.stringify({
  t: "session.create", cwd: repo.path, title: "alpha · doomed", prompt: "Read .claude/inbox/never.jpg",
  cols: 80, rows: 24, ackId: "launch-ack-3", needs: [".claude/inbox/never.jpg"],
}));
await waitFor(() => opAcks.some((a) => a.ackId === "launch-ack-3"), 8000);
const doomed = opAcks.find((a) => a.ackId === "launch-ack-3");
ws.send(JSON.stringify({ t: "launch.cancel", id: doomed.launchId }));
await waitFor(() => launches.some((l) => l.id === doomed.launchId && l.state === "canceled"), 6000);
await sleep(800);
const dead = launches.find((l) => l.id === doomed.launchId);
check(dead?.state === "canceled", `a cancelled launch settles as canceled (${dead?.state})`);
check(sessions.size === held2, `…and never opened a session (sessions: ${sessions.size}, was ${held2})`);

// Persisted, because a restart is routine and a forgotten launch is the
// original bug with a longer fuse. The file is the INTENT store now — a parked
// launch is `{target: repo+fresh, trigger: files}` and nothing else — and the
// row keeps the prompt in full, which is the promise that made `launch.ts`
// deletable rather than merely renamed.
const stored = readIntents(join(ROOT, STATE, "intents.json"));
const row = stored.find((l) => l.id === ack.launchId) ?? null;
check(!!row, "launches are persisted to <state>/intents.json — one store, one lifecycle");
check(row?.trigger?.kind === "files" && row?.target?.kind === "repo" && row?.target?.fresh === true,
  `…as a files-triggered fresh-session intent (${JSON.stringify(row?.trigger?.kind)}/${JSON.stringify(row?.target)})`);
check(row?.payload?.steps?.[0] === TEXT, "…keeping the prompt in full, un-clipped");
check(!stored.some((l) => l.id !== ack.launchId && l.payload?.steps?.[0] === TEXT),
  "…and exactly once, however many times the ackId was replayed");

ws.close();
host.kill();
await sleep(200);
process.exit(failed ? 1 : 0);
