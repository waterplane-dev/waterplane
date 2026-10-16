/**
 * The close sheet's facet engine (`core/launcher/closeModel.ts`): AND across
 * facets, OR within one, every chip cross-counted against the OTHERS, and the
 * foot's plan.
 *
 *     node --test packages/web/src/core/launcher/closeModel.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_STATE_OPTIONS, EMPTY_CLOSE_FACETS, closeCut, closeFacetCounts, closeFacetWords, closeFilterBarLabel,
  closeFootLabel, closeSendList, closeShellsAtStake, closeToast, closeWaitingCount, idleUnknownNote, stakesOf,
  isKept, timedKeptNote,
  underneathOf,
} from "./closeModel.ts";

const NOW = 1_700_000_000_000;
const ses = (id, o = {}) => ({
  id, cwd: `/r/${o.repo ?? "a"}`, title: id, running: true, createdAt: NOW - 3600e3, ...o,
});
const ctx = (over = {}) => ({
  now: NOW,
  repoName: (s) => s.cwd.split("/").pop(),
  statusOf: (s) => s.st ?? "coding",
  draftIds: new Set(),
  outbox: [],
  ...over,
});
const repoNames = (scope) => [...new Set(scope.map((s) => s.cwd.split("/").pop()))];

test("facets AND across, options OR within one", () => {
  const scope = [
    ses("a", { st: "wait", createdAt: NOW - 2 * 3600e3 }),
    ses("b", { st: "done", createdAt: NOW - 2 * 3600e3 }),
    ses("c", { st: "wait", createdAt: NOW - 30 * 60e3 }),
  ];
  const c = ctx();
  // state=wait alone: a and c.
  const byState = { ...EMPTY_CLOSE_FACETS, state: new Set(["wait"]) };
  assert.deepEqual(closeCut(scope, byState, c).map((s) => s.id), ["a", "c"]);
  // AND with openOver>1h: only a.
  const anded = { ...byState, openOver: new Set(["1h"]) };
  assert.deepEqual(closeCut(scope, anded, c).map((s) => s.id), ["a"]);
  // OR within state: wait or done → everyone.
  const ored = { ...EMPTY_CLOSE_FACETS, state: new Set(["wait", "done"]) };
  assert.equal(closeCut(scope, ored, c).length, 3);
});

test("a chip's count ignores its OWN facet's current picks, reads every other one", () => {
  const scope = [
    ses("a", { st: "wait", createdAt: NOW - 2 * 3600e3 }),
    ses("b", { st: "done", createdAt: NOW - 2 * 3600e3 }),
    ses("c", { st: "coding", createdAt: NOW - 2 * 3600e3 }),
  ];
  const c = ctx();
  // With "wait" already ticked, the "done" chip must still read 1 (itself),
  // not 0 (as if intersected with the current "wait" pick) and not 2 (as if
  // it also had to explain "coding" away) — cross-counted against OTHER
  // facets only, of which there are none active here.
  const f = { ...EMPTY_CLOSE_FACETS, state: new Set(["wait"]) };
  const counts = closeFacetCounts(scope, f, c, repoNames(scope));
  assert.equal(counts.state.wait, 1);
  assert.equal(counts.state.done, 1);
  assert.equal(counts.state.coding, 1);
  for (const o of CLOSE_STATE_OPTIONS) assert.ok(o in counts.state);
});

test("a chip IS cross-counted against every OTHER active facet", () => {
  const scope = [
    ses("a", { st: "wait", createdAt: NOW - 25 * 3600e3 }), // wait, open>1d
    ses("b", { st: "wait", createdAt: NOW - 2 * 3600e3 }),  // wait, not open>1d
    ses("c", { st: "done", createdAt: NOW - 25 * 3600e3 }), // done, open>1d
  ];
  const c = ctx();
  const f = { ...EMPTY_CLOSE_FACETS, openOver: new Set(["1d"]) };
  const counts = closeFacetCounts(scope, f, c, repoNames(scope));
  // The state chips are counted WITHIN the open>1d window already picked:
  // "wait" reads 1 (a, not b), "done" reads 1 (c).
  assert.equal(counts.state.wait, 1);
  assert.equal(counts.state.done, 1);
});

test("underneath: independent booleans, and 'nothing' is its own predicate", () => {
  const now = NOW;
  const withAgents = { id: "x", agents: [{ id: "1", what: "x" }] };
  const withShellLive = { id: "y", shellList: [{ pid: 1, startedAt: now - 1000, command: "x", workers: 1, cpuMs: 0, cpuMovedAt: now - 1000 }] };
  const withShellQuiet = { id: "z", shellList: [{ pid: 2, startedAt: now - 20 * 60e3, command: "x", workers: 1, cpuMs: 0, cpuMovedAt: now - 20 * 60e3 }] };
  const bare = { id: "w" };
  assert.equal(underneathOf(withAgents, now, "agents"), true);
  assert.equal(underneathOf(withAgents, now, "nothing"), false);
  assert.equal(underneathOf(withShellLive, now, "shellsLive"), true);
  assert.equal(underneathOf(withShellQuiet, now, "shellsQuiet"), true);
  assert.equal(underneathOf(withShellQuiet, now, "shellsLive"), false);
  assert.equal(underneathOf(bare, now, "nothing"), true);
  assert.equal(underneathOf(bare, now, "agents"), false);
});

test("underneath: unknown shells never read as quiet — they count live", () => {
  const now = NOW;
  // No cpuMovedAt/outputAt at all ⇒ shellBucket "unknown".
  const withUnknown = { id: "u", shellList: [{ pid: 3, startedAt: now - 1000, command: "x", workers: 1, cpuMs: 0 }] };
  assert.equal(underneathOf(withUnknown, now, "shellsLive"), true);
  assert.equal(underneathOf(withUnknown, now, "shellsQuiet"), false);
  assert.equal(underneathOf(withUnknown, now, "nothing"), false);
});

test("underneath: an old host (no shellList, only the boolean) reads shells: true as shellsLive, never nothing/quiet", () => {
  const now = NOW;
  const oldHostRunning = { id: "o", shells: true };
  assert.equal(underneathOf(oldHostRunning, now, "shellsLive"), true);
  assert.equal(underneathOf(oldHostRunning, now, "shellsQuiet"), false);
  assert.equal(underneathOf(oldHostRunning, now, "nothing"), false);
  const oldHostIdle = { id: "p", shells: false };
  assert.equal(underneathOf(oldHostIdle, now, "shellsLive"), false);
  assert.equal(underneathOf(oldHostIdle, now, "nothing"), true);
});

test("underneath: a read-but-empty shellList (new host, no shells) is nothing, regardless of a stale boolean", () => {
  const now = NOW;
  const emptyList = { id: "e", shellList: [], shells: true };
  assert.equal(underneathOf(emptyList, now, "shellsLive"), false);
  assert.equal(underneathOf(emptyList, now, "shellsQuiet"), false);
  assert.equal(underneathOf(emptyList, now, "nothing"), true);
});

test("words at stake: a draft outranks a queued prompt, a failed send is not 'queued'", () => {
  const drafts = new Set(["d1"]);
  const outbox = [
    { sessionId: "d1", status: "queued" },
    { sessionId: "q1", status: "pending" },
    { sessionId: "f1", status: "failed" },
  ];
  assert.equal(stakesOf({ id: "d1" }, drafts, outbox), "draft");
  assert.equal(stakesOf({ id: "q1" }, drafts, outbox), "queued");
  assert.equal(stakesOf({ id: "f1" }, drafts, outbox), "none");
  assert.equal(stakesOf({ id: "none" }, drafts, outbox), "none");
});

test("idle-unknown honesty line — zero says nothing, one names itself", () => {
  assert.equal(idleUnknownNote(0), "");
  assert.match(idleUnknownNote(1), /its quiet time/);
  assert.match(idleUnknownNote(3), /their quiet time/);
});

test("the filter bar: n of N, and the facets in words", () => {
  const f = { ...EMPTY_CLOSE_FACETS, state: new Set(["wait"]), idleOver: new Set(["1h"]) };
  assert.equal(closeFilterBarLabel(2, 9, f), "2 of 9 in scope · waiting for your answer · idle > 1h");
  assert.equal(closeFilterBarLabel(9, 9, EMPTY_CLOSE_FACETS), "9 of 9 in scope");
});

test("the foot: N=0 is no label, shells ride the count that will actually stop", () => {
  const cut = [ses("a", { shellList: [{ pid: 1 }, { pid: 2 }] }), ses("b", { shellList: [] })];
  const kept = new Set(["b"]); // b is kept — irrelevant here since it had no shells anyway
  const send = closeSendList(cut, kept);
  assert.deepEqual(send.map((s) => s.id), ["a"]);
  assert.equal(closeShellsAtStake(send), 2);
  assert.equal(closeFootLabel(1, 2), "close 1 · stops 2 background shells");
  assert.equal(closeFootLabel(0, 0), "");
  assert.equal(closeFootLabel(3, 0), "close 3");
});

test("keeping a row drops it from the send list even though it is in the cut", () => {
  const cut = [ses("a"), ses("b"), ses("c")];
  assert.deepEqual(closeSendList(cut, new Set(["b"])).map((s) => s.id), ["a", "c"]);
});

test("rows waiting on a box, among what is about to close", () => {
  const list = [ses("a", { st: "wait" }), ses("b", { st: "done" }), ses("c", { st: "wait" })];
  assert.equal(closeWaitingCount(list, ctx()), 2);
});

test("the toast names shells STOPPING (not stopped — nothing has been killed yet) and stars spared, once", () => {
  assert.match(closeToast(3, 5, 0), /archived 3 sessions.*stopping 5 background shells/);
  assert.doesNotMatch(closeToast(3, 5, 0), /stopped/);
  assert.match(closeToast(1, 0, 2), /kept 2 starred/);
  assert.match(closeToast(1, 0, "3 starred & flagged"), /kept 3 starred & flagged/);
  assert.doesNotMatch(closeToast(1, 0, ""), /kept \d/);
  assert.match(closeToast(1, 0, 0, "myapp"), /archived 1 session in myapp/);
  // Nothing was running underneath and nothing starred was spared — the
  // toast says only the standard "conversations are kept" line, never a
  // "stopping 0 shells"/"kept 0 starred" clause about a zero.
  assert.doesNotMatch(closeToast(2, 0, 0), /stopping \d|kept \d+ starred/);
});

// A session a timed prompt is aimed at starts KEPT — the prompt was written
// into it on purpose — and a tap on its shield is the override, not the keep.
test("a session with a timed prompt is kept out of the close until a tap puts it back", () => {
  const a = { id: "a" }, b = { id: "b" };
  const timed = new Set(["a"]);
  assert.deepEqual(closeSendList([a, b], new Set(), timed).map((s) => s.id), ["b"]);
  assert.deepEqual(closeSendList([a, b], new Set(["a"]), timed).map((s) => s.id), ["a", "b"], "the tap releases it");
  assert.equal(isKept("a", new Set(), timed), true);
  assert.equal(isKept("b", new Set(["b"]), timed), true, "a hand keep is still a keep");
  assert.deepEqual(closeSendList([a, b], new Set()).map((s) => s.id), ["a", "b"], "no timed set ⇒ the old behaviour");
  assert.equal(timedKeptNote(0), "");
  assert.match(timedKeptNote(1), /^1 session is kept open: a timed prompt is aimed at it\./);
  assert.match(timedKeptNote(1), /the desktop reopens that conversation/);
});
