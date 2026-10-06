// A `Stop` hook is a QUESTION, and a hook may answer no.
//
// Every keep-going loop is built the same way: the CLI asks to end the turn, a
// Stop hook answers `decision: block` with the next instruction, and the CLI
// carries straight on. No `UserPromptSubmit` follows — nothing was submitted,
// the continuation arrives in the conversation as a meta message — so a host
// that believes the Stop has just published "turn over" over a turn that is
// nine minutes from finishing.
//
// That is not a hypothetical: on the live desktop a session spinning
// "✻ Crafting… (9m 35s · ↓ 34.5k tokens)" published `turnActive: false`, the
// reader said "idle — nothing running", and the queue typed a prompt into the
// running turn that was never confirmed and was retried four times.
//
// `/compact` is the same lie from the other side: it fires NO hook at all — no
// `UserPromptSubmit`, no `Stop` — and grinds for minutes printing
// "Compacting conversation… (35s)" while the session reads idle.
//
// Pinned here, with the stub playing both (`STUB_MODE=goal`):
//   1. a Stop the CLI overrides does NOT end the turn — the session stays
//      `turnActive` for as long as its own working line keeps printing
//   2. the turn ends once the spinner stops and the real Stop lands
//   3. it ends ONCE — the refused Stop is settled, not replayed
//   4. work no hook announced at all is published as a turn, and retired when
//      the CLI stops printing it
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8884;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-stophook-`));
/** The turn carries on this long past the Stop that was refused — several
 *  settle passes, so the hold has to be re-earned rather than granted once. */
const KEEP_MS = 2400;
const VERIFY_MS = 400;
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
  STUB_MODE: "goal", STUB_HOOKS: "1", STUB_GOAL_MS: String(KEEP_MS),
  [E.STOP_VERIFY_MS]: String(VERIFY_MS),
  [E.IDLE_MS]: "600", [E.IDLE_PING_MS]: "600",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;

bootWait(PORT, 1500, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "goal" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, info = null;
    /** Every turn-flag value the wire carried, in order — the reader's own view
     *  of this session, which is where the lie was visible. The session is born
     *  with no turn, so the arc is read without that leading `false`. */
    const flags = [];
    const arc = () => flags.join(",").replace(/^false,/, "");
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid)) {
        info = m.session;
        const on = m.session.turnActive === true;
        if (flags[flags.length - 1] !== on) flags.push(on);
      }
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(200);
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 40 }));

    const until = async (cond, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(80); }
      return false;
    };
    await until(() => sid);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));
    check(await until(() => info?.hooked === true, 5000), "the hook pipe is live (the exact signal is the one under test)");

    // Submit a prompt: UserPromptSubmit, then a Stop 150 ms later that the loop
    // refuses — while the CLI keeps painting its working line.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "do the thing\r" }));
    check(await until(() => info?.turnActive === true, 4000), "the turn starts on UserPromptSubmit");

    // Well past the first settle pass, and past several more. The old code
    // published `turnActive: false` ~150 ms in.
    await sleep(VERIFY_MS * 3);
    check(info?.turnActive === true, "a Stop the CLI overrides does not end the turn");
    check(arc() === "true", "...and the phone never saw it end: no flicker to publish");

    // The spinner stops, the composer comes back, the real Stop lands.
    check(await until(() => info?.turnActive === false, KEEP_MS + 4000), "the turn ends when the CLI stops working");
    check(arc() === "true,false", "it ended exactly once — the refused Stop was settled, not replayed");

    // And a second turn still works: the settle path is per-Stop state, not a
    // latch that a continuation leaves stuck.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "again\r" }));
    check(await until(() => info?.turnActive === true, 4000), "the next turn starts normally");
    check(await until(() => info?.turnActive === false, KEEP_MS + 4000), "...and ends normally");

    // `/compact`: no hook fires at all. The only thing that says this session is
    // busy is the line it paints, and the old code published `idle` over it.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "/compact\r" }));
    check(await until(() => info?.turnActive === true, 4000), "work no hook announced is published as a turn");
    await sleep(VERIFY_MS * 2);
    check(info?.turnActive === true, "...and holds while the CLI keeps printing it");
    check(await until(() => info?.turnActive === false, KEEP_MS + 4000), "...and is retired when it stops, with no Stop to end it");

    ws.close();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
});
