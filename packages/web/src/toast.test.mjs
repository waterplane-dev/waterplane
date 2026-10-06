import test from "node:test";
import assert from "node:assert/strict";

import { showToast, toastMs, toastLog, clearToastLog, onToast, dismissToast, phoneHalfFirst } from "./toast.ts";

// ── Where the feed puts this phone's messages ─────────────────────────────
//
// Reported: a long toast's full text "must still show in the notifications
// list". It was there — below every desktop alert, off the bottom of the sheet.

test("the phone's half goes first when it holds the newest row", () => {
  const rows = [{ ts: 200, text: "a", n: 1 }];
  assert.equal(phoneHalfFirst(100, rows), true);
  assert.equal(phoneHalfFirst(undefined, rows), true);
  assert.equal(phoneHalfFirst(300, rows), false);
  assert.equal(phoneHalfFirst(100, []), false);
});

// ── How long a sentence stays up ──────────────────────────────────────────
//
// Reported: toasts "disappear too fast to read". Every one of them had the same
// 2200 ms, so "copied" and a three-line explanation of why a send is being held
// were granted the same reading time. The clock is now the length of the words.
//
// The floor and the ceiling are the two ends worth pinning: without a floor a
// one-word toast flashes, and without a ceiling a paragraph pasted into a toast
// covers the screen it is explaining for a minute.

test("a short message still gets the base", () => {
  assert.equal(toastMs(""), 3000);
  assert.ok(toastMs("copied") > 3000);
});

test("a longer message gets longer, monotonically", () => {
  const short = toastMs("queued");
  const long = toastMs("queued — waiting until the session can take it");
  assert.ok(long > short, `${long} should exceed ${short}`);
  assert.ok(long > 3000);
});

test("a pasted paragraph is capped, not a minute long", () => {
  assert.equal(toastMs("x".repeat(10_000)), 12_000);
});

// ── Every toast is also a row ─────────────────────────────────────────────
//
// The other half of the same report: the sentences "don't list in the
// notification list". The host's feed only ever held what crossed the wire.

test("what was said is kept, newest first", () => {
  clearToastLog();
  showToast("first");
  showToast("second");
  const rows = toastLog();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, "second");
  assert.equal(rows[1].text, "first");
  assert.equal(rows[0].n, 1);
});

test("the same words again bump a count rather than pushing the list down", () => {
  clearToastLog();
  showToast("queued");
  showToast("queued");
  showToast("queued");
  const rows = toastLog();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 3);
});

test("the log is bounded — an app-lifetime of toasts cannot grow without end", () => {
  clearToastLog();
  for (let i = 0; i < 200; i++) showToast(`message ${i}`);
  const rows = toastLog();
  assert.ok(rows.length <= 80, `kept ${rows.length}`);
  // The cap trims the OLDEST: the newest sentence is the one being re-read.
  assert.equal(rows[0].text, "message 199");
});

// ── Dismissing takes it off screen, not out of the log ────────────────────

test("a tap clears the screen and keeps the row", () => {
  clearToastLog();
  let shown = null;
  const off = onToast((m) => { shown = m; });
  showToast("tap me");
  assert.equal(shown, "tap me");
  dismissToast();
  assert.equal(shown, null);
  assert.equal(toastLog()[0].text, "tap me");
  off();
  clearToastLog();
});

// ── A row that announced a desktop alert can open it ──────────────────────
//
// Reported: the feed's rows "can not be clicked". The host's feed lives in
// memory, so after a restart the toasted copy of "Needs your decision" was the
// only one left — and it named a session without leading to it.

test("a toast that announced an alert keeps it on its row, across a repeat", () => {
  clearToastLog();
  const item = { id: "n1", ts: 1, kind: "prompt", title: "Needs your decision · myrepo", body: "", sessionId: "s1" };
  showToast(item.title, item);
  assert.equal(toastLog()[0].notif?.sessionId, "s1");
  showToast(item.title);
  assert.equal(toastLog()[0].n, 2);
  assert.equal(toastLog()[0].notif?.id, "n1", "a repeat without an alert must not drop the one it had");
  showToast("copied");
  assert.equal(toastLog()[0].notif, undefined);
  clearToastLog();
  dismissToast();
});
