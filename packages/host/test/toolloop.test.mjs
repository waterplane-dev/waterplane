/**
 * A session stuck in a tool loop (`toolloop.ts`) — fixture in, verdict out.
 *
 * `qwen-grep-loop.jsonl`: the first 80 tool calls of the 2026-10-31 run
 * (qwen3-vl via Ollama under claude-local), trimmed to the rows the rule reads,
 * the scratch path shortened. 26 varied searches, then the same Grep with the
 * same result over and over.
 * `healthy-busy.jsonl`: 500 tool calls from an ordinary, very busy session in
 * this repo, every input and result replaced by a hash of itself (equality
 * kept, words gone), prompts replaced by a marker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { feedLoopRow, loopReason, loopVerdict, newLoopState } from "../dist/toolloop.js";

const FIX = fileURLToPath(new URL("./fixtures/toolloop/", import.meta.url));
const rows = (name) => readFileSync(FIX + name, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Feed rows one by one; return the first verdict and how many there were. */
function run(list, at = 20) {
  const st = newLoopState();
  let first = null; let verdicts = 0; let maxRun = 0;
  for (const r of list) {
    feedLoopRow(st, r);
    maxRun = Math.max(maxRun, st.n);
    const v = loopVerdict(st, at);
    if (v) { verdicts++; first ??= v; st.told = true; }
  }
  return { first, verdicts, maxRun, st };
}

test("the qwen Grep loop trips once, naming the tool", () => {
  const { first, verdicts, maxRun } = run(rows("qwen-grep-loop.jsonl"));
  assert.ok(first, "a run of identical Greps must be told");
  assert.equal(first.tool, "Grep");
  assert.equal(first.n, 20);
  assert.equal(verdicts, 1, "one flag per run, not one per call past the threshold");
  assert.ok(maxRun >= 50);
  const line = loopReason(first, first.since + 90_000);
  assert.match(line, /same Grep call 20× in a row over 1 min/);
  assert.match(line, /nothing was stopped/);
});

test("a busy healthy session never trips, even at a quarter of the threshold", () => {
  const { first, maxRun } = run(rows("healthy-busy.jsonl"), 5);
  assert.equal(first, null);
  assert.ok(maxRun < 5, `longest identical run was ${maxRun}`);
});

const use = (id, input, name = "Bash") => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const res = (id, content) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });

test("a test-fix-retest loop with changing results never builds a run", () => {
  const list = [];
  for (let i = 0; i < 60; i++) {
    list.push(use(`t${i}`, { command: "npm test" }), res(`t${i}`, `${60 - i} failing`));
  }
  assert.equal(run(list, 3).first, null);
});

test("same call, same result: key order is not a change; a different call or a prompt re-arms", () => {
  const st = newLoopState();
  for (let i = 0; i < 3; i++) {
    feedLoopRow(st, use(`a${i}`, i % 2 ? { b: 1, a: 2 } : { a: 2, b: 1 }, "Grep"));
    feedLoopRow(st, res(`a${i}`, "Found 1 file"));
  }
  const v = loopVerdict(st, 3);
  assert.equal(v?.n, 3);
  st.told = true;
  feedLoopRow(st, use("a3", { a: 2, b: 1 }, "Grep")); feedLoopRow(st, res("a3", "Found 1 file"));
  assert.equal(loopVerdict(st, 3), null, "told once per run");
  feedLoopRow(st, { type: "user", message: { content: "please stop" } });
  assert.equal(st.n, 0);
  assert.equal(st.told, false);
});

test("a result whose call was never seen breaks the run (a miss, never an alarm)", () => {
  const st = newLoopState();
  for (let i = 0; i < 5; i++) { feedLoopRow(st, use(`x${i}`, { q: 1 })); feedLoopRow(st, res(`x${i}`, "same")); }
  feedLoopRow(st, res("never-seen", "same"));
  assert.equal(st.n, 0);
});

test("sidechain rows and an off threshold say nothing", () => {
  const st = newLoopState();
  for (let i = 0; i < 30; i++) {
    feedLoopRow(st, { ...use(`s${i}`, { q: 1 }), isSidechain: true });
    feedLoopRow(st, { ...res(`s${i}`, "same"), isSidechain: true });
  }
  assert.equal(st.n, 0);
  const on = run(rows("qwen-grep-loop.jsonl"), 0);
  assert.equal(on.first, null, "0 = off");
});

// ── the wiring (`sessions/loopwatch.ts`): incremental read, one flag, never over another ──

test("loopwatch: starts at the log's end, reads on, flags once by:host, never over a flag", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-loopwatch-"));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const { checkToolLoop } = await import("../dist/sessions/loopwatch.js");
    const { transcriptPath } = await import("../dist/transcript.js");
    const cwd = mkdtempSync(join(tmpdir(), "waterplane-loopcwd-"));
    const cid = "11111111-2222-4333-8444-555555555555";
    const path = transcriptPath(cwd, cid);
    mkdirSync(join(path, ".."), { recursive: true });
    const all = rows("qwen-grep-loop.jsonl");
    const lines = all.map((r) => JSON.stringify(r) + "\n");
    // One more Grep call + its result, the loop's own shape, to append again and again.
    const k = all.findLastIndex((r) => r.type === "user" && Array.isArray(r.message.content) && r.message.content.some((b) => b.type === "tool_result"));
    assert.equal(all[k - 1].message.content[0].type, "tool_use");
    const again = lines.slice(k - 1, k + 1).join("");
    writeFileSync(path, lines.slice(0, 40).join(""));
    const flags = [];
    let held;
    const core = { followUpOf: () => held, setFollowUp: (id, f) => { flags.push({ id, f }); return true; } };
    const s = { info: { id: "s1", cwd, claudeSessionId: cid, running: true }, backend: { id: "claude", caps: {}, facts: {} } };
    const backend = (await import("../dist/backends/index.js")).resolveBackend();
    s.backend = backend;
    checkToolLoop(core, s, 1);                       // arms at the end: what came before is never read
    appendFileSync(path, lines.slice(40, 60).join(""));
    checkToolLoop(core, s, 2);
    assert.equal(flags.length, 0, "the 40 rows before the cursor are not counted");
    appendFileSync(path, lines.slice(60).join(""));
    checkToolLoop(core, s, 3);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].f.by, "host");
    assert.match(flags[0].f.reason, /same Grep call \d+× in a row/);
    for (let i = 0; i < 30; i++) appendFileSync(path, again);
    checkToolLoop(core, s, 4);
    assert.equal(flags.length, 1, "one flag per run");
    // A fresh run with a flag already up: the flag stays.
    const s2 = { ...s, info: { ...s.info, id: "s2" } };
    held = { by: "hand", at: 1 };
    checkToolLoop(core, s2, 5);
    for (let i = 0; i < 30; i++) appendFileSync(path, again);
    checkToolLoop(core, s2, 6);
    assert.equal(flags.length, 1, "a flag somebody set is never overwritten");
    held = undefined;                                // control: the same appends on a third session DO flag
    const s3 = { ...s, info: { ...s.info, id: "s3" } };
    checkToolLoop(core, s3, 7);
    for (let i = 0; i < 30; i++) appendFileSync(path, again);
    checkToolLoop(core, s3, 8);
    assert.equal(flags.length, 2);
    assert.equal(flags[1].id, "s3");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
