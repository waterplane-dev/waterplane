// Verifies the silence-fallback COMPLETION guard: a non-hooked backlog session
// that goes idle while PARKED ON A CHOICE PROMPT must NOT mark its running item
// `done` — the silence is the prompt waiting for an answer, not a finished turn.
// The fired command itself prints a Yes/No prompt, so once the session is quiet
// `SessionInfo.prompt` is set and completion must be withheld; sending input that
// produces fresh output clears the prompt and the item then completes on idle.
//
// Timing note: assertions are driven by DELIBERATE timers + explicit backlog.list
// polls, never by spontaneous broadcasts. Firing emits two back-to-back
// `backlog.list` broadcasts (fireItem's own onChange + the tick's trailing one),
// and feed() takes ~2-5s to type+submit; acting on a stray broadcast would assert
// before the command is even delivered. `onList` is armed ONLY right before a
// poll, so intervening broadcasts are ignored.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8796;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-blp-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_MS]: "1500" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

let ws;
// A command whose OUTPUT is a choice prompt — when the shell goes quiet after
// running it, prompt.ts detects a pending prompt on the session.
const PROMPT_CMD = "printf 'Do you want to proceed?\\n1. Yes\\n2. No\\nEsc to cancel\\n'";

bootWait(PORT, 900, async () => {
  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "auto" }) }).then((r) => r.json());
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let sid = null;
  // One-shot handler for the NEXT backlog.list; armed only around a deliberate
  // poll so spontaneous broadcasts (fire/complete) don't advance the test.
  let onList = null;
  const poll = (fn) => { onList = fn; ws.send(JSON.stringify({ t: "backlog.list" })); };
  const done = () => { ws.close(); host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    // A session in the repo, auto-fire on, and the prompt-printing item queued.
    // The item opens a session of its OWN when it fires (this one is only what
    // makes the repo look ordinary); feed() then types + submits into whichever
    // session the fire reports.
    ws.send(JSON.stringify({ t: "backlog.openRepoSession", repoDir: repo.path }));
    ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true }));
    ws.send(JSON.stringify({ t: "backlog.add", text: PROMPT_CMD, repoDir: repo.path, label: "prompt task" }));

    // t+10s: session opened + item fired + feed delivered (~2-5s) + the printf
    // prompt detected (600ms after output settles) + well past <ENV>_IDLE_MS. If
    // the guard is absent the item has ALREADY been (wrongly) marked done by the
    // idle tick (~feed-end + 1.5s ≈ t+6-7s); with the guard it is still running.
    setTimeout(() => poll((it) => {
      sid = it && it.sessionId;
      check(!!sid, "item fired into the repo session");
      check(it && it.status === "running", `item stays running while parked on a prompt (status: ${it && it.status})`);
      // Clear the prompt: Ctrl-C abandons any pending readline buffer, then print
      // enough lines to push the numbered options out of the detector's 40-line
      // tail window (prompt.ts) so no prompt is re-detected once quiet again.
      ws.send(JSON.stringify({ t: "session.input", id: sid, data: "\x03" }));
      setTimeout(() => ws.send(JSON.stringify({ t: "session.input", id: sid, data: "seq 70\r" })), 500);
      // t+9s later: prompt gone, session idle past <ENV>_IDLE_MS → item completes.
      setTimeout(() => poll((it2) => {
        check(it2 && it2.status === "done", `item completes on idle once the prompt is cleared (status: ${it2 && it2.status})`);
        done();
      }), 9000);
    }), 10000);
  });

  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t !== "backlog.list") return;
    if (onList) { const fn = onList; onList = null; fn(m.items[0]); }
  });
});

setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 40000);
