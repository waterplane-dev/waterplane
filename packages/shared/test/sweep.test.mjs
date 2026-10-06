// Clearing out a transport directory (`shared/src/sweep.ts`).
//
// What these pin is the pair of rules that make a destructive control safe to
// put on a phone: the chip's NUMBER and the list it opens come from one
// predicate, and every count travels with its bytes. The measured case this was
// written for is a repo whose outbox held 31 files and 4.0 GB — where the count
// alone would have understated the decision by three orders of magnitude.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SWEEP_AGES, SWEEP_AGE_LABEL, fmtBytes, olderThan, planSweep,
  sweepButtonText, sweepCounts, sweepKeepText, sweepResultText, tally,
} from "../dist/index.js";

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const DAY = 86_400_000;
const MB = 1024 * 1024;

/** A file `days` old, `mb` megabytes big. */
const f = (name, days, mb) => ({ name, relPath: `.claude/outbox/${name}`, size: mb * MB, mtime: NOW - days * DAY });

// One repo's outbox, roughly the measured shape: a few huge old videos and a
// tail of recent small reports.
const ROWS = [
  f("today.png", 0, 2),
  f("yesterday.md", 1, 0.1),
  f("lastweek.gif", 9, 5),
  f("demo-april.mp4", 45, 900),
  f("demo-march.mp4", 100, 1200),
  f("ancient.mov", 400, 700),
];

test("the age ladder NESTS — older than a year is also older than a week", () => {
  // The chips descend, and that is what makes the ladder readable as "how
  // aggressive do I want to be". Disjoint bins answer a question nobody has
  // when the goal is reclaiming space.
  const c = sweepCounts(ROWS, NOW);
  assert.equal(c["7d"].count, 4);
  assert.equal(c["30d"].count, 3);
  assert.equal(c["90d"].count, 2);
  assert.equal(c["365d"].count, 1);
  // Monotone across the whole ladder, by construction rather than by luck.
  for (let i = 1; i < SWEEP_AGES.length; i++) {
    const wide = c[SWEEP_AGES[i - 1]], tight = c[SWEEP_AGES[i]];
    assert.ok(tight.count <= wide.count, `${SWEEP_AGES[i]} ⊄ ${SWEEP_AGES[i - 1]}`);
    assert.ok(tight.bytes <= wide.bytes, `${SWEEP_AGES[i]} bytes ⊄ ${SWEEP_AGES[i - 1]}`);
  }
});

test("the chip's number and the list it opens are the same cut", () => {
  // CLAUDE.md: a count on a control IS a filter, and one bucketing function
  // feeds both the number and the cut. A second copy of the edge is how a badge
  // becomes a liar, so this is the assertion that would catch it.
  const counts = sweepCounts(ROWS, NOW);
  for (const age of SWEEP_AGES) {
    const plan = planSweep(ROWS, age, NOW);
    assert.equal(plan.count, counts[age].count, age);
    assert.equal(plan.bytes, counts[age].bytes, age);
    for (const r of plan.rows) assert.ok(olderThan(r.mtime, age, NOW), `${r.name} is not ${age} old`);
  }
});

test("bytes travel with every count — the count alone is not the decision", () => {
  // 3 files of 6 reads as half the directory. Those 3 files are 99% of its
  // bytes, which is the fact the reader is actually acting on.
  const plan = planSweep(ROWS, "30d", NOW);
  assert.equal(plan.count, 3);
  assert.equal(plan.total.count, 6);
  assert.ok(plan.bytes / plan.total.bytes > 0.99);
  assert.equal(sweepButtonText(plan), "Delete 3 files · 2.7 GB");
});

test("the cut is on mtime, so a rewritten artifact is not old", () => {
  // A build that overwrites `report.html` every run has a fresh mtime and a
  // months-old birth time. Cutting on creation would delete today's output.
  const rewritten = { name: "report.html", relPath: ".claude/outbox/report.html", size: 10, mtime: NOW - DAY, ctime: NOW - 300 * DAY };
  assert.equal(olderThan(rewritten.mtime, "7d", NOW), false);
  assert.equal(planSweep([rewritten], "365d", NOW).count, 0);
});

