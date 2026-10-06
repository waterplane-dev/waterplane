/**
 * The by-hand build prune, pinned without a disk.
 *
 *     node --test packages/shared/test/sweepfamilies.test.mjs
 *
 * These cases are the ways a cut over build families could delete the wrong
 * thing: eating the newest copy of a variant nothing has rebuilt, folding two
 * unrelated artifacts into one family, disagreeing with the chip that opened
 * it, or offering a non-empty cut over a directory of photographs where every
 * file is its own family of one.
 *
 * Several of them pin behaviour that is INHERITED from `artifacts.ts`
 * (`familyKey`'s stable/variable token split). That is deliberate: this cut is
 * the first place a person sees that rule applied to files they did not just
 * build, so a silent change to it would change what a destructive button
 * selects — and the test that notices should sit beside the button, not only
 * beside the download queue.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FAMILY_KEEPS, familyButtonText, familyCount, familyCounts, familyKeepText, planFamilySweep,
} from "../dist/sweepfamilies.js";

/** A row as `files.ts` produces it. `mtime` ascending = build order. */
const row = (relPath, mtime, size = 100) => ({
  name: relPath.slice(relPath.lastIndexOf("/") + 1), relPath, size, mtime,
});

/** Six builds of one app, oldest first. */
const SIX = [
  row(".claude/outbox/picture-app-1.1.0+330.apk", 1_000),
  row(".claude/outbox/picture-app-1.1.0+331.apk", 2_000),
  row(".claude/outbox/picture-app-1.1.0+332.apk", 3_000),
  row(".claude/outbox/picture-app-1.1.0+333.apk", 4_000),
  row(".claude/outbox/picture-app-1.1.0+334.apk", 5_000),
  row(".claude/outbox/picture-app-1.1.0+335.apk", 6_000),
];

// ── the ladder ─────────────────────────────────────────────────────────────

test("keep-N keeps exactly the newest N of a family", () => {
  for (const keep of FAMILY_KEEPS) {
    const plan = planFamilySweep(SIX, keep);
    assert.equal(plan.count, 6 - keep, `keep ${keep}`);
    const kept = SIX.filter((r) => !plan.rows.includes(r)).map((r) => r.mtime);
    // The survivors are the newest ones, not any N of them.
    assert.deepEqual(kept.sort((a, b) => a - b), SIX.slice(6 - keep).map((r) => r.mtime));
  }
});

test("the ladder NESTS — a wider cut's victims contain a narrower one's", () => {
  const paths = (keep) => new Set(planFamilySweep(SIX, keep).rows.map((r) => r.relPath));
  const one = paths(1), three = paths(3), five = paths(5);
  for (const p of three) assert.ok(one.has(p), `${p} missing from keep-1`);
  for (const p of five) assert.ok(three.has(p), `${p} missing from keep-3`);
  // Descending counts are what makes the chip row readable as "how aggressive".
  assert.ok(one.size > three.size && three.size > five.size);
});

test("the chip's number and the chip's cut are one function", () => {
  const counts = familyCounts(SIX);
  for (const keep of FAMILY_KEEPS) {
    const plan = planFamilySweep(SIX, keep);
    assert.equal(counts[keep].count, plan.count, `keep ${keep} count`);
    assert.equal(counts[keep].bytes, plan.bytes, `keep ${keep} bytes`);
  }
});

test("a family smaller than the keep loses nothing", () => {
  const two = SIX.slice(4);
  assert.equal(planFamilySweep(two, 3).count, 0);
  assert.equal(planFamilySweep(two, 5).count, 0);
  assert.equal(planFamilySweep(two, 1).count, 1);
});

// ── what counts as the same thing ──────────────────────────────────────────

test("a variant suffix is a stable token, so debug and release are separate families", () => {
  const rows = [
    row(".claude/outbox/app-debug-1.apk", 1_000),
    row(".claude/outbox/app-debug-2.apk", 2_000),
    row(".claude/outbox/app-release-1.apk", 3_000),
    row(".claude/outbox/app-release-2.apk", 4_000),
  ];
  assert.equal(familyCount(rows), 2);
  const plan = planFamilySweep(rows, 1);
  // One victim per family — never "three older files than the newest build".
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.rows.map((r) => r.mtime).sort((a, b) => a - b), [1_000, 3_000]);
});

