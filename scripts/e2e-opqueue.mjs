// Durable OPS on the offline queue: "start a session here", "relaunch this one
// with other flags", "fan out to these repos", "run this build" survive the
// tunnel being down the same way typed text does — which means they need the
// same at-most-once contract. The ops covered here are exactly the ops the host
// handles: `session.create` (plain and with `replaceSessionId`), `fanout.run`,
// `fanout.followup`, `build.run`.
//
// The phone re-sends a queued message with the SAME ackId when it never saw the
// receipt. For `session.input` that would type a prompt twice; for these it
// would spawn a second session, a second N-repo sweep, or a second full build.
// So the host answers `op.ack` and remembers the verdict per ackId (acks.ts),
// and the ledger is PERSISTED — `npm run restart` is routine, and forgetting
// across it is exactly when a re-sent sweep would run twice.
//
// Asserted end to end against real stub sessions: the stub logs everything
// typed into it, so "how many copies of the follow-up landed" is countable.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8815;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-opqueue-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const LOG = join(ROOT, "stub-input.log");
const TEXT = "Summarize this project into the outbox";
const FOLLOW = "Now commit the summary you just wrote";

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
// A host that dies, or a socket that drops, mid-test used to read as a long run
// of FAILs with nothing behind them: every ack after it simply never came. One
// such run under heavy memory pressure could not be told apart from a host
// whose event loop was blocked, so both are now said out loud — the exit or
// close the moment it happens, and a liveness probe where a wait gives up.
let expectExit = false;
const startHost = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  h.on("exit", (code, signal) => {
    if (h === host && !expectExit) check(false, `the host exited mid-test (code ${code}, signal ${signal})`);
  });
  return h;
};
let host = startHost();
const base = `http://127.0.0.1:${PORT}`;
await waitForHost(PORT);

const mk = (name) => fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
}).then((r) => r.json());
const solo = await mk("solo");
const a = await mk("alpha");
const b = await mk("beta");

const logText = () => { try { return readFileSync(LOG, "utf8"); } catch { return ""; } };
const copies = (probe) => logText().split(probe).length - 1;

// ── One socket, one collector for everything the host says back ──
const state = { acks: [], sessions: new Map(), runs: [], buildRuns: [], builds: [] };
let ws;
let expectClose = false;
function connect() {
  expectClose = false;
  state.acks = [];
  state.sessions = new Map();
  state.runs = [];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    // Both receipt kinds land in one list; the ackIds here are unique per case.
    if (m.t === "op.ack" || m.t === "input.ack") state.acks.push(m);
    if (m.t === "session.created") state.sessions.set(m.session.id, m.session);
    if (m.t === "session.list") { state.sessions = new Map(m.sessions.map((s) => [s.id, s])); }
    if (m.t === "fanout.list") state.runs = m.runs;
    if (m.t === "fanout.run") state.runs = [m.run, ...state.runs.filter((r) => r.id !== m.run.id)];
    if (m.t === "build.list") { state.builds = m.builds; state.buildRuns = m.runs; }
  });
  ws.on("error", (e) => { console.log("FAIL: ws error " + e.message); failed = true; });
  const mine = ws;
  ws.on("close", (code) => { if (ws === mine && !expectClose) check(false, `the host closed the socket mid-test (code ${code})`); });
  return new Promise((resolve) => {
    ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); setTimeout(resolve, 600); });
  });
}
const send = (m) => ws.send(JSON.stringify(m));
const acksFor = (id) => state.acks.filter((x) => x.ackId === id);
const waitFor = async (pred, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(200); }
  return false;
};
/** Where a wait gave up: is the host still answering at all? An HTTP probe
 *  separates "slow" from "event loop blocked", and the process state separates
 *  blocked (S/U, sitting in a call) from spinning (R) from gone. */
async function diagnose(what) {
  let http;
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    http = `answers HTTP ${r.status}`;
  } catch (e) { http = `does NOT answer HTTP within 3 s (${e.name})`; }
  let proc = "gone";
  try {
    proc = execFileSync("ps", ["-o", "stat=,%cpu=,etime=", "-p", String(host.pid)], { encoding: "utf8", timeout: 3000 }).trim() || "gone";
  } catch { /* not running */ }
  console.log(`# after ${what}: host pid ${host.pid} ${http}; ps stat,%cpu,etime: ${proc}; socket readyState ${ws.readyState}`);
}

await connect();

