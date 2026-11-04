/**
 * The two one-shot rescues, run for real against a fake `localStorage`.
 *
 *     node --test packages/web/src/core/queue/migrate.test.mjs
 *
 * `padMigrate.test.mjs` states what happens to each rescued ROW. What only this file can state is the
 * half `migrate.ts` keeps: the read, the write, the mark, and that neither source is ever deleted. Each
 * of these runs once per phone against words that exist nowhere else, so nobody gets to report one twice.
 */
import "../../../../../scripts/lib-tsload.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
/** Keys whose write throws, as a full store does. */
const refused = new Set();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (refused.has(k)) throw new Error("QuotaExceededError");
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { migrateGiveUps, migratePadRescue } = await import("./migrate.ts");
const { loadPadDoc, writePadDoc } = await import("../../outbox.ts");
const { LS } = await import("../../storage.ts");

const DAY = 86_400_000;
const note = (id) => loadPadDoc().notes.find((n) => n.id === id);
const rescue = (rows) => store.set(LS.padRescue, JSON.stringify(rows));
const ledger = (rows) => store.set(LS.giveups, JSON.stringify(rows));

beforeEach(() => {
  store.clear();
  refused.clear();
});

// ── migratePadRescue ────────────────────────────────────────────────────────

test("a rescued note keeps its original id and ts", () => {
  rescue([{ id: "r1", text: "the words", ts: 123 }]);
  assert.equal(migratePadRescue(), 1);
  assert.deepEqual(note("r1"), { id: "r1", text: "the words", ts: 123 });
});

test("a note older than 7 days is still rescued: the old reader's TTL is not applied", () => {
  const ts = Date.now() - 30 * DAY;
  rescue([{ id: "old", text: "a month old", ts, lostAt: ts, how: "draft" }]);
  assert.equal(migratePadRescue(), 1);
  assert.equal(note("old").text, "a month old");
  assert.equal(note("old").ts, ts);
});

test("a note already on the pad is skipped, and the live copy stands", () => {
  writePadDoc({ notes: [{ id: "r1", text: "typed since", ts: 500 }], tombs: [] });
  rescue([{ id: "r1", text: "the fossil", ts: 999 }]);
  assert.equal(migratePadRescue(), 0);
  assert.equal(note("r1").text, "typed since");
});

test("a note tombstoned at or after its ts is skipped; one tombstoned before it comes back", () => {
  writePadDoc({ notes: [], tombs: [{ id: "after", gone: 200 }, { id: "at", gone: 100 }, { id: "before", gone: 50 }] });
  rescue([
    { id: "after", text: "deleted since", ts: 100 },
    { id: "at", text: "deleted at the same moment", ts: 100 },
    { id: "before", text: "typed after that delete", ts: 100 },
  ]);
  assert.equal(migratePadRescue(), 1);
  assert.deepEqual(loadPadDoc().notes.map((n) => n.id), ["before"]);
});

test("the rescue source is never deleted, whatever became of its rows", () => {
  writePadDoc({ notes: [{ id: "live", text: "x", ts: 1 }], tombs: [{ id: "gone", gone: 9 }] });
  const raw = JSON.stringify([
    { id: "new", text: "moved", ts: 5 },
    { id: "live", text: "skipped", ts: 5 },
    { id: "gone", text: "skipped", ts: 5 },
    { nonsense: true },
  ]);
  store.set(LS.padRescue, raw);
  migratePadRescue();
  assert.equal(store.get(LS.padRescue), raw, "byte for byte: a migration that got it wrong keeps its input");
});

test("the rescue runs once: a note deleted after it does not come back on the next boot", () => {
  rescue([{ id: "r1", text: "x", ts: 1 }]);
  assert.equal(migratePadRescue(), 1);
  writePadDoc({ notes: [], tombs: [] });
  assert.equal(migratePadRescue(), 0);
  assert.equal(note("r1"), undefined);
});

test("a refused pad write leaves no mark, so the next boot tries again and the words arrive", () => {
  rescue([{ id: "r1", text: "x", ts: 1 }]);
  refused.add(LS.pad);
  assert.equal(migratePadRescue(), 0, "nothing landed, so nothing is claimed");
  assert.equal(store.has(LS.padRescueMigrated), false);
  refused.clear();
  assert.equal(migratePadRescue(), 1);
  assert.equal(store.has(LS.padRescueMigrated), true);
});

