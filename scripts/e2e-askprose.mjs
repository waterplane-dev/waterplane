// A turn that ENDS ON A QUESTION is published as one — with no oracle key.
//
// The commonest way work stops here is not a dialog: the agent finishes a turn
// with "Want 2 implemented, or leave it at 1?" and sits at its composer. The
// CLI is not blocked, so `prompt` and `awaitingInput` are both empty and the
// session read `done` — a finished turn, nothing owed.
//
// The heuristic that spots it already existed, inside the retired in-core oracle, where it
// gated a Gemini call. That made the whole detection conditional on a
// third-party API key: with `GEMINI_API_KEY` unset — the ordinary case, and the
// case this script runs in — the tail was never even looked at.
//
// Pinned here: the fact reaches the WIRE (`session.asking`), it carries the
// question's own words, and typing retires it.
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

const PORT = 8836;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-askprose-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.IDLE_MS]: "700", [E.IDLE_PING_MS]: "700",
  GEMINI_API_KEY: "", // the point: no oracle on duty
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

bootWait(PORT, 900, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ask" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, info = null;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") sid = m.session.id;
      if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid)) info = m.session;
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(200);
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 }));

    const until = async (cond, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); }
      return false;
    };
    await until(() => sid);

    // An ordinary finished turn owes nothing.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo 'Build OK, edits compile.'\r" }));
    await until(() => info?.idle, 6000);
    check(!info?.asking, "a turn that ends on plain output is not a question");

    // …and one that ends on a question says so.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo 'Want 2 implemented, or leave it at 1?'\r" }));
    const asked = await until(() => !!info?.asking, 6000);
    check(asked, "a turn ending on a question publishes `asking` with no oracle key");
    check(/Want 2 implemented/.test(info?.asking?.text ?? ""), `the agent's own words ride on it (got ${JSON.stringify(info?.asking?.text)})`);
    check(!info?.prompt && !info?.awaitingInput, "it is NOT a dialog — nothing is blocked in the CLI");
    const at = info?.asking?.at;

    // Re-idling on the same unanswered question must not restart its clock:
    // "asked 0s ago" forever is the same lie as not asking at all.
    await sleep(1200);
    check(info?.asking?.at === at, "the clock is the question's, not the last repaint's");

    // An acknowledgement that names the WRONG question is refused: a tap on a
    // badge read a minute ago must not silence whatever replaced it.
    ws.send(JSON.stringify({ t: "session.ackAsking", id: sid, text: "something else entirely?" }));
    await sleep(600);
    check(!!info?.asking, "an ack naming a different question leaves the badge up");

    // "I dealt with it elsewhere." Types nothing, and must STICK: the tail
    // still ends on the question and is re-read on every re-idle, so a plain
    // clear would last about a second.
    ws.send(JSON.stringify({ t: "session.ackAsking", id: sid, text: info.asking.text }));
    const acked = await until(() => !info?.asking, 4000);
    check(acked, "acknowledging retires the question without typing");
    await sleep(1500);
    check(!info?.asking, "and it stays retired across re-idles — the tail has not changed");

    // A DIFFERENT question is a different decision and raises the badge again.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo 'Ship it now, or wait for review?'\r" }));
    const again = await until(() => !!info?.asking, 6000);
    check(again, "a new question after an acknowledgement is published normally");
    check(/Ship it now/.test(info?.asking?.text ?? ""), `and carries its own words (got ${JSON.stringify(info?.asking?.text)})`);

    // Typing is the answer. The fact retires on the keystroke, not on a re-scan.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "1\r" }));
    const cleared = await until(() => !info?.asking, 6000);
    check(cleared, "typing a reply retires the question");

    ws.close();
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  }
});
