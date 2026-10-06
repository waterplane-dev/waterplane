import test from "node:test";
import assert from "node:assert/strict";

import { suggestionBy } from "./suggestionBy.ts";

test("a suggestion names its plugin, and its model only when it said one", () => {
  assert.equal(suggestionBy({ by: "oracle", byName: "Decision oracle", model: "gemini-2.5-flash" }), "Decision oracle (gemini-2.5-flash)");
  assert.equal(suggestionBy({ by: "oracle", byName: "Decision oracle" }), "Decision oracle");
  assert.equal(suggestionBy({ by: "oracle", byName: "Decision oracle", model: "  " }), "Decision oracle");
});

test("a missing name falls back to the id, then to words — never to blank", () => {
  assert.equal(suggestionBy({ by: "oracle", byName: "" }), "oracle");
  assert.equal(suggestionBy({}), "a plugin");
});

test("an option that makes a standing rule says so, with the host's label and the scope", async () => {
  const { remembersText } = await import("./suggestionBy.ts");
  assert.equal(remembersText({ label: "touch a.txt" }), "won't ask again for: touch a.txt — this session only");
  assert.equal(remembersText({ label: "  " }), "won't ask again for: this request — this session only", "never a blank label");
});
