/**
 * The migration nobody can run twice.
 *
 * `myapp.padRescue` holds ten real notes on one phone and nowhere else. Every
 * rule below is one that, if it goes, either deletes those words or resurrects
 * something the person deliberately threw away — and neither is visible from
 * any screen afterwards, because the source value is read once and the mark is
 * written.
 *
 *     node --test packages/web/src/padMigrate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRescueRows } from "./padMigrate.ts";

const NOW = 1_700_000_000_000;
const empty = () => ({ notes: [], tombs: [] });
const byId = (doc, id) => doc.notes.find((n) => n.id === id);

test("a plain row comes back with its OWN id and its OWN ts", () => {
  const { doc, n } = migrateRescueRows([{ id: "r1", text: "the words", ts: 123 }], empty(), NOW);
  assert.equal(n, 1);
  // Renamed, it would leave every reference to it pointing at nothing; re-stamped
  // `now`, it would sort as today's thought and beat a tombstone it should lose to.
  assert.deepEqual(byId(doc, "r1"), { id: "r1", text: "the words", ts: 123 });
});

test("an id already on the pad is left alone", () => {
  const live = { notes: [{ id: "r1", text: "what I have since typed", ts: 500 }], tombs: [] };
  const { doc, n } = migrateRescueRows([{ id: "r1", text: "the fossil", ts: 999 }], live, NOW);
  assert.equal(n, 0, "nothing was added");
  assert.equal(byId(doc, "r1").text, "what I have since typed", "the live copy wins, newer ts or not");
});

test("a repeated id takes the NEWEST row, and counts once", () => {
  const rows = [
    { id: "r1", text: "older", ts: 100 },
    { id: "r1", text: "newest", ts: 300 },
    { id: "r1", text: "middle", ts: 200 },
  ];
  const { doc, n } = migrateRescueRows(rows, empty(), NOW);
  assert.equal(n, 1, "one note, however many copies of it the file held");
  assert.equal(byId(doc, "r1").text, "newest");
  assert.equal(doc.notes.length, 1);
});

test("a tombstone AT or AFTER the row's ts wins; one from BEFORE it does not", () => {
  const deletedSince = { notes: [], tombs: [{ id: "r1", gone: 200 }] };
  assert.equal(migrateRescueRows([{ id: "r1", text: "x", ts: 100 }], deletedSince, NOW).n, 0,
    "deleted after it was written — resurrecting it is what tombstones exist to stop");
  assert.equal(migrateRescueRows([{ id: "r1", text: "x", ts: 200 }], deletedSince, NOW).n, 0,
    "equal counts as deleted since: the delete is the later fact");

  const deletedBefore = { notes: [], tombs: [{ id: "r1", gone: 100 }] };
  const { doc, n } = migrateRescueRows([{ id: "r1", text: "typed after the delete", ts: 200 }], deletedBefore, NOW);
  assert.equal(n, 1, "these words were typed AFTER that delete");
  assert.equal(byId(doc, "r1").text, "typed after the delete");
  assert.deepEqual(doc.tombs, [], "and the spent tombstone goes, or the merge deletes it again");
});

test("a row with no usable ts is stamped `now` rather than dropped", () => {
  const rows = [{ id: "r1", text: "x" }, { id: "r2", text: "y", ts: "yesterday" }, { id: "r3", text: "z", ts: NaN }];
  const { doc, n } = migrateRescueRows(rows, empty(), NOW);
  assert.equal(n, 3);
  for (const id of ["r1", "r2", "r3"]) assert.equal(byId(doc, id).ts, NOW);
});

test("`steps`, `cwd`, `lostAt` and `how` are all optional — the note still migrates", () => {
  const rows = [
    { id: "r1", text: "bare" },
    { id: "r2", text: "full", ts: 5, steps: ["then this", "", 7, "  "], cwd: "/repo", lostAt: 1, how: "draft" },
  ];
  const { doc, n } = migrateRescueRows(rows, empty(), NOW);
  assert.equal(n, 2);
  assert.deepEqual(byId(doc, "r1"), { id: "r1", text: "bare", ts: NOW }, "absent stays ABSENT, never an empty array");
  assert.deepEqual(byId(doc, "r2").steps, ["then this"], "blank and non-string steps are not steps");
  assert.equal(byId(doc, "r2").cwd, "/repo");
  assert.equal("lostAt" in byId(doc, "r2"), false, "there is one pad now; where it came from is not a field");
  assert.equal("how" in byId(doc, "r2"), false);
});

test("a row with no id or no text is dropped, and never throws", () => {
  const rows = [
    null, undefined, 7, "a string", [],
    { text: "no id at all" },
    { id: "", text: "empty id" },
    { id: 12, text: "id is not a string" },
    { id: "r1" },
    { id: "r2", text: "" },
    { id: "r3", text: "   " },
    { id: "r4", text: 9 },
    { id: "keep", text: "the one real one", ts: 1 },
  ];
  const { doc, n } = migrateRescueRows(rows, empty(), NOW);
  assert.equal(n, 1, "the count is what was ACTUALLY added");
  assert.deepEqual(doc.notes.map((x) => x.id), ["keep"]);
});

test("nothing to migrate returns the doc it was given, untouched", () => {
  const live = { notes: [{ id: "a", text: "x", ts: 1 }], tombs: [{ id: "b", gone: 2 }] };
  for (const rows of [[], null, undefined, {}, "[]"]) {
    const out = migrateRescueRows(rows, live, NOW);
    assert.equal(out.n, 0);
    assert.equal(out.doc, live, "the same object: App writes only when `n` says something moved");
  }
});
