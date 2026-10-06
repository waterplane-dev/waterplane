// Fan-out: one prompt, N repos, a FRESH session each.
//
// Asserts the three things that make the feature safe to fire from a phone:
//   1. one session per selected repo, in that repo's cwd
//   2. the prompt reaches each session EXACTLY ONCE (same at-most-once delivery
//      the backlog uses — deliver.ts is shared, so a regression there shows here)
//   3. a dir that isn't a discovered repo is DROPPED, never spawned
//   4. a FOLLOW-UP reaches only the selected targets' EXISTING sessions, exactly
//      once, and never spawns anything (an unknown run id is an error, not a run)
//   5. a sweep SURVIVES the daemon. This is what the in-memory runs ring could
//      never do: a restart mid-run left N live `claude` processes and no account
//      at all of what they were for, no way to follow up on them as a set, and —
//      for the row the phone had just posted — no sweep. A run is now N rows in
//      the intent store sharing a `groupId`, so the restarted host still lists
//      it, still names its targets and their sessions, and reconciles anything
//      that was mid-flight rather than re-running it.
import { killTmuxServers } from "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8814;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-fanout-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const LOG = join(ROOT, "stub-input.log");
const TEXT = "Report this project's monthly cost into the outbox";
const PROBE = "Report this project's monthly cost";
const FOLLOW = "Now commit the report you just wrote";

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
const startHost = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return h;
};
let host = startHost();
const base = `http://127.0.0.1:${PORT}`;
await sleep(900);

const mk = (name) => fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
}).then((r) => r.json());
const a = await mk("alpha");
const b = await mk("beta");

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const sessions = new Map(); // id → SessionInfo
const toasts = [];
const opAcks = [];
let run = null;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "session.created") sessions.set(m.session.id, m.session);
  if (m.t === "session.list") for (const s of m.sessions) sessions.set(s.id, s);
  if (m.t === "fanout.run") run = m.run;
  if (m.t === "toast") toasts.push(m.text);
  if (m.t === "op.ack") opAcks.push(m);
});
await new Promise((resolve) => {
  let started = false;
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "fanout.list" && !started) {
      started = true;
      // The bogus path must be dropped, not spawned.
      ws.send(JSON.stringify({ t: "fanout.run", dirs: [a.path, b.path, "/definitely/not/a/repo"], text: TEXT, cols: 80, rows: 24 }));
      return;
    }
    if (m.t === "fanout.run") {
      const terminal = (t) => t.status === "running" || t.status === "done" || t.status === "failed";
      if (m.run.targets.length && m.run.targets.every(terminal)) resolve();
    }
  });
  setTimeout(resolve, 60000);
});
await sleep(500);
const log = () => { try { return readFileSync(LOG, "utf8"); } catch { return ""; } };
const count = (probe) => log().split(probe).length - 1;
const waitFor = async (pred, ms = 40000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(250); }
  return false;
};

const copies = count(PROBE);
const cwds = [...sessions.values()].map((s) => s.cwd).sort();

check(run?.targets.length === 2, `unknown dir dropped — 2 targets, not 3 (got ${run?.targets.length})`);
check(JSON.stringify(cwds) === JSON.stringify([a.path, b.path].sort()), `one session per selected repo (${JSON.stringify(cwds)})`);
check(run?.targets.every((t) => t.status === "running"), `every target delivered (${run?.targets.map((t) => `${t.title}:${t.status}${t.error ? ` (${t.error})` : ""}`).join(", ")})`);
check(run?.targets.every((t) => t.sessionId && sessions.has(t.sessionId)), "each target carries the session it spawned");
check(copies === 2, `prompt typed exactly once per repo (copies: ${copies})`);
// The stub reports no hooks, so no target can be proven finished — the run must
// stay OPEN rather than claim a completion it can't observe.
check(run && !run.finishedAt, "run stays open while its targets are still running");

// ── Follow-up: another instruction into the sessions the run already has ──
const before = [...sessions.keys()].length;
ws.send(JSON.stringify({ t: "fanout.followup", runId: run.id, text: FOLLOW, dirs: [a.path] }));
const target = () => run?.targets.find((t) => t.dir === a.path);
await waitFor(() => count(FOLLOW) >= 1 && target()?.status === "running");
await sleep(800);

