// The health index the Health view draws above the readings (`src/health/healthindexdoc.ts`):
// derived from the series file the view read, as the desktop host's `healthwatch.ts` does, and a
// sentence — never a 100 — where there is no file, no scored week or nothing readable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { data, tmp } from "./helpers.mjs";

const day = (w) => new Date(Date.UTC(2026, 0, 7) + w * 7 * 86_400_000).toISOString().slice(0, 10);
const row = (w, max, maxPath = "src/big.ts") => ({
  sha: `s${w}`, day: day(w), ts: Date.parse(`${day(w)}T12:00:00Z`), batch: false, prereg: "2026-09-22a+test",
  size: { value: { p95: 400, lineMean: 300, max, maxPath } }, retouch: { value: { rate: 0.1 } }, hatches: { value: { todo: 100 } },
  context: { value: { claudeMdChars: 4_000, descChars: 1_000 } },
  untested: { value: Array.from({ length: 100 }, (_, i) => `m${i}`) },
  classics: { value: { loc: 100_000, files: 1000 } },
});
const NOW = Date.parse("2026-02-01T00:00:00Z");

test("an absolute score: the giant file caps it and is named; shrinking it lifts the score", () => {
  const text = [row(0, 8_397), row(1, 900)].map((r) => JSON.stringify(r)).join("\n") + "\n{torn";
  const r = data.healthIndexOf(text, NOW);
  assert.equal(r.series.points.length, 2);
  const [a, b] = r.series.points;
  assert.ok(a.index >= 0 && a.index <= 100, "a score, not a chained 100");
  assert.equal(a.cappedBy, "size", "the 8,397-line file holds the score down");
  assert.ok(a.index < a.mean);
  assert.ok(a.alerts.some((x) => x.subject === "max" && /src\/big\.ts/.test(x.text)), "the alert names the offender");
  assert.ok(b.index > a.index, "a smaller longest file is a step up");
  assert.equal(b.alerts.length, 0);
  assert.equal(r.lastRefresh, null, "no weekly refresh runs in the extension");
});

test("no file, no scored week: a reason, never a number", () => {
  const none = data.healthIndexOf(null, NOW);
  assert.equal(none.series, null);
  assert.match(none.reason, /no repo-health series/);
  const partial = { ...row(0, 900), untested: { value: null, reason: "x" } };
  const nb = data.healthIndexOf(JSON.stringify(partial), NOW);
  assert.equal(nb.series, null);
  assert.match(nb.reason, /no scored week/);
});

test("read off a file; a missing file is the no-series sentence", () => {
  const d = tmp("hix");
  const f = join(d, "repohealth.jsonl");
  writeFileSync(f, [row(0, 900), row(1, 900)].map((r) => JSON.stringify(r)).join("\n"));
  assert.equal(Math.round(data.healthIndexOfFile(f, NOW).series.points[1].index), 100);
  assert.match(data.healthIndexOfFile(join(d, "nope.jsonl"), NOW).reason, /no repo-health series/);
});
