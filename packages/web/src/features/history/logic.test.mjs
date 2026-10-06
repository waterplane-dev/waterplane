import test from "node:test";
import assert from "node:assert/strict";

import { pinToast } from "./logic.ts";

test("a pin says what it became; a null unpins", () => {
  assert.equal(pinToast("e1"), "pinned as overview label");
  assert.equal(pinToast(null), "unpinned");
});