check(count(FOLLOW) === 1, `follow-up typed exactly once, only in the selected repo (copies: ${count(FOLLOW)})`);
check(target()?.status === "running", `followed-up target is running again (${target()?.status}${target()?.error ? `: ${target()?.error}` : ""})`);
check(run?.followUps?.length === 1 && run.followUps[0].dirs.length === 1, `the run records the follow-up and its subset (${JSON.stringify(run?.followUps)})`);
check([...sessions.keys()].length === before, `follow-up spawns NOTHING — still ${before} sessions`);

// An unknown run id must be refused, not turned into a fresh run.
toasts.length = 0;
ws.send(JSON.stringify({ t: "fanout.followup", runId: "no-such-run", text: FOLLOW }));
await waitFor(() => toasts.some((t) => t.startsWith("fan-out:")), 5000);
check(toasts.some((t) => t.startsWith("fan-out:")), `unknown run id refused (toasts: ${JSON.stringify(toasts)})`);
check([...sessions.keys()].length === before, "a refused follow-up spawns nothing either");
// Every fan-out above went out WITHOUT an ackId: the durable-op receipts
// (e2e-opqueue.mjs) are opt-in, and the un-acked form must still behave exactly
// as it always did — run, follow up, refuse an unknown id — with no receipt.
check(opAcks.length === 0, `ackId-less fan-out gets no op.ack (saw ${JSON.stringify(opAcks)})`);

// ── 5. The sweep survives the daemon ─────────────────────────────────────
// A restart is routine (`npm run restart` is `launchctl kickstart -k`), and it
// used to be the one event that erased a run outright: the ring was in memory,
// so twelve sessions were left with nothing saying which sweep had opened them.
const beforeRestart = JSON.stringify(run.targets.map((t) => [t.dir, t.sessionId]).sort());
ws.close();
host.kill();
await sleep(1200);
// A REBOOT, not a plain restart: under tmux a restart keeps every pane alive
// (that is `e2e-tmux.mjs`'s subject), so the panes are killed with the daemon to
// keep this section's subject — the sessions the targets went into are gone.
killTmuxServers();
host = startHost();
await sleep(1800);

const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let after = null;
const sessions2 = new Map();
ws2.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "fanout.list") after = m.runs;
  if (m.t === "fanout.run") after = [m.run, ...(after ?? []).filter((r) => r.id !== m.run.id)];
  if (m.t === "session.created") sessions2.set(m.session.id, m.session);
  if (m.t === "session.list") for (const s of m.sessions) sessions2.set(s.id, s);
});
await new Promise((r) => ws2.on("open", r));
ws2.send(JSON.stringify({ t: "hello", protocol: 1 }));
await sleep(600);
ws2.send(JSON.stringify({ t: "fanout.list" }));
await waitFor(() => after !== null, 8000);
await sleep(500);

const survived = (after ?? []).find((r) => r.id === run.id);
check(!!survived, `the run is still listed after a restart (${JSON.stringify((after ?? []).map((r) => r.id))})`);
check(survived?.text === TEXT, "…with the prompt it was sweeping, in full");
check(JSON.stringify((survived?.targets ?? []).map((t) => [t.dir, t.sessionId]).sort()) === beforeRestart,
  `…and every target, still naming the session it opened (${JSON.stringify(survived?.targets?.map((t) => `${t.dir}:${t.status}`))})`);
check(survived?.followUps?.length === 1, `…and the follow-up it was given (${survived?.followUps?.length})`);
// Reconciliation, not amnesia and not a re-run: the sessions those targets were
// delivered into died with the daemon (their tmux server killed above), so each row must END —
// never silently succeed, and never be typed into a second time.
// And never `done`: a log that has the words proves they were delivered, not
// that the turn ended, and a session that did not come back can no longer say
// which. (This run has no conversation log, so the verdict is `unknown` and the
// sentence is *that session is gone*; with one it is *did not come back*.)
check(await waitFor(() => (after ?? []).find((r) => r.id === run.id)?.targets.every((t) => t.status === "failed" && /session is gone|did not come back/.test(t.error ?? "")), 15000),
  `every target reconciled to a terminal verdict (${JSON.stringify((after ?? []).find((r) => r.id === run.id)?.targets.map((t) => `${t.status}:${t.error ?? ""}`))})`);
check(count(PROBE) === 2, `and NOTHING was re-typed by the restart (copies: ${count(PROBE)})`);
check(count(FOLLOW) === 1, `…the follow-up included (copies: ${count(FOLLOW)})`);
check(sessions2.size === 0, `no sessions were spawned on the way back up (${sessions2.size})`);

ws2.close();
host.kill();
await sleep(200);
process.exit(failed ? 1 : 0);
