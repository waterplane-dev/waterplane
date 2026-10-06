// Boots the host, asserts session.input delivery receipts (input.ack):
//   - ackId to a LIVE session  → { ok: true }
//   - ackId to a GONE session  → { ok: false }  (so the phone recovers the text)
// Portable: throwaway root, repo via API, <ENV>_CLAUDE_BIN=bash (no real claude).
import { WebSocket } from "ws";
import { bootHost } from "./lib-e2e.mjs";

const { port: PORT, stop } = await bootHost({ tag: "ack" });
const fail = async (m) => { console.error("FAIL:", m); await stop(); process.exit(1); };
setTimeout(() => fail("timeout — no acks"), 8000);

// The settle window the old bootWait(…, 800) gave, kept so the timing is unchanged.
await new Promise((r) => setTimeout(r, 800));
{
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ack" }),
  }).then((r) => r.json());
  if (!repo.path) fail("could not create repo");
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let sid = null;
  const acks = new Map(); // ackId → ok
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") {
      ws.send(JSON.stringify({ t: "session.create", cwd: repos.targets[0].worktreePath, cols: 80, rows: 24 }));
    } else if (m.t === "session.created" && !sid) {
      sid = m.session.id;
      // Give the shell a moment to come up, then fire a good and a bad send.
      setTimeout(() => {
        ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo hi\r", ackId: "good-1" }));
        ws.send(JSON.stringify({ t: "session.input", id: "deadbeef", data: "echo nope\r", ackId: "bad-1" }));
      }, 400);
    } else if (m.t === "input.ack") {
      acks.set(m.ackId, m.ok);
      console.log("ack:", m.ackId, "ok=" + m.ok, m.reason ? `(${m.reason})` : "");
      if (acks.has("good-1") && acks.has("bad-1")) {
        if (acks.get("good-1") !== true) fail("live session ack should be ok:true");
        if (acks.get("bad-1") !== false) fail("gone session ack should be ok:false");
        console.log("PASS: input.ack ok=true for live session, ok=false for gone session");
        await stop();
        process.exit(0);
      }
    }
  });
  ws.on("error", (e) => fail("ws error " + e.message));
}
