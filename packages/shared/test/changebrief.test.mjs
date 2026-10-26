import { test } from "node:test";
import assert from "node:assert/strict";
import { CHANGE_FOCI, DEFAULT_CHANGE_FOCI, MAX_CHANGE_FOCUS_NOTE, cleanChangeFoci, cleanChangeFocusNote } from "../dist/index.js";

test("every focus is ticked by default, and ids are unique", () => {
  assert.deepEqual(DEFAULT_CHANGE_FOCI, CHANGE_FOCI.map((f) => f.id));
  assert.equal(new Set(DEFAULT_CHANGE_FOCI).size, CHANGE_FOCI.length);
  for (const id of ["security", "behavior", "deploy"]) assert.ok(DEFAULT_CHANGE_FOCI.includes(id), id);
});

test("an id the table does not know is dropped on both ends, and order is the table's", () => {
  assert.deepEqual(cleanChangeFoci(["deploy", "nope", "security", 3, "deploy"]), ["security", "deploy"]);
  assert.deepEqual(cleanChangeFoci("security"), []);
  assert.deepEqual(cleanChangeFoci(undefined), []);
});

test("the own-focus line is trimmed and clipped to the cap", () => {
  assert.equal(cleanChangeFocusNote("  payments?  "), "payments?");
  assert.equal(cleanChangeFocusNote("x".repeat(MAX_CHANGE_FOCUS_NOTE + 50)).length, MAX_CHANGE_FOCUS_NOTE);
  assert.equal(cleanChangeFocusNote(42), "");
});
