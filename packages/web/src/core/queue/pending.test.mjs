/**
 * The pending session, run for real: the synthetic screen and the verbs on it.
 *
 *     node --test packages/web/src/core/queue/pending.test.mjs
 *
 * A prompt queued behind a `session.create` and a draft typed on the screen while it warms up are the
 * only copy of those words. `usePendingState` is rendered through `react-dom/server`, so its memos and
 * refs are React's own; `pendingFns` takes the queue context as an argument, so a plain object drives it.
 */
import "../../../../../scripts/lib-tsload.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { pendingFns, usePendingState } = await import("./pending.ts");
const { loadDraft, saveDraft } = await import("../../outbox.ts");

// After the imports, so no module's load-time check sees a browser. These timers never fire: `track`'s
// flush and the link log's write are neither this file's subject nor something to keep a test open for.
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {} };

const BRIDGE_MS = 30_000;
const create = (ackId, over = {}) => ({
  ackId, sessionId: "create:/repo", cwd: "/repo", text: "open", ts: 10, status: "queued", mode: "op",
  op: { t: "session.create", ackId, cwd: "/repo", title: "My repo", launch: { model: "opus", effort: "high" } },
  ...over,
});
const behind = (ackId, createAck, over = {}) => ({
  ackId, sessionId: "create:/repo", cwd: "/repo", text: `words of ${ackId}`, ts: 20, status: "queued", mode: "input",
  pendingCreate: true, createAck, ...over,
});

/** The hook's result. `kept` is written into its ref on a first pass, then read on a second. */
function pendingState({ activeId, outbox = [], sessions = [], kept }) {
  let got;
  function Probe() {
    const [second, setSecond] = useState(false);
    got = usePendingState(activeId, outbox, second ? [...sessions] : sessions);
    if (kept && !second) {
      for (const [k, v] of Object.entries(kept)) got.pendingKept.current.set(k, v);
      setSecond(true);
    }
    return null;
  }
  renderToString(createElement(Probe));
  return got;
}

function fakeQueue(rows = [], over = {}) {
  const c = {
    outboxRef: { current: rows },
    pendingKept: { current: new Map() },
    activeIdRef: { current: null },
    connRef: { current: { status: "open" } },
    wantNavRef: { current: true },
    buffers: { current: new Map() },
    pendingEntry: null,
    overlays: [], visited: [], ops: [], active: undefined,
    writeOutbox(list) { c.outboxRef.current = list; return list; },
    addOutbox(e) { c.outboxRef.current = [...c.outboxRef.current, e]; },
    queueOp(op, lane, text, opts) {
      c.ops.push({ op, lane, text, opts });
      c.outboxRef.current = [...c.outboxRef.current, create(opts.ackId, { sessionId: lane, text, cwd: opts.cwd, op })];
    },
    setOverlay(v) { c.overlays.push(v); },
    setActiveId(v) { c.active = v; },
    setLastVisitedId(v) { c.visited.push(v); },
    ...over,
  };
  return { c, fns: pendingFns(c) };
}

beforeEach(() => store.clear());

// ── usePendingState ─────────────────────────────────────────────────────────

test("a queued create is a session screen, on its way and never ended", () => {
  const { pendingSession, pendingEntry } = pendingState({ activeId: "pending:c1", outbox: [create("c1")] });
  assert.equal(pendingEntry.ackId, "c1");
  assert.deepEqual(pendingSession, {
    id: "pending:c1", cwd: "/repo", title: "My repo", remoteControl: false, running: true, createdAt: 10,
    model: "opus", effort: "high", permissionMode: undefined, remoteControlled: undefined,
  });
});

test("the entry behind a screen is that create's: a prompt with the same ack is not one", () => {
  const state = pendingState({ activeId: "pending:c1", outbox: [behind("c1", "c0")] });
  assert.equal(state.pendingEntry, null);
  assert.equal(state.pendingSession, null, "nothing queued and nothing remembered: there is no screen");
});

test("the screen survives the ack that retired its entry, from what was kept", () => {
  const kept = { c1: { cwd: "/repo", title: "My repo", ts: 7 } };
  const { pendingSession } = pendingState({ activeId: "pending:c1", kept });
  assert.equal(pendingSession.id, "pending:c1");
  assert.equal(pendingSession.title, "My repo");
  assert.equal(pendingSession.createdAt, 7);
  assert.equal(pendingSession.running, true);
});

test("`+ later` has no entry: the repo is in the id", () => {
  const { pendingSession, pendingEntry } = pendingState({ activeId: "pending:later:/dev/thing" });
  assert.equal(pendingEntry, null);
  assert.equal(pendingSession.cwd, "/dev/thing");
  assert.equal(pendingSession.title, "thing");
  assert.equal(pendingSession.running, true);
});

