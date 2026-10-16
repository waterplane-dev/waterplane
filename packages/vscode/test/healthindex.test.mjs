// The health index the Health view draws above the readings (`src/health/healthindexdoc.ts`):
// derived from the series file the view read, as the desktop host's `healthwatch.ts` does, and a
// sentence — never a 100 — where there is no file, no baseline or nothing readable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { data, tmp } from "./helpers.mjs";

const day = (w) => new Date(Date.UTC(2026, 0, 7) + w * 7 * 86_400_000).toISOString().slice(0, 10);
const row = (w, p95) => ({
  sha: `s${w}`, day: day(w), ts: Date.parse(`${day(w)}T12:00:00Z`), batch: false, prereg: "2026-09-22a+test",
  size: { value: { p95 } }, retouch: { value: { rate: 0.5 } }, hatches: { value: { todo: 100 } },
  context: { value: { claudeMdChars: 12_000, descChars: 4_000 } },
  untested: { value: Array.from({ length: 400 }, (_, i) => `m${i}`) },
  classics: { value: { loc: 100_000, files: 1000 } },
});
const NOW = Date.parse("2026-02-01T00:00:00Z");

test("a series with a complete week chains from 100; a shrinking p95 lifts it", () => {
  const text = [row(0, 500), row(1, 400)].map((r) => JSON.stringify(r)).join("\n") + "\n{torn";
  const r = data.healthIndexOf(text, NOW);
  assert.equal(r.series.baselineWeek, "2026-01-05");
  assert.equal(r.series.points.length, 2);
  assert.equal(r.series.points[0].index, 100);
  assert.ok(r.series.points[1].index > 100, "a smaller p95 is a step up");
  assert.ok(r.series.points[1].contributions.size > 0);
  assert.equal(r.lastRefresh, null, "no weekly refresh runs in the extension");
});

test("no file, no baseline: a reason, never a number", () => {
  const none = data.healthIndexOf(null, NOW);
  assert.equal(none.series, null);
  assert.match(none.reason, /no repo-health series/);
  const partial = { ...row(0, 500), untested: { value: null, reason: "x" } };
  const nb = data.healthIndexOf(JSON.stringify(partial), NOW);
  assert.equal(nb.series, null);
  assert.match(nb.reason, /no baseline/);
});

test("read off a file; a missing file is the no-series sentence", () => {
  const d = tmp("hix");
  const f = join(d, "repohealth.jsonl");
  writeFileSync(f, [row(0, 500), row(1, 500)].map((r) => JSON.stringify(r)).join("\n"));
  assert.equal(Math.round(data.healthIndexOfFile(f, NOW).series.points[1].index), 100);
  assert.match(data.healthIndexOfFile(join(d, "nope.jsonl"), NOW).reason, /no repo-health series/);
});
