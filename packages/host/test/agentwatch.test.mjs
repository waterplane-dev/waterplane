/**
 * The large-subagent push: the decision, the once-per-agent memory, the
 * setting read at call time, and pruning when a session ends.
 *
 *     node --test packages/host/test/agentwatch.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_LARGE_TOK } from "@waterplane/shared";
import { createAgentWatch, shouldPushAgent } from "../dist/agentwatch.js";

const info = (over = {}, spark = {}) => ({
  id: "s1", title: "api work",
  contextSpark: { pts: [1], marks: [], peak: 1, liveAgentTok: 620_000, liveAgentId: "a1", liveAgentType: "general-purpose", ...spark },
  ...over,
});
const rig = (setting) => {
  const sent = [];
  const w = createAgentWatch({ notify: (kind, p) => sent.push({ kind, ...p }), setting: () => setting.v });
  return { w, sent };
};

test("shouldPushAgent: needs an id, a size at the line, and a first sight", () => {
  const seen = new Map();
  assert.equal(shouldPushAgent(seen, "s", "a", AGENT_LARGE_TOK - 1, AGENT_LARGE_TOK), false);
  assert.equal(shouldPushAgent(seen, "s", "a", AGENT_LARGE_TOK, AGENT_LARGE_TOK), true);
  assert.equal(shouldPushAgent(seen, "s", undefined, 900_000, AGENT_LARGE_TOK), false);
  assert.equal(shouldPushAgent(seen, "s", "a", undefined, AGENT_LARGE_TOK), false);
  seen.set("s", new Set(["a"]));
  assert.equal(shouldPushAgent(seen, "s", "a", 900_000, AGENT_LARGE_TOK), false);
  assert.equal(shouldPushAgent(seen, "s", "b", 900_000, AGENT_LARGE_TOK), true);
  assert.equal(shouldPushAgent(seen, "other", "a", 900_000, AGENT_LARGE_TOK), true);
});

test("pushes once per (session, agent), tagged, with the session id", () => {
  const { w, sent } = rig({});
  w.onUpdated(info());
  w.onUpdated(info());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "agent");
  assert.equal(sent[0].sessionId, "s1");
  assert.equal(sent[0].tag, "agent-s1");
  assert.match(sent[0].title, /api work: a general-purpose agent passed 620k/);
  w.onUpdated(info({}, { liveAgentId: "a2" }));
  assert.equal(sent.length, 2);
});

test("below the default line nothing is sent; a lower setting, read at call time, sends", () => {
  const setting = { v: undefined };
  const { w, sent } = rig(setting);
  w.onUpdated(info({}, { liveAgentTok: 300_000 }));
  assert.equal(sent.length, 0);
  setting.v = "250000";
  w.onUpdated(info({}, { liveAgentTok: 300_000 }));
  assert.equal(sent.length, 1);
  setting.v = "garbage";
  w.onUpdated(info({}, { liveAgentTok: 300_000, liveAgentId: "a9" }));
  assert.equal(sent.length, 1);
});

test("no spark, no live agent: silent; forget lets the same agent id speak again", () => {
  const { w, sent } = rig({});
  w.onUpdated({ id: "s1", title: "t" });
  w.onUpdated(info({}, { liveAgentId: undefined }));
  assert.equal(sent.length, 0);
  w.onUpdated(info());
  w.forget("s1");
  w.onUpdated(info());
  assert.equal(sent.length, 2);
});
