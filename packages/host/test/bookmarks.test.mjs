/**
 * Conversation bookmarks (R-conversations-007): the store (`bookmarks.ts`)
 * survives a restart and refuses a bad id; the archive (`archive.ts`) stamps
 * bookmark + name, filters to bookmarks honestly, searches name and note, and
 * reads an archived conversation as the reader's document without a session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookmarkStore } from "../dist/bookmarks.js";
import { archivedToolDetails, archivedTranscript, listArchive } from "../dist/archive.js";

const tmp = (p) => mkdtempSync(join(tmpdir(), `waterplane-bookmark-${p}-`));
const ID1 = "aaaaaaaa-0000-0000-0000-000000000001";
const ID2 = "aaaaaaaa-0000-0000-0000-000000000002";
const ID3 = "aaaaaaaa-0000-0000-0000-000000000003";

test("the store keeps bookmarks per directory across a restart, and refuses a bad id", () => {
  const path = join(tmp("store"), "bookmarks.json");
  const a = new BookmarkStore(path);
  const seen = [];
  a.onChange((cwd, id) => seen.push(id));
  assert.deepEqual(a.set("/r", ID1, { at: 5, note: " look\nhere ", name: "Tab" }), { at: 5, note: "look here", name: "Tab" });
  assert.equal(a.set("/r", "../../etc/passwd", { at: 5 }), undefined);
  assert.equal(a.set("/r", ID2, { note: "no at" }), undefined);
  assert.deepEqual(seen, [ID1]);
  const b = new BookmarkStore(path);
  assert.deepEqual(b.get("/r", ID1), { at: 5, note: "look here", name: "Tab" });
  assert.equal(b.get("/other", ID1), undefined);
  assert.equal(b.set("/r", ID1, null), null);
  assert.equal(new BookmarkStore(path).get("/r", ID1), undefined);
  assert.equal(b.set("/r", ID3, null), null, "removing nothing is not an error");
});

test("the archive stamps, filters and searches bookmarks; a vanished log is not listed", () => {
  const home = tmp("home");
  process.env.CLAUDE_CONFIG_DIR = home;
  const cwd = tmp("repo");
  const dir = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const user = (uuid, text) => ({ type: "user", uuid, timestamp: new Date(1e12).toISOString(), message: { role: "user", content: text } });
  const asst = (uuid, content) => ({ type: "assistant", uuid, timestamp: new Date(1e12).toISOString(), message: { role: "assistant", content } });
  const write = (id, recs, t) => {
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    utimesSync(p, t, t);
  };
  write(ID1, [user("u1", "Fix the scroll jank"), asst("a1", [{ type: "text", text: "done" }])], 1_600_000_000);
  write(ID2, [user("u1", "Write the release notes")], 1_600_000_100);

  const marks = new Map([[ID1, { at: 9, note: "screenshot the gif", name: "Old name" }], [ID3, { at: 9 }]]);
  const names = new Map([[ID2, "Release notes"]]);
  const all = listArchive(cwd, { bookmarks: marks, names });
  assert.equal(all.total, 2);
  assert.equal(all.bookmarked, undefined);
  const byId = Object.fromEntries(all.rows.map((r) => [r.id, r]));
  assert.deepEqual(byId[ID1].bookmark, marks.get(ID1));
  assert.equal(byId[ID1].name, "Old name", "the bookmark's remembered name when the roster knows none");
  assert.equal(byId[ID2].name, "Release notes");
  assert.equal(byId[ID2].bookmark, undefined);

  const only = listArchive(cwd, { bookmarked: true, bookmarks: marks, names });
  assert.equal(only.bookmarked, true);
  assert.equal(only.total, 1, "total counts after the cut; the bookmark with no log is not listed");
  assert.equal(only.scanned, 2);
  assert.deepEqual(only.rows.map((r) => r.id), [ID1]);

  assert.deepEqual(listArchive(cwd, { q: "GIF", bookmarks: marks }).rows.map((r) => r.id), [ID1], "q matches the note");
  assert.deepEqual(listArchive(cwd, { q: "release notes", names }).rows.map((r) => r.id), [ID2]);
  assert.deepEqual(listArchive(cwd, { q: "old name", bookmarks: marks }).rows.map((r) => r.id), [ID1], "q matches the name");

  const doc = archivedTranscript(cwd, ID1);
  assert.equal(doc.source, "jsonl");
  assert.equal(doc.claudeSessionId, ID1);
  assert.equal(doc.turns[0].prompt, "Fix the scroll jank");
  assert.equal(archivedTranscript(cwd, ID1, Date.now()), "unchanged");
  assert.equal(archivedTranscript(cwd, "../../x"), null);
  assert.equal(archivedTranscript(cwd, ID3), null);
  assert.equal(archivedToolDetails(cwd, "../x", "t1"), null);
});
