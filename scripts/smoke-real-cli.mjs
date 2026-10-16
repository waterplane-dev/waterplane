#!/usr/bin/env node
// Opt-in smoke (NOT in run-e2e): the daemon driving the REAL `claude` binary,
// end to end, for the things a CLI release can break that the stub TUI never
// will — every other e2e runs `claude-stub-tui.mjs`, so a new CLI version that
// moves a box, renames a flag or reshapes its log passes `npm test` unchanged.
//
// One Haiku session in a fresh repo, checked step by step:
//   boot     the real binary starts under our flags (--settings, --plugin-dir)
//   version  the session reports a cliVersion
//   trust    the folder-trust box is DETECTED (prompt.ts) and answered by tap
//   tool     a Bash permission box is detected and answered by tap
//   turn     the command's output reaches the PTY and the turn ends
//   hooks    the injected hooks reached the sink (session.hooked)
//   context  the context meter / ledger produced a reading
//   clihealth  the detector-health record, printed for the report
//
// Spends a few cents of Haiku. Uses the developer's real login (real HOME) but
// a temp root, its own state dir and a private tmux socket dir, so the live
// daemon's sessions, ledgers and settings are never touched.
//
//   npm run build && node scripts/smoke-real-cli.mjs [--json out.json]
//
// Exit 0 = every step passed; 1 = a step failed (the JSON names which and why).
import "./lib-tmuxiso.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootHost } from "./lib-e2e.mjs";
import { E } from "./lib-brand.mjs";
import { promptFingerprint } from "../packages/shared/dist/promptid.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/index.js";

const jsonAt = process.argv.indexOf("--json");
const JSON_OUT = jsonAt > 0 ? process.argv[jsonAt + 1] : null;
const STEP_MS = Number(process.env.SMOKE_STEP_MS || 90_000);
const MODEL = process.env.SMOKE_MODEL || "haiku";

const claudeBin = process.env.SMOKE_CLAUDE_BIN || execFileSync("sh", ["-lc", "command -v claude"], { encoding: "utf8" }).trim();
const cliVersion = (() => { try { return execFileSync(claudeBin, ["--version"], { encoding: "utf8" }).trim(); } catch { return null; } })();

