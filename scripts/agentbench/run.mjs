// One benchmark run, driven through a real waterplane host exactly as the phone drives one:
//   node scripts/agentbench/run.mjs --src before --backend copilot --model auto --task ui [--timeout-min 20] [--label before]
// Copies WORK/src-<src> (APFS clone), applies the task's setup, commits it as the baseline,
// boots that copy's host on a free port with its own state/config/tmux, creates ONE session
// with the prompt, answers only a folder-trust box, waits for the turn to end (or the
// timeout), grades, reads the CLI's own log for tool calls, and appends a row to results.jsonl.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS } from "./tasks.mjs";
import { BRAND } from "../../packages/shared/dist/brand.js";
import { E } from "../lib-brand.mjs";

const WORK = process.env.AGENTBENCH_WORK || join(tmpdir(), "agentbench");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SRC = join(WORK, `src-${arg("src", "before")}`);
const BACKEND = arg("backend", "claude");
const MODEL = arg("model", "");
const TASK = arg("task", "ui");
const LABEL = arg("label", arg("src", "before"));
const TIMEOUT = Number(arg("timeout-min", "20")) * 60_000;
const QUIET_MS = Number(arg("quiet-s", "20")) * 1000;
const OLLAMA = arg("ollama", process.env[E.OLLAMA_URL] || "http://127.0.0.1:11434");
// The desktop's own plugin list, unless --plugins names dirs (comma-separated) — e.g. an older copy.
const PLUGINS = arg("plugins", (() => {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".config", BRAND.configDirName, "plugin-paths.json"), "utf8")).paths
      .map((p) => p.replace(/^~/, homedir())).join(",");
  } catch { return ""; }
})());
const task = TASKS[TASK];
if (!task) throw new Error(`unknown task ${TASK}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(WORK, "runs", LABEL, `${BACKEND}-${(MODEL || "default").replace(/[^a-z0-9.-]/gi, "_")}`, `${TASK}-${stamp}`);
mkdirSync(runDir, { recursive: true });
const repo = join(runDir, "repo");
execFileSync("cp", ["-c", "-R", SRC, repo]);
const ctx = task.setup ? task.setup(repo) : {};
execFileSync("git", ["add", "-A"], { cwd: repo });
execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "bench baseline", "--no-verify"], { cwd: repo });
const prompt = typeof task.prompt === "function" ? task.prompt(ctx) : task.prompt;
writeFileSync(join(runDir, "prompt.txt"), prompt);
const repoReal = realpathSync(repo);

const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const PORT = await freePort();
const cfg = join(runDir, "cfg");
mkdirSync(cfg);
writeFileSync(join(cfg, "plugin-paths.json"), JSON.stringify({ paths: PLUGINS ? PLUGINS.split(",") : [] }));
const tmuxDir = mkdtempSync("/tmp/wpb-");
const hostLog = join(runDir, "host.log");
const host = spawn("node", ["packages/host/dist/main.js"], {
  cwd: SRC,
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !(/^(CLAUDE|TMUX|ANTHROPIC_)/.test(k) || k.startsWith(BRAND.envPrefix)))),
    [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1",
    [E.ROOT]: runDir, [E.STATE_DIR]: join(runDir, "state"), [E.CONFIG_DIR]: cfg,
    [E.OLLAMA_URL]: OLLAMA, TMUX_TMPDIR: tmuxDir,
    ...(arg("env") ? Object.fromEntries(arg("env").split(",").map((kv) => kv.split("="))) : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stdout.on("data", (d) => appendFileSync(hostLog, d));
host.stderr.on("data", (d) => appendFileSync(hostLog, d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
for (;;) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch { /* booting */ }
  if (Date.now() - t0 > 30_000) throw new Error("host did not boot; see " + hostLog);
  await sleep(300);
}

const { promptFingerprint } = await import(join(SRC, "packages/shared/dist/index.js"));
const WebSocket = (await import(join(SRC, "node_modules/ws/wrapper.mjs"))).default;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
const send = (m) => ws.send(JSON.stringify(m));
let info = null, sid = null, sawActive = false, quietSince = 0, answered = new Set(), events = [], createAck = null;
const note = (s) => { events.push(`${((Date.now() - tStart) / 1000).toFixed(0)}s ${s}`); };
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if ((m.t === "session.created" || m.t === "session.updated") && (!sid || m.session.id === sid) && m.session.cwd && realpathSync(m.session.cwd) === repoReal) {
    sid = m.session.id; info = m.session;
  }
  if (m.t === "op.ack" && m.ackId === "bench-create") { createAck = m; if (m.ok === false) note(`create refused: ${m.error || JSON.stringify(m)}`); }
});
const tStart = Date.now();
send({
  t: "session.create", cwd: repoReal, cols: 120, rows: 40, ackId: "bench-create", prompt,
  launch: { backend: BACKEND, ...(MODEL ? { model: MODEL } : {}), permissionMode: "bypassPermissions" },
});

let outcome = "timeout", lastActive = null, psTaken = false, copilotTrusted = false;
while (Date.now() - tStart < TIMEOUT) {
  await sleep(1000);
  if (createAck?.ok === false) { outcome = "create-refused"; break; }
  if (!info) continue;
  if (!info.running) { outcome = "exited"; note("session exited"); break; }
  // Copilot's own folder-trust box is never published to the phone: a person answers it at the
  // terminal. Play that person once: Enter on the default "1. Yes".
  if (BACKEND === "copilot" && !copilotTrusted) {
    try {
      const doc = await fetch(`http://127.0.0.1:${PORT}/api/scrollback?id=${sid}`).then((r) => r.json());
      const tail = (doc.lines || []).slice(-40).map((l) => (typeof l === "string" ? l : l.text ?? "")).join("\n");
      if (/Do you trust the files in this folder\?/.test(tail) && /1\. Yes/.test(tail)) {
        const sock = readdirSync(join(tmuxDir, `tmux-${process.getuid()}`))[0];
        const tenv = { ...process.env, TMUX_TMPDIR: tmuxDir, TMUX: "" };
        const target = execFileSync("tmux", ["-L", sock, "ls", "-F", "#{session_name}"], { env: tenv, encoding: "utf8" }).trim().split("\n")[0];
        execFileSync("tmux", ["-L", sock, "send-keys", "-t", target, "Enter"], { env: tenv });
        copilotTrusted = true; note("copilot trust box: Enter at the terminal (the person's answer)");
      }
    } catch (e) { /* try again next second */ }
  }
  const p = info.prompt;
  if (p) {
    const fp = promptFingerprint(p);
    if (!answered.has(fp)) {
      answered.add(fp);
      note(`box ${p.kind}: ${String(p.question || "").slice(0, 100)} [${(p.options || []).map((o) => o.label).join(" | ").slice(0, 120)}]`);
      if (p.kind === "tool") { // a trust box is the host's own to accept
        send({ t: "session.input", id: sid, data: "1", expectPrompt: fp, ackId: `bench-box-${answered.size}` });
        note(`answered 1 (${p.kind})`);
      }
    }
    if (p.kind === "question" || p.kind === "select" || p.kind === "plan") { outcome = "asked-person"; note("agent asked the person; stopping"); break; }
  }
  if (info.turnActive !== lastActive) { note(`turnActive=${info.turnActive} idle=${info.idle} hooked=${info.hooked}`); lastActive = info.turnActive; }
  if (info.turnActive && Date.now() - tStart > 8000) { sawActive = true; quietSince = 0; continue; }
  if (sawActive && !psTaken) { psTaken = true; try { writeFileSync(join(runDir, "ps.txt"), execFileSync("ps", ["-axo", "pid,args"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(repoReal) || ["copilot", "claude --", BACKEND].some((w) => l.includes(w))).join("\n")); } catch { /* optional */ } }
  const boxOpen = p && !answered.has(promptFingerprint(p));
  if (sawActive && info.idle !== false && !boxOpen) {
    quietSince ||= Date.now();
    if (Date.now() - quietSince >= QUIET_MS) { outcome = "finished"; break; }
  } else quietSince = 0;
}
const wallS = Math.round((Date.now() - tStart - (outcome === "finished" ? QUIET_MS : 0)) / 1000);

