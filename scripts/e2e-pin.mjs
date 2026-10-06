// Overview labels (first / last prompt) + pinning:
//  - recording prompts populates SessionInfo.firstPrompt / lastPrompt (first stays,
//    last tracks the newest) — the phone shows "first … last" as the session gist
//  - session.pin sets pinnedPrompt/pinnedEntryId to a chosen history entry, so the
//    "last" slot can show something meaningful instead of a bare "yes"
//  - the pin persists to <root>/<state>/pins.json and clears on entryId:null
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8798;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-pin-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_MS]: "600", [E.IDLE_PING_MS]: "400" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pinsFile = () => { const p = join(ROOT, STATE, "pins.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; };

bootWait(PORT, 800, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let sid = null;
  const latest = new Map(); // id → newest SessionInfo
  let entries = [];         // newest history for sid
  const cur = () => latest.get(sid) || {};
  try {
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") { sid = m.session.id; latest.set(sid, m.session); }
      if (m.t === "session.updated") latest.set(m.session.id, m.session);
      if (m.t === "session.history" && m.id === sid) entries = m.entries;
    });

    const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "pin" }) }).then((r) => r.json());
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 }));
    for (let i = 0; i < 40 && !sid; i++) await sleep(100);
    check(!!sid, "session created");

    // Record a first and a last prompt (the "last" is a useless bare "yes").
    ws.send(JSON.stringify({ t: "session.record", id: sid, text: "add a dark mode toggle to settings", kind: "prompt" }));
    await sleep(150);
    ws.send(JSON.stringify({ t: "session.record", id: sid, text: "yes", kind: "prompt" }));
    await sleep(300);
    check(cur().firstPrompt === "add a dark mode toggle to settings", "firstPrompt = first recorded prompt");
    check(cur().lastPrompt === "yes", "lastPrompt tracks the newest prompt");

    // Grab the history so we know the first entry's id, then pin it.
    ws.send(JSON.stringify({ t: "session.history", id: sid }));
    for (let i = 0; i < 20 && entries.length < 2; i++) await sleep(100);
    check(entries.length === 2, "history has both recorded prompts");
    const firstId = entries[0].id;
    ws.send(JSON.stringify({ t: "session.pin", id: sid, entryId: firstId }));
    await sleep(300);
    check(cur().pinnedEntryId === firstId, "session.pin → pinnedEntryId round-trips");
    check(cur().pinnedPrompt === "add a dark mode toggle to settings", "pinnedPrompt = pinned entry text (overrides the 'yes')");
    check(pinsFile()[sid] === firstId, "pin persisted to <state>/pins.json");

    // Recording another prompt must not disturb the pin.
    ws.send(JSON.stringify({ t: "session.record", id: sid, text: "go", kind: "prompt" }));
    await sleep(300);
    check(cur().lastPrompt === "go", "lastPrompt advances");
    check(cur().pinnedPrompt === "add a dark mode toggle to settings", "pin survives a new prompt");

    // Clear the pin.
    ws.send(JSON.stringify({ t: "session.pin", id: sid, entryId: null }));
    await sleep(300);
    check(cur().pinnedEntryId === undefined && cur().pinnedPrompt === undefined, "session.pin null → pin cleared");
    check(pinsFile()[sid] === undefined, "cleared pin removed from <state>/pins.json");

    ws.close();
  } catch (e) {
    console.log("FAIL: threw", e); failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  }
});
