import test from "node:test";
import assert from "node:assert/strict";
import { archiveRowLines, bookmarkChipText, bookmarkCount, bookmarkCutText, withBookmark } from "./bookmarkFacts.ts";

test("row lines: tab name as title with the first prompt under it", () => {
  assert.deepEqual(archiveRowLines({ title: "fix the login redirect", name: "login fix" }), { title: "login fix", sub: "fix the login redirect" });
});

test("row lines: one line when the two agree or only one is known", () => {
  assert.deepEqual(archiveRowLines({ title: "Login fix", name: "login fix" }), { title: "login fix", sub: null });
  assert.deepEqual(archiveRowLines({ title: "only a prompt" }), { title: "only a prompt", sub: null });
  assert.deepEqual(archiveRowLines({ title: "", name: "named" }), { title: "named", sub: null });
  assert.deepEqual(archiveRowLines({ title: "" }), { title: null, sub: null });
});

test("row lines: the bookmark's remembered name stands in for a forgotten tab name", () => {
  assert.deepEqual(archiveRowLines({ title: "p", bookmark: { at: 1, name: "kept name" } }), { title: "kept name", sub: "p" });
});

test("count comes from the bookmarked listing alone; an old host is said, never counted", () => {
  assert.deepEqual(bookmarkCount(null), { kind: "loading" });
  assert.deepEqual(bookmarkCount({ cwd: "/r", total: 400, offset: 0, rows: [], scanned: 400 }), { kind: "old-host" });
  const c = bookmarkCount({ cwd: "/r", total: 3, offset: 0, rows: [], scanned: 400, bookmarked: true });
  assert.deepEqual(c, { kind: "count", n: 3 });
  assert.equal(bookmarkChipText(c), "Bookmarks (3)");
  assert.equal(bookmarkChipText({ kind: "old-host" }), "Bookmarks");
});

test("the cut says n of N, and an old host is a sentence about the desktop", () => {
  assert.match(bookmarkCutText({ kind: "count", n: 3 }, 400), /3 of 400/);
  assert.match(bookmarkCutText({ kind: "old-host" }, 400), /update/);
});

test("withBookmark patches one row and removes the field cleanly", () => {
  const rows = [{ id: "a", bookmark: { at: 1 } }, { id: "b" }];
  const off = withBookmark(rows, "a", undefined);
  assert.equal("bookmark" in off[0], false);
  assert.equal(off[1], rows[1]);
  assert.deepEqual(withBookmark(rows, "b", { at: 2, note: "n" })[1], { id: "b", bookmark: { at: 2, note: "n" } });
});
