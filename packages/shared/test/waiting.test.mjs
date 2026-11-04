/** `waiting.ts` — the one "waiting on you" predicate and `GET /api/attention`'s summary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionWaits, summarizeWaiting, parseWaitingSummary, waitingTotal, WAITING_IDS_MAX, WAITING_ITEMS_MAX } from "../dist/index.js";

const prompt = { question: "Proceed?", options: [] };

test("sessionWaits: a box, an unparsed dialog or a question turn on a running session", () => {
  assert.equal(sessionWaits({ running: true, prompt }), true);
  assert.equal(sessionWaits({ running: true, awaitingInput: true }), true);
  assert.equal(sessionWaits({ running: true, asking: { text: "which one?" } }), true);
  assert.equal(sessionWaits({ running: true }), false);
});

test("sessionWaits: not running or behind a wall is not waiting", () => {
  assert.equal(sessionWaits({ running: false, prompt }), false);
  assert.equal(sessionWaits({ running: true, prompt, signedOut: true }), false);
  assert.equal(sessionWaits({ running: true, awaitingInput: true, limit: { blocked: true, blockedSince: 1, resetAt: 2, nextAttemptAt: 3, attempts: 0 } }), false);
});

test("summarizeWaiting: waiting sessions, open attention newest first, handled and info left out", () => {
  const sessions = [
    { id: "a", running: true, prompt },
    { id: "b", running: true },
    { id: "c", running: true, awaitingInput: true, signedOut: true },
  ];
  const items = [
    { id: "1", ts: 10, kind: "approval", title: "vault: key", plugin: "vault", tag: "plugin-vault-ask:x", body: "secret words" },
    { id: "2", ts: 30, kind: "prompt", title: "newer", sessionId: "b" },
    { id: "3", ts: 40, kind: "approval", title: "answered", handled: { at: 41, by: "phone" } },
    { id: "4", ts: 50, kind: "done", title: "info only" },
  ];
  const w = summarizeWaiting(sessions, items, 99);
  assert.equal(w.ts, 99);
  assert.deepEqual(w.sessions, { n: 1, ids: ["a"] });
  assert.equal(w.attention.n, 2);
  assert.deepEqual(w.attention.items.map((i) => i.id), ["2", "1"]);
  assert.deepEqual(w.attention.items[1], { id: "1", ts: 10, kind: "approval", title: "vault: key", plugin: "vault", tag: "plugin-vault-ask:x" });
  assert.equal("body" in w.attention.items[1], false, "a line, never the body");
  assert.equal(waitingTotal(w), 3);
});

test("summarizeWaiting: a waiting session's own prompt item is the same wait, counted once", () => {
  const sessions = [{ id: "a", running: true, prompt }, { id: "b", running: true }];
  const items = [
    { id: "p-a", ts: 1, kind: "prompt", title: "a needs you", sessionId: "a" },
    { id: "p-b", ts: 2, kind: "prompt", title: "b needs you", sessionId: "b" },
    { id: "u-a", ts: 3, kind: "undelivered", title: "not delivered", sessionId: "a" },
  ];
  const w = summarizeWaiting(sessions, items, 0);
  assert.equal(w.sessions.n, 1);
  assert.deepEqual(w.attention.items.map((i) => i.id), ["u-a", "p-b"], "only the waiting session's prompt item folds");
  assert.equal(waitingTotal(w), 3);
});

test("summarizeWaiting: lists are capped, the counts are not", () => {
  const sessions = Array.from({ length: WAITING_IDS_MAX + 5 }, (_, i) => ({ id: `s${i}`, running: true, prompt }));
  const items = Array.from({ length: WAITING_ITEMS_MAX + 3 }, (_, i) => ({ id: `n${i}`, ts: i, kind: "prompt", title: "t" }));
  const w = summarizeWaiting(sessions, items, 0);
  assert.equal(w.sessions.n, WAITING_IDS_MAX + 5);
  assert.equal(w.sessions.ids.length, WAITING_IDS_MAX);
  assert.equal(w.attention.n, WAITING_ITEMS_MAX + 3);
  assert.equal(w.attention.items.length, WAITING_ITEMS_MAX);
});

test("parseWaitingSummary: a round trip, and a shape it cannot trust is null, never zero", () => {
  const w = summarizeWaiting([{ id: "a", running: true, prompt }], [{ id: "1", ts: 5, kind: "approval", title: "t", plugin: "vault" }], 7);
  assert.deepEqual(parseWaitingSummary(JSON.parse(JSON.stringify(w))), w);
  assert.equal(parseWaitingSummary(null), null);
  assert.equal(parseWaitingSummary({ ts: 1 }), null);
  assert.equal(parseWaitingSummary({ ts: 1, sessions: { n: -1, ids: [] }, attention: { n: 0, items: [] } }), null);
  assert.equal(parseWaitingSummary("<html>"), null);
});
