import test from "node:test";
import assert from "node:assert/strict";

import { CONFIRM_WINDOW_MS, confirmingLine, hostStillConfirming } from "./sendConfirm.ts";

// What turns a queue row RED, and when it is too early to. The complaint this
// answers was timed: seven seconds after tapping Send — one echo window and one
// log poll — the strip above the composer read "1 message not delivered —
// nothing ran" with Restore / Manage / Dismiss under it, while the host had
// four re-sends and a doubling sweep still to spend on that exact row. Asking a
// person to act there is asking them to re-send a prompt that may be running.

const row = (over = {}) => ({
  ackId: "a1", text: "run the suite", ts: 1_000, status: "failed",
  failState: "unconfirmed", failedAt: 1_000, ...over,
});

test("an unreadable screen is the desktop's question, not a failure yet", () => {
  assert.equal(hostStillConfirming(row(), 1_000 + 7_000), true, "seven seconds in, nobody knows anything");
});

test("every other verdict is answered the moment it arrives", () => {
  // The desktop said no, or said the question is gone: those are facts, and a
  // row carrying one has nothing left to wait for. `unsubmitted` belongs here
  // and not above: the host SAW the words in that composer, so the row is
  // waiting on a person's Return, and hiding it behind "confirming" would bury
  // the one send somebody really does have to deal with.
  for (const failState of ["unsubmitted", "stale", "refused", "other", undefined]) {
    assert.equal(hostStillConfirming(row({ failState }), 1_000 + 7_000), false, `${failState} is settled`);
  }
});

test("a verdict from the host's own sweep ends it — that is the normal path", () => {
  assert.equal(hostStillConfirming(row({ hostSettled: true }), 1_000 + 7_000), false);
});

test("the window is a backstop, so a row is never hopeful for ever", () => {
  assert.equal(hostStillConfirming(row(), 1_000 + CONFIRM_WINDOW_MS - 1), true);
  assert.equal(hostStillConfirming(row(), 1_000 + CONFIRM_WINDOW_MS), false,
    "past the host's whole ladder with no word at all, the last thing anybody knew is the honest one");
});

test("rows that are not failed are not this state at all", () => {
  for (const status of ["queued", "pending", "sent"]) {
    assert.equal(hostStillConfirming(row({ status }), 1_000 + 7_000), false);
  }
});

test("the clock is the FAILURE instant, not when the row was queued", () => {
  // A row can sit queued for an hour on a dead tunnel; the desktop's question
  // starts when it was typed, not when it was written.
  assert.equal(hostStillConfirming(row({ ts: 1_000, failedAt: 1_000_000 }), 1_000_000 + 5_000), true);
  // With no failure stamp at all, the fallbacks are used in order rather than
  // treating an undated row as fresh for ever.
  assert.equal(hostStillConfirming(row({ failedAt: undefined, sentAt: 500 }), 500 + CONFIRM_WINDOW_MS), false);
  assert.equal(hostStillConfirming(row({ failedAt: undefined, sentAt: undefined }), 1_000 + 5_000), true);
});

test("the sentence says what happens WITHOUT the reader — a spinner nobody can act on is worse", () => {
  assert.match(confirmingLine(1), /^1 message typed/);
  assert.match(confirmingLine(1), /types it again itself/);
  assert.match(confirmingLine(3), /^3 messages typed/);
});