const steps = [];
let session = null;
let pty = "";
const report = () => ({ ok: steps.every((s) => s.ok), claudeBin, cliVersion, model: MODEL, steps, ptyTail: pty.slice(-3000) });
const finish = async (host, code) => {
  const r = report();
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(r, null, 2));
  console.log(r.ok ? "PASS: real CLI smoke" : `FAIL: ${steps.filter((s) => !s.ok).map((s) => s.name).join(", ")}`);
  try { await host?.stop(); } catch { /* exiting anyway */ }
  process.exit(code ?? (r.ok ? 0 : 1));
};
const step = (name, ok, detail) => { steps.push({ name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); return ok; };

const host = await bootHost({ tag: "smoke-real", quiet: true, env: { [E.CLAUDE_BIN]: claudeBin } });
const repoDir = join(host.root, "smoke-real");
mkdirSync(repoDir);
execFileSync("git", ["init", "-q"], { cwd: repoDir });
writeFileSync(join(repoDir, "README.md"), "smoke\n");

const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`);
const waiters = new Set();
const check = () => { for (const w of waiters) if (w.pred()) { waiters.delete(w); clearTimeout(w.timer); w.resolve(true); } };
const until = (pred, ms = STEP_MS) => new Promise((resolve) => {
  if (pred()) return resolve(true);
  const w = { pred, resolve, timer: setTimeout(() => { waiters.delete(w); resolve(false); }, ms) };
  waiters.add(w);
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if ((m.t === "session.created" || m.t === "session.updated") && (!session || m.session.id === session.id)) session = m.session;
  else if (m.t === "pty" && session && m.id === session.id) pty += Buffer.from(m.dataB64, "base64").toString("utf8");
  else if (m.t === "clihealth") ws.health = m;
  else if (m.t === "session.exit" && session && m.id === session.id) session = { ...session, exited: m.code };
  check();
});
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));

let n = 0;
const ack = () => `smoke-${process.pid}-${++n}`;
// `rawKeys`: what a person at the desk would press if the phone showed no
// buttons — used only to step PAST a box the detector missed, so one run
// reports every broken step instead of stopping at the first.
const answer = async (kind, rawKeys) => {
  if (!step(`${kind} box detected`, await until(() => session?.prompt?.kind === kind), session?.prompt ? `saw ${session.prompt.kind}: ${session.prompt.question}` : `no box published (awaitingInput=${!!session?.awaitingInput})`)) {
    if (!rawKeys) return false;
    ws.send(JSON.stringify({ t: "session.input", id: session.id, data: rawKeys }));
    return true;
  }
  const p = session.prompt;
  // The consenting option, by its words: claude 2.1.293's trust box lists "No, exit" FIRST.
  const yes = p.options.find((o) => /^yes\b/i.test(o.label)) ?? p.options[0];
  // As the phone answers (`PromptAnswer.tsx`): a box with no numbers (`nav`) is answered by naming
  // the option and the host walks the selection onto it — a digit there types nothing.
  const keys = p.nav ? { data: "", promptChoice: yes.index } : { data: String(yes.index) };
  ws.send(JSON.stringify({ t: "session.input", id: session.id, ...keys, ackId: ack(), expectPrompt: promptFingerprint(p) }));
  return step(`${kind} box answered`, await until(() => session?.prompt?.kind !== kind, 20_000), `chose "${yes.label}"${p.nav ? " (nav)" : ""}`);
};

ws.send(JSON.stringify({ t: "session.create", cwd: repoDir, cols: 120, rows: 40, ackId: ack(), launch: { model: MODEL, permissionMode: "default" } }));
if (!step("boot", await until(() => !!session), session ? session.id : "no session.created")) await finish(host);
step("version", await until(() => !!session.cliVersion, 30_000), session.cliVersion || `binary says ${cliVersion}`);
if (!(await answer("trust", "\x1b[B\r"))) await finish(host);
step("composer idle", await until(() => !session.prompt && !session.awaitingInput && session.turnActive !== true, 30_000), `awaitingInput=${!!session.awaitingInput}`);

ws.send(JSON.stringify({ t: "session.input", id: session.id, data: "Use the Bash tool to run exactly: mkdir -p wp-smoke && echo WP_SMOKE_$((6*7)) — then reply DONE.", submit: true, ackId: ack() }));
if (!(await answer("tool", "\r"))) await finish(host);
// The CLI folds a tool's output ("Ran 1 shell command"), so the result is read
// off the conversation log the way the phone's reader reads it.
step("turn ended", await until(() => session.turnActive === false && pty.includes("DONE"), 60_000));
const tr = await fetch(`${host.base}/api/transcript?id=${session.id}&detail=full`).then((r) => (r.ok ? r.text() : "")).catch(() => "");
step("transcript", tr.includes("WP_SMOKE_42"), tr ? "tool result read off the CLI's log" : "no transcript");
step("hooks", await until(() => session.hooked === true, 15_000), "the injected hooks reached the sink");
// The on-screen meter only appears near the limit, so its absence on a fresh
// session is not a failure — reported, not judged.
steps.push({ name: "context meter (info)", ok: true, detail: `left=${session.contextLeft ?? "-"} used=${session.contextUsedTok ?? "-"}` });
const ctx = await fetch(`${host.base}/api/context?id=${session.id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
step("context ledger", !!ctx, ctx ? "series read off the CLI's log" : "no context series (ctxlog could not read the log)");

ws.send(JSON.stringify({ t: "clihealth.get" }));
await until(() => !!ws.health, 5_000);
steps.push({ name: "clihealth", ok: true, detail: JSON.stringify(ws.health?.rollup ?? null) });
ws.send(JSON.stringify({ t: "session.kill", id: session.id }));
await finish(host);
