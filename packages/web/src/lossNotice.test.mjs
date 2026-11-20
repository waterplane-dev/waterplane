/**
 * Typed words this phone cannot keep are SAID on the composer, never lost silently:
 * drafts, sheet drafts, presets, header commands, file remarks, command history, held dictations.
 *
 *     node --test packages/web/src/lossNotice.test.mjs
 */
import "../../../scripts/lib-tsload.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
let failAll = false;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { if (failAll) throw new Error("QuotaExceededError"); store.set(k, String(v)); },
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { getLosses, resetLossesForTest, dismissLoss, lossSentence } = await import("./lossNotice.ts");
const { LS, lsJsonUser, lsSetJsonUser } = await import("./storage.ts");
const { saveDraft, loadDraft, saveSheetDraft, loadSheetDraft } = await import("./outbox.ts");
const { loadPresets, savePresets, DEFAULT_PRESETS } = await import("./presets.ts");
const { loadHeaderCmds, DEFAULT_HEADER_CMDS } = await import("./headerCmds.ts");

beforeEach(() => { store.clear(); failAll = false; resetLossesForTest(); });

test("presets: a parse error shows the defaults, keeps the text aside, says so", () => {
  const key = LS.fanoutPresets;
  store.set(key, "{not json");
  assert.deepEqual(loadPresets().map((p) => p.id), DEFAULT_PRESETS.map((p) => p.id));
  assert.equal(store.get(key), "{not json", "stored text untouched by the read");
  assert.equal(store.get(key + ".unreadable"), "{not json", "kept aside");
  assert.deepEqual(getLosses().map((n) => [n.kind, n.what]), [["unreadable", "presets"]]);
  // the next save keeps the aside copy, never the only copy
  savePresets(DEFAULT_PRESETS);
  assert.equal(store.get(key + ".unreadable"), "{not json");
});

test("header commands: a parse error keeps the text aside and says so", () => {
  store.set(LS.headerCmds, "[[");
  assert.equal(loadHeaderCmds().length, DEFAULT_HEADER_CMDS.length);
  assert.equal(store.get(LS.headerCmds + ".unreadable"), "[[");
  assert.equal(getLosses()[0].what, "header commands");
});

test("a refused write returns false and surfaces a notice; a later success clears it", () => {
  failAll = true;
  assert.equal(lsSetJsonUser(LS.cmdHistory, ["a"], "command history"), false);
  assert.deepEqual(getLosses().map((n) => [n.kind, n.what]), [["refused", "command history"]]);
  failAll = false;
  assert.equal(lsSetJsonUser(LS.cmdHistory, ["a"], "command history"), true);
  assert.equal(getLosses().length, 0);
});

test("a draft the store refuses is reported, once", () => {
  failAll = true;
  assert.equal(saveDraft("s1", "words"), false);
  assert.equal(saveDraft("s1", "words more"), false);
  assert.equal(getLosses().length, 1);
  assert.match(lossSentence(getLosses()[0]), /could not be saved/);
  dismissLoss(getLosses()[0].id);
  assert.equal(getLosses().length, 0);
});

test("an unreadable drafts store is reported with the slot that holds it", () => {
  store.set(LS.composeDrafts, "garbage");
  assert.equal(loadDraft("s1"), "");
  assert.equal(getLosses()[0].keptSlot, LS.composeDrafts + ".unreadable");
  assert.equal(store.get(LS.composeDrafts + ".unreadable"), "garbage");
});

test("sheet drafts: the 21st (and 40th) draft drops nothing", () => {
  for (let i = 0; i < 40; i++) saveSheetDraft(`k${i}`, `text ${i}`);
  for (let i = 0; i < 40; i++) assert.equal(loadSheetDraft(`k${i}`), `text ${i}`);
});

test("lsJsonUser: a value of the wrong shape is unreadable, not empty", () => {
  store.set("k", "[1]");
  assert.deepEqual(lsJsonUser("k", {}, "file remarks", (v) => !Array.isArray(v)), {});
  assert.equal(store.get("k.unreadable"), "[1]");
  assert.equal(getLosses()[0].what, "file remarks");
});

test("a dismissed unreadable line stays dismissed; a new kept slot speaks again", async () => {
  const { reportLoss, clearLoss } = await import("./lossNotice.ts");
  resetLossesForTest();
  reportLoss({ kind: "unreadable", what: "x", keptSlot: "a" });
  dismissLoss("unreadable:x");
  reportLoss({ kind: "unreadable", what: "x", keptSlot: "a" });
  assert.equal(getLosses().length, 0);
  reportLoss({ kind: "unreadable", what: "x", keptSlot: "b" });
  assert.equal(getLosses()[0].keptSlot, "b");
  reportLoss({ kind: "unreadable", what: "x", keptSlot: "c" });
  assert.equal(getLosses()[0].keptSlot, "c");
  clearLoss("unreadable:x");
  assert.equal(getLosses().length, 0);
});

test("a dismissed refused line comes back on the next refused write", async () => {
  const { reportLoss } = await import("./lossNotice.ts");
  resetLossesForTest();
  reportLoss({ kind: "refused", what: "drafts" });
  dismissLoss("refused:drafts");
  assert.equal(getLosses().length, 0);
  reportLoss({ kind: "refused", what: "drafts" });
  assert.equal(getLosses().length, 1);
});

test("a successful read of a healed store forgets the dismissal, so a later failure speaks anew", () => {
  store.set("k", "[1]");
  lsJsonUser("k", {}, "file remarks", (v) => !Array.isArray(v));
  dismissLoss("unreadable:file remarks");
  lsJsonUser("k", {}, "file remarks", (v) => !Array.isArray(v)); // same cause, still dismissed
  store.set("k", "{}");
  lsJsonUser("k", {}, "file remarks", (v) => !Array.isArray(v)); // healed: a clean read
  store.set("k", "[2]");
  store.delete("k.unreadable");
  lsJsonUser("k", {}, "file remarks", (v) => !Array.isArray(v));
  assert.equal(getLosses().length, 1, "the new failure is not swallowed by the old dismissal");
});

test("the composer drafts store clears a dismissal on a clean read too", () => {
  store.set(LS.composeSheets, "{not json");
  loadSheetDraft("a");
  dismissLoss("unreadable:sheet drafts");
  store.set(LS.composeSheets, "{}");
  loadSheetDraft("a");
  store.set(LS.composeSheets, "{bad");
  store.delete(LS.composeSheets + ".unreadable");
  loadSheetDraft("a");
  assert.equal(getLosses().length, 1);
});
