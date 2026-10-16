/**
 * What a screen may claim about a synced write.
 *
 * Pure and DOM-free, so `node --test` runs it straight over the TypeScript the
 * way `activityRows.test.mjs` does. Every rule here is one a person reads off a
 * screen and acts on, and every one of them fails silently: a `synced` printed
 * on a phone that has been off the tunnel for a day is worse than no line at
 * all, which is the whole reason this store exists.
 *
 *     node --test packages/web/src/syncState.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  noteLocalWrite, noteSuperseded, noteSynced, outstandingSync, queueSync, resetSyncState, rowChipWord,
  setSyncOnline, syncChipWord, syncSentence, syncStateOf, syncSummary, worstSync,
} from "./syncState.ts";

const K = "myapp.pad";
const T0 = 1_700_000_000_000;

test("a key nobody has written or heard about says NOTHING", () => {
  resetSyncState();
  // The cold-start window. A confident answer here is the one thing that must
  // not happen — `settings.all` lands on hello and closes it off the source.
  assert.equal(syncStateOf(K).phase, "unknown");
  assert.equal(syncSentence(syncStateOf(K)), null);
});

test("a local write with a live link is `pending`, and says it is only on this phone", () => {
  resetSyncState();
  setSyncOnline(true);
  noteLocalWrite(K, T0);
  assert.equal(syncStateOf(K).phase, "pending");
  assert.match(syncSentence(syncStateOf(K), "your notes"), /only on this phone/);
});

test("the same write with NO link is `offline` — a different fact, and a different sentence", () => {
  resetSyncState();
  setSyncOnline(false);
  noteLocalWrite(K, T0);
  // Collapsing these two is how a push that is genuinely stuck reads as a bad
  // tunnel for a week. `useRemoteResource` splits error from offline for the
  // same reason.
  assert.equal(syncStateOf(K).phase, "offline");
  assert.match(syncSentence(syncStateOf(K)), /no connection/);
});

test("the host's echo is the receipt — it turns pending into synced", () => {
  resetSyncState();
  setSyncOnline(true);
  noteLocalWrite(K, T0);
  noteSynced(K, T0);
  assert.equal(syncStateOf(K).phase, "synced");
  assert.match(syncSentence(syncStateOf(K), "your notes"), /on more than this phone/);
});

test("an echo OLDER than our write does not confirm it", () => {
  resetSyncState();
  setSyncOnline(true);
  noteSynced(K, T0);          // the desktop's copy, from before
  noteLocalWrite(K, T0 + 500); // …and then we wrote again
  assert.equal(syncStateOf(K).phase, "pending");
});

test("a write after a confirmation goes back to pending — the receipt is per write, not per key", () => {
  resetSyncState();
  setSyncOnline(true);
  noteLocalWrite(K, T0);
  noteSynced(K, T0);
  noteLocalWrite(K, T0 + 1000);
  assert.equal(syncStateOf(K).phase, "pending");
});

test("hearing the host's value for a key we never wrote is `synced` — nothing of ours is outstanding", () => {
  resetSyncState();
  setSyncOnline(true);
  noteSynced(K, T0);
  assert.equal(syncStateOf(K).phase, "synced");
});

test("another device's newer value is `superseded`, and the sentence refuses to call it a loss", () => {
  resetSyncState();
  setSyncOnline(true);
  noteLocalWrite(K, T0);
  noteSuperseded(K, T0 + 10);
  assert.equal(syncStateOf(K).phase, "superseded");
  const said = syncSentence(syncStateOf(K), "your notes");
  assert.match(said, /another device/);
  // The host is last-write-wins on the whole value, and the pad merges per note
  // on adopt (`shared/pad.ts`), so nothing of this device's was dropped. Saying
  // "deleted" here would be false AND would send a person hunting for a rescue.
  assert.match(said, /nothing of yours was deleted/);
});

test("a later local write clears `superseded` — this phone has the newest word again", () => {
  resetSyncState();
  setSyncOnline(true);
  noteSuperseded(K, T0);
  noteLocalWrite(K, T0 + 1);
  assert.equal(syncStateOf(K).phase, "pending");
});

test("a sheet reports the WORST of the keys it edits, ranked by what a person must know", () => {
  resetSyncState();
  setSyncOnline(true);
  noteSynced("a", T0);
  noteLocalWrite("b", T0);            // pending
  noteLocalWrite("c", T0); noteSuperseded("c", T0 + 5); // superseded
  assert.equal(worstSync(["a", "b", "c"]).phase, "superseded");
  assert.equal(worstSync(["a", "b"]).phase, "pending");
  assert.equal(worstSync(["a"]).phase, "synced");
});

test("one unheard-of key never silences a real answer about the others", () => {
  resetSyncState();
  setSyncOnline(true);
  noteSynced("a", T0);
  assert.equal(worstSync(["a", "never-written"]).phase, "synced");
  // …and wins only when it is all there is.
  assert.equal(worstSync(["never-written"]).phase, "unknown");
});

test("going offline re-words a pending write without forgetting it", () => {
  resetSyncState();
  setSyncOnline(true);
  noteLocalWrite(K, T0);
  assert.equal(syncStateOf(K).phase, "pending");
  setSyncOnline(false);
  assert.equal(syncStateOf(K).phase, "offline");
  assert.equal(syncStateOf(K).wroteAt, T0);
  setSyncOnline(true);
  assert.equal(syncStateOf(K).phase, "pending");
});

test("a confirmed key stays confirmed when the link drops — the desktop still has it", () => {
  resetSyncState();
  setSyncOnline(true);
  noteLocalWrite(K, T0);
  noteSynced(K, T0);
  setSyncOnline(false);
  // The link being down says nothing about what the desktop already holds, and
  // re-wording this as "offline" would retract a true statement.
  assert.equal(syncStateOf(K).phase, "synced");
});

// ── queueSync: the things that ride the send queue, not the settings merge ──

test("only the HOST's own listing earns a green mark", () => {
  // An ack says a frame was taken. The listing says it was stored, and that is
  // the whole difference between "it is on its way" and "you can put the phone
  // down".
  assert.equal(queueSync({ queued: false, onHost: true, online: true }), "synced");
  assert.equal(queueSync({ queued: false, onHost: false, online: true }), "unknown");
  assert.equal(syncChipWord("synced"), "on desktop");
  assert.equal(syncChipWord("unknown"), null);
});

test("a queued save splits on the link, exactly as a settings key does", () => {
  assert.equal(queueSync({ queued: true, onHost: false, online: true }), "pending");
  assert.equal(queueSync({ queued: true, onHost: false, online: false }), "offline");
});

test("a send that GAVE UP never reads as queued — it is not on its way", () => {
  // The bug this fixes: a failed `schedule.save` stayed in the pending list and
  // drew the amber "queued" chip, so the one row that will never arrive was the
  // one claiming to be arriving.
  assert.equal(queueSync({ queued: true, failed: true, onHost: false, online: true }), "failed");
  assert.equal(queueSync({ queued: true, failed: true, onHost: false, online: false }), "failed");
  assert.equal(syncChipWord("failed"), "not sent");
  assert.match(syncSentence({ phase: "failed" }, "this schedule", false), /gave up/);
});

test("a queued EDIT of a stored row still reads as not-yet-there", () => {
  // The host listing carries the pre-edit copy; what is on screen is the edit,
  // and the edit is only on this phone.
  assert.equal(queueSync({ queued: true, onHost: true, online: true }), "pending");
});

// ── A list that says the good case ONCE, at its head ─────────────────────────

test("a row drops ONLY the green chip, and only when its list's head says it", () => {
  // Without a head the row keeps its "on desktop": a row is never silent about
  // where it is. With one, the exceptions are all a row draws.
  assert.equal(rowChipWord("synced"), "on desktop");
  assert.equal(rowChipWord("synced", true), null);
  for (const p of ["pending", "offline", "superseded", "failed"]) {
    assert.equal(rowChipWord(p, true), syncChipWord(p), p);
  }
  assert.equal(rowChipWord("unknown", true), null);
});

test("the head's word claims ALL only when all are there, and counts otherwise", () => {
  assert.equal(syncSummary(["synced", "synced", "synced"]).word, "on desktop");
  // One row stuck on this phone: a bare "on desktop" over it would be the green
  // light this store was written to retire.
  assert.equal(syncSummary(["synced", "pending", "synced", "synced"]).word, "3 of 4 on desktop");
  // `unknown` has no honest answer, so it is counted neither way.
  assert.equal(syncSummary(["synced", "unknown"]).word, "on desktop");
  // No synced row: the head says nothing, the rows' chips are the story.
  assert.equal(syncSummary(["pending", "failed"]), null);
  assert.equal(syncSummary([]), null);
});

test("the head's title agrees in number with what it counts", () => {
  assert.match(syncSummary(["synced"]).title, /the one row here is on more than this phone/);
  assert.match(syncSummary(["synced", "synced"]).title, /all 2 rows here are on more than this phone/);
  assert.match(syncSummary(["synced", "pending", "offline"]).title, /1 of the 3 rows here is on more/);
  assert.match(syncSummary(["synced", "synced", "failed"]).title, /2 of the 3 rows here are on more/);
});

test("the chip sentence agrees in number with its caller", () => {
  assert.match(syncSentence({ phase: "synced" }, "your notes", true), /your notes are on more than this phone/);
  assert.match(syncSentence({ phase: "synced" }, "this schedule", false), /this schedule is on more than this phone/);
});

// ── outstandingSync: how much this phone is still holding alone ─────────────

test("outstandingSync counts only what is genuinely still here", () => {
  resetSyncState();
  setSyncOnline(true);
  noteLocalWrite("a", T0);              // pending
  noteLocalWrite("b", T0);
  noteSynced("b", T0);                  // synced — nothing outstanding
  noteLocalWrite("c", T0);
  noteSuperseded("c", T0 + 1);          // replaced: nothing of OURS is waiting
  assert.equal(outstandingSync(["a", "b", "c", "never-written"]), 1);
  setSyncOnline(false);
  // Offline is still outstanding — the desktop does not have it either way.
  assert.equal(outstandingSync(["a", "b", "c"]), 1);
});

test("outstandingSync is zero when this phone has written nothing", () => {
  resetSyncState();
  assert.equal(outstandingSync(["a", "b"]), 0);
});
