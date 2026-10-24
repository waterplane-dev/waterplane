/**
 * Review R4: a plugin backend's `create()` awaits `prepare()` before the session is registered, so
 * for that window a fired row's session is not in `autoSessionCount()` yet. The slot figure the
 * ladder reads must count those in-flight opens, or a tick inside the window over-admits one.
 */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { startingSlotCount } = await import("../dist/server/intentDeps.js");

const row = (over) => ({ id: "r", state: "starting", cwd: "/r", target: { kind: "repo", fresh: true }, ...over });

test("a starting row that opens a session counts until its session is live", () => {
  const live = new Set(["s-live"]);
  const isLive = (id) => live.has(id);
  assert.equal(startingSlotCount([row({})], isLive), 1, "prepare() still pending: no session id yet");
  assert.equal(startingSlotCount([row({ sessionId: "s-live" })], isLive), 0, "its session exists — autoSessionCount has it");
  assert.equal(startingSlotCount([row({ sessionId: "s-dead" })], isLive), 1, "an id that is not live yet is not counted twice, nor missed");
  assert.equal(startingSlotCount([row({ state: "running" })], isLive), 0, "running rows ran past the create");
  assert.equal(startingSlotCount([row({ state: "queued" })], isLive), 0);
  assert.equal(startingSlotCount([row({ target: { kind: "session", sessionId: "s-live" } })], isLive), 0, "a row typing into an existing session opens none");
  assert.equal(startingSlotCount([row({ id: "a" }), row({ id: "b" })], isLive), 2);
});
