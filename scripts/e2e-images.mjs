// New-image detection: a file appearing in a session's worktree during a turn
// is broadcast as session.images (and would push-notify). Uses bash as the
// fake `claude` so we can drive PTY output to trigger idle/turn-finished scans.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8796;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-img-`));
const env = {
  ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_PING_MS]: "700",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

bootWait(PORT, 900, async () => {
  try {
    const repo = await j("/api/repo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "demo" }) });
    check(!!repo.path, "repo created");

    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      let id = null;
      let wrote = false;
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "session.created" && !id) {
          id = m.session.id;
          ws.send(JSON.stringify({ t: "session.attach", id }));
          // First turn settles (baseline snapshot taken at create). After a beat,
          // drop a new png into the repo, then nudge the shell so a fresh idle fires.
          setTimeout(() => {
            writeFileSync(join(repo.path, "result.png"), Buffer.from("89504e470d0a1a0a", "hex"));
            wrote = true;
            ws.send(JSON.stringify({ t: "session.input", id, data: "echo done\r" }));
          }, 1200);
        } else if (m.t === "session.images" && wrote) {
          check(m.id === id && m.images.some((i) => i.name === "result.png"), "session.images reports the new png");
          check(typeof m.repoId === "string" && m.repoId.length > 0, "session.images carries repoId for artifact url");
          ws.close();
          resolve();
        }
      });
      ws.on("error", () => resolve());
      // start a session in the repo
      setTimeout(() => ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 30 })), 200);
      setTimeout(resolve, 8000);
    });
    check(!failed, "image flow completed");
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  done();
});

setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 15000);