test("an adopted screen stands in until the session is listed, and not a frame longer", () => {
  const kept = { s1: { cwd: "/repo", title: "My repo", ts: 7, adoptedAt: Date.now() } };
  assert.equal(pendingState({ activeId: "s1", kept }).pendingSession.id, "s1");
  const listed = [{ id: "s1", cwd: "/repo" }];
  assert.equal(pendingState({ activeId: "s1", sessions: listed, kept }).pendingSession, null);
});

test("past the bridge an adopted id is just unknown, on either id", () => {
  const was = { cwd: "/repo", title: "My repo", ts: 7, adoptedAt: Date.now() - BRIDGE_MS - 1 };
  assert.equal(pendingState({ activeId: "s1", kept: { s1: was } }).pendingSession, null);
  assert.equal(pendingState({ activeId: "pending:c1", kept: { c1: was } }).pendingSession, null);
});

test("a kept entry never adopted is no stand-in for a real id, and no id at all is no screen", () => {
  const kept = { s1: { cwd: "/repo", title: "My repo", ts: 7 } };
  assert.equal(pendingState({ activeId: "s1", kept }).pendingSession, null);
  assert.equal(pendingState({ activeId: null }).pendingSession, null);
});

// ── entering a screen ───────────────────────────────────────────────────────

test("entering a pending screen remembers what it was opened for, and goes there", () => {
  const { c, fns } = fakeQueue([create("c1")]);
  fns.enterPending("c1");
  assert.deepEqual(c.pendingKept.current.get("c1"), { cwd: "/repo", title: "My repo", ts: 10 });
  assert.equal(c.active, "pending:c1");
  assert.deepEqual(c.overlays, [null]);
  assert.equal(c.wantNavRef.current, false);
});

test("what is kept stays bounded at 8, oldest out", () => {
  const rows = Array.from({ length: 10 }, (_, i) => create(`c${i}`));
  const { c, fns } = fakeQueue(rows);
  for (const r of rows) fns.enterPending(r.ackId);
  assert.deepEqual([...c.pendingKept.current.keys()], rows.slice(2).map((r) => r.ackId));
});

test("the in-flight chip opens the oldest live create for that repo only", () => {
  const { c, fns } = fakeQueue([
    create("failed", { status: "failed" }),
    create("elsewhere", { cwd: "/other" }),
    create("oldest"),
    create("newer"),
  ]);
  fns.enterOldestPending("/repo");
  assert.equal(c.active, "pending:oldest");
  c.active = undefined;
  fns.enterOldestPending("/nothing");
  assert.equal(c.active, undefined);
});

test("`+ later` opens the screen with nothing queued behind it", () => {
  const { c, fns } = fakeQueue();
  fns.enterLater("/repo");
  assert.equal(c.active, "pending:later:/repo");
  assert.deepEqual(c.outboxRef.current, []);
});

// ── retry ───────────────────────────────────────────────────────────────────

test("a refused create is retried under a FRESH ack, its words carried forward in order", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dead = create("c1", { status: "failed" });
  const { c, fns } = fakeQueue([
    dead,
    behind("p2", "c1", { status: "failed", ts: 30, text: "second" }),
    behind("p1", "c1", { status: "failed", ts: 20, text: "first" }),
    behind("cmd", "c1", { status: "failed", ts: 40, text: "/compact", kind: "command" }),
    behind("other", "c9", { status: "failed", text: "another create's" }),
  ], { pendingEntry: dead });
  fns.retryPendingCreate();

  const [{ op, opts, text }] = c.ops;
  assert.notEqual(opts.ackId, "c1", "the old ack holds the host's refusal, and a retry wearing it never runs");
  assert.equal("ackId" in op, false, "nor does the op carry it forward");
  assert.equal(text, "open");

  const rows = c.outboxRef.current;
  assert.equal(rows.some((e) => ["c1", "p1", "p2", "cmd"].includes(e.ackId)), false, "two copies is how a retry runs twice");
  const chain = rows.filter((e) => e.createAck === opts.ackId);
  assert.deepEqual(chain.map((e) => e.text), ["first", "second", "/compact"]);
  assert.deepEqual(chain.map((e) => e.kind), ["prompt", "prompt", "command"]);
  assert.ok(rows.some((e) => e.ackId === "other"), "another create's failed words stay where they are");
  assert.equal(c.active, `pending:${opts.ackId}`);
});

test("only a failed create is retried", () => {
  const live = create("c1");
  const { c, fns } = fakeQueue([live], { pendingEntry: live });
  fns.retryPendingCreate();
  assert.deepEqual(c.ops, []);
  assert.deepEqual(c.outboxRef.current, [live]);
});

// ── adoption ────────────────────────────────────────────────────────────────

