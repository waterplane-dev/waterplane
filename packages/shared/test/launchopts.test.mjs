/**
 * `cleanLaunchOpts` — a launch as it may be STORED on a deferred row, a
 * schedule's action or a `backlog.add`: rebuilt from the five `LaunchOpts`
 * fields, a value the CLI would not take dropped (never guessed), and nothing
 * left at all reading as the new-session defaults.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanAction, cleanIntentRow, cleanLaunchOpts } from "../dist/index.js";

test("the five fields survive; anything else, or a value the CLI has no word for, is dropped", () => {
  const full = { model: "claude-opus-5[1m]", effort: "xhigh", permissionMode: "plan", remoteControlled: true, backend: "localrun" };
  assert.deepEqual(cleanLaunchOpts(full), full);
  assert.deepEqual(cleanLaunchOpts({ model: " ollama/qwen3-coder:30b ", effort: "turbo", permissionMode: "yolo", remoteControlled: "yes", rogue: 1 }),
    { model: "ollama/qwen3-coder:30b" });
  assert.equal(cleanLaunchOpts({ model: "two words" }), undefined, "a space is not a model");
  assert.equal(cleanLaunchOpts({}), undefined, "an empty object is not a choice");
  for (const v of [null, undefined, "opus", 3, ["opus"]]) assert.equal(cleanLaunchOpts(v), undefined);
});

test("an intent row's launch is cleaned on the way in, and absent stays absent", () => {
  const row = (launch) => cleanIntentRow({
    id: "l1", cwd: "/r", payload: { kind: "prompt", steps: ["go"] }, target: { kind: "repo" },
    trigger: { kind: "idle" }, state: "queued", createdAt: 1, ...(launch !== undefined ? { launch } : {}),
  }, 2);
  assert.deepEqual(row({ model: "sonnet", effort: "low", junk: true }).launch, { model: "sonnet", effort: "low" });
  assert.equal(row(undefined).launch, undefined);
  assert.equal(row(null).launch, undefined, "null (a patch's clear) is the defaults");
});

test("a schedule's backlog action keeps its launch, cleaned like the sweep's", () => {
  const base = { kind: "backlog", repoDir: "/r", text: "groom" };
  assert.deepEqual(cleanAction({ ...base, launch: { model: "haiku", effort: "nope" } }).launch, { model: "haiku" });
  assert.equal("launch" in cleanAction(base), false, "a rule with no launch is written exactly as it always was");
  assert.deepEqual(cleanAction({ kind: "fanout", dirs: ["/a"], text: "t", launch: { model: "opus", x: 1 } }).launch, { model: "opus" });
});
