// Records the stub `demo` session through a real host with WIRE_RECORD on, and
// returns the path of the JSONL. Shared by e2e-demorecord.mjs and by anyone
// (re)generating a scenario: `node scripts/lib-demorecord.mjs <out.jsonl>`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG } from "./lib-brand.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drive: repo list, create repo, open a session, send a prompt, answer the box. */
export async function recordDemoSession(file, { plant } = {}) {
  const h = await bootHost({
    quiet: true,
    tag: "demorec",
    env: {
      [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
      STUB_MODE: "demo",
      [E.WIRE_RECORD]: file,
    },
  });
  try {
    const post = (p, body) => fetch(h.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const repo = await post("/api/repo", { name: "todo-app" });
    await fetch(h.base + "/api/repos").then((r) => r.json());
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    let sid = null;
    let boxed = false;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && m.session.prompt?.options?.length) boxed = true;
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(300);
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 }));
    const until = async (c, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (c()) return true; await sleep(100); } return false; };
    await until(() => sid);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));
    await sleep(300);
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: plant ? `add sorting ${plant}\r` : "add sorting by due date\r" }));
    await until(() => boxed);
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "1" }));
    await sleep(1200);
    ws.close();
    return { repoPath: repo.path, root: h.root };
  } finally {
    await h.stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] || join(mkdtempSync(join(tmpdir(), `${SLUG}-wire-`)), "wire.jsonl");
  await recordDemoSession(out);
  console.log(out);
}
