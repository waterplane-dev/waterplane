import test from "node:test";
import assert from "node:assert/strict";

import { acceptsResults } from "./logic.ts";

test("results land only on the scope the sheet is showing", () => {
  assert.equal(acceptsResults("s1", "s1"), true);
  assert.equal(acceptsResults(undefined, null), true);
  assert.equal(acceptsResults("s1", "s2"), false);
  assert.equal(acceptsResults("s1", null), false, "a session-scoped reply is not the all-sessions list");
  assert.equal(acceptsResults(undefined, "s1"), false, "an all-sessions reply is not one session's");
});
