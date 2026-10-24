import test from "node:test";
import assert from "node:assert/strict";
import { queuedAnswerNote } from "./answerQueued.ts";

test("link down: promises the send for when the link is back", () => {
  assert.equal(queuedAnswerNote([{ label: "Yes" }], false), "“Yes” queued — sent, in order, as soon as the link is back");
  assert.match(queuedAnswerNote([{ label: "a" }, { label: "b" }], false), /^2 answers queued \(a, b\) — .*link is back$/);
});

test("link up: never says the link is back, says it waits for the desktop", () => {
  const one = queuedAnswerNote([{ label: "Yes" }], true);
  assert.equal(one, "“Yes” sending — waiting for the desktop to confirm");
  assert.doesNotMatch(one, /link/);
  assert.doesNotMatch(queuedAnswerNote([{ label: "a" }, { label: "b" }], true), /link|queued/);
});
