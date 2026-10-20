// Verifies backlog auto-fire: queued item → a session opened FOR it → done.
//
// The session used to be the repo's one shared `backlog · <repo>` conversation,
// which every item that repo ever queued was appended to. It is one per item now
// (`sessioncost.ts`, and the 124-conversations-are-76%-of-the-tokens measurement
// in CLAUDE.md) — so the PTY here is captured off `session.created` rather than
// off the item going running: the executor awaits its own delivery now, and by
// the time the row says `running` the words have already been typed.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8795;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-bl-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_MS]: "1500" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

bootWait(PORT, 900, async () => {
  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "auto" }) }).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let phase = 0;
  let sid = null;
  let gateRepo = null;
  let pty = "";
  const seenSessions = new Set();
  const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    // Attach to every session the host opens, the instant it opens: the item's
    // own session is created and typed into inside one `starting` state.
    if (m.t === "session.created" && !seenSessions.has(m.session.id)) {
      seenSessions.add(m.session.id);
      ws.send(JSON.stringify({ t: "session.attach", id: m.session.id }));
      return;
    }
    if (m.t === "pty") { pty += b64(m.dataB64); return; }
    if (m.t !== "backlog.list") return;
    if (phase === 0) {
      phase = 1;
      // Nothing needs opening first: auto-fire opens a session for the item.
      ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true }));
      ws.send(JSON.stringify({ t: "backlog.add", text: "echo BL_FIRE_$((6*7))", repoDir: repo.path, label: "auto task" }));
    } else {
      const it = m.items[0];
      // Same beat as phase 5 below: the row is written `starting` BEFORE the
      // executor runs, so its session is named on the broadcast after that one.
      if (it && it.status === "running" && it.sessionId && phase === 1) {
        phase = 2;
        sid = it.sessionId;
        check(!!it.sessionId, "item got a session opened FOR it, named on the row while it runs");
      } else if (it && it.status === "done" && phase === 2) {
        phase = 3;
        check(true, "item advanced to done on idle");
        check(pty.includes("BL_FIRE_42"), `fire fed text into session (captured: ${JSON.stringify(pty.slice(-200))})`);
        ws.send(JSON.stringify({ t: "backlog.archive", id: it.id, archived: true }));
      } else if (phase === 3) {
        const it3 = m.items[0];
        check(!!it3 && it3.archived === true, "item marked archived (still present, not deleted)");
        phase = 4;
        ws.send(JSON.stringify({ t: "backlog.archive", id: it3.id, archived: false }));
      } else if (phase === 4) {
        const it4 = m.items.find((i) => i.repoDir === repo.path);
        check(!!it4 && !it4.archived, "item unarchived");
        // Storage is the ONE intent store now — `<root>/<state>/intents.json`,
        // written tmp+rename. The per-repo `backlog.json` it replaces was a bare
        // writeFileSync, and it was one of six places a piece of deferred work
        // could be. A repo never grows one again.
        check(existsSync(join(ROOT, STATE, "intents.json")), "items are rows in the host's one intent store");
        check(!existsSync(join(repo.path, STATE, "backlog.json")), "no per-repo backlog.json is written any more");
        check(!existsSync(join(ROOT, STATE, "backlog.json")), "no global backlog.json at root");
        // A second repo, nothing open in it. This used to be a dead end — the
        // fire failed with "no open session" and the row sat there for ever,
        // which is how forty of them piled up. Firing opens a session for the
        // item now (bounded by `<ENV>_BACKLOG_SESSIONS`, never the one you opened
        // by hand). Add+fire in a fresh repo and expect it to RUN.
        phase = 5;
        fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "nosession" }) })
          .then((r) => r.json())
          .then((r2) => { gateRepo = r2.path; ws.send(JSON.stringify({ t: "backlog.add", text: "echo NOPE", repoDir: gateRepo, label: "gate task", fire: true })); });
      } else if (phase === 5) {
        const g = m.items.find((i) => i.repoDir === gateRepo);
        // `sessionId` lands a beat after the row goes `starting` — the store
        // persists `starting` BEFORE the executor, which is the rule that stops
        // a crash leaving two agents in one worktree, so for one broadcast the
        // row is in flight with nothing to name yet. Assert on the settled shape.
        if (g && g.sessionId && (g.status === "running" || g.status === "done")) {
          phase = 6;
          check(!!g.sessionId, `an item in a repo with nothing open got a session of its own (session: ${JSON.stringify(g.sessionId)})`);
          check(g.status !== "failed", "…and the item ran rather than dying on the missing session");
          ws.close();
          host.kill();
          setTimeout(() => process.exit(failed ? 1 : 0), 100);
        }
      }
    }
  });
});

watchdog(() => { console.log("FAIL: timeout (auto-fire didn't complete)"); host.kill(); process.exit(1); });
