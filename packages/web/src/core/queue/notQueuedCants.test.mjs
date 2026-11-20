import test from "node:test";
import assert from "node:assert/strict";
import { notQueuedCants, PHASE_NOT_QUEUED } from "./phase.ts";

const verbs = [["when it's free", true], ["start in order", false], ["send it somewhere else", true], ["add a prompt", false]];

test("a queued row says nothing: the buttons are there", () => {
  assert.deepEqual(notQueuedCants(verbs, true, "x"), []);
});

test("a row past queued names only the verbs that apply, with the phase's reason in text", () => {
  const reason = PHASE_NOT_QUEUED.sending;
  assert.deepEqual(notQueuedCants(verbs, false, reason), [
    { label: "when it's free", reason },
    { label: "send it somewhere else", reason },
  ]);
});

test("no reason, no sentence (never an empty 'no x —')", () => {
  assert.deepEqual(notQueuedCants(verbs, false, ""), []);
});
