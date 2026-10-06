// The pad's merge (`shared/src/pad.ts`).
//
// The pad is a synced setting, and a synced setting is an opaque string with
// one `ts`: the host's merge can only be last-write-wins on the WHOLE value, so
// a device pushing a stale copy used to delete every note the other one held.
// This is the per-note merge that replaces it — tombstones so a delete can
// travel, a canonical serialization so two devices holding the same notes agree
// byte for byte, and a tie-break that is deterministic rather than polite.
//
// The words the sheet says are here too, for `shared/assess.ts`'s reason: a
// reword is a decision about the app's vocabulary and edits this file with it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptPad, draftToRescue, mergePad, parsePad, removeNotes, serializePad, upsertNote,
  PAD_TOMB_CAP, PAD_TOMB_TTL_MS,
  DRAFT_KEPT_TOAST, DRAFT_REFUSED_TOAST, FILE_WORDS, PAD_HINT, PAD_WRITE_REFUSED,
  padFiledToast, padFullText, padMigratedToast,
} from "../dist/index.js";

const NOW = 1_700_000_000_000;
const note = (id, ts, text = `note ${id}`) => ({ id, text, ts });
const doc = (notes = [], tombs = []) => ({ notes, tombs });
const ids = (d) => d.notes.map((n) => n.id).sort();
const tombIds = (d) => d.tombs.map((t) => t.id).sort();

// ── parse ────────────────────────────────────────────────────────────

test("parse tolerates junk, and a non-array is an EMPTY doc", () => {
  assert.deepEqual(parsePad(null), doc());
  assert.deepEqual(parsePad(""), doc());
  assert.deepEqual(parsePad("not json at all"), doc());
  assert.deepEqual(parsePad('{"notes":[]}'), doc()); // an object is not an array
  assert.deepEqual(parsePad("[]"), doc());
});

test("parse keeps notes and tombstones apart, and drops what is neither", () => {
  const d = parsePad(JSON.stringify([
    { id: "a", text: "hello", ts: 5 },
    { id: "b", gone: 9 },
    { id: "c" },                       // neither: no text, no `gone`
    { text: "no id", ts: 1 },          // no id
    null, 7, "x",
    { id: "d", text: "junk ts", ts: "nope", steps: ["one", 2, "three"], cwd: "/r" },
  ]));
  assert.deepEqual(ids(d), ["a", "d"]);
  assert.deepEqual(tombIds(d), ["b"]);
  const dd = d.notes.find((n) => n.id === "d");
  assert.equal(dd.ts, 0);                       // a non-finite ts degrades to 0
  assert.deepEqual(dd.steps, ["one", "three"]); // steps filtered to strings
  assert.equal(dd.cwd, "/r");
});

test("duplicate note ids keep the greater ts", () => {
  const d = parsePad(JSON.stringify([note("a", 1, "old"), note("a", 9, "new")]));
  assert.equal(d.notes.length, 1);
  assert.equal(d.notes[0].text, "new");
});

// ── serialize ────────────────────────────────────────────────────────

test("serialization is CANONICAL — two orderings produce one string", () => {
  // This is what makes the convergence in `web/settings.ts` terminate: the
  // loser of a concurrent push re-merges and gets back the exact string it was
  // sent, so nothing is pushed again.
  const a = doc([note("b", 2), note("a", 2), note("c", 5)], [{ id: "z", gone: 1 }, { id: "y", gone: 4 }]);
  const b = doc([note("c", 5), note("a", 2), note("b", 2)], [{ id: "y", gone: 4 }, { id: "z", gone: 1 }]);
  assert.equal(serializePad(a), serializePad(b));
  // Notes newest first, ties by id; tombstones after them.
  assert.deepEqual(JSON.parse(serializePad(a)).map((e) => e.id), ["c", "a", "b", "y", "z"]);
});

test("serialize round-trips through parse", () => {
  const d = doc([{ id: "a", text: "hi", ts: 3, steps: ["then"], cwd: "/r" }], [{ id: "b", gone: 8 }]);
  assert.deepEqual(parsePad(serializePad(d)), d);
});

// ── merge ────────────────────────────────────────────────────────────

