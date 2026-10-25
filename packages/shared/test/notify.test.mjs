// Which notification kinds may fire (`shared/src/index.ts`). The rule is
// sparse-by-design: a stored preference names only the kinds the user has
// touched, so a kind added in a later version must arrive with ITS OWN default
// rather than muted by a file written before it existed.
import test from "node:test";
import assert from "node:assert/strict";
import { NOTIFICATION_KINDS, NOTIFY_DEFAULT_OFF, cleanNotifyPrefs, notifyEnabled } from "../dist/index.js";

test("everything is on by default except the per-turn ping", () => {
  for (const kind of NOTIFICATION_KINDS) {
    assert.equal(notifyEnabled({}, kind), kind !== "idle", kind);
  }
  assert.deepEqual([...NOTIFY_DEFAULT_OFF], ["idle"]);
});

test("no prefs at all is the same as empty prefs — a fresh host is not silent", () => {
  assert.equal(notifyEnabled(null, "prompt"), true);
  assert.equal(notifyEnabled(undefined, "limit"), true);
  assert.equal(notifyEnabled(null, "idle"), false);
});

test("an explicit choice beats the default, in both directions", () => {
  assert.equal(notifyEnabled({ idle: true }, "idle"), true);
  assert.equal(notifyEnabled({ prompt: false }, "prompt"), false);
});

test("a kind nobody has touched keeps its default while others are set", () => {
  const prefs = { idle: true, backlog: false };
  assert.equal(notifyEnabled(prefs, "prompt"), true);
  assert.equal(notifyEnabled(prefs, "backlog"), false);
});

test("the store is cleaned on the way in — hand-edited JSON cannot invent a kind", () => {
  const clean = cleanNotifyPrefs({ idle: true, nonsense: false, prompt: "yes", limit: 0 });
  assert.deepEqual(clean, { idle: true });
});

test("a non-object (corrupt file, array, null) cleans to no preferences at all", () => {
  for (const bad of [null, undefined, 7, "idle", [1, 2]]) {
    assert.deepEqual(cleanNotifyPrefs(bad), {});
  }
});

// Two levels (owner, 2026-10-25): only `attention` counts on the bell and is
// pushed. The table below IS the plan's level map — a change here is a
// decision, not a fix (.claude/outbox/notifications-attention-plan.md §1).
import { ATTENTION_KINDS, notifyLevel, levelOf, needsYou, gitAttentionKey, buildAttentionKey } from "../dist/index.js";

test("the kinds that wait on a person default to attention; every other kind is information", () => {
  assert.deepEqual([...ATTENTION_KINDS], ["prompt", "approval", "cli", "disk", "undelivered", "followup"]);
  for (const kind of NOTIFICATION_KINDS) {
    assert.equal(notifyLevel(kind), ATTENTION_KINDS.includes(kind) ? "attention" : "info", kind);
  }
});

test("a known outcome beats the kind: failed is attention, ok is information", () => {
  assert.equal(notifyLevel("backlog", "failed"), "attention");
  assert.equal(notifyLevel("git", "failed"), "attention");
  assert.equal(notifyLevel("info", "failed"), "attention");
  assert.equal(notifyLevel("git", "ok"), "info");
  assert.equal(notifyLevel("limit", "ok"), "info");
});

test("an explicit level from the call site wins over both", () => {
  assert.equal(notifyLevel("followup", undefined, "info"), "info");
  assert.equal(notifyLevel("info", "ok", "attention"), "attention");
  assert.equal(notifyLevel("prompt", undefined, /** @type {any} */ ("loud")), "attention");
});

test("an item from an older host (no level) is judged by the same rule over its kind", () => {
  assert.equal(levelOf({ kind: "prompt" }), "attention");
  assert.equal(levelOf({ kind: "artifact" }), "info");
  assert.equal(levelOf({ kind: "artifact", level: "attention" }), "attention");
});

test("needsYou: unhandled attention only", () => {
  assert.equal(needsYou({ kind: "prompt" }), true);
  assert.equal(needsYou({ kind: "prompt", handled: { at: 1, by: "person" } }), false);
  assert.equal(needsYou({ kind: "backlog", level: "info" }), false);
  assert.equal(needsYou({ kind: "git", level: "attention" }), true);
});

test("attention keys are spelled once, per repo and verb / build entry", () => {
  assert.equal(gitAttentionKey("r1", "push"), "git:r1:push");
  assert.notEqual(gitAttentionKey("r1", "push"), gitAttentionKey("r1", "pull"));
  assert.equal(buildAttentionKey("r1", "apk"), "build:r1:apk");
});