test("words typed while the session warmed up move onto the real id", () => {
  saveDraft("pending:c1", "half a thought");
  const { c, fns } = fakeQueue([], { activeIdRef: { current: "pending:c1" } });
  c.pendingKept.current.set("c1", { cwd: "/repo", title: "My repo", ts: 7 });
  fns.adoptPendingSession("c1", "s1");
  assert.equal(loadDraft("s1"), "half a thought");
  assert.equal(loadDraft("pending:c1"), "");
  assert.equal(c.active, "s1");
  assert.deepEqual(c.visited, ["s1"]);
  assert.deepEqual(c.buffers.current.get("s1"), []);
  assert.ok(c.pendingKept.current.get("c1").adoptedAt, "stamped under the create's id");
  assert.equal(c.pendingKept.current.get("s1").title, "My repo", "and kept under the session's");
});

test("adoption with no draft does not write an empty one over the session's own", () => {
  saveDraft("s1", "already here");
  const { fns } = fakeQueue([], { activeIdRef: { current: "pending:c1" } });
  fns.adoptPendingSession("c1", "s1");
  assert.equal(loadDraft("s1"), "already here");
});

test("a screen not on top is stamped but not moved: its draft stays, the view stays", () => {
  saveDraft("pending:c1", "half a thought");
  const { c, fns } = fakeQueue([], { activeIdRef: { current: "s9" } });
  c.pendingKept.current.set("c1", { cwd: "/repo", title: "My repo", ts: 7 });
  fns.adoptPendingSession("c1", "s1");
  assert.equal(loadDraft("pending:c1"), "half a thought");
  assert.equal(c.active, undefined);
  assert.ok(c.pendingKept.current.get("s1").adoptedAt);
});

// ── the prompts behind a create ─────────────────────────────────────────────

test("a prompt behind a create queues in the create's lane, unsendable until it is bound", () => {
  const { c, fns } = fakeQueue();
  fns.queueSessionPrompt("/repo", "the words", "c1");
  const [row] = c.outboxRef.current;
  const { ackId, ts: _ts, ...rest } = row;
  assert.ok(ackId);
  assert.deepEqual(rest, {
    sessionId: "create:/repo", cwd: "/repo", text: "the words", status: "queued", attempts: 0, kind: "prompt",
    mode: "input", pendingCreate: true, holdUntilIdle: true, createAck: "c1", armed: true,
  });
});

test("a parked create holds only its own chain", () => {
  const { c, fns } = fakeQueue([behind("mine", "c1"), behind("theirs", "c2")]);
  fns.holdForLaunch("create:/repo", "c1");
  const [mine, theirs] = c.outboxRef.current;
  assert.equal(mine.noTtl, true);
  assert.equal("noTtl" in theirs, false);
});

test("a refused create fails its own chain with the words intact, never another create's", () => {
  const { c, fns } = fakeQueue([behind("mine", "c1"), behind("theirs", "c2")]);
  fns.failPendingCreates("create:/repo", "the desktop refused", "c1");
  const [mine, theirs] = c.outboxRef.current;
  assert.equal(mine.status, "failed");
  assert.equal(mine.reason, "the desktop refused");
  assert.equal(mine.text, "words of mine");
  assert.ok(mine.failedAt);
  assert.equal(theirs.status, "queued");
});

test("a dead upload fails the queued messages naming its file, and only those", () => {
  const rel = ".claude/inbox/shot.png";
  const up = { ackId: "up", sessionId: "s1", text: "", status: "failed", mode: "upload", upload: { relPath: rel } };
  const row = (ackId, over) => ({ ackId, sessionId: "s1", text: "unrelated", status: "queued", mode: "input", ...over });
  const { c, fns } = fakeQueue([
    up,
    row("names", { text: `look at ${rel}` }),
    row("inOp", { mode: "op", op: { t: "session.create", prompt: `look at ${rel}` } }),
    row("plain"),
    row("sent", { text: `look at ${rel}`, status: "sent" }),
    row("lane", { text: `look at ${rel}`, sessionId: "s2" }),
  ]);
  fns.failDependentUploads(up, "the picture never arrived");
  const by = Object.fromEntries(c.outboxRef.current.map((e) => [e.ackId, e]));
  assert.equal(by.names.status, "failed");
  assert.equal(by.names.text, `look at ${rel}`, "the recovery bar puts these words back");
  assert.equal(by.names.reason, "the picture never arrived");
  assert.equal(by.inOp.status, "failed");
  assert.equal(by.plain.status, "queued", "sharing a lane is not naming the file");
  assert.equal(by.sent.status, "sent");
  assert.equal(by.lane.status, "queued");
  assert.equal(by.up, up, "the upload's own row is left as it stands");
});

test("an entry with no upload path fails nothing", () => {
  const rows = [{ ackId: "a", sessionId: "s1", text: "x", status: "queued", mode: "input" }];
  const { c, fns } = fakeQueue(rows);
  fns.failDependentUploads({ ackId: "up", sessionId: "s1" }, "why");
  assert.equal(c.outboxRef.current, rows);
});
