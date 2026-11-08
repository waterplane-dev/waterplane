/** The file browser's remembered folder (`filesDir.ts`). node --test packages/web/src/filesDir.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirFor, withDir } from "./filesDir.ts";

test("each repo keeps its own folder", () => {
  const dirs = withDir(withDir({}, "a", "packages/web"), "b", "docs");
  assert.equal(dirFor(dirs, "a"), "packages/web");
  assert.equal(dirFor(dirs, "b"), "docs");
});

test("an unknown repo, or a value that is not a path, starts at the root", () => {
  assert.equal(dirFor({}, "a"), "");
  assert.equal(dirFor({ a: 3 }, "a"), "");
});

test("going back to the root drops the entry and leaves the others", () => {
  assert.deepEqual(withDir({ a: "x", b: "y" }, "a", ""), { b: "y" });
});
