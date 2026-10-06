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