test("nothing to rescue, or a source that is not a list, is marked done and writes no pad", () => {
  for (const raw of [null, "[]", "{}", "not json"]) {
    store.clear();
    if (raw !== null) store.set(LS.padRescue, raw);
    assert.equal(migratePadRescue(), 0);
    assert.equal(store.has(LS.padRescueMigrated), true);
    assert.equal(store.has(LS.pad), false);
  }
});

// ── migrateGiveUps ──────────────────────────────────────────────────────────

test("a ledger row becomes a failed work item for its own repo, under a fresh ackId", () => {
  ledger([{ ackId: "ledger-id", ts: 100, text: "the words", cwd: "/repo", reason: "link died", failState: "unsent" }]);
  const [row, ...rest] = migrateGiveUps([]);
  assert.deepEqual(rest, []);
  assert.notEqual(row.ackId, "ledger-id", "the old id may still hold a verdict, and a retry wearing it never runs");
  assert.ok(row.ackId);
  const { ackId: _fresh, ...kept } = row;
  assert.deepEqual(kept, {
    sessionId: "/repo", cwd: "/repo", text: "the words", ts: 100, status: "failed", mode: "backlog",
    label: "the words", failedAt: 100, failState: "unsent", reason: "link died",
  });
});

test("the pad note's full words beat the ledger's clipped head, chain included", () => {
  writePadDoc({ notes: [{ id: "n1", text: "the whole note", ts: 1, steps: ["then this"] }], tombs: [] });
  ledger([{ ackId: "a", ts: 1, text: "the who", clipped: true, padId: "n1", cwd: "/r", reason: "gave up" }]);
  const [row] = migrateGiveUps([]);
  assert.equal(row.text, "the whole note\n\nthen this");
  assert.equal(row.reason, "gave up", "the words are whole, so nothing says they were cut");
});

test("with the note gone a clipped row says so; with no reason at all it says that", () => {
  ledger([
    { ackId: "a", ts: 1, text: "the who", clipped: true, padId: "gone", cwd: "/r", reason: "gave up" },
    { ackId: "b", ts: 2, text: "no reason kept", cwd: "/r" },
  ]);
  const [a, b] = migrateGiveUps([]);
  assert.equal(a.text, "the who");
  assert.equal(a.reason, "gave up (only the shortened copy was kept)");
  assert.equal(b.reason, "this one never reached a session");
});

test("a row retried, or one the queue still holds, would be the same message twice", () => {
  ledger([
    { ackId: "retried", ts: 1, text: "x", retriedAt: 5 },
    { ackId: "held", ts: 2, text: "y" },
    { ackId: "free", ts: 3, text: "z" },
  ]);
  const held = { ackId: "held", text: "y", ts: 2, status: "queued" };
  assert.deepEqual(migrateGiveUps([held]).map((e) => e.text), ["y", "z"]);
});

test("a row with no words to bring across makes no row", () => {
  ledger([
    { ackId: "a", text: "bytes", bytes: true },
    { ackId: "b", text: "a file", kind: "file" },
    { ackId: "c", text: "1", kind: "answer" },
    { ackId: "d", text: "   " },
    { ackId: "e" },
    null,
  ]);
  const list = [];
  assert.equal(migrateGiveUps(list), list, "the same list: nothing was added");
});

test("rescued rows sort oldest first behind the queue, and the queue is left as it was", () => {
  ledger([{ ackId: "a", ts: 30, text: "third" }, { ackId: "b", ts: 10, text: "first" }, { ackId: "c", ts: 20, text: "second" }]);
  const live = { ackId: "live", text: "queued now", ts: 99, status: "queued" };
  const out = migrateGiveUps([live]);
  assert.equal(out[0], live);
  assert.deepEqual(out.slice(1).map((e) => e.text), ["first", "second", "third"]);
  assert.ok(out.slice(1).every((e) => e.status === "failed"), "nothing here goes out on its own");
});

test("the give-ups source is never deleted, and the second call adds nothing", () => {
  const raw = JSON.stringify([{ ackId: "a", ts: 1, text: "x", cwd: "/r" }]);
  store.set(LS.giveups, raw);
  assert.equal(migrateGiveUps([]).length, 1);
  assert.equal(store.get(LS.giveups), raw);
  const list = [];
  assert.equal(migrateGiveUps(list), list);
});

test("an empty or unreadable ledger is marked done and changes nothing", () => {
  for (const raw of [null, "[]", "{}", "not json"]) {
    store.clear();
    if (raw !== null) store.set(LS.giveups, raw);
    const list = [];
    assert.equal(migrateGiveUps(list), list);
    assert.equal(store.has(LS.giveupsMigrated), true);
  }
});
