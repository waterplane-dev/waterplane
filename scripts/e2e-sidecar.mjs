// The tab name (the one unattended call left) bought from a LOCAL model instead
// of from Anthropic — end to end, through a real daemon.
//
// `nameTab` runs once per session, off the session's FIRST PROMPT only, and
// goes through the same sidecar engine axis the retired per-turn summary did.
// The three things that could go wrong are each a way a person would be worse
// off than before:
//
//   1. the name is obtained from the LOCAL server and nothing else — the name
//      on the session is the one the server returned, so it demonstrably did
//      not come from `claude` (a call the account paid for)
//   2. the request is toolless and carries the first prompt — the only shape a
//      no-tools completion can answer at all, and the reason this task may be
//      routed here
//   3. a local model that returns NOTHING (the measured reasoning-model case:
//      the whole budget spent on thinking, `content` empty) leaves the tab
//      without a name. No name is the existing contract.
//
// Plus the misconfiguration: a spec that cannot be parsed must produce NO name
// and say so — never a silent fall back to claude, since stopping that call is
// the only reason anyone sets the variable.
//
// The server here is a ten-line Node stub speaking /chat/completions, so this
// needs no ollama, no model download and no GPU in CI.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8816;
const PORT_BAD = 8817;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-sidecar-`));
const MODEL = "gemma4:e4b"; // the colon in the tag is the parse this pins

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The stand-in for ollama ─────────────────────────────────────────────────
// `mode` is flipped from the script: "quiet" is the reasoning model that spent
// its budget thinking and returned an empty content, "speaks" is a normal one.
let mode = "quiet";
const SENTENCE = "widget build loop";
const seen = [];
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* recorded as null — that is a failure too */ }
    seen.push({ url: req.url, body });
    const message = mode === "quiet"
      ? { role: "assistant", content: "", reasoning_content: "Okay, the user wants one sentence. Let me think about" }
      : { role: "assistant", content: SENTENCE };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "stub", object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }] }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${stub.address().port}/v1`;

const envFor = (port, spec) => ({
  ...process.env,
  // e2e must never touch the shared tmux server, and the boot doctor must not
  // print into output the script reads.
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(port), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  // A turn "ends" on silence here (the bash stub fires no hooks), and the
  // name is triggered off that. Short, so the script is not mostly waiting.
  [E.IDLE_PING_MS]: "600",
  [E.SIDECAR_SUMMARY]: spec,
});

let host = null;
let hostErr = "";
function boot(port, spec) {
  host = spawn("node", ["packages/host/dist/main.js"], { env: envFor(port, spec), stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.on("data", () => {});
  host.stderr.on("data", (d) => { hostErr += d; process.stderr.write("[host] " + d); });
}

/** Open a session in `cwd`, send it a first prompt, and
 *  report the tab names seen on the wire for it. */
function driveSession(port, cwd, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const summaries = [];
    let sid = null;
    const finish = () => { try { ws.close(); } catch { /* already gone */ } resolve(summaries); };
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "welcome") {
        ws.send(JSON.stringify({ t: "session.create", cwd, cols: 80, rows: 24 }));
      } else if (m.t === "session.created") {
        sid = m.session.id;
        // The first prompt is the ONLY thing the naming call is shown.
        const prompt = `${label}: build the widget and print ten progress lines`;
        ws.send(JSON.stringify({ t: "session.record", id: sid, text: prompt, kind: "prompt" }));
        ws.send(JSON.stringify({ t: "session.input", id: sid, data: `for i in 1 2 3 4 5 6 7 8 9 10; do echo "${label} line $i — building the widget"; done\r` }));
        // Long enough for: the loop to print, the idle ping to fire, and one
        // completion to come back off the stub.
        setTimeout(finish, 6000);
      } else if (m.t === "session.updated" && m.session.id === sid) {
        if (m.session.tabTitle) summaries.push(m.session.tabTitle);
      }
    });
  });
}

const die = (m) => { console.log("FAIL: " + m); if (host) host.kill(); stub.close(); process.exit(1); };
watchdog(() => die("timeout"), 90_000);

try {
  // ── A host routed at the local server ─────────────────────────────────────
  boot(PORT, `openai-compat:${BASE}|${MODEL}`);
  await bootWait(PORT, 900, async () => {});
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "sidecar" }),
  }).then((r) => r.json());
  if (!repo.path) die("could not create repo");

  // 3. The model that thought and said nothing: the tab stays unnamed.
  const quiet = await driveSession(PORT, repo.path, "quiet");
  check(quiet.length === 0, `an empty completion publishes no name (saw ${JSON.stringify(quiet)})`);
  check(seen.length > 0, "the local server was asked, even though it answered with nothing");

  // 2. What was asked for, exactly.
  const req = seen[0];
  check(req.url === "/v1/chat/completions", `the route is the OpenAI one (${req.url})`);
  check(req.body && req.body.model === MODEL, `the model tag survives its colon (${req.body && req.body.model})`);
  check(req.body && req.body.tools === undefined, "no tools are offered — this task is toolless by contract");
  check(!!req.body && Array.isArray(req.body.messages) && req.body.messages.some((m) => m.role === "user" && m.content.includes("quiet: build the widget")),
    "the first prompt travels IN the request, which is why a toolless engine can answer at all");

  // 1. A model that speaks: the name on the session is the LOCAL one.
  mode = "speaks";
  const spoke = await driveSession(PORT, repo.path, "loud");
  check(spoke.includes(SENTENCE), `the tab name on the session is the local server's answer (saw ${JSON.stringify(spoke)})`);

  host.kill();
  await sleep(400);

  // ── A misrouted host: no name, and a sentence saying why ──────────────
  // `openai-compat:<url>` with no model cannot be completed by guessing, and
  // falling back to claude would spend the tokens the knob exists to save.
  hostErr = "";
  const before = seen.length;
  boot(PORT_BAD, `openai-compat:${BASE}`);
  await bootWait(PORT_BAD, 900, async () => {});
  const bad = await driveSession(PORT_BAD, repo.path, "misrouted");
  check(bad.length === 0, `a spec that cannot be parsed publishes no name (saw ${JSON.stringify(bad)})`);
  check(seen.length === before, "and nothing was sent to the server either");
  check(/\[sidecar\]/.test(hostErr) && hostErr.includes(E.SIDECAR_SUMMARY),
    "the host says which variable is wrong, once, instead of failing silently");
} catch (e) {
  console.log("FAIL: threw", e);
  failed = true;
}

if (host) host.kill();
stub.close();
setTimeout(() => process.exit(failed ? 1 : 0), 150);