// ── 1. session.create ────────────────────────────────────────────────
// The duplicate goes out immediately: a retry that races the first delivery is
// the normal case (the phone re-flushes the moment the socket reopens), so the
// dedupe cannot rely on the first one having finished.
send({ t: "session.create", cwd: solo.path, cols: 80, rows: 24, ackId: "op-create-1" });
send({ t: "session.create", cwd: solo.path, cols: 80, rows: 24, ackId: "op-create-1" });
await waitFor(() => acksFor("op-create-1").length >= 2, 15000);
await sleep(600);
send({ t: "session.list" });
await sleep(400);
const created = acksFor("op-create-1");
const soloSessions = [...state.sessions.values()].filter((s) => s.cwd === solo.path);
check(created.length === 2, `both sends are acked (${created.length})`);
check(created.every((x) => x.ok) && created[0]?.sessionId && created[0].sessionId === created[1]?.sessionId,
  `both receipts name the SAME session (${JSON.stringify(created.map((x) => x.sessionId))})`);
check(soloSessions.length === 1, `a re-sent session.create spawns exactly one session (saw ${soloSessions.length})`);

// ── 2. fanout.run — the most expensive message to duplicate ──────────
send({ t: "fanout.run", dirs: [a.path, b.path], text: TEXT, cols: 80, rows: 24, ackId: "op-fan-1" });
send({ t: "fanout.run", dirs: [a.path, b.path], text: TEXT, cols: 80, rows: 24, ackId: "op-fan-1" });
await waitFor(() => acksFor("op-fan-1").length >= 2, 20000);
// …and once more well after it settled, so the PERSISTED verdict is exercised
// too, not just the in-flight guard.
//
// "Settled" means BOTH targets exist and each has its session and is past
// `starting`. The run the receipt and the first `fanout.run` frame carry has
// NO targets yet — the sweep posts its child rows after the parent fires — and
// `[].every(…)` is true, so a bare `every` passed at once and everything below
// (the prompt count, then a follow-up the host rightly refuses with "none of
// those sessions is still open" because no target has a session yet) raced
// the deliveries. That was the load-flake: unloaded the deliveries happened to
// finish inside the fixed sleeps that follow. The bound is the product's own:
// `deliverToNewSession` may wait out a not-ready first attempt and try again.
const settledTargets = () => {
  const ts = state.runs.find((r) => r.id === acksFor("op-fan-1")[0]?.runId)?.targets ?? [];
  return ts.length === 2 && ts.every((t) => t.sessionId && (t.status === "running" || t.status === "done" || t.status === "failed"));
};
const settled = await waitFor(settledTargets, 100000);
if (!settled) await diagnose("the fan-out never settled");
check(settled,
  `both fan-out targets got a session and settled their delivery (${JSON.stringify(state.runs[0]?.targets?.map((t) => [t.status, !!t.sessionId]))})`);
send({ t: "fanout.run", dirs: [a.path, b.path], text: TEXT, cols: 80, rows: 24, ackId: "op-fan-1" });
await waitFor(() => acksFor("op-fan-1").length >= 3, 10000);
await sleep(500);
send({ t: "fanout.list" });
await sleep(400);
const fanAcks = acksFor("op-fan-1");
const runId = fanAcks[0]?.runId;
check(fanAcks.length === 3 && fanAcks.every((x) => x.ok && x.runId === runId),
  `every re-send is acked with the SAME run (${JSON.stringify(fanAcks.map((x) => x.runId))})`);
check(state.runs.length === 1, `a re-sent fan-out starts exactly one run (saw ${state.runs.length})`);
check(copies(TEXT) === 2, `the prompt reached each of the 2 repos once, no more (copies: ${copies(TEXT)})`);

// ── 3. build.run ─────────────────────────────────────────────────────
const CMD = "echo OPQUEUE_BUILD_MARKER";
send({ t: "build.save", repoDir: solo.path, builds: [{ id: "b1", name: "echo", cmd: CMD }] });
await waitFor(() => state.builds.length === 1, 5000);
send({ t: "build.run", repoDir: solo.path, buildId: "b1", ackId: "op-build-1" });
send({ t: "build.run", repoDir: solo.path, buildId: "b1", ackId: "op-build-1" });
await waitFor(() => acksFor("op-build-1").length >= 2, 10000);
await sleep(800);
send({ t: "build.list", repoDir: solo.path });
await sleep(500);
const buildAcks = acksFor("op-build-1");
check(buildAcks.length === 2 && buildAcks.every((x) => x.ok && x.runId === buildAcks[0].runId),
  `both build receipts name the same run (${JSON.stringify(buildAcks.map((x) => x.runId))})`);
check(state.buildRuns.length === 1, `a re-sent build.run compiles once (saw ${state.buildRuns.length} runs)`);

