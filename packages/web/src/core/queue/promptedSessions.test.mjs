/** A session whose create carried a first prompt is not empty while the desktop may still be typing it. */
import test from "node:test";
import assert from "node:assert/strict";
import { isPromptedSession, notePromptedSession } from "./promptedSessions.ts";

test("a prompted session stays non-empty for the host's wait, then lets go", () => {
  assert.equal(isPromptedSession("s1", 0), false);
  notePromptedSession("s1", 1000);
  assert.equal(isPromptedSession("s1", 1000 + 60_000), true);
  assert.equal(isPromptedSession("s1", 1000 + 3 * 60_000 + 1), false);
  assert.equal(isPromptedSession("other", 1000), false);
});