test("`-dirty` splits a family, and that is pinned rather than fixed", () => {
  // Measured on this desktop: `tiptoi-debug-dirty.apk` is a family of 72 while
  // `tiptoi-debug.apk` is a family of 3. Somebody will eventually read that as
  // a bug in `familyKey`; it is the same rule that stops a sibling artifact
  // being eaten, and changing it changes what the download queue de-duplicates
  // and what the automatic prune deletes. If this test fails, that decision was
  // made somewhere else.
  const rows = [
    row(".claude/outbox/tiptoi-debug-aa11bb22.apk", 1_000),
    row(".claude/outbox/tiptoi-debug-cc33dd44.apk", 2_000),
    row(".claude/outbox/tiptoi-debug-dirty-ee55ff66.apk", 3_000),
    row(".claude/outbox/tiptoi-debug-dirty-1122aabb.apk", 4_000),
  ];
  assert.equal(familyCount(rows), 2);
  assert.equal(planFamilySweep(rows, 1).count, 2);
});

test("the uniquifier files.ts appends is the same artifact, not another one", () => {
  const rows = [
    row(".claude/outbox/report-aa11bb.html", 1_000),
    row(".claude/outbox/report-cc22dd_2.html", 2_000),
  ];
  assert.equal(familyCount(rows), 1);
  assert.equal(planFamilySweep(rows, 1).count, 1);
});

test("photos never supersede each other, so the cut over an inbox is empty", () => {
  // Every token variable ⇒ `familyKey` falls back to the exact path. This is
  // why the chip row is drawn on the outbox scope only: a control that can
  // only ever select nothing is worse than no control.
  const rows = [
    row(".claude/inbox/1000074170.jpg", 1_000),
    row(".claude/inbox/1000074171.jpg", 2_000),
    row(".claude/inbox/1000074172.jpg", 3_000),
  ];
  assert.equal(familyCount(rows), 3);
  assert.equal(planFamilySweep(rows, 1).count, 0);
});

test("a regeneration at the same path still supersedes", () => {
  // The common build-overwrites-its-output case — one path, so one family.
  const rows = [row(".claude/outbox/1000074170.jpg", 1_000)];
  assert.equal(planFamilySweep(rows, 1).count, 0);
});

// ── the totals and the sentences ───────────────────────────────────────────

test("the plan carries the WHOLE directory for the n-of-N line", () => {
  const plan = planFamilySweep(SIX, 3);
  assert.equal(plan.total.count, 6);
  assert.equal(plan.total.bytes, 600);
  assert.equal(plan.bytes, 300);
  assert.equal(plan.oldestMtime, 1_000);
  // Rows come back newest first, like every other listing here.
  assert.deepEqual(plan.rows.map((r) => r.mtime), [3_000, 2_000, 1_000]);
});

test("nothing selected leaves oldestMtime absent rather than a made-up number", () => {
  const plan = planFamilySweep(SIX.slice(5), 3);
  assert.equal(plan.count, 0);
  assert.equal(plan.oldestMtime, null);
});

test("the sentence says what STAYS, and how many families it is across", () => {
  const plan = planFamilySweep(SIX, 3);
  assert.match(familyKeepText(plan, 3, familyCount(SIX)), /3 files stay \(300 B\) — the newest 3 of each of 1 build family\./);
  const none = planFamilySweep(SIX.slice(5), 3);
  assert.match(familyKeepText(none, 3, 1), /Nothing here is superseded/);
  assert.equal(familyKeepText(planFamilySweep([], 3), 3, 0), "Nothing here.");
});

test("the button restates the whole decision, and says why these files", () => {
  assert.equal(familyButtonText(planFamilySweep(SIX, 3)), "Delete 3 superseded builds · 300 B");
  assert.equal(familyButtonText(planFamilySweep(SIX.slice(5), 3)), "Nothing superseded");
  assert.equal(familyButtonText(planFamilySweep(SIX.slice(4), 1)), "Delete 1 superseded build · 100 B");
});
