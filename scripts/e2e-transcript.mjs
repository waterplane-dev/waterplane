// Reader view (structured transcript): GET /api/transcript
//  - parses the claude CLI's own conversation log into turns/blocks: prompt text,
//    assistant markdown, thinking, tool calls with labels + results + error flag
//  - synthetic prompt records (hook output, task notifications, resume caveats)
//    and sub-agent (sidechain) lines never open a bogus turn
//  - a LOCAL command is the exception: `/context` and its `<local-command-stdout>`
//    are a turn of their own (`local: "log"`), its answer a `screen` block —
//    read mode used to show a conversation in which neither had happened
//  - the outline fields are filled: heuristic summary, tool count, files touched
//  - the default document is LITE: tool names/labels/ok, but inputs+results are
//    withheld (`omitted`) and fetched per turn from /api/transcript/tools
//  - `?detail=full` still returns the whole thing
//  - a prompt the CLI ABSORBED into the running turn — written to the log as a
//    `queued_command` attachment and as nothing else — opens a turn, is flagged
//    `absorbed`, and retires this app's own "not started yet" row
//  - `since` → 204 when the log hasn't changed (cheap polling)
//  - no conversation log ⇒ falls back to the recorded prompt+capture history
//  - an unknown session id is a 404, not a crash
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8804;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-transcript-`));
const HOME = mkdtempSync(join(tmpdir(), `${SLUG}-claudehome-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_HOME]: HOME,
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.IDLE_MS]: "600", [E.IDLE_PING_MS]: "400",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write a conversation log where the CLI would keep it. */
function writeLog(cwd, convId, records) {
  const dir = join(HOME, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, convId + ".jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const user = (uuid, content, extra = {}) => ({ type: "user", uuid, timestamp: new Date(1e12).toISOString(), message: { role: "user", content }, ...extra });
const asst = (uuid, content, extra = {}) => ({ type: "assistant", uuid, timestamp: new Date(1e12).toISOString(), message: { role: "assistant", content }, ...extra });

bootWait(PORT, 800, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let sid = null, info = null;
  try {
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") { sid = m.session.id; info = m.session; }
      if (m.t === "session.updated" && m.session.id === sid) info = m.session;
    });

    const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "trans" }) }).then((r) => r.json());
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 24 }));
    for (let i = 0; i < 40 && !sid; i++) await sleep(100);
    check(!!sid, "session created");
    const conv = info?.claudeSessionId;
    check(!!conv, "fresh session knows its conversation id (--session-id)");

    // ── A conversation with everything the reader has to render ─────────
    writeLog(repo.path, conv, [
      { type: "mode", mode: "normal" },                                   // non-message noise
      user("u0", "<command-name>/context</command-name>"),                // a local command: a turn of its own
      user("u0b", "<local-command-stdout>context used: 42k/200k</local-command-stdout>"),
      user("ux", "<system-reminder>plumbing</system-reminder>"),           // synthetic: opens nothing
      user("u1", "Fix the **scroll** jank and see https://example.com/spec"),
      asst("a1", [{ type: "thinking", thinking: "the watchdog re-arms per render" }]),
      asst("a2", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(repo.path, "src/ws.ts") } }]),
      user("u2", [{ type: "tool_result", tool_use_id: "t1", content: "line one\nline two" }]),
      asst("a3", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm run build", description: "build" } }]),
      user("u3", [{ type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }]),
      asst("a4", [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: join(repo.path, "src/ws.ts"), old_string: "a", new_string: "b" } }]),
      user("u4", [{ type: "tool_result", tool_use_id: "t3", content: "ok" }]),
      asst("side", [{ type: "text", text: "subagent chatter" }], { isSidechain: true }),
      asst("a5", [{ type: "text", text: "Fixed the jank. The watchdog was re-armed on every render.\n\n```ts\nconst x = 1;\n```" }]),
      user("u5", "thanks"),
      asst("a6", [{ type: "text", text: "You're welcome." }]),
    ]);

    const doc = await fetch(`${base}/api/transcript?id=${sid}`).then((r) => r.json());
    check(doc.source === "jsonl", "source = the CLI's own conversation log");
    check(doc.turns.length === 3,
      `three turns — the local command, and the two prompts (got ${doc.turns.length})`);

    // The local command: its own turn, marked as one, with the CLI's own output
    // under it as terminal text. Never markdown — box drawing through a markdown
    // renderer is soup.
    const cmd = doc.turns[0];
    check(cmd.prompt === "/context" && cmd.local === "log",
      `the local command is a turn of its own, marked (got ${cmd.prompt}/${cmd.local})`);
    check(cmd.blocks.length === 1 && cmd.blocks[0].kind === "screen" && cmd.blocks[0].text.includes("42k/200k"),
      `...with its stdout as a screen block (got ${JSON.stringify(cmd.blocks)})`);

    const t1 = doc.turns[1];
    check(t1.prompt.startsWith("Fix the **scroll** jank"), "turn carries the full prompt text");
    check(t1.n === 2 && !!t1.sentAt, "turn is numbered and timestamped");
    check(t1.toolCount === 3, `tool count = 3 (got ${t1.toolCount})`);
    check(t1.sidechains === 1, "sub-agent line counted, not inlined");
    check(t1.files.join(",") === "src/ws.ts", `files touched = repo-relative edit target (got ${t1.files.join(",")})`);
    check(t1.summary === "Fixed the jank.", `summary = first sentence of the final text (got ${JSON.stringify(t1.summary)})`);

    const kinds = t1.blocks.map((b) => b.kind).join(",");
    check(kinds === "thinking,tool,tool,tool,text", `block order preserved (got ${kinds})`);
    const think = t1.blocks[0];
    check(think.text.includes("re-arms per render"), "thinking block kept (collapsed client-side)");
    const read = t1.blocks[1], bash = t1.blocks[2];
    check(read.name === "Read" && read.label === "src/ws.ts", `Read labelled by relative path (got ${read.label})`);
    check(bash.label === "npm run build", `Bash labelled by its command (got ${bash.label})`);
    check(t1.blocks[4].text.includes("```ts"), "assistant markdown kept verbatim (rendered client-side)");
    check(doc.turns[2].prompt === "thanks" && doc.turns[2].n === 3, "the prompt after it follows");

    // ── The default is LITE ─────────────────────────────────────────────
    // Inputs/results are the bulk of a real conversation's bytes and the phone
    // pays for them twice (tunnel, then IndexedDB). They stay on the host.
    check(doc.detail === "lite", `default document is lite (got ${doc.detail})`);
    check(t1.blocks.every((b) => b.kind !== "tool" || (b.omitted === true && b.input === undefined && b.result === undefined)),
      "lite: every tool block is flagged `omitted` with no input and no result");
    // `ok` must survive — it is the only "did this finish" a lite block has, and
    // without it a completed tool reads identically to one still running.
    check(read.ok === true && bash.ok === false, "lite: ok/error survives the strip");

    // ── The withheld pair, on demand, per turn ──────────────────────────
    const det = await fetch(`${base}/api/transcript/tools?id=${sid}&turn=${t1.id}`).then((r) => r.json());
    check(det.tools?.t1?.result === "line one\nline two", "tool details: result comes back keyed by tool_use id");
    check(det.tools?.t1?.input?.includes("src/ws.ts"), "tool details: input comes back too");
    check(det.tools?.t2?.result === "boom" && det.tools.t2.ok === false, "tool details: the failed call carries its error output");
    check(Object.keys(det.tools).length === 3, `tool details: one entry per call in the turn (got ${Object.keys(det.tools).length})`);
    const detMiss = await fetch(`${base}/api/transcript/tools?id=${sid}&turn=nosuchturn`);
    check(detMiss.status === 404, `tool details for an unknown turn ⇒ 404 (got ${detMiss.status})`);

    // ── …and `detail=full` is still the whole document ──────────────────
    const full = await fetch(`${base}/api/transcript?id=${sid}&detail=full`).then((r) => r.json());
    check(full.detail === "full", `detail=full says so (got ${full.detail})`);
    const fread = full.turns[1].blocks[1];
    check(fread.result === "line one\nline two" && !fread.omitted, "detail=full carries results inline, unflagged");
    check(JSON.stringify(full).length > JSON.stringify(doc).length, "the full document is the bigger one");

    // ── Cheap polling: unchanged log ⇒ 204 ──────────────────────────────
    const again = await fetch(`${base}/api/transcript?id=${sid}&since=${doc.updatedAt}`);
    check(again.status === 204, `unchanged log answers 204 (got ${again.status})`);
    const stale = await fetch(`${base}/api/transcript?id=${sid}&since=${doc.updatedAt - 5000}`);
    check(stale.status === 200, "older `since` still returns the document");

    // ── A prompt the CLI took mid-turn ──────────────────────────────────
    // The report was "read mode misses the last output of the CLI". It did not:
    // a prompt typed into a busy session is sometimes ABSORBED into the running
    // turn, and then the CLI writes no `user` record for it at all — the words
    // exist once, as a `queued_command` attachment. So the reader drew no turn,
    // folded the answer into the previous prompt's turn, and this app's own
    // "sent · the CLI has not started it yet" row never retired, sorted below
    // the answer it had already been given. Asserted here and not only in
    // `packages/host/test/absorbed.test.mjs` because the flag has to survive the
    // wire and the lite strip to reach a phone.
    const repoQ = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "transq" }) }).then((r) => r.json());
    sid = null;
    ws.send(JSON.stringify({ t: "session.create", cwd: repoQ.path, cols: 80, rows: 24 }));
    for (let i = 0; i < 40 && !sid; i++) await sleep(100);
    const sidQ = sid, convQ = info?.claudeSessionId;
    // What this app records when the phone sends into a busy session — the row
    // that stayed up for ever.
    ws.send(JSON.stringify({ t: "session.record", id: sidQ, text: "and the second thing?", kind: "prompt" }));
    await sleep(300);
    writeLog(repoQ.path, convQ, [
      user("q1", "the first thing"),
      asst("q2", [{ type: "text", text: "Done with the first thing." }]),
      { type: "queue-operation", operation: "enqueue", content: "and the second thing?", timestamp: new Date(1e12).toISOString() },
      { type: "attachment", uuid: "qa1", timestamp: new Date(1e12).toISOString(), attachment: { type: "queued_command", prompt: "and the second thing?", commandMode: "prompt" } },
      asst("q3", [{ type: "text", text: "And the second thing is done too." }]),
      // Plumbing queued behind a turn is not a prompt somebody sent — it must
      // open nothing here, exactly as it opens nothing from a `user` record.
      { type: "attachment", uuid: "qa2", timestamp: new Date(1e12).toISOString(), attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>x</task-id>\n</task-notification>" } },
    ]);
    const docQ = await fetch(`${base}/api/transcript?id=${sidQ}`).then((r) => r.json());
    check(docQ.turns.length === 2, `the absorbed prompt is a turn of its own (got ${docQ.turns.length})`);
    const abs = docQ.turns[1];
    check(abs?.prompt === "and the second thing?", `...carrying the words the CLI took (got ${JSON.stringify(abs?.prompt)})`);
    check(abs?.absorbed === true, "...flagged `absorbed`, so the row can say the answer above may reply to both");
    check(abs?.blocks?.[0]?.text === "And the second thing is done too.",
      "...with the CLI's last output under it, which is the whole report");
    check(docQ.turns[0].blocks.length === 1, "...and the earlier answer stays with the prompt it was given for");
    check(!docQ.turns.some((t) => t.queued),
      "...and nothing is still waiting: the log has taken those words");

    // ── Fallback: a session with no conversation log ────────────────────
    const repo2 = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "trans2" }) }).then((r) => r.json());
    sid = null;
    ws.send(JSON.stringify({ t: "session.create", cwd: repo2.path, cols: 80, rows: 24 }));
    for (let i = 0; i < 40 && !sid; i++) await sleep(100);
    const sid2 = sid;
    ws.send(JSON.stringify({ t: "session.record", id: sid2, text: "no log for this one", kind: "prompt" }));
    await sleep(300);
    const doc2 = await fetch(`${base}/api/transcript?id=${sid2}`).then((r) => r.json());
    check(doc2.source === "history", `no conversation log ⇒ history fallback (got ${doc2.source})`);
    check(doc2.turns[0]?.prompt === "no log for this one", "fallback turn carries the recorded prompt");

    const missing = await fetch(`${base}/api/transcript?id=nope`);
    check(missing.status === 404, `unknown session id ⇒ 404 (got ${missing.status})`);

    // ── The desktop's own scrollback ────────────────────────────────────
    // The phone keeps a reconstruction of what it displayed (`web/screenlog.ts`)
    // and it reads like one: a view switch repaints the whole grid, which is
    // indistinguishable from an enormous scroll, so the outgoing screen is
    // archived WHOLE and appears again on the way back, while anything painted
    // with the app closed was never captured. Duplicated blocks and missing
    // ones. The host has the raw PTY bytes and one real VT, so here there is
    // nothing to infer — and that is what the sheet asks for first.
    ws.send(JSON.stringify({ t: "session.input", id: sid2, data: "printf scrollback-marker-one; echo\r" }));
    await sleep(900);
    const sb = await fetch(`${base}/api/scrollback?id=${sid2}`).then((r) => r.json());
    check(Array.isArray(sb.lines) && sb.lines.length > 0, `the desktop answers with lines (got ${sb.lines?.length})`);
    // Twice: the PTY's echo of the command, and its output. One would be
    // satisfied by the echo alone, which proves nothing about the replay.
    check(sb.lines.filter((l) => l.includes("scrollback-marker-one")).length >= 2,
      `what the terminal printed is in it, echo AND output (got ${sb.lines.filter((l) => l.includes("scrollback-marker-one")).length})`);
    check(sb.bounded === false,
      `a short session is not bounded — "as far back as it kept" is a different claim from "the whole session" (got ${sb.bounded})`);
    const sbMissing = await fetch(`${base}/api/scrollback?id=nope`);
    check(sbMissing.status === 404, `unknown session id ⇒ 404 (got ${sbMissing.status})`);

    ws.close();
  } catch (e) {
    console.log("FAIL: threw", e); failed = true;
  } finally {
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  }
});
