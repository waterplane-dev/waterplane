// A REPAINT after a resume is not a new wall.
//
// Once a continue has been typed, only banner text AFTER its echo counts as a
// block. The old banner stays on screen above the echo, and a repaint draws it
// again: tmux redraws every pane on a resize and a re-attach (and, until the
// host answered its terminal queries, ~5 s after a client started — `termqueries.ts`).
// Read off the BYTE stream,
// that redrawn banner came after everything else and re-blocked a session that
// had just resumed — the block cleared, the resize, and the session was "at
// limit" again with attempts reset to 0, its next continue a minute away. It
// matters exactly where the conversation log cannot outrank the screen
// (`unknown`), which is the stub's case here: no log at all.
//
// Asserted, in order: blocked at boot; resumed by one continue; after a resize
// (a full tmux redraw with the old banner still on screen) and an idle pass it
// is STILL not blocked, and nothing typed a second continue. Then the mirror
// case: a GENUINE second wall, printed below that old continue echo, blocks the
// session again with its attempt count back at 0 — the leftover `attempts > 0`
// (kept after a clear so the repaint rule holds) must not make the post-echo
// scan ignore a real wall, and the new block must not inherit the old count.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait, freePort } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = await freePort();
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-limitrepaint-`));
const env = {
  ...process.env, [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-limit.mjs",
  STUB_LIMIT_OK: "1",
  STUB_LIMIT_WALL: "1",
  [E.IDLE_PING_MS]: "700",
  [E.LIMIT_RETRY_MS]: "600000",   // no automatic attempt: the one continue is the test's
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); } return false; };

bootWait(PORT, 800, async () => {
  try {
    const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "wall" }),
    }).then((r) => r.json());
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const send = (m) => ws.send(JSON.stringify(m));
    let sid = null, lim = null, settled = false, lastPty = 0;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") { sid = m.session.id; send({ t: "session.attach", id: sid }); }
      if (m.t === "session.updated" && m.session.id === sid && m.session.limit) lim = m.session.limit;
      if (m.t === "pty" && m.id === sid) {
        lastPty = Date.now();
        // The client's post-timeout redraw: the resume must not land on it (`e2e-limitparallel.mjs`).
        if (Buffer.from(m.dataB64, "base64").toString("utf8").includes("\x1b[?1004h")) settled = true;
      }
    });
    await new Promise((r) => ws.on("open", r));
    send({ t: "hello", protocol: 1 });
    await sleep(200);
    send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30 });

    check(await until(() => lim?.blocked === true), "the session is blocked at boot");
    check(await until(() => settled && Date.now() - lastPty > 1000), "…and its tmux client has settled");
    send({ t: "limit.resume" });
    check(await until(() => lim && !lim.blocked && lim.attempts === 1), `one continue resumes it (attempts ${lim?.attempts})`);

    // The repaint: a resize makes tmux redraw the whole pane, old banner included.
    send({ t: "session.resize", id: sid, cols: 90, rows: 28 });
    await sleep(400);
    send({ t: "session.resize", id: sid, cols: 100, rows: 30 });
    await sleep(3000); // several idle passes (IDLE_PING_MS 700) — each one asks checkLimit
    check(lim && !lim.blocked, `a repaint after the resume is NOT a new wall (blocked ${lim?.blocked}, attempts ${lim?.attempts})`);
    check(lim?.attempts === 1, `…and the attempt count is the one continue, not reset by a re-block (got ${lim?.attempts})`);

    // A new prompt that hits the limit for real: its banner lands BELOW the old echo.
    send({ t: "session.input", id: sid, data: "next wall\r" });
    check(await until(() => lim?.blocked === true), `a real second wall after the resume blocks again (blocked ${lim?.blocked})`);
    check(lim?.attempts === 0, `…as a NEW block, its attempt count back at 0 (got ${lim?.attempts})`);
    ws.close();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
});
