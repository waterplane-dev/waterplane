// The phone's mode picker, host half: `session.mode` presses shift+tab and
// re-reads the footer, and `liveMode` follows a shift+tab typed anywhere.
//
// The stub draws claude 2.1.293's footer as measured (`STUB_MODE=permmode`:
// auto → manual → accept edits → plan → auto) under a real composer, so this
// pins the walk end to end through tmux and the recorder's grid:
//   - a switch reaches its target and says nothing else;
//   - a switch to the mode already shown presses NOTHING;
//   - a mode the cycle does not hold goes round ONCE and says so in words,
//     leaving the footer where it started;
//   - two taps in a row are two walks, one after the other, never interleaved;
//   - a shift+tab typed as a raw key (the desk's) reaches `liveMode` on the
//     quiet tick;
//   - an unknown session is answered with a sentence, never silence.
// Presses are COUNTED off the stub's input log, so "pressed nothing" is a number.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8931;
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), `${SLUG}-permmode-`));
const LOG = join(root, "stub-input.log");
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(root),
  [E.CLAUDE_BIN]: STUB, STUB_MODE: "permmode", STUB_LOG: LOG,
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
/** shift+tabs the stub has received so far. */
const presses = () => { try { return readFileSync(LOG, "utf8").split("\x1b[Z").length - 1; } catch { return 0; } };

bootWait(PORT, 1500, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "modes" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, info = null;
    const replies = [];
    ws.on("message", (frame) => {
      const m = JSON.parse(frame.toString());
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid)) info = m.session;
      if (m.t === "session.moded") replies.push(m);
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(200);
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 100, rows: 30 }));
    const until = async (cond, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
      return false;
    };
    await until(() => sid);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));
    // The first quiet tick reads the footer the stub opened on.
    check(await until(() => info?.liveMode === "auto", 12000), "liveMode reads the launch footer (auto) on the quiet tick");

    const ask = async (mode, id = sid) => {
      const n = replies.length;
      ws.send(JSON.stringify({ t: "session.mode", id, mode }));
      await until(() => replies.length > n, 15000);
      return replies[n];
    };

    // 1. A switch that is in the cycle: three presses, the target, no sentence.
    let p0 = presses();
    let r = await ask("plan");
    check(r?.mode === "plan" && !r.reason, `auto → plan reaches plan with no reason (got ${JSON.stringify(r)})`);
    check(presses() - p0 === 3, `…in exactly three shift+tabs (got ${presses() - p0})`);
    check(await until(() => info?.liveMode === "plan", 3000), "…and liveMode follows on the session list");

    // 2. Already there: answered at once, nothing pressed.
    p0 = presses();
    r = await ask("plan");
    check(r?.mode === "plan" && !r.reason, "plan → plan answers plan");
    check(presses() - p0 === 0, `…without pressing anything (got ${presses() - p0})`);

    // 3. Not in this session's cycle: once round, back at the start, in words.
    p0 = presses();
    r = await ask("bypassPermissions");
    check(r?.mode === "plan", `a mode outside the cycle leaves the footer where it started (got ${r?.mode})`);
    check(/isn't in this session's shift\+tab cycle/.test(r?.reason ?? ""), `…and says why (got ${JSON.stringify(r?.reason)})`);
    check(presses() - p0 === 4, `…after exactly one lap (got ${presses() - p0} presses)`);

    // 4. Two taps back to back: serialised, each answered with its own target.
    p0 = presses();
    const n = replies.length;
    ws.send(JSON.stringify({ t: "session.mode", id: sid, mode: "default" }));
    ws.send(JSON.stringify({ t: "session.mode", id: sid, mode: "acceptEdits" }));
    await until(() => replies.length >= n + 2, 20000);
    check(replies[n]?.mode === "default" && !replies[n]?.reason, `first tap: manual (got ${JSON.stringify(replies[n])})`);
    check(replies[n + 1]?.mode === "acceptEdits" && !replies[n + 1]?.reason, `second tap: accept edits (got ${JSON.stringify(replies[n + 1])})`);
    check(presses() - p0 === 3, `…plan → auto → manual, then → accept edits: three presses, none lost or doubled (got ${presses() - p0})`);

    // 5. A shift+tab from somewhere else (a raw key, as the desk would type it).
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "\x1b[Z" }));
    check(await until(() => info?.liveMode === "plan", 12000), "a raw shift+tab reaches liveMode on the quiet tick");

    // 6. Nobody there: a sentence, never silence.
    r = await ask("plan", "no-such-session");
    check(!r?.mode && !!r?.reason, `an unknown session is answered in words (got ${JSON.stringify(r)})`);

    ws.close();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    host.kill();
    setTimeout(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } process.exit(failed ? 1 : 0); }, 300);
  }
});
