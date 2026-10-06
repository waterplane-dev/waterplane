#!/usr/bin/env node
// Opt-in probe (NOT in run-e2e): run the real `claude` against the local Ollama
// for ONE short prompt and record what WP5 needs to know (backends-design §9.5):
//   - what the CLI's own context gauge printed for a non-Anthropic model id
//   - whether the injected hooks reached a sink
//   - whether a jsonl conversation log was written (and its model / usage)
//   - how long the turn took
// Spends nothing (local model). Uses its OWN tmux socket (-L spike_cl) and
// session names `spike_cl_*`; never touches waterplane_*.
//
//   node scripts/probe-claude-local.mjs [model] [scratchDir]
//
// Knobs (env): PROBE_DIR (scratch dir; argv[3] wins; default under os.tmpdir()),
// PROBE_OLLAMA_URL, PROBE_LEAN=1 (append the lean argv the host ships —
// `claudeLocalLeanArgs()` from packages/host/dist, so `npm run build` first),
// PROBE_ARGS (a JSON array of extra claude args, appended after the lean ones),
// PROBE_PROMPT (the one prompt; default asks for the word "pong"). `toolUses`
// lists the tools the turn called, and `firstUsage` is the FIRST request's usage.
// `ollamaLoaded` says whether the model was already resident before the turn
// (measured 2026-10-02: ~3 s of a lean first turn with the file in the page cache).
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PROBE_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const DIR = process.argv[3] || process.env.PROBE_DIR || join(tmpdir(), "probe-claude-local");
const SOCK = "spike_cl";
const NAME = `spike_cl_${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => spawnSync("tmux", ["-L", SOCK, ...a], { encoding: "utf8" });
const screen = () => tmux("capture-pane", "-p", "-t", NAME).stdout ?? "";

const tags = await fetch(`${URL_}/api/tags`).then((r) => r.json()).catch(() => null);
if (!tags) { console.log(`Ollama not reachable at ${URL_}`); process.exit(2); }
const model = process.argv[2] || "qwen3-coder:30b-64k";
if (!tags.models.some((m) => m.name === model)) { console.log(`Ollama has no model ${model}; it has: ${tags.models.map((m) => m.name).join(", ")}`); process.exit(2); }
const show = await fetch(`${URL_}/api/show`, { method: "POST", body: JSON.stringify({ model }) }).then((r) => r.json());
const numCtx = /^num_ctx\s+(\d+)/m.exec(show.parameters ?? "")?.[1] ?? null;
const ctxLen = Object.entries(show.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1] ?? null;

mkdirSync(DIR, { recursive: true });
const events = [];
const sink = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => { try { events.push({ at: Date.now(), ...JSON.parse(b) }); } catch { /* ignore */ } res.end("{}"); });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
const port = sink.address().port;
const h = [{ hooks: [{ type: "command", command: `curl -sS -m 2 -X POST http://127.0.0.1:${port}/api/hook -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true`, timeout: 5 }] }];
const settings = JSON.stringify({ hooks: { SessionStart: h, UserPromptSubmit: h, Stop: h, Notification: h, SessionEnd: h } });

writeFileSync(join(DIR, "hooks.json"), settings); // a file: the hook command holds single quotes
let extra = [];
if (process.env.PROBE_LEAN === "1") {
  const m = await import(new URL("../packages/host/dist/backends/claude-local.js", import.meta.url).href)
    .catch(() => { console.log("PROBE_LEAN=1 needs packages/host/dist (npm run build)"); process.exit(2); });
  extra.push(...m.claudeLocalLeanArgs());
}
if (process.env.PROBE_ARGS) extra.push(...JSON.parse(process.env.PROBE_ARGS));
const q = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
const env = `DISABLE_AUTOUPDATER=1 ANTHROPIC_BASE_URL=${URL_} ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY=`;
const cmd = `cd '${DIR}' && exec env ${env} claude --model '${model}' --settings '${join(DIR, "hooks.json")}' ${extra.map(q).join(" ")}`;
const ps = await fetch(`${URL_}/api/ps`).then((r) => r.json()).catch(() => null);
const ollamaLoaded = ps ? (ps.models ?? []).some((m) => m.name === model) : null;
const r0 = tmux("new-session", "-d", "-s", NAME, "-x", "120", "-y", "40", cmd);
if (r0.status !== 0) { console.log(`tmux refused: ${r0.stderr}`); process.exit(1); }

const out = { model, ollamaUrl: URL_, numCtx, contextLength: ctxLen, extraArgs: extra, ollamaLoaded };
try {
  // boot: answer a trust dialog if one appears, wait for the composer
  const t0 = Date.now();
  for (; Date.now() - t0 < 60000; await sleep(1000)) {
    const s = screen();
    if (/trust/i.test(s) && /1\.\s*Yes/i.test(s)) { tmux("send-keys", "-t", NAME, "Enter"); continue; }
    if (/^❯/m.test(s) || /│ >/.test(s)) break;
  }
  out.bootMs = Date.now() - t0;
  out.bootScreen = screen().split("\n").filter(Boolean).slice(-8);
  tmux("send-keys", "-t", NAME, "-l", process.env.PROBE_PROMPT || "Reply with exactly the one word: pong");
  await sleep(300);
  tmux("send-keys", "-t", NAME, "Enter");
  const t1 = Date.now();
  for (; Date.now() - t1 < 240000; await sleep(1000)) if (events.some((e) => e.hook_event_name === "Stop")) break;
  out.turnMs = Date.now() - t1;
  out.stopSeen = events.some((e) => e.hook_event_name === "Stop");
  await sleep(2500);
  const final = screen();
  out.finalScreen = final.split("\n").filter(Boolean).slice(-14);
  out.gaugeRows = final.split("\n").filter((l) => /context|tokens|%/i.test(l)).map((l) => l.trim());
  out.hookEvents = events.map((e) => e.hook_event_name);
  out.sessionId = events.find((e) => e.session_id)?.session_id ?? null;
  out.transcriptPath = events.find((e) => e.transcript_path)?.transcript_path ?? null;
  const proj = join(homedir(), ".claude", "projects");
  let jsonl = out.transcriptPath && existsSync(out.transcriptPath) ? out.transcriptPath : null;
  if (!jsonl && out.sessionId) for (const d of readdirSync(proj)) { const p = join(proj, d, `${out.sessionId}.jsonl`); if (existsSync(p)) jsonl = p; }
  out.jsonl = jsonl;
  if (jsonl) {
    const rows = readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const asst = rows.filter((r) => r.type === "assistant");
    out.jsonlRows = rows.length;
    out.assistantModels = [...new Set(asst.map((r) => r.message?.model))];
    out.lastUsage = asst.at(-1)?.message?.usage ?? null;
    out.lastText = JSON.stringify(asst.at(-1)?.message?.content ?? null).slice(0, 200);
    out.firstUsage = asst[0]?.message?.usage ?? null;
    out.toolUses = asst.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []).filter((c) => c.type === "tool_use").map((c) => c.name));
    out.jsonlBytes = statSync(jsonl).size;
  }
} finally {
  tmux("kill-session", "-t", NAME);
  tmux("kill-server");
  sink.close();
}
console.log(JSON.stringify(out, null, 2));
