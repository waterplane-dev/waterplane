/**
 * A live session's label follows `/model` and `/effort` typed since launch.
 *
 *     node --test packages/web/src/liveLaunch.test.mjs
 *
 * Reported from a phone: the header read `opus · medium` after `/model fable`
 * and `/effort high` had landed and a turn had run on both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { liveLaunch } from "./liveLaunch.ts";

test("the newest turn's model and effort beat the launch flags", () => {
  const s = liveLaunch({ model: "opus", effort: "medium", turnModel: "claude-fable-5-1", turnEffort: "high" });
  assert.equal(s.model, "fable");
  assert.equal(s.effort, "high");
});

test("the same family keeps the launch spelling, [1m] included", () => {
  assert.equal(liveLaunch({ model: "opus[1m]", turnModel: "claude-opus-5-5" }).model, "opus[1m]");
});

test("no turn yet is the launch flags, untouched", () => {
  const s = { model: "opus", effort: "medium" };
  assert.equal(liveLaunch(s), s);
});

test("an effort-only reading moves only the effort", () => {
  const s = liveLaunch({ model: "opus", effort: "medium", turnEffort: "high" });
  assert.deepEqual([s.model, s.effort], ["opus", "high"]);
});

test("an id with no family word is shown, not guessed", () => {
  assert.equal(liveLaunch({ model: "opus", turnModel: "gpt-x" }).model, "gpt-x");
});