// The screen at the end, for "where it went wrong".
try {
  const doc = await fetch(`http://127.0.0.1:${PORT}/api/scrollback?id=${sid}`).then((r) => r.json());
  writeFileSync(join(runDir, "screen.txt"), (doc.lines || []).map((l) => (typeof l === "string" ? l : l.text ?? JSON.stringify(l))).join("\n"));
} catch { /* optional */ }
if (sid) send({ t: "session.kill", id: sid });
await sleep(1500);
ws.close();
host.kill();
await sleep(500);
try { execFileSync("tmux", ["kill-server"], { env: { ...process.env, TMUX_TMPDIR: tmuxDir, TMUX: "" }, stdio: "ignore" }); } catch { /* none */ }
rmSync(tmuxDir, { recursive: true, force: true });

// What the CLI itself logged: tool calls, model requests, last words.
function claudeStats() {
  const dir = join(homedir(), ".claude/projects", repoReal.replace(/[^a-zA-Z0-9]/g, "-"));
  if (!existsSync(dir)) return { note: "no claude log" };
  let tools = 0, requests = new Set(), last = "", lastIn = 0, toolNames = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== "assistant") continue;
      if (j.requestId) requests.add(j.requestId); else if (j.message?.id) requests.add(j.message.id);
      const u = j.message?.usage; if (u) lastIn = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      for (const b of j.message?.content || []) {
        if (b.type === "tool_use") { tools++; toolNames[b.name] = (toolNames[b.name] || 0) + 1; }
        if (b.type === "text" && b.text.trim()) last = b.text.trim();
      }
    }
  }
  return { tools, toolNames, requests: requests.size, lastContextTok: lastIn, lastWords: last.slice(-600), log: dir };
}
function copilotStats() {
  const root = join(homedir(), ".copilot/session-state");
  for (const id of readdirSync(root)) {
    const ws = join(root, id, "workspace.yaml");
    if (!existsSync(ws) || !readFileSync(ws, "utf8").includes(`cwd: ${repoReal}`)) continue;
    const ev = join(root, id, "events.jsonl");
    if (!existsSync(ev)) continue;
    let tools = 0, turns = 0, last = "", models = new Set(), toolNames = {}, skills = [];
    for (const line of readFileSync(ev, "utf8").split("\n")) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type === "tool.execution_start") { tools++; toolNames[j.data.toolName] = (toolNames[j.data.toolName] || 0) + 1; if (j.data.model) models.add(j.data.model); if (j.data.toolName === "skill") skills.push(j.data.arguments?.skill); }
      if (j.type === "assistant.turn_start") turns++;
      if (j.type === "assistant.message" && typeof j.data?.content === "string" && j.data.content.trim()) last = j.data.content.trim();
    }
    return { tools, toolNames, requests: turns, models: [...models], skills, lastWords: last.slice(-600), log: ev };
  }
  return { note: "no copilot log" };
}
const stats = BACKEND === "copilot" ? copilotStats() : claudeStats();
let grade;
try { grade = task.grade(repo); } catch (e) { grade = { score: 0, pass: false, notes: [`grader threw: ${e.message}`] }; }
const diffStat = execFileSync("git", ["diff", "--stat", "HEAD"], { cwd: repo, encoding: "utf8" }).trim().split("\n").slice(-1)[0] || "(no diff)";
writeFileSync(join(runDir, "diff.patch"), execFileSync("git", ["diff", "HEAD"], { cwd: repo, encoding: "utf8" }));
const row = {
  label: LABEL, backend: BACKEND, model: MODEL || "default", task: TASK, outcome, wallS, ...grade, diffStat,
  told: info?.told, stats, events, runDir, at: new Date().toISOString(),
};
appendFileSync(join(WORK, "results.jsonl"), JSON.stringify(row) + "\n");
console.log(JSON.stringify({ ...row, events: events.slice(-12) }, null, 1));
process.exit(0);