// ── 4. fanout.followup ───────────────────────────────────────────────
const before = state.sessions.size;
send({ t: "fanout.followup", runId, text: FOLLOW, dirs: [a.path], ackId: "op-fu-1" });
send({ t: "fanout.followup", runId, text: FOLLOW, dirs: [a.path], ackId: "op-fu-1" });
await waitFor(() => acksFor("op-fu-1").length >= 2 && copies(FOLLOW) >= 1, 30000);
await sleep(1200);
const fuAcks = acksFor("op-fu-1");
const run = state.runs.find((r) => r.id === runId);
check(fuAcks.length === 2 && fuAcks.every((x) => x.ok), `both follow-up sends are acked ok (${JSON.stringify(fuAcks.map((x) => x.ok))})`);
check(run?.followUps?.length === 1, `the run records ONE follow-up (${run?.followUps?.length})`);
check(copies(FOLLOW) === 1, `the follow-up was typed exactly once (copies: ${copies(FOLLOW)})`);

// ── 5. An unknown run id is refused, not turned into a fresh run ─────
send({ t: "fanout.followup", runId: "no-such-run", text: FOLLOW, ackId: "op-fu-2" });
await waitFor(() => acksFor("op-fu-2").length >= 1, 8000);
await sleep(400);
const bad = acksFor("op-fu-2")[0];
check(bad && bad.ok === false && !!bad.reason, `an unknown run id is acked ok:false with a reason (${JSON.stringify(bad)})`);
check(state.sessions.size === before, `a refused follow-up spawns nothing (still ${before} sessions)`);

// ── 6. session.create + replaceSessionId: relaunch as ONE op ─────────
// "Relaunch with different flags" is kill-then-create. Sent as two messages the
// kill is a bare socket write the ws layer DROPS while the tunnel is down, while
// the create is durably queued — so an offline relaunch whose tab is then killed
// replays only the create and leaves two claude processes in the same worktree.
// Folded into the create's own ackId it is atomic and at-most-once.
const oldSolo = created[0].sessionId;
send({ t: "session.create", cwd: solo.path, cols: 80, rows: 24, replaceSessionId: oldSolo, ackId: "op-relaunch-1" });
send({ t: "session.create", cwd: solo.path, cols: 80, rows: 24, replaceSessionId: oldSolo, ackId: "op-relaunch-1" });
await waitFor(() => acksFor("op-relaunch-1").length >= 2, 15000);
await sleep(1200);
send({ t: "session.list" });
await sleep(500);
const relaunch = acksFor("op-relaunch-1");
const newSolo = relaunch[0]?.sessionId;
const liveSolo = [...state.sessions.values()].filter((s) => s.cwd === solo.path && s.running);
check(relaunch.length === 2 && relaunch.every((x) => x.ok && x.sessionId === newSolo),
  `both relaunch receipts name the SAME new session (${JSON.stringify(relaunch.map((x) => x.sessionId))})`);
check(!!newSolo && newSolo !== oldSolo, `the relaunch produced a new session (${oldSolo} → ${newSolo})`);
check(liveSolo.length === 1 && liveSolo[0].id === newSolo,
  `the replaced session was killed once — exactly one live claude in that worktree (${JSON.stringify(liveSolo.map((s) => s.id))})`);

// A target that is already gone is not an error: killing it was the intent, and
// a retry arriving after the first attempt succeeded must still get a session.
send({ t: "session.create", cwd: b.path, cols: 80, rows: 24, replaceSessionId: "no-such-session", ackId: "op-relaunch-2" });
await waitFor(() => acksFor("op-relaunch-2").length >= 1, 10000);
await sleep(400);
const orphanReplace = acksFor("op-relaunch-2")[0];
check(orphanReplace?.ok === true && !!orphanReplace.sessionId,
  `a replace whose target is already gone still creates (${JSON.stringify(orphanReplace)})`);

// A relaunch onto the SAME conversation (the model sheet: `resumeSessionId` =
// the session's own) keeps the row's words. The prompt history and the tab
// name are stored per BOOT id and the kill deletes both, so a model switch
// used to bring the session back with an empty Started/Latest.
const CARRY = "Carry this prompt across the relaunch";
send({ t: "session.create", cwd: b.path, cols: 80, rows: 24, prompt: CARRY, ackId: "op-carry-src" });
await waitFor(() => acksFor("op-carry-src").length >= 1, 15000);
const carrySrc = acksFor("op-carry-src")[0]?.sessionId;
await waitFor(() => { send({ t: "session.list" }); return state.sessions.get(carrySrc)?.firstPrompt === CARRY; }, 20000);
const srcInfo = state.sessions.get(carrySrc);
check(srcInfo?.firstPrompt === CARRY && !!srcInfo?.claudeSessionId, `the source session has its first prompt (${JSON.stringify(srcInfo?.firstPrompt)})`);
send({ t: "session.create", cwd: b.path, cols: 80, rows: 24, replaceSessionId: carrySrc,
  resumeMode: "continue", resumeSessionId: srcInfo?.claudeSessionId, ackId: "op-carry-1" });
