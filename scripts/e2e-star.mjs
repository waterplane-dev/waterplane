// Prima-interest star + "new since you left" annotation:
//  - session.star toggles SessionInfo.starred and round-trips via session.updated
//  - the star persists to <root>/<state>/stars.json (durable, keyed by conversation id)
//  - a turn ending while UNWATCHED sets newActivity; attaching clears it
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8799;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-star-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_MS]: "600", [E.IDLE_PING_MS]: "400" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const starsFile = () => { const p = join(ROOT, STATE, "stars.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : []; };

bootWait(PORT, 800, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let sid = null, cid = null;
  const latest = new Map(); // id → newest SessionInfo
  const cur = () => latest.get(sid) || {};
  try {
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") { sid = m.session.id; cid = m.session.claudeSessionId; latest.set(sid, m.session); }
      if (m.t === "session.updated") latest.set(m.session.id, m.session);
    });

    const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "star" }) }).then((r) => r.json());
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 }));
    // wait for creation
    for (let i = 0; i < 40 && !sid; i++) await sleep(100);
    check(!!sid, "session created");

    // Star it (creator is auto-attached, i.e. watching).
    ws.send(JSON.stringify({ t: "session.star", id: sid, starred: true }));
    await sleep(300);
    check(cur().starred === true, "session.star → starred=true round-trips");
    check(starsFile().includes(cid) || starsFile().includes(sid), "star persisted to <state>/stars.json");

    // "Leave" (unwatch, session keeps running), then a turn finishes → newActivity.
    ws.send(JSON.stringify({ t: "session.detach", id: sid }));
    await sleep(150);
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo hi\r" }));
    await sleep(1000);
    check(cur().newActivity === true, "turn finished while unwatched → newActivity flagged");

    // Come back (attach) → we've now seen it → newActivity clears.
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));
    await sleep(400);
    check(cur().newActivity === false, "attaching clears newActivity (seen)");
    check(cur().starred === true, "star survives attach");

    // Unstar.
    ws.send(JSON.stringify({ t: "session.star", id: sid, starred: false }));
    await sleep(300);
    check(cur().starred === false, "session.star → starred=false round-trips");
    check(!starsFile().includes(cid) && !starsFile().includes(sid), "unstar removed from <state>/stars.json");

    ws.close();
  } catch (e) {
    console.log("FAIL: threw", e); failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  }
});
