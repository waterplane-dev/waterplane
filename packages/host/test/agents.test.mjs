/**
 * "What is still running under this session" — the fact the turn flag does not
 * carry.
 *
 * The failure: a session that launched two background agents published
 * `turnActive: false` (correctly — the MAIN loop's turn had ended) and the
 * reader, which has no terminal to check that against, said "idle — nothing
 * running" while both agents worked for another six minutes. The cases below
 * are the shapes that reach `readRunningAgents` off a real project directory:
 * an agent still writing, one the parent has already recorded as finished, one
 * resumed after that record, and one whose CLI died without writing either.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastActivity, notifiedAt, readCliRecord, readRunningAgents } from "../dist/agents.js";

const CWD = "/Users/x/dev/demo";
const CONV = "362d560e-1690-489a-b533-5f30c9412081";

/** A project tree shaped exactly like the CLI's own. Returns the cwd to ask about. */
function project({ agents, parent = [] }) {
  const home = mkdtempSync(join(tmpdir(), "waterplane-agents-"));
  process.env.WATERPLANE_CLAUDE_HOME = home;
  const proj = join(home, ".claude", "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"));
  const subs = join(proj, CONV, "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(proj, `${CONV}.jsonl`), parent.map((r) => JSON.stringify(r)).join("\n"));
  for (const a of agents) {
    const log = join(subs, `agent-${a.id}.jsonl`);
    writeFileSync(log, (a.lines ?? []).map((r) => JSON.stringify(r)).join("\n"));
    const metaFile = join(subs, `agent-${a.id}.meta.json`);
    writeFileSync(metaFile, JSON.stringify(a.meta ?? {}));
    const t = a.lastWriteAt / 1000;
    utimesSync(log, t, t);
    if (a.metaAt !== undefined) utimesSync(metaFile, a.metaAt / 1000, a.metaAt / 1000);
  }
  return CWD;
}

