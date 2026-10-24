// "Restart when idle" (`logic.ts`): fires only when a restart would stop
// nothing and nothing queued is still headed into the session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { armVerdict } from "./logic.ts";

const s = (o = {}) => ({ id: "a", cwd: "/r", title: "t", cliVersion: "2.1.10", ...o });

test("idle, nothing queued: fire", () => {
  assert.equal(armVerdict(s(), "2.1.12", "2.1.12", "conv", 0), "fire");
});

test("a running turn, an agent, shells or a queued message: wait", () => {
  assert.equal(armVerdict(s({ turnActive: true }), "2.1.12", "2.1.12", "conv", 0), "wait");
  assert.equal(armVerdict(s({ agents: [{}] }), "2.1.12", "2.1.12", "conv", 0), "wait");
  assert.equal(armVerdict(s({ shells: true }), "2.1.12", "2.1.12", "conv", 0), "wait");
  assert.equal(armVerdict(s(), "2.1.12", "2.1.12", "conv", 1), "wait");
});

test("already on the new version, or a different install now: drop", () => {
  assert.equal(armVerdict(s({ cliVersion: "2.1.12" }), "2.1.12", "2.1.12", "conv", 0), "drop");
  assert.equal(armVerdict(s(), "2.1.12", "2.1.13", "conv", 0), "drop");
  assert.equal(armVerdict(s(), "2.1.12", undefined, "conv", 0), "drop");
});

test("no conversation id to resume: drop, never a fresh start", () => {
  assert.equal(armVerdict(s(), "2.1.12", "2.1.12", undefined, 0), "drop");
});
