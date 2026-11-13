// MCP tasks and background agents are counted and named apart, once, for host and phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_TASK_TYPE, isMcpTask, runningCounts, runningWords } from "../dist/runningwords.js";

test("runningWords names agents and MCP tasks apart", () => {
  const mcp = { type: MCP_TASK_TYPE };
  assert.equal(isMcpTask(mcp), true);
  assert.equal(isMcpTask({ type: "general-purpose" }), false);
  assert.deepEqual(runningCounts([{}, mcp, mcp]), { agents: 1, mcp: 2 });
  assert.equal(runningWords([{}, mcp, mcp]), "1 agent + 2 MCP tasks");
  assert.equal(runningWords([mcp], true), "1 MCP task + shells");
  assert.equal(runningWords([{}, {}]), "2 agents");
  assert.equal(runningWords(undefined), "");
  assert.equal(runningWords([], true), "shells");
});
