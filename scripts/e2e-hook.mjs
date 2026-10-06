// Verifies the claude-hook readiness signal end to end, using the bash stub
// (which emits no real hooks) and simulating claude by POSTing lifecycle events
// to /api/hook. Proves the three behaviors the silence heuristic couldn't:
//   1. a hook arriving flips the session to `hooked` (pipe is live)
//   2. turnActive (UserPromptSubmit, no Stop yet) BLOCKS auto-fire even after the
//      silence threshold passes — the exact bug: silence said "ready", turn wasn't
//   3. the item completes on its own turn's Stop (stopCount past the fire baseline),
//      not on a silence guess
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8796;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-hook-`));
// Small idle threshold so "waited past silence, still not fired" is quick to prove.
const IDLE = 1200;
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_MS]: String(IDLE) };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };
const fail = (m) => { console.log("FAIL: " + m); host.kill(); process.exit(1); };

let sid = null, cid = null, cwd = null;
const postHook = (event) =>
  fetch(`${base}/api/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hook_event_name: event, session_id: cid, cwd }) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listResolvers = [];
const nextBacklog = () => new Promise((r) => listResolvers.push(r));

bootWait(PORT, 900, async () => {
  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "hooked" }) }).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let hookedSeen = false;
  // Latest turnActive seen on the wire — what the reader view badges as "working".
  let turnFlag = false;
  let opened;
  const openedP = new Promise((r) => { opened = r; });
  ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); opened(); });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.focus" && !sid) sid = m.id;
    const s = m.session || (m.sessions && m.sessions.find((x) => x.id === sid));
    if (s && s.id === sid) {
      if (!cid && s.claudeSessionId) { cid = s.claudeSessionId; cwd = s.cwd; }
      if (s.hooked) hookedSeen = true;
      turnFlag = s.turnActive === true;
    }
    if (m.t === "backlog.list") { const r = listResolvers.shift(); if (r) r(m); }
  });

  // Open a session in the repo by hand — `backlog.openRepoSession` is the route
  // that does it synchronously and hands back an id — then drive the hook
  // lifecycle over it. (It is no longer the only path that spawns a session:
  // every fired item opens one of its own. It is the only one this test can
  // name an id for without firing work.)
  await openedP;
  ws.send(JSON.stringify({ t: "backlog.openRepoSession", repoDir: repo.path }));

  // Wait for the session to exist and expose its (minted) claude session id.
  for (let i = 0; i < 60 && !(sid && cid && cwd); i++) { await sleep(100); if (!sid) ws.send(JSON.stringify({ t: "session.list" })); }
  if (!(sid && cid && cwd)) return fail("never learned session id/cwd");

  // 1. A hook arriving marks the pipe live.
  await postHook("SessionStart");
  for (let i = 0; i < 30 && !hookedSeen; i++) await sleep(100);
  check(hookedSeen, "session flips to `hooked` once a hook arrives");

  // 2. A turn is in flight (UserPromptSubmit, no Stop) — must block auto-fire even
  // after the silence threshold elapses.
  await postHook("UserPromptSubmit");
  ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true }));
  ws.send(JSON.stringify({ t: "backlog.add", text: "echo HOOK_$((6*7))", repoDir: repo.path, label: "hook task" }));
  await sleep(IDLE * 2 + 800); // well past the silence threshold + a couple ticks
  const afterWait = await new Promise((r) => { listResolvers.push(r); ws.send(JSON.stringify({ t: "backlog.list" })); });
  const q = afterWait.items.find((i) => i.repoDir === repo.path);
  check(!!q && q.status === "queued", `item stays QUEUED while the turn is active, despite silence (status: ${q && q.status})`);
  // Same flag, published: the reader view has no terminal to look at, so "working"
  // has to come off the wire.
  check(turnFlag, "turnActive is broadcast while the turn is in flight");

  // 3a. The turn's Stop makes the session ready → the item fires.
  await postHook("Stop"); // stopCount → 1, turnActive → false
  let running = null;
  for (let i = 0; i < 40 && !running; i++) {
    const bl = await new Promise((r) => { listResolvers.push(r); ws.send(JSON.stringify({ t: "backlog.list" })); });
    const it = bl.items.find((i) => i.repoDir === repo.path);
    if (it && it.status === "running") running = it;
    else await sleep(200);
  }
  check(!!running, "item auto-fires once the Stop hook reports the turn ended");
  check(!turnFlag, "turnActive clears on Stop (reader view stops saying `working`)");

  // 3b. Its own turn's Stop (past the fire baseline) completes it — not a silence guess.
  await postHook("UserPromptSubmit");
  await postHook("Stop"); // stopCount → 2 > baseline 1 → done
  let doneItem = null;
  let lastSeen = null;
  for (let i = 0; i < 40 && !doneItem; i++) {
    const bl = await new Promise((r) => { listResolvers.push(r); ws.send(JSON.stringify({ t: "backlog.list" })); });
    const it = bl.items.find((i) => i.repoDir === repo.path);
    lastSeen = it ?? lastSeen;
    if (it && it.status === "done") doneItem = it;
    else await sleep(200);
  }
  check(!!doneItem, `item completes on its turn-end Stop (hook-driven, not silence) — last saw ${JSON.stringify(lastSeen && { status: lastSeen.status, error: lastSeen.error })}`);

  ws.close();
  done();
});

setTimeout(() => fail("timeout (hook flow didn't complete)"), 30000);
