import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_IDS, OVERLAY_IDS, archiveBackendHint, archiveBackends, archiveStartRepo, knownFeatureIds, liveConversationIds, liveSessionFor,
} from "./logic.ts";

const desc = (id, label, caps = {}, extra = {}) => ({ id, label, caps, ...extra });

test("archive backends: no frame, or an empty one, is claude alone (no chip row)", () => {
  assert.deepEqual(archiveBackends(null), [{ id: "claude", label: "Claude Code" }]);
  assert.deepEqual(archiveBackends([]), [{ id: "claude", label: "Claude Code" }]);
});

test("archive backends: claude first, then only backends whose facts include conversations, in frame order", () => {
  const frame = [
    desc("bravo", "Bravo"), // fact absent: never a tab
    desc("acme", "Acme", { conversations: true }),
    desc("shell", "Shell", { conversations: true }, { kind: "shell" }),
    desc("claude", "Claude Code (desk)", { conversations: true }),
    desc("delta", "Delta", { conversations: false }),
  ];
  assert.deepEqual(archiveBackends(frame), [
    { id: "claude", label: "Claude Code (desk)" },
    { id: "acme", label: "Acme" },
  ]);
});

test("the non-claude hint names the backend's own label and says what is not offered", () => {
  const h = archiveBackendHint("Acme");
  assert.match(h, /one Acme wrote; resuming one starts Acme\./);
  assert.match(h, /forking and bookmarks are not offered for Acme yet/);
});

test("live conversation ids include a plugin session's backendSessionId", () => {
  const s = liveConversationIds([{ claudeSessionId: "c1" }, { backendSessionId: "p1" }, {}]);
  assert.deepEqual([...s].sort(), ["c1", "p1"]);
});

test("a session with neither id contributes nothing", () => {
  assert.equal(liveConversationIds([{}, { claudeSessionId: undefined, backendSessionId: undefined }]).size, 0);
});

test("the live session for a conversation is found by either id", () => {
  const a = { id: "a", claudeSessionId: "c1" };
  const b = { id: "b", backendSessionId: "p1" };
  assert.equal(liveSessionFor([a, b], "c1"), a);
  assert.equal(liveSessionFor([a, b], "p1"), b);
  assert.equal(liveSessionFor([a, b], "zz"), undefined);
});

test("the catalog prefixes every id the way track() records it, toolbar ids first", () => {
  const ids = knownFeatureIds(["diff", "model"]);
  assert.deepEqual(ids.slice(0, 2), ["toolbar:diff", "toolbar:model"]);
  assert.ok(ids.includes("overlay:storage"));
  assert.ok(ids.includes("action:speedtest.run"));
  assert.equal(ids.length, 2 + OVERLAY_IDS.length + ACTION_IDS.length);
});

test("every overlay this feature owns is in the catalog, so it can read zero uses", () => {
  for (const o of ["speedtest", "secret", "features", "storage", "nethealth", "localrt", "archive", "context", "fanout", "toolbar", "hdrcmd", "snippets"]) {
    assert.ok(OVERLAY_IDS.includes(o), o);
  }
});

test("the assessment's generated ids are in the catalog", () => {
  assert.ok(ACTION_IDS.includes("assess.run"));
  assert.ok(ACTION_IDS.some((a) => a.startsWith("assess.bulk.")));
});

test("live conversation ids skip sessions with no conversation id", () => {
  const s = liveConversationIds([{ claudeSessionId: "a" }, {}, { claudeSessionId: "b" }, { claudeSessionId: "a" }]);
  assert.deepEqual([...s].sort(), ["a", "b"]);
});

test("the archive opens on the repo in context, else the first listed, else nothing", () => {
  assert.equal(archiveStartRepo("r2", ["r1", "r2"]), "r2");
  assert.equal(archiveStartRepo(null, ["r1", "r2"]), "r1");
  assert.equal(archiveStartRepo(undefined, []), "");
});
