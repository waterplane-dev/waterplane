/**
 * The phone's storage reading, pinned without a browser.
 *
 *     node --test packages/web/src/storagePlan.test.mjs
 *
 * `storagePlan.ts` has no DOM and no IndexedDB in it, so `node --test` runs it
 * straight over the TypeScript and `npm run test:unit` discovers it — the
 * `downloadState.test.mjs` arrangement.
 *
 * Every case below is a way this screen could lie about a destructive button:
 * folding an unknown into a total as if it were zero, ranking a store nobody
 * could measure above one that was measured, printing a negative "unaccounted"
 * figure because the browser's estimate is approximate, or offering one tap
 * that empties the two kinds of store together.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearButtonText, clearConfirmText, clearGroupText, clearResultText,
  groupUses, nativeNoteText, tallyText, totalText, unnamedBytes, utf8Len,
} from "./storagePlan.ts";

const use = (over = {}) => ({ id: "x", label: "thumbnails", kind: "cache", count: 1, bytes: 10, cost: "costs a re-fetch", ...over });

// ── the two kinds ──────────────────────────────────────────────────────────

test("the two kinds are separate groups and nothing returns their union", () => {
  const { caches, keep } = groupUses([
    use({ id: "thumbs", kind: "cache", bytes: 100 }),
    use({ id: "uploads", kind: "keep", bytes: 900 }),
  ]);
  assert.deepEqual(caches.rows.map((r) => r.id), ["thumbs"]);
  assert.deepEqual(keep.rows.map((r) => r.id), ["uploads"]);
  // The module must not export a way to ask for both at once — the whole point
  // of the split is that one tap can never reach an only-copy store.
  assert.equal(caches.bytes, 100);
  assert.equal(keep.bytes, 900);
});

test("rows are ranked by bytes, biggest first", () => {
  const { caches } = groupUses([
    use({ id: "small", bytes: 10 }),
    use({ id: "big", bytes: 1000 }),
    use({ id: "mid", bytes: 500 }),
  ]);
  assert.deepEqual(caches.rows.map((r) => r.id), ["big", "mid", "small"]);
});

test("an empty store is still a row — a missing row reads as a store we forgot", () => {
  const { caches } = groupUses([use({ id: "full", bytes: 10 }), use({ id: "empty", count: 0, bytes: 0 })]);
  assert.deepEqual(caches.rows.map((r) => r.id), ["full", "empty"]);
  assert.equal(caches.count, 1);
});

// ── unknown is not zero ────────────────────────────────────────────────────

test("an unmeasured row sorts last and poisons the group total", () => {
  const { caches } = groupUses([use({ id: "known", bytes: 5 }), use({ id: "unknown", bytes: null })]);
  assert.deepEqual(caches.rows.map((r) => r.id), ["known", "unknown"]);
  // Not 5. A total that quietly omits an unknown is a wrong number on the one
  // screen whose whole job is to be right about bytes.
  assert.equal(caches.bytes, null);
  assert.equal(caches.partial, true);
});

test("an unmeasured row is never printed as 0 B", () => {
  assert.match(tallyText(3, null, "photo"), /size unknown/);
  assert.doesNotMatch(tallyText(3, null, "photo"), /0 B/);
  assert.equal(tallyText(1, 1024, "photo"), "1 photo · 1.0 KB");
  assert.equal(tallyText(2, 1024, "photo"), "2 photos · 1.0 KB");
});

// ── the gap between what the browser says and what we named ────────────────

test("unaccounted bytes degrade to absent rather than to a negative", () => {
  assert.equal(unnamedBytes(100, 500), 400);
  // The estimate is an approximation; a phone that just deleted something can
  // report less than we measured. That is a reason to say nothing.
  assert.equal(unnamedBytes(500, 100), null);
  assert.equal(unnamedBytes(500, 500), null);
  assert.equal(unnamedBytes(500, undefined), null);
  assert.equal(unnamedBytes(null, 500), null);
  assert.equal(unnamedBytes(100, Number.NaN), null);
});

test("the total line says which of the three cases it is in", () => {
  assert.match(totalText(100, undefined, undefined), /won’t say/);
  assert.match(totalText(null, 500, undefined), /could not be measured/);
  assert.match(totalText(100, 500, 1000), /100 B is named below; the other 400 B/);
  assert.match(totalText(100, 500, 1000), /of 1000 B|of 1000|1.0 KB/);
  // Measured more than the browser admits to: the two readings are said apart,
  // and the impossible "500 B of it" sentence is never printed.
  assert.match(totalText(500, 100, undefined), /measure 500 B between them/);
  assert.doesNotMatch(totalText(500, 100, undefined), /of it is named/);
});

// ── the destructive labels restate the whole decision ──────────────────────

test("a clear button never says just “Clear”", () => {
  assert.equal(clearButtonText(use({ label: "thumbnails", count: 31, bytes: 21 * 1024 * 1024 })), "Clear thumbnails · 31 · 21 MB");
  assert.equal(clearButtonText(use({ count: 0, bytes: 0 })), "Nothing in thumbnails");
  assert.equal(clearButtonText(use({ count: 4, bytes: null })), "Clear thumbnails · 4");
});

test("the second tap words a delete differently from a re-fetch", () => {
  assert.match(clearConfirmText(use({ kind: "keep", count: 2, bytes: 2048 })), /^Yes — delete 2 · 2.0 KB$/);
  assert.match(clearConfirmText(use({ kind: "cache", count: 2, bytes: 2048 })), /^Yes — clear 2 · 2.0 KB$/);
});

test("the group control counts only rows it can actually clear", () => {
  const { caches } = groupUses([
    use({ id: "a", count: 2, bytes: 1024 }),
    use({ id: "b", count: 0, bytes: 0 }),
    use({ id: "c", count: 9, bytes: 1024, cant: "cleared from the queue screen" }),
  ]);
  // Two rows have bytes; only one of them is clearable here.
  assert.equal(clearGroupText({ ...caches, kind: "cache" }), "Clear all 1 caches · 2.0 KB");
  const empty = groupUses([use({ count: 0, bytes: 0 })]).caches;
  assert.equal(clearGroupText({ ...empty, kind: "cache" }), "Nothing cached here");
});

test("a clear that half worked says so, and names what is still there", () => {
  assert.match(clearResultText({ label: "thumbnails", count: 31, bytes: 1024, failed: [] }), /^Cleared 31 entries · 1.0 KB from thumbnails\.$/);
  assert.match(clearResultText({ label: "thumbnails", count: 0, bytes: 0, failed: [] }), /already empty/);
  assert.match(clearResultText({ label: "caches", count: 2, bytes: 10, failed: ["transcripts"] }), /Still here: transcripts/);
});

// ── the bytes the browser cannot see ───────────────────────────────────────

test("files the shell holds are said to be outside the browser’s figure", () => {
  assert.equal(nativeNoteText(0, 0), null);
  assert.match(nativeNoteText(2, 90 * 1024 * 1024), /2 downloads · 90 MB sit outside/);
});

// ── the string measurer ────────────────────────────────────────────────────

test("utf8Len matches the encoder, including on a truncated string", () => {
  const enc = new TextEncoder();
  for (const s of ["", "abc", "größer", "日本語", "a😀b", "\u{1F600}".repeat(3)]) {
    assert.equal(utf8Len(s), enc.encode(s).length, s);
  }
  // A lone high surrogate — what a transcript trimmed mid-character leaves
  // behind. The encoder emits a 3-byte replacement; so do we.
  assert.equal(utf8Len("a\ud83d"), enc.encode("a\ud83d").length);
  assert.equal(utf8Len("\udc00b"), enc.encode("\udc00b").length);
});
