/** The weeks fold for the per-day plot series, pure (`node --test`). */
import test from "node:test";
import assert from "node:assert/strict";
import { foldWeeks, weekLastIndices } from "./repoHealthWeeks.ts";

const p = (day, v) => ({ day, v });

test("each ISO week keeps its LAST point, oldest first", () => {
  const pts = [
    p("2026-09-28", 1), // Mon
    p("2026-10-01", 2),
    p("2026-10-04", 3), // Sun — same week
    p("2026-10-05", 4), // Mon — next week
    p("2026-10-14", 5),
  ];
  assert.deepEqual(foldWeeks(pts).map((x) => x.v), [3, 4, 5]);
  assert.deepEqual(weekLastIndices(pts.map((x) => x.day)), [2, 3, 4]);
});

test("a null value is still a point: the week's last point is kept whatever it holds", () => {
  const pts = [p("2026-09-28", 10), p("2026-09-30", null), p("2026-10-06", 12)];
  const f = foldWeeks(pts);
  assert.equal(f.length, 2);
  assert.equal(f[0].v, null, "never swapped for the last non-null day");
  assert.equal(f[0].day, "2026-09-30");
});

test("a day with no week is kept as its own point; empty in, empty out", () => {
  assert.deepEqual(foldWeeks([p("x", 1), p("2026-09-28", 2), p("2026-09-29", 3)]).map((x) => x.v), [1, 3]);
  assert.deepEqual(foldWeeks([]), []);
});

test("the year boundary folds by ISO week, not by calendar year", () => {
  // 2026-12-28 (Mon) … 2027-01-03 (Sun) is one ISO week.
  assert.deepEqual(foldWeeks([p("2026-12-29", 1), p("2027-01-02", 2), p("2027-01-04", 3)]).map((x) => x.v), [2, 3]);
});