await waitFor(() => acksFor("op-carry-1").length >= 1, 15000);
await sleep(600);
send({ t: "session.list" });
await sleep(400);
const carried = state.sessions.get(acksFor("op-carry-1")[0]?.sessionId);
check(carried?.firstPrompt === CARRY, `a same-conversation relaunch keeps the first prompt (${JSON.stringify(carried?.firstPrompt)})`);
// …and a relaunch that starts a NEW conversation does not wear the old words.
send({ t: "session.create", cwd: b.path, cols: 80, rows: 24, replaceSessionId: carried?.id, ackId: "op-carry-2" });
await waitFor(() => acksFor("op-carry-2").length >= 1, 15000);
await sleep(600);
send({ t: "session.list" });
await sleep(400);
const fresh = state.sessions.get(acksFor("op-carry-2")[0]?.sessionId);
check(!!fresh && !fresh.firstPrompt, `a fresh relaunch starts with no prompt labels (${JSON.stringify(fresh?.firstPrompt)})`);

// ── 7. The ledger survives a restart ─────────────────────────────────
// `npm run restart` happens constantly. An in-memory-only ledger forgets every
// ackId across it, so a queued fan-out re-sent afterwards would run the whole
// sweep a second time. The runs are DURABLE now (they are rows in the intent
// store, not an in-memory ring), so the proof is: the old ackId is re-acked with
// the ORIGINAL runId, that run is still THERE afterwards rather than forgotten,
// and no second run and no new session appear.
//
// The kill is a SIGTERM on purpose — `npm run restart` is launchd
// `kickstart -k`, i.e. exactly that. So the debounced half of the ledger is
// exercised too: an `input.ack` verdict recorded milliseconds before the signal
// is still sitting on a 500 ms UNREF'd timer, and without a flush on the signal
// it dies with the process, leaving the phone's retry to retype the prompt.
const PERSIST_MARK = "PERSISTED_INPUT_MARKER";
send({ t: "session.input", id: newSolo, data: PERSIST_MARK, ackId: "op-input-1" });
// Kill the moment the receipt arrives: the verdict is remembered just before
// the ack is sent, so its 500 ms save timer is still pending. A fixed sleep
// here raced the other way under load — the SIGTERM could land before the host
// had even READ the message, and then "ok:false on replay" is the correct
// answer to a send that never happened, not a lost ledger entry.
check(await waitFor(() => acksFor("op-input-1").length >= 1, 8000), "the input was acked before the restart");
expectClose = true; expectExit = true;
try { ws.close(); } catch { /* already closing */ }
host.kill();
await sleep(1200);
expectExit = false;
host = startHost();
await waitForHost(PORT);
await connect();
const sessionsAfterBoot = state.sessions.size;
send({ t: "fanout.run", dirs: [a.path, b.path], text: TEXT, cols: 80, rows: 24, ackId: "op-fan-1" });
await waitFor(() => acksFor("op-fan-1").length >= 1, 10000);
await sleep(1500);
send({ t: "fanout.list" });
send({ t: "session.list" });
await sleep(600);
const afterRestart = acksFor("op-fan-1")[0];
check(afterRestart?.ok === true && afterRestart.runId === runId,
  `after a restart the same ackId is re-acked with the ORIGINAL run (${JSON.stringify(afterRestart)})`);
check(state.runs.length === 1 && state.runs[0]?.id === runId,
  `the sweep SURVIVED the restart and no second one started (${JSON.stringify(state.runs.map((r) => r.id))}, wanted just ${runId})`);
check(state.sessions.size === sessionsAfterBoot, `and no sessions were spawned (${state.sessions.size} vs ${sessionsAfterBoot})`);
check(copies(TEXT) === 2, `still only the original 2 copies of the prompt (copies: ${copies(TEXT)})`);

// The debounced receipt: re-sent with the same ackId, it must come back ok:true
// from the ledger. Without the shutdown flush the host would have forgotten it
// and answered ok:false (that session died with the old process) — which is the
// client's signal to recover the text and send it again.
send({ t: "session.input", id: newSolo, data: PERSIST_MARK, ackId: "op-input-1" });
await waitFor(() => acksFor("op-input-1").length >= 1, 8000);
const replayed = acksFor("op-input-1")[0];
check(replayed?.ok === true,
  `an input receipt still debounced when the SIGTERM landed was flushed and is replayed ok (${JSON.stringify(replayed)})`);
check(copies(PERSIST_MARK) === 1, `and the text was never typed twice (copies: ${copies(PERSIST_MARK)})`);

expectClose = true; expectExit = true;
try { ws.close(); } catch { /* already closing */ }
host.kill();
await sleep(200);
process.exit(failed ? 1 : 0);