test("rows come back newest first, and the plan says how far back it reaches", () => {
  const plan = planSweep(ROWS, "7d", NOW);
  assert.deepEqual(plan.rows.map((r) => r.name), ["lastweek.gif", "demo-april.mp4", "demo-march.mp4", "ancient.mov"]);
  // How far back the cut REACHES, not how far back it was allowed to: those
  // differ whenever the oldest file is younger than the chip.
  assert.equal(plan.oldestMtime, NOW - 400 * DAY);
  assert.equal(planSweep(ROWS, "365d", NOW).oldestMtime, NOW - 400 * DAY);
  assert.equal(planSweep([], "7d", NOW).oldestMtime, null);
});

test("what is KEPT is said out loud, including when that is nothing", () => {
  // A destructive control that only describes what it destroys leaves the
  // reader to derive the complement — the half they actually care about.
  assert.match(sweepKeepText(planSweep(ROWS, "30d", NOW), "30d"), /^3 newer files stay \(7\.1 MB\)\.$/);
  assert.equal(sweepKeepText(planSweep(ROWS, "365d", NOW), "365d"), "5 newer files stay (2.1 GB).");
  // Nothing matched: all of it stays, and the sentence says the age it failed
  // to match rather than going quiet.
  const none = planSweep([f("new.png", 0, 1)], "365d", NOW);
  assert.equal(sweepKeepText(none, "365d"), `Nothing here is ${SWEEP_AGE_LABEL["365d"]} — all 1 files stay (1.0 MB).`);
  assert.equal(sweepButtonText(none), "Nothing to delete");
  // Everything matched.
  const all = planSweep([f("old.png", 400, 1)], "365d", NOW);
  assert.equal(sweepKeepText(all, "365d"), "Everything here is older than a year. Nothing would be kept.");
  // An empty directory is its own sentence, not "0 newer files stay".
  assert.equal(sweepKeepText(planSweep([], "7d", NOW), "7d"), "Nothing here.");
});

test("\"already gone\" is reported apart from \"could not be removed\"", () => {
  // One is the sweep succeeding by another route (an agent deleted it first);
  // the other is bytes still on disk under a message that says done. Folding
  // them together teaches the reader to distrust a clean run.
  assert.equal(sweepResultText({ deleted: 3, bytes: 3 * MB, missing: [], failed: [] }),
    "Deleted 3 files · 3.0 MB.");
  assert.equal(sweepResultText({ deleted: 2, bytes: MB, missing: ["a"], failed: [] }),
    "Deleted 2 files · 1.0 MB. 1 already gone.");
  assert.equal(sweepResultText({ deleted: 0, bytes: 0, missing: [], failed: ["a", "b"] }),
    "Deleted nothing. 2 could not be removed — still on disk.");
});

test("bytes are readable at a glance, and a nonsense size degrades to ?", () => {
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(999), "999 B");
  assert.equal(fmtBytes(1024), "1.0 KB");
  assert.equal(fmtBytes(4.0 * 1024 * 1024 * 1024), "4.0 GB");
  assert.equal(fmtBytes(160 * MB), "160 MB");
  // Never a wrong number: an unreadable size is absent, per CLAUDE.md.
  assert.equal(fmtBytes(NaN), "?");
  assert.equal(fmtBytes(-1), "?");
});

test("tally is the same arithmetic for the cut and for the whole directory", () => {
  assert.deepEqual(tally([]), { count: 0, bytes: 0 });
  assert.deepEqual(tally(ROWS).count, 6);
  assert.equal(tally(ROWS).bytes, planSweep(ROWS, "7d", NOW).total.bytes);
});

test("planSweep never mutates its input", () => {
  // It sorts, and a sort in place would reorder the caller's listing under it.
  const rows = [f("a", 1, 1), f("b", 400, 1), f("c", 100, 1)];
  const before = rows.map((r) => r.name);
  planSweep(rows, "7d", NOW);
  assert.deepEqual(rows.map((r) => r.name), before);
});
