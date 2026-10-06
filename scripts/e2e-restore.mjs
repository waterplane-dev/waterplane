import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
const PORT = 8813;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-r-`));
// Stub `claude` that prints its args then blocks. Asserts that SEVERAL
// conversations in the SAME repo survive a host restart individually: each
// fresh session gets its own minted claude session id (--session-id), the
// recent list keeps one entry per conversation (not per cwd), and after a
// restart each entry resumes exactly its own conversation (--resume <id>).
const STUB = join(ROOT, "echoargs.sh");
writeFileSync(STUB, "#!/bin/bash\necho \"ARGS:$@\"\nread x\n");
chmodSync(STUB, 0o755);
const env = { ...process.env, [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: STUB, [E.PREFLIGHT]: "0" };
const base = `http://127.0.0.1:${PORT}`;
let failed = false; const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
const startHost = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return h;
};
let host = startHost();
const finish = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

bootWait(PORT, 900, async () => {
  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "r" }) }).then((r) => r.json());

  // ── Phase 1: two sessions in the same repo, then kill the host ──
  const ids = [];
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let checked = false;
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
    ws.on("message", (raw) => { const m = JSON.parse(raw.toString());
      if (m.t === "welcome") ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "one", cols: 80, rows: 24, launch: { model: "opus" } }));
      else if (m.t === "session.created" && ids.length === 0) { ids.push(m.session.claudeSessionId);
        ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "two", cols: 80, rows: 24, launch: { model: "sonnet" } })); }
      else if (m.t === "session.created" && ids.length === 1) { ids.push(m.session.claudeSessionId);
        check(ids[0] && ids[1] && ids[0] !== ids[1], `two same-repo sessions got distinct claude ids: ${ids[0]} / ${ids[1]}`); }
      else if (m.t === "recent.list" && ids.length === 2 && !checked) { checked = true;
        const mine = m.recent.filter((r) => r.cwd === repo.path);
        check(mine.length === 2, `recent list keeps BOTH same-repo conversations (got ${mine.length})`);
        check(new Set(mine.map((r) => r.claudeSessionId)).size === 2, "recent entries carry distinct claudeSessionIds");
        check(mine.every((r) => r.launch?.model), "recent entries remember launch flags");
        ws.close(); resolve(); }
    });
  });
  host.kill();
  await new Promise((r) => host.once("exit", r));
  await new Promise((r) => setTimeout(r, 800)); // let the port free

  // ── Phase 2: fresh host, resume EACH conversation from the recent list ──
  host = startHost();
  await new Promise((r) => setTimeout(r, 900));
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let target = null, rid = null, cap = "";
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
    ws.on("message", (raw) => { const m = JSON.parse(raw.toString());
      if (m.t === "recent.list" && !target) {
        const mine = m.recent.filter((r) => r.cwd === repo.path);
        check(mine.length === 2, `recent list survives restart with both conversations (got ${mine.length})`);
        target = mine.find((r) => r.title === "one"); // the OLDER one — --continue could never reach it
        check(!!target?.claudeSessionId, "restart-surviving entry still has its claudeSessionId");
        ws.send(JSON.stringify({ t: "session.create", cwd: target.cwd, title: target.title, resume: true, resumeSessionId: target.claudeSessionId, cols: 80, rows: 24, launch: target.launch })); }
      else if (m.t === "session.created" && target) { rid = m.session.id;
        check(m.session.claudeSessionId === target.claudeSessionId, "restored session adopts the requested conversation id");
        check(m.session.model === "opus", "restored session keeps its remembered launch flags"); }
      else if (m.t === "pty" && m.id === rid) { cap += b64(m.dataB64);
        if (cap.includes("ARGS:")) { const line = cap.split("\n").find((l) => l.includes("ARGS:"));
          check(new RegExp(`--resume ${target.claudeSessionId}`).test(line), "restore launches --resume <exact id>: " + line.trim());
          check(!/--continue/.test(line), "restore does NOT fall back to per-directory --continue");
          ws.close(); resolve(); } }
    });
  });
  finish();
});
setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 25000);
