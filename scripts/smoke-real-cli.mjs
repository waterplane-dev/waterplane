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
//   ask      a multi-select AskUserQuestion: detected, enriched off the log,
//            one row ticked by its digit, submitted by the Submit row
//   local    `/context` delivered as a TUI-local command (no turn, screen moves)
//   clihealth  the detector-health record, printed for the report
//   fixtures   where the host kept this CLI's captures (`clifixtures.ts`), for
//              `node tools/harvestfixtures.mjs --dir <that dir>`
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
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

// The log-health spawn grace (60 s) outlasts this whole run, which would keep
// the `transcript.jsonl` observation — and its fixture capture — from firing.
const host = await bootHost({ tag: "smoke-real", quiet: true, env: { [E.CLAUDE_BIN]: claudeBin, [E.HEALTH_GRACE_MS]: process.env[E.HEALTH_GRACE_MS] ?? "1000" } });
const repoDir = join(host.root, "smoke-real");
mkdirSync(repoDir);
execFileSync("git", ["init", "-q"], { cwd: repoDir });
writeFileSync(join(repoDir, "README.md"), "smoke\n");

const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`);
const waiters = new Set();
/** Delivery receipts by ackId (`input.ack`). */
const acks = new Map();
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
  else if (m.t === "input.ack") acks.set(m.ackId, m);
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

// A checkbox box, answered as the phone answers one: a digit ticks a row, and
// `promptSubmit` has the host walk the cursor onto Submit (`submitPromptBox`).
// It also files `askbox.enrich` (the log's question for the box) and
// `prompt.submit` — each one's fixture capture rides on that good.
ws.send(JSON.stringify({ t: "session.input", id: session.id, submit: true, ackId: ack(),
  data: "Call the AskUserQuestion tool exactly once with one question, \"Which fruits go in the salad?\", header \"Fruit\", multiSelect true, options Apple, Banana and Cherry (each with a one-line description). After the answer, reply DONE2." }));
if (step("ask box detected", await until(() => session?.prompt?.multi === true), session?.prompt ? `saw ${session.prompt.kind}` : "no checkbox box published")) {
  // The host's own matcher, asked here against the labels it published.
  const askDiag = async () => {
    try {
      const { pendingAskQuestions, pickAsk } = await import("../packages/host/dist/askbox.js");
      const asks = pendingAskQuestions(repoDir, session.claudeSessionId);
      const labels = (session.prompt?.options ?? []).map((o) => o.label);
      return `labels ${JSON.stringify(labels)}, pending asks ${asks.length}${asks[0] ? ` ${JSON.stringify(asks[0].options.map((o) => o.label))}` : ""}, match ${!!pickAsk(asks, labels)}`;
    } catch (e) { return `diag failed: ${e.message}`; }
  };
  const enriched = await until(() => session.prompt?.options?.some((o) => o.desc), 20_000);
  // On a miss, say whether the CLI's log held the pending call at all — the
  // difference between a matcher that broke and a CLI that stopped writing the
  // call before it is answered (`askbox.ts` rests on the latter not happening).
  let logged = "unknown";
  try {
    const dir = join(homedir(), ".claude", "projects", realpathSync(repoDir).replace(/[^A-Za-z0-9]/g, "-"));
    // The CALL record, not the tool's definition (the CLI logs its request
    // records too, and every one of them names AskUserQuestion).
    const pending = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      .some((f) => readFileSync(join(dir, f), "utf8").split("\n").some((l) => /"type":"tool_use"[^}]*"name":"AskUserQuestion"/.test(l)));
    logged = pending ? "the log holds the call" : "the log does NOT hold the call while the box is up";
  } catch { /* unknown */ }
  step("ask box enriched", enriched, enriched ? "descriptions in the CLI's own words (its log, or the PreToolUse hook)"
    : `${logged}; conversation id ${session.claudeSessionId ?? "unknown"}, askId ${session.prompt?.askId ?? "none"}; ${await askDiag()}`);
  const banana = session.prompt.options.find((o) => /banana/i.test(o.label)) ?? session.prompt.options[1];
  ws.send(JSON.stringify({ t: "session.input", id: session.id, data: String(banana.index), ackId: ack(), expectPrompt: promptFingerprint(session.prompt) }));
  step("ask row ticked", await until(() => session.prompt?.options?.some((o) => o.index === banana.index && o.checked), 10_000), banana.label);
  ws.send(JSON.stringify({ t: "session.input", id: session.id, data: "", promptSubmit: true, ackId: ack(), expectPrompt: promptFingerprint(session.prompt) }));
  step("ask box submitted", await until(() => !session.prompt?.multi, 20_000));
  // 2.1.304 asks once more before sending — "Review your answers", a numbered
  // box of its own (Submit answers / Cancel) — and the phone answers it like any box.
  if (await until(() => session.prompt?.options?.some((o) => /^submit answers/i.test(o.label)), 5_000)) {
    const p = session.prompt, go = p.options.find((o) => /^submit answers/i.test(o.label));
    ws.send(JSON.stringify({ t: "session.input", id: session.id, data: String(go.index), ackId: ack(), expectPrompt: promptFingerprint(p) }));
    step("ask review answered", await until(() => !session.prompt, 20_000), `chose "${go.label}"`);
  }
  step("ask turn ended", await until(() => session.turnActive === false && pty.includes("DONE2"), 60_000));
}

// A TUI-local command: a view opens, no turn starts (`slash.local`).
// Its receipt, not the output growing: the typed echo alone grows it, and the
// delivery's own "the screen moved" proof is what `slash.local` records.
const ctxAck = ack();
ws.send(JSON.stringify({ t: "session.input", id: session.id, data: "/context", submit: true, ackId: ctxAck }));
const ctxDone = await until(() => acks.has(ctxAck), 60_000);
const ctxR = acks.get(ctxAck);
step("local command", ctxDone && ctxR.ok && session.turnActive !== true, ctxR ? `/context: ${ctxR.ok ? "delivered" : ctxR.reason ?? "refused"}` : "no receipt");
ws.send(JSON.stringify({ t: "session.input", id: session.id, data: "\x1b" }));

ws.send(JSON.stringify({ t: "clihealth.get" }));
await until(() => !!ws.health, 5_000);
steps.push({ name: "clihealth", ok: true, detail: JSON.stringify(ws.health?.rollup ?? null) });
// The temp root outlives `stop()`, so the captures can be harvested afterwards.
const { hostStateDir } = await import("../packages/host/dist/branddirs.js");
step("fixtures (info)", true, join(hostStateDir(host.root), "clifixtures"));
ws.send(JSON.stringify({ t: "session.kill", id: session.id }));
await finish(host);
