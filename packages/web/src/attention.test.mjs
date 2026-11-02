/**
 * The one bucketing function (`sessionStatus`) and the cut both a launcher
 * chip and its sheet make (`attentionCut`): a count on a control is a filter,
 * so the chip's number and the sheet's rows must be one array.
 *
 *     node --test packages/web/src/attention.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTENTION_NOUN, BLOCK_GROUPS, BLOCK_WORD, attentionCut, attentionTitle, blockedGroups, cutWords, listedBlockOf, sessionStatus, waitShapes,
} from "./attention.ts";

const ses = (id, o = {}) => ({ id, cwd: `/dev/${o.repo ?? "app"}`, title: id, running: true, idle: true, createdAt: 1, ...o });
const limit = (o = {}) => ({
  blocked: true, blockedSince: 100, resetAt: null, nextAttemptAt: 500, attempts: 0, weekly: false, autoContinue: true,
  autoContinueOverride: null, queuePos: 1, resuming: false, first: false, ...o,
});
const net = (o = {}) => ({ state: "waiting", attempt: 1, max: 8, nextAt: 900, error: "Connection error.", at: 50, ...o });
const box = { kind: "choice", question: "Proceed?", options: [] };

test("the ladder: exited < blocked (all four kinds) > waiting > done > coding, one bucket each", () => {
  assert.equal(sessionStatus(ses("x", { running: false })), "exited");
  assert.equal(sessionStatus(ses("a", { signedOut: true })), "blocked");
  assert.equal(sessionStatus(ses("l", { login: { url: "https://x", awaitingCode: false, at: 1 } })), "blocked");
  assert.equal(sessionStatus(ses("s", { limit: limit({ spend: true }) })), "blocked");
  assert.equal(sessionStatus(ses("u", { limit: limit() })), "blocked");
  assert.equal(sessionStatus(ses("n", { netRetry: net() })), "blocked");
  // A wall outside the session outranks a box on screen behind it.
  assert.equal(sessionStatus(ses("ub", { limit: limit(), prompt: box })), "blocked");
  assert.equal(sessionStatus(ses("w", { prompt: box })), "wait");
  assert.equal(sessionStatus(ses("d", { awaitingInput: true })), "wait");
  assert.equal(sessionStatus(ses("q", { asking: { text: "which one?", at: 1 } })), "wait");
  assert.equal(sessionStatus(ses("i")), "done");
  assert.equal(sessionStatus(ses("c", { idle: false })), "coding");
  assert.equal(sessionStatus(ses("ag", { agents: [{ what: "x" }] })), "coding");
});

test("an exited session is blocked only while the host still holds it in the resume queue", () => {
  assert.equal(sessionStatus(ses("q", { running: false, limit: limit({ queuePos: 2 }) })), "blocked", "reopens with --continue at the reset");
  assert.equal(sessionStatus(ses("r", { running: false, limit: limit({ queuePos: null, resuming: true }) })), "blocked");
  assert.equal(sessionStatus(ses("p", { running: false, limit: limit({ queuePos: null }) })), "exited", "nothing will reopen it");
  assert.equal(sessionStatus(ses("a", { running: false, signedOut: true })), "exited", "a sign-in or a retry needs a live session");
  assert.equal(sessionStatus(ses("n", { running: false, netRetry: net() })), "exited");
  assert.equal(listedBlockOf(ses("p", { running: false, limit: limit({ queuePos: null }) })), null);
});

test("attentionCut: the chip's number IS the sheet's rows — one array, and N counts the hidden ones", () => {
  const list = [
    ses("w1", { prompt: box }), ses("w2", { asking: { text: "ok?", at: 1 } }), ses("w3", { repo: "hidden", awaitingInput: true }),
    ses("b1", { signedOut: true }), ses("b2", { netRetry: net() }), ses("b3", { repo: "hidden", limit: limit() }),
    ses("b4", { running: false, limit: limit({ queuePos: 3 }) }),
    ses("x", { running: false, prompt: box }), // an exited session's stale box is not waiting
    ses("i"),
  ];
  const inView = (cwd) => cwd !== "/dev/hidden";
  const wait = attentionCut(list, "wait", null, inView);
  assert.deepEqual(wait.shown.map((s) => s.id), ["w1", "w2"]);
  assert.deepEqual(wait.all.map((s) => s.id), ["w1", "w2", "w3"]);
  const blocked = attentionCut(list, "blocked", null, inView);
  assert.deepEqual(blocked.shown.map((s) => s.id), ["b1", "b2", "b4"]);
  assert.equal(blocked.all.length, 4);

  // The sheets PARTITION what they are handed: their cards add up to the chip.
  const groups = blockedGroups(blocked.shown);
  assert.deepEqual([...groups.keys()], [...BLOCK_GROUPS]);
  assert.equal([...groups.values()].reduce((n, g) => n + g.length, 0), blocked.shown.length);
  assert.deepEqual(groups.get("auth").map((s) => s.id), ["b1"]);
  assert.deepEqual(groups.get("net").map((s) => s.id), ["b2"]);
  assert.deepEqual(groups.get("limit").map((s) => s.id), ["b4"]);
  const shapes = waitShapes(wait.all);
  assert.equal(shapes.asked.length + shapes.unreadable.length + shapes.inProse.length, wait.all.length);
  assert.deepEqual(shapes.unreadable.map((s) => s.id), ["w3"]);
  assert.deepEqual(shapes.inProse.map((s) => s.id), ["w2"]);
});

test("the per-repo roll-up and the global chip bucket the same way", () => {
  const list = [ses("a", { prompt: box }), ses("b", { signedOut: true }), ses("c", { netRetry: net({ state: "gaveup", nextAt: null }) })];
  const byStatus = (k) => list.filter((s) => sessionStatus(s) === k).length;
  assert.equal(byStatus("wait"), attentionCut(list, "wait", null, () => true).shown.length);
  assert.equal(byStatus("blocked"), attentionCut(list, "blocked", null, () => true).shown.length);
});

test("n of N: said only when the sheet hides some", () => {
  const a = ses("a", { signedOut: true });
  const b = ses("b", { signedOut: true, repo: "hidden" });
  assert.equal(cutWords("blocked", { shown: [a], all: [a] }), null);
  assert.equal(cutWords("blocked", { shown: [a], all: [a, b] }), "1 of 2 blocked — 1 is in hidden or unfocused repos");
  assert.equal(cutWords("wait", { shown: [], all: [a, b] }), "0 of 2 waiting — 2 are in hidden or unfocused repos");
});

test("chip words: one noun per kind, singular/plural in the title, one word per block kind", () => {
  assert.equal(ATTENTION_NOUN.wait, "waiting");
  assert.equal(ATTENTION_NOUN.blocked, "blocked");
  assert.match(attentionTitle("wait", 1), /^1 session is waiting for your answer — tap to answer them here$/);
  assert.match(attentionTitle("blocked", 3), /^3 sessions are blocked — .* tap to see why and steer them$/);
  assert.match(attentionTitle("wait", 2, { repo: "app", replies: true }), /^2 sessions in app are waiting .* reply on a clock — tap to show only those$/);
  assert.deepEqual(BLOCK_WORD, { auth: "signed out", spend: "out of credit", limit: "at limit", net: "network retry" });
});