test("merge UNIONS the two sides", () => {
  const out = mergePad(doc([note("a", 1)]), doc([note("b", 2)]), NOW);
  assert.deepEqual(ids(out), ["a", "b"]);
});

test("the newer ts wins per note", () => {
  const mine = doc([note("a", 10, "mine, later")]);
  const theirs = doc([note("a", 2, "theirs, earlier")]);
  assert.equal(mergePad(mine, theirs, NOW).notes[0].text, "mine, later");
  assert.equal(mergePad(theirs, mine, NOW).notes[0].text, "mine, later");
});

test("an exact tie is broken DETERMINISTICALLY, not in favour of mine", () => {
  // "prefer mine" diverges: each device would keep its own copy and push it at
  // the other for ever.
  const mine = doc([note("a", 5, "aaa")]);
  const theirs = doc([note("a", 5, "zzz")]);
  const one = mergePad(mine, theirs, NOW);
  const two = mergePad(theirs, mine, NOW);
  assert.equal(serializePad(one), serializePad(two));
  assert.equal(one.notes[0].text, "zzz"); // the canonical JSON that sorts later
});

test("a tombstone at or after the note's ts drops it", () => {
  // Inside the TTL, or the delete is simply forgotten — see the test below.
  const mine = doc([note("a", NOW - 5000)]);
  const theirs = doc([], [{ id: "a", gone: NOW - 5000 }]);
  assert.deepEqual(ids(mergePad(mine, theirs, NOW)), []);
  assert.deepEqual(ids(mergePad(theirs, mine, NOW)), []);
  assert.deepEqual(tombIds(mergePad(mine, theirs, NOW)), ["a"]);
});

test("an EDIT after a delete resurrects the note and drops the tombstone", () => {
  // Typed words beat a delete made on a device that had not seen them.
  const edited = doc([note("a", NOW - 1000, "I typed this after you deleted it")]);
  const deleted = doc([], [{ id: "a", gone: NOW - 5000 }]);
  const out = mergePad(edited, deleted, NOW);
  assert.deepEqual(ids(out), ["a"]);
  assert.deepEqual(tombIds(out), []);
  assert.equal(serializePad(out), serializePad(mergePad(deleted, edited, NOW)));
});

test("a tombstone the pad has moved a TTL past no longer suppresses anything", () => {
  // The cutoff is `newest stamp in the union − TTL`, so it takes newer WORDS to
  // age a delete out. `z` is the pad having moved on without it.
  const stale = NOW - PAD_TOMB_TTL_MS - 1;
  const out = mergePad(doc([note("a", stale - 1000), note("z", NOW)]), doc([], [{ id: "a", gone: stale }]), NOW);
  assert.deepEqual(ids(out), ["a", "z"]);   // the note comes back once, wearing its old date
  assert.deepEqual(tombIds(out), []);
  // One day inside the window still suppresses.
  const fresh = NOW - PAD_TOMB_TTL_MS + 24 * 60 * 60 * 1000;
  assert.deepEqual(
    ids(mergePad(doc([note("a", fresh - 1000), note("z", NOW)]), doc([], [{ id: "a", gone: fresh }]), NOW)),
    ["z"]);
  // …and a pad nobody has written to since ages NOTHING out, however long ago
  // that was: the delete is still the last thing anybody said about this note,
  // so there are no newer words for a stale copy to overwrite.
  const quiet = mergePad(doc([note("a", stale - 1000)]), doc([], [{ id: "a", gone: stale }]), NOW);
  assert.deepEqual(ids(quiet), []);
  assert.deepEqual(tombIds(quiet), ["a"]);
});

test("the TTL is cut on the DATA: clocks hours apart produce the SAME bytes", () => {
  // The push-at-each-other loop this replaces. `gone` sits exactly on the edge
  // `now - PAD_TOMB_TTL_MS` draws, so device A (behind) kept the tombstone and
  // suppressed the note while device B (ahead) dropped it and resurrected the
  // note — each adopt flipped the value back, one push per debounce for the
  // whole skew window, and neither device was wrong.
  const edge = NOW - PAD_TOMB_TTL_MS;
  const mine = doc([note("keep", NOW - 1000)], [{ id: "a", gone: edge }]);
  const theirs = doc([note("a", edge - 5000)]);
  const canonical = serializePad(mergePad(mine, theirs, NOW));
  const hour = 60 * 60 * 1000;
  for (const skew of [-72 * hour, -2 * hour, -1, 0, 1, 2 * hour, 24 * 365 * hour]) {
    assert.equal(serializePad(mergePad(mine, theirs, NOW + skew)), canonical,
      `a device whose clock is ${skew} ms out must merge to the same bytes`);
    assert.equal(serializePad(mergePad(theirs, mine, NOW + skew)), canonical,
      "…from either side, since that is the other half of the same contract");
  }
});

