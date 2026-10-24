// The conversation-binding ladder a backend plugin calls through `api.bindConversation`: moved
// from opencode's `ocIdVerdict`/`pickOcSession` (their cases, same assertions, `ownRow` renamed
// `createsRecord`). Pure: no store, no PTY.
import test from "node:test";
import assert from "node:assert/strict";
import { BIND_CONFIRM_MS, bindConversation, pickBound } from "../dist/index.js";

test("exactly one candidate is adopted; zero or several stay ABSENT", () => {
  const none = new Set();
  assert.equal(pickBound(["a"], none), "a");
  assert.equal(pickBound([], none), null);
  assert.equal(pickBound(["a", "b"], none), null, "a tie is a fact, never 'the newest'");
  assert.equal(pickBound(["a", "a"], none), "a");
  assert.equal(pickBound(["a", "b"], new Set(["b"])), "a");
  assert.equal(pickBound(["a"], new Set(["a"])), null);
});

test("the structural rung is offered only to a launch that created a record", () => {
  const look = (extra) => bindConversation({ createsRecord: false, fresh: [], prompt: [], adopted: new Set(), now: 1_000_000, ...extra });
  assert.equal(look({ createsRecord: true, fresh: ["new"] }).id, "new");
  assert.equal(look({ createsRecord: false, fresh: ["new"] }).id, null);
  assert.equal(look({ createsRecord: false, fresh: ["a", "b"] }).id, null);
});

test("a rung-2 match is adopted only once it has stood for a second look", () => {
  const now = 5_000_000;
  const base = { createsRecord: false, fresh: [], prompt: ["x"], adopted: new Set() };
  const first = bindConversation({ ...base, now });
  assert.equal(first.id, null);
  assert.deepEqual(first.seen, { id: "x", at: now });
  assert.equal(bindConversation({ ...base, seen: first.seen, now: now + 500 }).id, null);
  assert.equal(bindConversation({ ...base, seen: first.seen, now: now + BIND_CONFIRM_MS }).id, "x");
  const tied = bindConversation({ ...base, prompt: ["x", "ours"], seen: first.seen, now: now + 5_000 });
  assert.equal(tied.id, null);
  assert.equal(tied.seen, null);
});

test("an adoption ends the discovery, and a different match restarts its clock", () => {
  const now = 9_000_000;
  const seen = { id: "old", at: now - 60_000 };
  const moved = bindConversation({ createsRecord: false, fresh: [], prompt: ["new"], adopted: new Set(), seen, now });
  assert.equal(moved.id, null);
  assert.deepEqual(moved.seen, { id: "new", at: now });
  const won = bindConversation({ createsRecord: true, fresh: ["f"], prompt: ["p"], adopted: new Set(), seen, now });
  assert.equal(won.id, "f");
  assert.equal(won.seen, null);
});
