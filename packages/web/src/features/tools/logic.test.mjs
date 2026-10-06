import test from "node:test";
import assert from "node:assert/strict";

import { ACTION_IDS, OVERLAY_IDS, archiveStartRepo, knownFeatureIds, liveConversationIds } from "./logic.ts";

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
