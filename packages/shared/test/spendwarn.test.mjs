/** Spend warnings: which scale, which colour, and what never trips. */
import test from "node:test";
import assert from "node:assert/strict";
import { SPEND_WARN_DEFAULT as D, cleanSpendWarn, spendWarnOf } from "../dist/index.js";

test("with a weekly calibration the marks are a share of the week: 2% orange, 5% red", () => {
  // $15 a point, the Max reading the defaults were derived from.
  assert.equal(spendWarnOf(20, 15, D), null, "1.3% is under the orange mark");
  const w = spendWarnOf(31, 15, D);
  assert.equal(w.level, "warn"); assert.equal(w.by, "week");
  assert.match(w.text, /≈2.1% of the week/);
  assert.match(w.text, /orange mark at 2%/);
  const h = spendWarnOf(205, 14.6, D);
  assert.equal(h.level, "high");
  assert.match(h.text, /≈14% of the week \(\$205\.00 at list prices\)/);
});

test("without one (an API key, or a week not calibrated yet) dollars decide", () => {
  assert.equal(spendWarnOf(29, null, D), null);
  assert.equal(spendWarnOf(30, null, D).level, "warn");
  const h = spendWarnOf(80, undefined, D);
  assert.equal(h.level, "high"); assert.equal(h.by, "usd");
  assert.match(h.text, /red mark at \$75 \(no weekly limit reading/);
});

test("unknown never trips, and off is off", () => {
  assert.equal(spendWarnOf(null, 15, D), null);
  assert.equal(spendWarnOf(0, 15, D), null);
  assert.equal(spendWarnOf(NaN, null, D), null);
  assert.equal(spendWarnOf(500, 15, { ...D, on: false }), null);
});

test("a stored value is cleaned field by field, never to zero", () => {
  assert.deepEqual(cleanSpendWarn(null), D);
  assert.deepEqual(cleanSpendWarn({ warnPct: 0, highPct: "x" }), D);
  assert.deepEqual(cleanSpendWarn({ on: false, warnPct: 1, highPct: 3, warnUsd: 10, highUsd: 40 }),
    { on: false, warnPct: 1, highPct: 3, warnUsd: 10, highUsd: 40 });
  // red at or under orange is a typo: that pair falls back, the other is kept.
  assert.deepEqual(cleanSpendWarn({ warnPct: 5, highPct: 2, warnUsd: 10, highUsd: 40 }), { ...D, warnUsd: 10, highUsd: 40 });
});