test("a LEGACY array merges, and my tombstones still apply to it", () => {
  // An older bundle writes a bare array of notes: `tombs: []`, so the delete I
  // made here is the only one in play and it still wins.
  const legacy = JSON.stringify([note("a", 1), note("b", 1)]);
  const mine = removeNotes(doc([note("a", 1)]), ["a"], NOW);
  const out = mergePad(mine, parsePad(legacy), NOW);
  assert.deepEqual(ids(out), ["b"]);
});

test("merge is COMMUTATIVE and IDEMPOTENT", () => {
  const mine = removeNotes(doc([note("a", NOW - 9000), note("b", NOW - 7000)]), ["b"], NOW - 1000);
  const theirs = doc([note("b", NOW - 500), note("c", NOW - 4000)], [{ id: "a", gone: NOW - 20_000 }]);
  const ab = serializePad(mergePad(mine, theirs, NOW));
  const ba = serializePad(mergePad(theirs, mine, NOW));
  assert.equal(ab, ba);
  const again = serializePad(mergePad(parsePad(ab), parsePad(ab), NOW));
  assert.equal(again, ab);
  const thrice = serializePad(mergePad(parsePad(ab), theirs, NOW));
  assert.equal(thrice, ab);
});

test("the cap is applied AFTER the resurrection, so reviving one note costs no OTHER delete its place", () => {
  // `PAD_TOMB_CAP + 2` deletes, the newest of which an edit is about to revive.
  // Cutting to the cap FIRST spent one of its slots on the tombstone rule 3 was
  // about to remove, so the output carried CAP − 1 deletes while the union
  // still knew CAP of them — and the one that fell off the bottom was
  // somebody's real delete, made on a device that is no longer holding it.
  const tombs = Array.from({ length: PAD_TOMB_CAP + 2 }, (_, i) => ({ id: `t${i}`, gone: NOW - 5000 + i }));
  const newest = tombs[tombs.length - 1];
  const theirs = doc([], tombs);
  const out = mergePad(doc([note(newest.id, newest.gone + 1)]), theirs, NOW);

  assert.deepEqual(ids(out), [newest.id], "the edit after the delete keeps its words");
  const kept = new Set(out.tombs.map((t) => t.id));
  assert.ok(!kept.has(newest.id), "…and drops its tombstone, which is rule 3");
  assert.equal(out.tombs.length, PAD_TOMB_CAP,
    "the cap is a cut of what SURVIVED rule 3, not a cut taken before it");
  assert.ok(!kept.has("t0"), "the one that fell off is the OLDEST delete");
  assert.ok(kept.has("t1"), "…and only that one: rule 3 freed the other slot, it did not spend it");
  assert.equal(serializePad(mergePad(out, theirs, NOW)), serializePad(out),
    "…so a second exchange with the same peer changes nothing");
});

test("merge NEVER drops a note for size — the caps bind on a local add", () => {
  const many = Array.from({ length: 900 }, (_, i) => note(`n${i}`, i));
  const out = mergePad(doc(many.slice(0, 500)), doc(many.slice(400)), NOW);
  assert.equal(out.notes.length, 900);
});

// ── removeNotes / upsertNote ─────────────────────────────────────────

test("removeNotes tombstones an id that was never here", () => {
  // A delete made against a note only the other device holds still has to
  // travel — "I do not have it" is not a delete.
  const out = removeNotes(doc([note("a", 1)]), ["a", "ghost"], NOW);
  assert.deepEqual(ids(out), []);
  assert.deepEqual(tombIds(out), ["a", "ghost"]);
  // …and it does its job at the merge.
  assert.deepEqual(ids(mergePad(out, doc([note("ghost", NOW - 1)]), NOW)), []);
});