/** What the CLI writes into the PARENT when a background agent stops. */
const notification = (id, at) => ({
  type: "user",
  timestamp: new Date(at).toISOString(),
  message: { role: "user", content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n` },
});

const assistantSaying = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantCalling = (name) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] } });

test("an agent still writing, with nothing retiring it, is running", () => {
  const now = Date.now();
  const cwd = project({
    agents: [{
      id: "a141a1e425712cd1b",
      lastWriteAt: now - 4000,
      meta: { agentType: "general-purpose", description: "Fable review: design and API", model: "fable" },
      lines: [assistantCalling("Read")],
    }],
  });
  const rows = readRunningAgents(cwd, CONV, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].what, "Fable review: design and API");
  assert.equal(rows[0].type, "general-purpose");
  assert.equal(rows[0].model, "fable");
  assert.equal(rows[0].doing, "Read");
});

test("the parent's task-notification is what retires it — not silence", () => {
  const now = Date.now();
  const cwd = project({
    agents: [{ id: "aaa", lastWriteAt: now - 2000, meta: { description: "review" } }],
    parent: [notification("aaa", now - 1000)],
  });
  assert.deepEqual(readRunningAgents(cwd, CONV, now), []);
});

test("an agent RESUMED after its notification is running again", () => {
  // The CLI's own note: a task-notification fires each time the agent stops,
  // and `SendMessage` starts it again. So the comparison is "did it write after
  // it was last retired", never "was it ever retired".
  const now = Date.now();
  const cwd = project({
    agents: [{ id: "aaa", lastWriteAt: now - 1000, meta: { description: "review" } }],
    parent: [notification("aaa", now - 60_000)],
  });
  assert.equal(readRunningAgents(cwd, CONV, now).length, 1);
});

test("the CLI's finished mark retires an agent that woke after its notification", () => {
  // Measured 2026-10-23: a background agent was told about its own stray
  // background search after it had reported, answered in one line and stopped.
  // That last write came after the parent's only notification, so the session
  // read "1 agent" for ten minutes after everything had ended. The meta file is
  // rewritten with `finished: true` ~100 ms before that last line.
  const now = Date.now();
  const cwd = project({
    agents: [{ id: "aaa", lastWriteAt: now - 1000, metaAt: now - 1100, meta: { description: "review", finished: true } }],
    parent: [notification("aaa", now - 60_000)],
  });
  assert.deepEqual(readRunningAgents(cwd, CONV, now), []);
});

test("a finished mark older than the agent's last write does not retire it", () => {
  // Resumed with SendMessage after it finished: it is writing again, and the
  // stale flag no longer speaks for it.
  const now = Date.now();
  const cwd = project({
    agents: [{ id: "aaa", lastWriteAt: now - 1000, metaAt: now - 60_000, meta: { description: "review", finished: true } }],
  });
  assert.equal(readRunningAgents(cwd, CONV, now).length, 1);
});

test("an agent whose ending was never written down goes stale rather than running for ever", () => {
  const now = Date.now();
  const cwd = project({ agents: [{ id: "aaa", lastWriteAt: now - 60 * 60_000, meta: { description: "review" } }] });
  assert.deepEqual(readRunningAgents(cwd, CONV, now), []);
});

test("a long quiet tool call is still running — freshness alone would call it finished", () => {
  const now = Date.now();
  const cwd = project({ agents: [{ id: "aaa", lastWriteAt: now - 5 * 60_000, meta: { description: "run the suite" } }] });
  assert.equal(readRunningAgents(cwd, CONV, now).length, 1);
});

test("no conversation id, and no directory, answer an empty list — never a guess", () => {
  const now = Date.now();
  const cwd = project({ agents: [{ id: "aaa", lastWriteAt: now, meta: {} }] });
  assert.deepEqual(readRunningAgents(cwd, undefined, now), []);
  assert.deepEqual(readRunningAgents("/Users/x/dev/nothing-here", CONV, now), []);
});

test("a missing description costs the wording, never the row", () => {
  const now = Date.now();
  const cwd = project({ agents: [{ id: "aaa", lastWriteAt: now, meta: { agentType: "general-purpose" } }] });
  assert.equal(readRunningAgents(cwd, CONV, now)[0].what, "general-purpose");
});

/**
 * A dynamic workflow's agents live one level down and never get a notification
 * of their own; the journal says which ended. CLI 2.1.308: the terminal said
 * "Waiting for 1 dynamic workflow to finish" over three working agents while
 * the reader said "idle — nothing running".
 */
function workflow(cwd, wf, { agents, journal }) {
  const proj = join(process.env.WATERPLANE_CLAUDE_HOME, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const dir = join(proj, CONV, "subagents", "workflows", wf);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), journal.map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const a of agents) {
    const log = join(dir, `agent-${a.id}.jsonl`);
    writeFileSync(log, "");
    writeFileSync(join(dir, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: a.label }));
    utimesSync(log, a.lastWriteAt / 1000, a.lastWriteAt / 1000);
  }
}

test("a workflow's agents are running until the journal records their result", () => {
  const now = Date.now();
  const cwd = project({ agents: [] });
  workflow(cwd, "wf_93053e76-e8d", {
    agents: [
      { id: "a1", label: "impl:backend", lastWriteAt: now - 3000 },
      { id: "a2", label: "impl:watch", lastWriteAt: now - 2000 },
      { id: "a3", label: "fix:backend", lastWriteAt: now - 1000 },
    ],
    journal: [
      { type: "launched" },
      { type: "started", key: "v2:k1", agentId: "a1", label: "impl:backend" },
      { type: "started", key: "v2:k2", agentId: "a2", label: "impl:watch" },
      { type: "result", key: "v2:k1", result: {} },
      { type: "started", key: "v2:k3", agentId: "a3", label: "fix:backend" },
    ],
  });
  assert.deepEqual(readRunningAgents(cwd, CONV, now).map((r) => r.what), ["fix:backend", "impl:watch"]);
});

test("the workflow's own notification retires every agent under it", () => {
  const now = Date.now();
  const launch = {
    type: "user",
    timestamp: new Date(now - 60_000).toISOString(),
    message: { role: "user", content: [{ type: "tool_result", content: "Workflow launched in background. Task ID: wlmr7wulb\nSummary: x\nTranscript dir: /h/.claude/projects/p/c/subagents/workflows/wf_15b48c06-78a\nScript file: /h/s.js" }] },
  };
  const cwd = project({ agents: [], parent: [launch, notification("wlmr7wulb", now - 500)] });
  workflow(cwd, "wf_15b48c06-78a", {
    agents: [{ id: "b1", label: "review:css", lastWriteAt: now - 1000 }],
    journal: [{ type: "launched" }, { type: "started", key: "v2:k1", agentId: "b1" }],
  });
  assert.deepEqual(readRunningAgents(cwd, CONV, now), []);
});

test("a workflow agent nobody ended still goes stale", () => {
  const now = Date.now();
  const cwd = project({ agents: [] });
  workflow(cwd, "wf_x", {
    agents: [{ id: "c1", label: "impl", lastWriteAt: now - 60 * 60_000 }],
    journal: [{ type: "started", key: "v2:k1", agentId: "c1" }],
  });
  assert.deepEqual(readRunningAgents(cwd, CONV, now), []);
});

test("notifiedAt keeps the NEWEST stop per agent, and tolerates an unparseable line", () => {
  const t1 = Date.UTC(2026, 8, 11, 19, 42, 0);
  const t2 = Date.UTC(2026, 8, 11, 20, 10, 0);
  const tail = [
    "{ half a record",
    JSON.stringify(notification("aaa", t1)),
    JSON.stringify(notification("aaa", t2)),
  ].join("\n");
  assert.equal(notifiedAt(tail).get("aaa"), t2);
  assert.equal(notifiedAt(null).size, 0);
});

test("the activity line is the last tool called, else the last thing said, else nothing", () => {
  const tail = [assistantSaying("Reading the diff"), assistantCalling("Bash")].map((r) => JSON.stringify(r)).join("\n");
  assert.equal(lastActivity(tail), "Bash");
  assert.equal(lastActivity(JSON.stringify(assistantSaying("Reading the diff"))), "Reading the diff");
  assert.equal(lastActivity("not json at all"), null);
  assert.equal(lastActivity(null), null);
});

// ── background shells: which CLI session record is OURS ─────────────────────
// `~/.claude/sessions/<pid>.json` is the only place the CLI writes "shells are
// still running" (`status: "shell"`). Two live processes can hold the same
// conversation (a `--resume` of one open elsewhere), so the tmux target is the
// exact key and the conversation id counts only when it is unambiguous.
import { pickCliSession, readCliStatus } from "../dist/agents.js";

const alive = (pid) => pid !== 999;

test("pickCliSession: the tmux target wins over a shared conversation id", () => {
  const recs = [
    { pid: 1, sessionId: "c", tmux: "myapp_aaaa:@1.%1", status: "idle" },
    { pid: 2, sessionId: "c", tmux: "myapp_bbbb:@2.%2", status: "shell" },
  ];
  assert.equal(pickCliSession(recs, "myapp_bbbb", "c", alive)?.pid, 2);
  // a prefix of another session's name is not that session
  assert.equal(pickCliSession(recs, "myapp_bbb", "x", alive), null);
});

test("pickCliSession: conversation id only when exactly one live process claims it", () => {
  const recs = [
    { pid: 1, sessionId: "c", status: "idle" },
    { pid: 2, sessionId: "c", status: "shell" },
    { pid: 999, sessionId: "d", status: "shell" },
  ];
  assert.equal(pickCliSession(recs, null, "c", alive), null);
  assert.equal(pickCliSession(recs.slice(1), null, "c", alive)?.pid, 2);
  assert.equal(pickCliSession(recs, null, "d", alive), null, "a dead pid is nobody's status");
});

test("readCliStatus: reads the matched record's status, null when none matches", () => {
  const home = mkdtempSync(join(tmpdir(), "waterplane-clisess-"));
  process.env.WATERPLANE_CLAUDE_HOME = home;
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: "conv-1", tmux: "myapp_s1:@3.%3", status: "shell",
  }));
  writeFileSync(join(dir, "note.txt"), "not a record");
  assert.equal(readCliStatus("s1", "myapp_s1", undefined), "shell");
  assert.equal(readCliStatus("s2", null, "conv-1"), "shell");
  assert.equal(readCliStatus("s3", "myapp_s3", "other"), null);
});

test("readCliRecord: the same match, plus the pid shells.ts needs to find its wrappers", () => {
  const home = mkdtempSync(join(tmpdir(), "waterplane-clirec-"));
  process.env.WATERPLANE_CLAUDE_HOME = home;
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: "conv-1", tmux: "myapp_s1:@3.%3", status: "shell",
  }));
  assert.deepEqual(readCliRecord("s1", "myapp_s1", undefined), { status: "shell", pid: process.pid });
  assert.equal(readCliRecord("s3", "myapp_s3", "other"), null);
});

test("readCliRecord: with no tmux target, the cache never bypasses the 'exactly one live record' guard", () => {
  const home = mkdtempSync(join(tmpdir(), "waterplane-clirec-dup-"));
  process.env.WATERPLANE_CLAUDE_HOME = home;
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "dup", status: "busy" }));
  // Exactly one live record claims "dup" — matched. No tmux target, so this
  // must never populate the cache with a single file that a later call could
  // re-validate against itself and call that "exactly one".
  assert.deepEqual(readCliRecord("s4", null, "dup"), { status: "busy", pid: process.pid });
  // A second live process now claims the SAME conversation id — a `--resume`
  // of a conversation already open elsewhere. The guard can only see this by
  // rescanning the whole directory; re-validating one cached file would keep
  // returning the first record for ever.
  writeFileSync(join(dir, `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: "dup", status: "idle" }));
  assert.equal(readCliRecord("s4", null, "dup"), null, "ambiguous — nobody's status, not a stale single match");
});

test("readCliRecord: a tmux-target match IS cached, and stays exact", () => {
  const home = mkdtempSync(join(tmpdir(), "waterplane-clirec-cache-"));
  process.env.WATERPLANE_CLAUDE_HOME = home;
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: "conv-cache", tmux: "myapp_s5:@1.%1", status: "busy" }));
  assert.deepEqual(readCliRecord("s5", "myapp_s5", "conv-cache"), { status: "busy", pid: process.pid });
  // Flip the status on disk without adding or removing any file — the cached
  // path is re-read (never a stale in-memory copy of the record itself).
  writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: "conv-cache", tmux: "myapp_s5:@1.%1", status: "shell" }));
  assert.deepEqual(readCliRecord("s5", "myapp_s5", "conv-cache"), { status: "shell", pid: process.pid });
});
