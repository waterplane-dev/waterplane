/**
 * Conversation bookmarks (`bookmark.ts`, R-conversations-007): a bookmark that
 * cannot say when it was set is dropped whole; note and name are one clipped
 * line; the id rule is the archive delete's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOKMARK_NOTE_CAP, cleanBookmark, clipBookmarkText, isConversationId } from "../dist/index.js";

test("a bookmark without a usable `at` is dropped, not defaulted", () => {
  assert.equal(cleanBookmark(null), null);
  assert.equal(cleanBookmark([]), null);
  assert.equal(cleanBookmark({ note: "x" }), null);
  assert.equal(cleanBookmark({ at: 0 }), null);
  assert.equal(cleanBookmark({ at: Number.NaN }), null);
  assert.equal(cleanBookmark({ at: "5" }), null);
});

test("note and name are one line, clipped, and dropped when empty", () => {
  assert.deepEqual(cleanBookmark({ at: 7, note: "  the gif\n frame  ", name: " Tab  name " }), { at: 7, note: "the gif frame", name: "Tab name" });
  assert.deepEqual(cleanBookmark({ at: 7, note: "   ", name: 42, extra: true }), { at: 7 });
  const long = cleanBookmark({ at: 1, note: "a".repeat(500) });
  assert.equal(long.note.length, BOOKMARK_NOTE_CAP);
  assert.ok(long.note.endsWith("…"));
  assert.equal(clipBookmarkText(undefined), undefined);
});

test("a conversation id is a bare basename — no traversal, no dots", () => {
  assert.equal(isConversationId("aaaaaaaa-0000-0000-0000-000000000001"), true);
  for (const bad of ["", "../x", "a/b", "a.b", ".hidden", "-lead", "a".repeat(129), 5, null]) assert.equal(isConversationId(bad), false, String(bad));
});
