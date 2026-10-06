import test from "node:test";
import assert from "node:assert/strict";

import { explainCostPrompt } from "./explainCost.ts";

test("the explain-the-cost prompt names the transcript and forbids changes", () => {
  const p = explainCostPrompt({ title: "myapp · fix", cwd: "/Users/x/dev/myapp", claudeSessionId: "abc-123", model: "opus" });
  assert.ok(p);
  assert.match(p, /Do NOT implement anything/);
  assert.match(p, /abc-123\.jsonl/);
  assert.match(p, /\/Users\/x\/dev\/myapp/);
  assert.match(p, /model: opus/);
  assert.match(p, /ask me which/);
});

test("no conversation id is no prompt, never a guess", () => {
  assert.equal(explainCostPrompt({ title: "t", cwd: "/x" }), null);
  assert.equal(explainCostPrompt({ title: "t", cwd: "/x", claudeSessionId: " " }), null);
});
