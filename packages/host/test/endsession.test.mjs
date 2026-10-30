/**
 * Ending a session (`sessions/endsession.ts`) runs against a fake core — no PTY. Pins what a
 * real exit tears down: flags reset, timers cleared, agents/shells cleared with nothing re-armed,
 * the closed row written, one `updated` then `exit`, a resurrection offered last.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "waterplane-endsession-"));
process.env.CLAUDE_CONFIG_DIR = home;
const { endSession } = await import("../dist/sessions/endsession.js");
const { exitReport } = await import("../dist/sessions/tmux.js");
const { finalizeCapture } = await import("../dist/sessions/record.js");
const { checkAgents, retireAgentPoll } = await import("../dist/sessions/agentpoll.js");
const { resolveBackend } = await import("../dist/backends/index.js");

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); };
after(() => { console.log = realLog; });

function fixture(over = {}) {
  const calls = [];
  const events = [];
  const s = {
    info: { id: "s1", title: "t", cwd: home, createdAt: Date.now(), running: true, turnActive: true,
      prompt: { x: 1 }, awaitingInput: true, asking: {}, cliSuggestion: "x", login: {}, links: [1], awaitingCode: true,
      claudeSessionId: "conv-1", agents: [{ id: "a" }], shells: true, shellList: [{ id: "x" }] },
    backend: resolveBackend("claude"), turnActive: true, agentTimer: null, history: [], capturing: null,
    // Short and unref'd: a timer endSession fails to clear must fire inside the test, never hold the process.
    promptTimer: setTimeout(() => calls.push("promptTimerFired"), 20).unref(),
    idleTimer: setTimeout(() => calls.push("idleTimerFired"), 20).unref(),
    screenLog: { dispose: () => calls.push("screenLog.dispose") },
    ...over,
  };
  const sessions = new Map([["s1", s]]);
  const core = {
    sessions,
    emit: (...a) => { calls.push(`emit:${a[0]}`); events.push(a); return true; },
    retireAgentPoll: (x) => { calls.push("retireAgentPoll"); retireAgentPoll(x); },
    checkAgents: (x) => { calls.push("checkAgents"); checkAgents(core, x); },
    clearStopVerify: () => calls.push("clearStopVerify"),
    clearLimitTimer: () => calls.push("clearLimitTimer"),
    stopClaudeIdWatch: () => calls.push("stopClaudeIdWatch"),
    detectClaudeId: () => { calls.push("detectClaudeId"); return null; },
    adoptClaudeId: () => calls.push("adoptClaudeId"),
    detectBackendId: () => null, adoptBackendId: () => calls.push("adoptBackendId"),
    deleteLive: (id) => calls.push(`deleteLive:${id}`),
    closedRowOf: (x, alive, exit) => { calls.push(`closedRowOf:${exit.by}`); return { id: x.info.id, by: exit.by }; },
    pushClosed: (row) => { calls.push("pushClosed"); events.push(["closed", row]); },
    maybeScheduleResurrect: () => calls.push("maybeScheduleResurrect"),
    finalizeCapture: (x) => { calls.push("finalizeCapture"); finalizeCapture(core, x); },
  };
  // The facade formats the line from the info as it stood at exit; built here the same way.
  // Read when endSession reads it — its first line — so a test that swaps `s.info` gets its own line.
  const facts = { get exitLine() { return exitReport(s.info, 0, null, s.backend.bin()); }, exitCode: 0, signal: null, diedAtLimit: () => false };
  return { s, core, calls, events, facts };
}

test("exit: the session stops running, nothing is pending, nothing is armed", () => {
  const { s, core, facts } = fixture();
  endSession(core, s, facts);
  assert.equal(s.info.running, false);
  assert.equal(s.turnActive, false);
  assert.equal(s.info.turnActive, false);
  assert.equal(s.info.prompt, null);
  assert.equal(s.info.awaitingInput, undefined);
  assert.equal(s.info.asking, null);
  assert.equal(s.info.cliSuggestion, null);
  assert.equal(s.info.login, null);
  assert.ok(!("links" in s.info) && !("awaitingCode" in s.info));
  assert.equal(s.agentTimer, null, "no agent poll is armed");
  assert.equal(s.info.agents, undefined);
  assert.equal(s.info.shells, undefined);
  assert.equal(s.info.shellList, undefined);
});

test("exit: the timers it is given are cleared (they never fire)", async () => {
  const { s, core, calls, facts } = fixture();
  const given = [s.promptTimer, s.idleTimer];
  const cleared = [];
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = (t) => { cleared.push(t); return realClear(t); };
  try { endSession(core, s, facts); } finally { globalThis.clearTimeout = realClear; }
  assert.deepEqual(given.filter((t) => cleared.includes(t)), given, "endSession cleared both handles it was given");
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!calls.includes("promptTimerFired") && !calls.includes("idleTimerFired"));
});

test("exit: the capture is sealed, the exit is logged, and another backend's conversation id is adopted", () => {
  const { s, core, calls, facts } = fixture({ capturing: "h1", captureBuf: "", cols: 80, history: [{ id: "h1" }],
    backend: { bin: () => "fakecli", caps: {}, facts: { transcript: [{ store: "fake-store" }] } } });
  s.info.backendSessionId = undefined;
  logs.length = 0;
  endSession(core, s, facts);
  assert.equal(s.capturing, null, "finalizeCapture ran");
  assert.ok(logs.some((l) => l.includes("session exit · ") && l.includes("(s1)") && l.includes("code 0")), "the exitReport line was written");
  assert.ok(calls.includes("adoptBackendId"), "the backend-id branch was taken");
});

test("exit: a backend with no store reader of its own is not asked for a backend id", () => {
  const { s, core, calls, facts } = fixture();
  endSession(core, s, facts);
  assert.ok(!calls.includes("adoptBackendId"));
});

test("exit: teardown order — recorder, polls, watches, ids, live record, closed row, updated, exit, resurrection", () => {
  const { s, core, calls, facts } = fixture({ info: undefined });
  s.info = { id: "s1", title: "t", cwd: home, createdAt: Date.now(), running: true }; // no conversation id yet
  endSession(core, s, facts);
  const o = (x) => { const i = calls.indexOf(x); assert.ok(i >= 0, `${x} ran`); return i; };
  const chain = ["screenLog.dispose", "finalizeCapture", "retireAgentPoll", "checkAgents", "clearStopVerify", "clearLimitTimer", "stopClaudeIdWatch",
    "detectClaudeId", "adoptClaudeId", "deleteLive:s1", "closedRowOf:exited", "pushClosed", "emit:updated", "emit:exit", "maybeScheduleResurrect"];
  const idx = chain.map(o);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "the order holds");
  assert.equal(calls.filter((c) => c === "emit:updated").length, 1, "nothing to clear, so only the final update");
  assert.ok(calls.indexOf("retireAgentPoll") + 1 === calls.indexOf("checkAgents"));
});

test("exit: a conversation id already known is not re-detected", () => {
  const { s, core, calls, facts } = fixture();
  endSession(core, s, facts);
  assert.ok(!calls.includes("detectClaudeId"));
});

test("exit: who closed it — a kill is not 'exited', a limit death is 'limit', a named closer wins", () => {
  for (const [over, died, by] of [[{ killed: true }, false, "undefined"], [{}, true, "limit"], [{}, false, "exited"], [{ closeBy: "phone" }, true, "phone"]]) {
    const { s, core, calls, facts } = fixture(over);
    endSession(core, s, { ...facts, diedAtLimit: () => died });
    assert.ok(calls.includes(`closedRowOf:${by}`), `${JSON.stringify(over)} died=${died} => ${by}`);
  }
});

test("exit: shown agents are cleared through checkAgents, which publishes once; the final update is the second", () => {
  const { s, core, calls, facts } = fixture();
  endSession(core, s, facts);
  assert.equal(calls.filter((c) => c === "emit:updated").length, 2);
});