test("upsertNote replaces by id and forgets the delete for it", () => {
  const start = removeNotes(doc([note("a", 1)]), ["a"], NOW);
  const back = upsertNote(start, note("a", NOW + 5, "typed again"));
  assert.deepEqual(tombIds(back), []);
  assert.equal(back.notes.length, 1);
  assert.equal(back.notes[0].text, "typed again");
});

// ── adoptPad ─────────────────────────────────────────────────────────

test('adoptPad("", mine) keeps my notes and reports the change', () => {
  // A removal on the wire must not take this device's notes with it: they
  // survive the merge and get pushed back.
  const mine = serializePad(doc([note("a", 5)]));
  const out = adoptPad("", mine, NOW);
  assert.deepEqual(ids(parsePad(out.value)), ["a"]);
  assert.equal(out.changed, true);
});

test("adoptPad(x, x) reports UNCHANGED — this is where the exchange stops", () => {
  const x = serializePad(doc([note("a", 5), note("b", 9)], [{ id: "c", gone: NOW - 10 }]));
  const out = adoptPad(x, x, NOW);
  assert.equal(out.value, x);
  assert.equal(out.changed, false);
});

test("adoptPad converges in one more round trip", () => {
  // Two devices push concurrently; the host keeps the later ts and sends the
  // winner back to the loser, whose re-merge equals the incoming string.
  const a = serializePad(doc([note("a", 5)]));
  const b = serializePad(doc([note("b", 7)]));
  const merged = adoptPad(b, a, NOW).value;          // A adopts B's value
  assert.equal(adoptPad(merged, b, NOW).value, merged); // B then adopts the merge
  assert.equal(adoptPad(merged, b, NOW).changed, false);
});

// ── the words ────────────────────────────────────────────────────────

test("the sheet's own sentences", () => {
  assert.equal(
    PAD_HINT,
    "Notes with no target yet — write them anywhere, offline included, and aim them later. " +
    "A note that names a repo can be filed straight onto that repo's backlog. " +
    "Sending or filing one uses the normal queue, so it survives a dead tunnel like anything else you type.",
  );
  assert.equal(
    padFullText(400, 498),
    "the pad is full (400 notes, 498 KB) — your text is still in the editor; send, file or clear a note first",
  );
  assert.equal(
    PAD_WRITE_REFUSED,
    "this phone's storage refused the note — your text is still in the editor; free some space, or send or clear a note first",
  );
  assert.equal(padMigratedToast(1), "one note that was kept on this phone is back on the pad");
  assert.equal(padMigratedToast(10), "10 notes that were kept on this phone are back on the pad");
  assert.equal(DRAFT_KEPT_TOAST, "kept your unfinished prompt — it is a note on the pad");
  assert.equal(
    DRAFT_REFUSED_TOAST,
    "the pad could not take your unfinished prompt, so it was left in the box — nothing was replaced",
  );
  assert.equal(FILE_WORDS.label, "file it");
  assert.equal(FILE_WORDS.title("myapp"), "put it on myapp's backlog as it is — it waits there, nothing runs now");
  assert.equal(padFiledToast("myapp", true), "filed offline — it reaches myapp's backlog when the link is back");
  assert.equal(padFiledToast("myapp", false), "filed — on myapp's backlog");
});

// ── draftToRescue: the LOCAL overwrite ───────────────────────────────

test("a draft the seed is about to replace is kept, chain and all", () => {
  const keep = draftToRescue("look at this\fthen run the tests", "");
  assert.deepEqual(keep, { text: "look at this", steps: ["then run the tests"] });
});

test("a single-step draft carries no empty chain", () => {
  assert.deepEqual(draftToRescue("just the one", ""), { text: "just the one" });
});

test("the ordinary cases rescue nothing", () => {
  // Nothing there; whitespace is not a draft; and re-opening the same message
  // is not an overwrite.
  assert.equal(draftToRescue("", "seeded"), null);
  assert.equal(draftToRescue("  \n ", "seeded"), null);
  assert.equal(draftToRescue("same words", "same words"), null);
});

test("a seed that differs at all is an overwrite, even by a space", () => {
  assert.deepEqual(draftToRescue("same words ", "same words"), { text: "same words " });
});
