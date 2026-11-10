/**
 * Agent readings (`agentclass.ts` + `agentscan.ts` + `agentreadings.ts`): the
 * rework classification, what one log is read into, the weekly fold, and the
 * store's incremental sweep — on hand-written logs in a temp CLAUDE_CONFIG_DIR.
 *
 *     node --test packages/host/test/agentreadings.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRework, foldAgentWeeks, lastWeeks, promptWords, weekOfMs, countByWeek, inRepairRun } from "../dist/agentclass.js";
import { summarizeConv, summarizeAgentLog } from "../dist/agentscan.js";
import { AgentReadingsStore, agentReadingsFor, bugsByWeek, slugBelongs } from "../dist/agentreadings.js";
import { setExposureDir } from "../dist/exposure.js";

process.env.TZ = "UTC";

// ── classification ────────────────────────────────────────────────────────

test("rework words in the prompt or the title make rework; a building verb up front makes feature; the rest is unknown", () => {
  assert.deepEqual(classifyRework("fix the push button", undefined), { c: "rework", word: "fix" });
  assert.deepEqual(classifyRework("The vault card is broken on Android", undefined), { c: "rework", word: "broken" });
  assert.deepEqual(classifyRework("it does not work after the update", undefined), { c: "rework", word: "does not work" });
  assert.deepEqual(classifyRework("Add a chart for compactions", undefined), { c: "feature", word: "add" });
  assert.deepEqual(classifyRework("please implement the export", undefined), { c: "feature", word: "implement" });
  assert.deepEqual(classifyRework("Why is the queue slow?", undefined), { c: "unknown" });
  assert.deepEqual(classifyRework("Why is the queue slow?", "Queue regression on resume"), { c: "rework", word: "regression" });
  // A rework word wins over a building verb: "add a test, the old one is broken" is mending.
  assert.equal(classifyRework("Add a guard, the parser is broken", undefined).c, "rework");
  // Whole words only: a fixture is not a fix.
  assert.equal(classifyRework("Write the fixture loader", undefined).c, "feature");
  assert.equal(classifyRework(undefined, undefined).c, "unknown");
});

test("pasted blocks and command wrappers are not the person's words", () => {
  const p = '\n\n<pasted_content id="ab">\nThe build failed again, here is the log\n</pasted_content>\nSummarise this log';
  assert.equal(promptWords(p), "Summarise this log");
  assert.equal(classifyRework(p, undefined).c, "unknown");
});

test("a review-repair run directory matches its run id either way round", () => {
  assert.equal(inRepairRun("wf_b56e13f6-d31", ["wf_b56e13f6-d31a9"]), true);
  assert.equal(inRepairRun("wf_other", ["wf_b56e13f6"]), false);
  assert.equal(inRepairRun(undefined, ["wf_x"]), false);
});

// ── one log ───────────────────────────────────────────────────────────────

const T = (d, h = 10) => `2026-11-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;
const usage = (i, cr, cw, o = 5) => ({ input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: o });
const asst = (id, ts, u, content = [], sid = "S1") =>
  JSON.stringify({ type: "assistant", sessionId: sid, timestamp: ts, cwd: "/r/app", message: { id, model: "claude-opus-5-5", usage: u, content } });
const user = (ts, content, extra = {}, sid = "S1") =>
  JSON.stringify({ type: "user", sessionId: sid, timestamp: ts, cwd: "/r/app", entrypoint: "cli", message: { role: "user", content }, ...extra });

function convLog({ sid = "S1", prompt = "fix the login screen", firstSessionField } = {}) {
  return [
    JSON.stringify({ type: "user", sessionId: sid, ...(firstSessionField ? { session_id: firstSessionField } : {}), timestamp: T(2), cwd: "/r/app", entrypoint: "cli", message: { role: "user", content: prompt } }),
    asst("m1", T(2), usage(10, 1000, 200), [{ type: "tool_use", id: "t1", name: "Read", input: {} }], sid),
    // The same request streamed again under one id: counted once.
    asst("m1", T(2), usage(10, 1000, 200), [{ type: "text", text: "…" }], sid),
    asst("m2", T(2), usage(5, 2000, 100), [{ type: "tool_use", id: "t2", name: "Edit", input: {} }], sid),
    asst("m3", T(3), usage(1, 3000, 50), [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "git -C /r/app commit -m x" } }], sid),
    user(T(3), [{ type: "tool_result", tool_use_id: "t3", content: "ok" }], {}, sid),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: T(9) }),
    asst("m4", T(9), usage(2, 500, 9000), [{ type: "tool_use", id: "t4", name: "Workflow", input: { scriptPath: "/h/.claude/workflows/review-repair.js" } }], sid),
    user(T(9), [{ type: "tool_result", tool_use_id: "t4", content: "started" }], { toolUseResult: { runId: "wf_abc-123" } }, sid),
    JSON.stringify({ type: "ai-title", aiTitle: "Login screen", sessionId: sid }),
  ].join("\n") + "\n";
}

function writeLog(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

test("a conversation log: fresh, tokens before the first edit, commit, compaction, review-repair run, weeks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-agentscan-"));
  const text = convLog();
  const p = writeLog(dir, "S1.jsonl", text);
  const s = await summarizeConv(p, "S1", Buffer.byteLength(text), 1, 64); // tiny chunks: lines cross every slice
  assert.equal(s.nf, undefined);
  assert.equal(s.c, "rework");
  assert.equal(s.cw, "fix");
  assert.equal(s.w, "/r/app");
  // m1 once + m2 (the request that made the edit), never m3/m4.
  assert.deepEqual(s.ex, [15, 3000, 300, 2]);
  assert.equal(s.cm, 1);
  assert.equal(s.cp, 1);
  assert.deepEqual(s.rr, ["wf_abc-123"]);
  // 2 and 3 November are week 2026-11-02; 9 November opens 2026-11-09.
  assert.deepEqual(Object.keys(s.wk).sort(), ["2026-11-02", "2026-11-09"]);
  assert.deepEqual(s.wk["2026-11-02"], [16, 15, 6000, 350, 0, 3]);
  assert.equal(s.t0, Date.parse(T(2)));
  assert.equal(s.t1, Date.parse(T(9)));
});

test("a fork of a parent that names no session_id is found by its copied prefix being older than the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-agentscan-"));
  const text = convLog({ sid: "S6" }); // uniform sessionId, no session_id: nothing to compare
  const p = writeLog(dir, "S6.jsonl", text);
  const size = Buffer.byteLength(text);
  const mtime = Date.parse(T(9, 11));
  // Born on 9 Nov 09:00: the 2 and 3 Nov rows were copied in; the 9 Nov 10:00 rows are its own.
  const f = await summarizeConv(p, "S6", size, mtime, 64, Date.parse(T(9, 9)));
  assert.equal(f.nf, "fork");
  assert.equal(f.c, "unknown");
  assert.deepEqual(Object.keys(f.wk), ["2026-11-09"]);
  assert.deepEqual(f.wk["2026-11-09"], [2, 5, 500, 9000, 0, 1]);
  assert.equal(f.cm, undefined); // the commit was the parent's
  assert.equal(f.cp, 1); // the compaction row is stamped 9 Nov 10:00: its own
  // Born with its first record: fresh, all its own.
  const fresh = await summarizeConv(p, "S6", size, mtime, 64, Date.parse(T(2)));
  assert.equal(fresh.nf, undefined);
  assert.equal(fresh.cm, 1);
  assert.equal(fresh.cp, 1);
  // A birth after the last write is a copy or restore, not a fork: it says nothing.
  const restored = await summarizeConv(p, "S6", size, mtime, 64, mtime + 3_600_000);
  assert.equal(restored.nf, undefined);
  assert.equal(restored.cm, 1);
  // No birth known: no second test.
  assert.equal((await summarizeConv(p, "S6", size, mtime, 64)).nf, undefined);
});

test("a fresh session with one early startup row before its birth is not a fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-agentscan-"));
  // One attachment stamped at 08:00, the file born at 17:00, the first prompt and replies after.
  const text = [
    JSON.stringify({ type: "attachment", sessionId: "S9", session_id: "S9", timestamp: T(9, 8), cwd: "/r/app" }),
    user(T(9, 17), "fix the login screen", {}, "S9"),
    asst("m1", T(9, 17), usage(10, 1000, 200), [], "S9"),
  ].join("\n") + "\n";
  const p = writeLog(dir, "S9.jsonl", text);
  const s = await summarizeConv(p, "S9", Buffer.byteLength(text), Date.parse(T(9, 18)), 64, Date.parse(T(9, 17)));
  assert.equal(s.nf, undefined);
  assert.equal(s.c, "rework");
  assert.deepEqual(Object.keys(s.wk), ["2026-11-09"]);
});

test("a fork, a continuation and a headless run are not fresh; a failed commit is no commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-agentscan-"));
  const fork = convLog({ sid: "S2", firstSessionField: "PARENT" });
  assert.equal((await summarizeConv(writeLog(dir, "S2.jsonl", fork), "S2", fork.length, 1)).nf, "fork");
  const cont = convLog({ sid: "S3", prompt: "This session is being continued from a previous conversation that ran out of context." });
  assert.equal((await summarizeConv(writeLog(dir, "S3.jsonl", cont), "S3", cont.length, 1)).nf, "continued");
  const headless = convLog({ sid: "S4" }).replace('"entrypoint":"cli"', '"entrypoint":"sdk-cli"');
  assert.equal((await summarizeConv(writeLog(dir, "S4.jsonl", headless), "S4", headless.length, 1)).nf, "headless");
  const failed = convLog({ sid: "S5" }).replace('"tool_use_id":"t3","content":"ok"', '"tool_use_id":"t3","content":"nothing to commit","is_error":true');
  assert.equal((await summarizeConv(writeLog(dir, "S5.jsonl", failed), "S5", failed.length, 1)).cm, undefined);
});

test("an agent log keeps its workflow run directory and its weeks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-agentscan-"));
  const text = asst("a1", T(4), usage(1, 100, 10)) + "\n" + asst("a1", T(4), usage(1, 100, 10)) + "\n";
  const rel = "S1/subagents/workflows/wf_abc-123/agent-x.jsonl";
  const p = writeLog(join(dir, "S1/subagents/workflows/wf_abc-123"), "agent-x.jsonl", text);
  const s = await summarizeAgentLog(p, rel, text.length, 1);
  assert.equal(s.wf, "wf_abc-123");
  assert.deepEqual(s.wk, { "2026-11-02": [1, 5, 100, 10, 0, 1] });
});

// ── the weekly fold ───────────────────────────────────────────────────────

const conv = (o) => ({ m: 1, s: 1, c: "unknown", wk: {}, cp: 0, ...o });
const W1 = "2026-11-02";
const W2 = "2026-11-09";
const mon = Date.parse(`${W1}T12:00:00Z`);
const NO_ESC = { crash: { absent: "no watch" }, bugs: {} };

test("exploration: the LOWER median over fresh sessions that edited, with its own split; the rest counted beside it", () => {
  const convs = [
    conv({ t0: mon, ex: [1, 100, 10, 2] }),
    conv({ t0: mon, ex: [1, 300, 10, 4] }),
    conv({ t0: mon, ex: [1, 200, 10, 3] }),
    conv({ t0: mon, ex: [1, 400, 10, 5] }),
    conv({ t0: mon }), // fresh, never edited
    conv({ t0: mon, nf: "headless", ex: [0, 1, 0, 1] }),
  ].map((c) => ({ conv: c, agents: [] }));
  const [w] = foldAgentWeeks(convs, [W1], NO_ESC);
  assert.equal(w.explore.sessions, 4);
  assert.equal(w.explore.noEdit, 1);
  assert.equal(w.explore.skipped, 1);
  assert.equal(w.explore.medianTok, 211); // 1 + 200 + 10, the second of four
  assert.equal(w.explore.medianRequests, 3);
  assert.equal(w.explore.split.cacheRead, 200);
  assert.equal(w.explore.split.output, 0);
});

test("every reading is absent with a sentence where it cannot be taken — never a zero", () => {
  const [w] = foldAgentWeeks([], [W1], { crash: { absent: "No exposure watch reading is stored." }, bugs: { absent: "This repo has nothing on the backlog." } });
  assert.match(w.explore.absent, /No session started/);
  assert.match(w.rework.absent, /No tokens/);
  assert.match(w.compact.absent, /No session/);
  assert.deepEqual(w.escaped, { crashMarks: { absent: "No exposure watch reading is stored." }, bugItems: { absent: "This repo has nothing on the backlog." } });
  const onlyHeadless = foldAgentWeeks([{ conv: conv({ t0: mon, t1: mon, nf: "headless", cp: 2 }), agents: [] }], [W1], NO_ESC)[0];
  assert.match(onlyHeadless.explore.absent, /forked, continued or headless/);
  assert.match(onlyHeadless.compact.absent, /None of the 1 session this week ran a git commit \(2 compactions/);
});

test("rework: tokens by the week they were spent; review-repair agents are rework, other agents follow their conversation", () => {
  const c1 = conv({ c: "feature", rr: ["wf_r1"], wk: { [W1]: [10, 0, 90, 0, 0, 1], [W2]: [1, 0, 0, 0, 0, 1] } });
  const repairAgent = { m: 1, s: 1, wf: "wf_r1", wk: { [W1]: [0, 0, 50, 0, 0, 1] } };
  const plainAgent = { m: 1, s: 1, wk: { [W1]: [0, 0, 20, 0, 0, 1] } };
  const c2 = conv({ c: "unknown", wk: { [W1]: [0, 0, 30, 0, 0, 1] } });
  const [w1, w2] = foldAgentWeeks([{ conv: c1, agents: [repairAgent, plainAgent] }, { conv: c2, agents: [] }], [W1, W2], NO_ESC);
  assert.equal(w1.rework.totalTok, 200);
  assert.equal(w1.rework.byClass.feature.cacheRead, 110);
  assert.equal(w1.rework.byClass.rework.cacheRead, 50);
  assert.equal(w1.rework.byClass.unknown.cacheRead, 30);
  assert.deepEqual(w1.rework.sessions, { rework: 1, feature: 1, unknown: 1 });
  assert.equal(w1.rework.repairRuns, 1);
  assert.equal(w2.rework.totalTok, 1);
});

test("compactions: per committed session in the week the log last moved, with every session's figure beside it", () => {
  const convs = [
    conv({ t1: mon, cp: 3, cm: 1 }),
    conv({ t1: mon, cp: 1, cm: 1 }),
    conv({ t1: mon, cp: 4 }),
    conv({ t1: Date.parse(`${W2}T12:00:00Z`), cp: 9, cm: 1 }),
  ].map((c) => ({ conv: c, agents: [] }));
  const [w] = foldAgentWeeks(convs, [W1], NO_ESC);
  assert.deepEqual(w.compact, { committed: 2, compactions: 4, sessionsAll: 3, compactionsAll: 8 });
});

test("weeks: Monday keys, the last N ending this week; instants counted into weeks", () => {
  assert.equal(weekOfMs(Date.parse("2026-11-08T23:00:00Z")), W1);
  assert.equal(weekOfMs(Date.parse("2026-11-09T00:30:00Z")), W2);
  assert.deepEqual(lastWeeks(Date.parse("2026-11-11T08:00:00Z"), 3), ["2026-10-26", W1, W2]);
  assert.deepEqual(countByWeek([mon, mon + 1, NaN, Date.parse(`${W2}T01:00:00Z`)]), { [W1]: 2, [W2]: 1 });
});

test("escaped bugs: only this repo's bug items; absent when nothing is categorised", () => {
  const item = (o) => ({ id: "i", text: "t", status: "queued", repoDir: "/r/app", createdAt: mon, order: 0, ...o });
  assert.deepEqual(bugsByWeek([item({ category: "bug" }), item({ category: "feature" }), item({ repoDir: "/r/other", category: "bug" }),
    item({ repoDir: "/r/app/.claude/worktrees/x", category: "bug" })], ["/r/app"]), { [W1]: 2 });
  assert.match(bugsByWeek([item({})], ["/r/app"]).absent, /category/);
  assert.match(bugsByWeek([], ["/r/app"]).absent, /nothing on the backlog/);
  assert.match(bugsByWeek(null, ["/r/app"]).absent, /could not be read/);
});

// ── the store ─────────────────────────────────────────────────────────────

test("slugs: the repo's own and its worktrees', a sibling that shares the prefix past a dash is left to the cwd check below", () => {
  assert.equal(slugBelongs("-r-app", "-r-app"), true);
  assert.equal(slugBelongs("-r-app--claude-worktrees-agent-1", "-r-app"), true);
  assert.equal(slugBelongs("-r-apple", "-r-app"), false);
});

test("the store sweeps incrementally: unchanged logs are not re-read; a sibling repo's logs stay out by their cwd", async () => {
  const home = mkdtempSync(join(tmpdir(), "wp-agentstore-"));
  process.env.CLAUDE_CONFIG_DIR = home;
  const projects = join(home, "projects");
  writeLog(join(projects, "-r-app"), "S1.jsonl", convLog());
  writeLog(join(projects, "-r-app", "S1", "subagents", "workflows", "wf_abc-123"), "agent-x.jsonl", asst("a1", T(4), usage(0, 700, 0)) + "\n");
  // `-r-app-old` shares the slug prefix but its records say another repo.
  writeLog(join(projects, "-r-app-old"), "S9.jsonl", convLog({ sid: "S9" }).replaceAll('"/r/app"', '"/r/app-old"'));
  setExposureDir(join(home, "exposure"));
  const store = new AgentReadingsStore(join(home, "state"), () => undefined);
  const first = await store.sweep(["/r/app"], 0);
  assert.equal(first.reread, 3);
  const convs = store.conversations(["/r/app"]);
  assert.equal(convs.length, 1);
  assert.equal(convs[0].agents.length, 1);
  const again = await store.sweep(["/r/app"], 0);
  assert.equal(again.reread, 0);
  appendFileSync(join(projects, "-r-app", "S1.jsonl"), asst("m9", T(10), usage(1, 1, 1)) + "\n");
  assert.equal((await store.sweep(["/r/app"], 0)).reread, 1);
  // Within the max age nothing is walked at all.
  assert.equal((await store.sweep(["/r/app"])).reread, 1);

  const doc = await agentReadingsFor(store, "/r/app", [], Date.parse(T(10)));
  assert.equal(doc.ok, true);
  const w = doc.weeks.find((x) => x.week === W1);
  assert.equal(w.rework.repairRuns, 1);
  assert.equal(doc.weeks.at(-1).week, W2);
  assert.match(doc.rules.rework, /unknown, never feature/);
  assert.match(w.escaped.crashMarks.absent, /No exposure watch reading/);
  setExposureDir(null);
  store.flush();
  delete process.env.CLAUDE_CONFIG_DIR;
});

test("a fork's copied prefix is the parent's: no week, no compaction, no commit, no class of its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-agentscan-"));
  const P = (row) => JSON.stringify({ ...JSON.parse(row), session_id: "PARENT" });
  const O = (row) => JSON.stringify({ ...JSON.parse(row), session_id: "S2" });
  const text = [
    P(user(T(2), "fix the login screen", {}, "S2")),
    P(asst("m1", T(2), usage(10, 1000, 200), [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "git commit -m x" } }], "S2")),
    P(user(T(2), [{ type: "tool_result", tool_use_id: "t3", content: "ok" }], {}, "S2")),
    // A compaction row carries neither spelling: placed by the rows around it.
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: T(3), sessionId: "S2" }),
    O(asst("m9", T(9), usage(1, 50, 5), [], "S2")),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: T(9), sessionId: "S2" }),
  ].join("\n") + "\n";
  const s = await summarizeConv(writeLog(dir, "S2.jsonl", text), "S2", Buffer.byteLength(text), 1);
  assert.equal(s.nf, "fork");
  assert.equal(s.c, "unknown");
  assert.equal(s.cp, 1);
  assert.equal(s.cm, undefined);
  assert.deepEqual(s.wk, { "2026-11-09": [1, 5, 50, 5, 0, 1] });
});
