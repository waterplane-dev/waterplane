/**
 * outbox.ts's read and save really go through storedGuard: a stored queue/drafts value that cannot be
 * read is a state (kept aside, reported), never an empty list, and a refused write returns false.
 *
 *     node --test packages/web/src/core/queue/outboxGuard.test.mjs
 */
import "../../../../../scripts/lib-tsload.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
let failAll = false;
let failUnreadable = false;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (failAll || (failUnreadable && k.includes(".unreadable"))) throw new Error("QuotaExceededError");
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { readOutbox, loadOutbox, saveOutbox, saveDraft, loadDraft } = await import("../../outbox.ts");
const { LS } = await import("../../storage.ts");

const OUTBOX = LS.composeOutbox;
const DRAFTS = LS.composeDrafts;

beforeEach(() => {
  store.clear();
  failAll = false;
  failUnreadable = false;
});

test("a corrupt stored queue reads unreadable, not empty, and the raw value is kept aside", () => {
  store.set(OUTBOX, "{bad");
  assert.deepEqual(readOutbox(), { list: [], unreadable: true });
  assert.deepEqual(loadOutbox(), []);
  assert.equal(store.get(OUTBOX + ".unreadable"), "{bad");
});

test("a save after an unreadable read leaves the raw copy", () => {
  store.set(OUTBOX, "{bad");
  readOutbox();
  assert.equal(saveOutbox([]), true);
  assert.equal(store.get(OUTBOX + ".unreadable"), "{bad");
});

test("an absent queue is empty, not unreadable", () => {
  assert.deepEqual(readOutbox(), { list: [], unreadable: false });
});

test("a refused write returns false from saveOutbox and saveDraft", () => {
  failAll = true;
  assert.equal(saveOutbox([]), false);
  assert.equal(saveDraft("s", "x"), false);
});

test("drafts of the wrong shape read as empty and keep the raw copy", () => {
  for (const raw of ["[]", "null"]) {
    store.clear();
    store.set(DRAFTS, raw);
    assert.equal(loadDraft("s"), "");
    assert.equal(store.get(DRAFTS + ".unreadable"), raw);
  }
});

// outbox.ts's write() must hand shapeOf(key) to writeChecked. These never read first, so the
// read-time copy does not exist and only the write-time check can save the raw value.
test("a save with no prior read copies an unreadable value aside before replacing it", () => {
  store.set(OUTBOX, "{bad");
  assert.equal(saveOutbox([]), true);
  assert.equal(store.get(OUTBOX + ".unreadable"), "{bad");
  store.set(DRAFTS, "[1]");
  assert.equal(saveDraft("s", "x"), true);
  assert.equal(store.get(DRAFTS + ".unreadable"), "[1]");
});

test("a save refuses to replace an unreadable value whose copy cannot be written", () => {
  failUnreadable = true;
  store.set(OUTBOX, "{bad");
  assert.equal(saveOutbox([]), false);
  assert.equal(store.get(OUTBOX), "{bad");
  store.set(DRAFTS, "[1]");
  assert.equal(saveDraft("s", "x"), false);
  assert.equal(store.get(DRAFTS), "[1]");
});
