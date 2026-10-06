/**
 * The share sheet's wording and its session list.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { shareOtherSessions, shareSummary } from "./logic.ts";

test("shareSummary counts pictures, files and text by how they will be routed", () => {
  assert.equal(shareSummary({ files: [{ type: "image/png", name: "a" }, { type: "application/pdf", name: "b" }], text: "x" }), "1 picture · 1 file · text");
  assert.equal(shareSummary({ files: [{ type: "image/svg+xml", name: "a.svg" }, { type: "", name: "c.JPG" }], text: "" }), "1 picture · 1 file");
  assert.equal(shareSummary({ files: [], text: "" }), "nothing");
});

test("shareOtherSessions: live ones, without the one on screen", () => {
  const ss = [{ id: "a", running: true }, { id: "b", running: false }, { id: "c", running: true }];
  assert.deepEqual(shareOtherSessions(ss, "a").map((s) => s.id), ["c"]);
  assert.deepEqual(shareOtherSessions(ss, null).map((s) => s.id), ["a", "c"]);
});
