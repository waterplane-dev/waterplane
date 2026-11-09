import test from "node:test";
import assert from "node:assert/strict";

import { explainName } from "./explainName.ts";

test("an Explain's name never doubles a leading what", () => {
  assert.equal(explainName("the hold"), "what the hold means");
  assert.equal(explainName("what the vault does with this key"), "what the vault does with this key means");
  assert.equal(explainName("What this allows"), "what this allows means");
  assert.equal(explainName("whatever"), "what whatever means");
});
