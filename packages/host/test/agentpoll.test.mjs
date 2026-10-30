/**
 * The agent poll's owner lifecycle (bughunt 2026-10-29 HS-1): a session that stops being the
 * live one (detach, remove) retires its poll — an in-flight `ps` read publishes nothing and
 * arms nothing, and no timer is left behind.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "waterplane-agentpoll-"));
process.env.CLAUDE_CONFIG_DIR = home;
mkdirSync(join(home, "sessions"), { recursive: true });
const { checkAgents, retireAgentPoll, agentPollSeams } = await import("../dist/sessions/agentpoll.js");
const { resolveBackend } = await import("../dist/backends/index.js");
const { tmuxName } = await import("../dist/sessions/knobs.js");
writeFileSync(join(home, "sessions", `${process.pid}.json`), JSON.stringify({
  pid: process.pid, sessionId: "conv-poll", tmux: `${tmuxName("s1")}:@1.%1`, status: "busy",
}));

function fixture() {
  const s = {
    info: { id: "s1", cwd: home, running: true, claudeSessionId: "conv-poll" },
    backend: resolveBackend("claude"), agentTimer: null, turnActive: true, spawnedAt: Date.now(),
  };
  const events = [];
  const sessions = new Map([["s1", s]]);
  const core = { sessions, emit: (...a) => events.push(a) };
  return { s, core, events, sessions };
}
function holdPs() {
  let release;
  const gate = new Promise((r) => { release = r; });
  agentPollSeams.readPs = () => gate.then(() => []);
  return release;
}
const realPs = agentPollSeams.readPs;
after(() => { agentPollSeams.readPs = realPs; });
const tick = () => new Promise((r) => setImmediate(r));

test("pin: a live session's in-flight read publishes and re-arms its timer", async () => {
  const { s, core } = fixture();
  s.info.claudeSessionId = "conv-poll";
  const release = holdPs();
  checkAgents(core, s);
  assert.equal(s.agentTimer, null);
  release(); await tick(); await tick();
  assert.ok(s.agentTimer, "turn is active: the poll re-arms");
  retireAgentPoll(s);
  assert.equal(s.agentTimer, null);
});

for (const how of ["retired", "removed from the map only"]) {
  test(`HS-1: ${how} while the ps read is in flight => no publish, no timer`, async () => {
    const { s, core, events, sessions } = fixture();
    const release = holdPs();
    checkAgents(core, s);
    sessions.delete("s1");
    if (how === "retired") retireAgentPoll(s);
    release(); await tick(); await tick();
    assert.equal(s.agentTimer, null);
    assert.deepEqual(events, []);
  });
}

test("HS-1: a pending timer whose session left the map does not poll again", async () => {
  const { s, core, sessions } = fixture();
  agentPollSeams.readPs = async () => [];
  checkAgents(core, s); await tick(); await tick();
  assert.ok(s.agentTimer);
  sessions.delete("s1");
  checkAgents(core, s); // a stray call from a retired owner
  assert.equal(s.agentTimer, null, "the stray call retires instead of re-arming");
});

test("exit: an exited session still in the map has its agents/shells cleared and no timer armed", () => {
  const { s, core, events } = fixture();
  s.info.agents = [{ id: "a" }]; s.info.shells = true; s.info.shellList = [{ id: "x" }];
  s.info.running = false;
  retireAgentPoll(s);
  checkAgents(core, s); // what the exit path now calls
  assert.equal(s.info.agents, undefined);
  assert.equal(s.info.shells, undefined);
  assert.equal(s.info.shellList, undefined);
  assert.equal(s.agentTimer, null);
  assert.equal(events.length, 1);
});
