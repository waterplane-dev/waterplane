// Boots the host daemon, drives one session over WS, asserts the round-trip.
// Portable: uses a throwaway root and creates a repo via the API (no machine paths).
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

// Moved off its old port: the dictation daemon (dictate-private, launchd de.hoh.dictated) holds that one since 2026-10-27.
const PORT = 8793;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-smoke-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");

bootWait(PORT, 800, async () => {
  // HTTP checks
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json());
  console.log("health:", JSON.stringify(health));
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "smoke" }),
  }).then((r) => r.json());
  if (!repo.path) fail("could not create repo");
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());
  console.log("repos discovered:", repos.targets.length);
  if (repos.targets.length === 0) fail("no repos discovered under root");

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let captured = "";
  let sid = null;
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") {
      console.log("welcome tailscaleIp:", m.tailscaleIp);
      ws.send(JSON.stringify({ t: "session.create", cwd: repos.targets[0].worktreePath, cols: 80, rows: 24 }));
    } else if (m.t === "session.created") {
      sid = m.session.id;
      console.log("session created:", sid, m.session.title);
      ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo ROUNDTRIP_$((6*7))\r" }));
      setTimeout(() => ws.send(JSON.stringify({ t: "session.input", id: sid, data: "exit\r" })), 400);
    } else if (m.t === "pty" && m.id === sid) {
      captured += b64(m.dataB64);
    } else if (m.t === "session.exit" && m.id === sid) {
      console.log("session exited code:", m.code);
      if (captured.includes("ROUNDTRIP_42")) {
        console.log("PASS: round-trip stdin→pty→stdout verified");
        host.kill();
        process.exit(0);
      } else {
        fail("expected output not found. captured:\n" + captured.slice(-400));
      }
    }
  });
  ws.on("error", (e) => fail("ws error " + e.message));
});

watchdog(() => fail("timeout"));
