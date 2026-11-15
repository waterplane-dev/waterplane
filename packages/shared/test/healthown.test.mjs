// The repo's own readings with a TARGET in the health score
// (`shared/src/healthindex/own.ts`, R-metrics-066): scored against the target
// by the curve an entry in that direction uses, in the mean, the worst-entry
// cap and coverage; absent = unknown with the reason, never 0; a reading
// without a target stays out of the score.
import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_SCORE_CAP_GAP,
  healthDirScore,
  healthEntryScore,
  healthHeadlineWords,
  healthCapWords,
  healthIndex,
  healthMoveWords,
  healthOwnCount,
  healthOwnTargetsOf,
  healthRowScore,
  healthScore,
  healthScoreAtLeast,
  repoHealthIndexOf,
} from "../dist/index.js";

const list = (n) => Array.from({ length: n }, (_, i) => `m${i}`);

/** Five quiet entries (100 each) and an optional `own`. */
function quiet(o = {}) {
  const day = o.day ?? "2026-11-04";
  return {
    sha: "s", day, ts: Date.parse(`${day}T12:00:00Z`), batch: false, prereg: "p",
    size: { value: { p95: 300, max: 900, maxPath: "a", lineMean: 300 } },
    retouch: { value: { rate: 0.1 } },
    hatches: { value: { todo: 1 }, split: { unexplained: 1, explained: 0 } },
    context: { value: { claudeMdChars: 8000, descChars: 2000 } },
    untested: { value: list(10) },
    classics: { value: { loc: 100_000, files: 537 } },
    ...(o.own === undefined ? {} : { own: o.own }),
  };
}
const reading = (key, value, extra = {}) => ({ key, name: key.toUpperCase(), means: "m", better: "lower", unit: "", value, ...extra });
const own = (...readings) => ({ file: ".waterplane-shared/health.json", readings });

test("one curve: an entry and an own target in the same direction score alike", () => {
  assert.equal(healthDirScore("lower", 10, 5), healthScore(10, 5));
  assert.equal(healthDirScore("higher", 0.25, 0.5), healthScoreAtLeast(0.25, 0.5));
  assert.equal(healthEntryScore("testsWithCode", 0.25, 0.5), healthDirScore("higher", 0.25, 0.5));
  assert.equal(healthEntryScore("retouch", 0.3, 0.15), healthDirScore("lower", 0.3, 0.15));
});

test("a reading with no target stays out of the score, exactly as before", () => {
  const before = healthRowScore(quiet(), null);
  const s = healthRowScore(quiet({ own: own(reading("plain", 1_000_000)) }), null);
  assert.equal(s.index, before.index);
  assert.equal(s.mean, before.mean);
  assert.equal(s.coverage.applicable, before.coverage.applicable);
  assert.equal(s.coverage.key, before.coverage.key, "no basket moved: not a gap");
  assert.equal(healthOwnCount(s.coverage), 0);
});

test("a reading of this desktop (backfill false) never enters the score, even with a target on the row", () => {
  const before = healthRowScore(quiet(), null);
  const s = healthRowScore(quiet({ own: own(reading("mach", 1_000_000, { target: 5, backfill: false })) }), null);
  assert.equal(s.index, before.index);
  assert.equal(s.coverage.applicable, before.coverage.applicable);
  assert.equal(healthOwnCount(s.coverage), 0);
});

test("a target reached scores 100 and leaves a quiet repo at 100", () => {
  const s = healthRowScore(quiet({ own: own(reading("slow", 4, { target: 5 })) }), null);
  assert.equal(Math.round(s.index), 100);
  assert.equal(s.coverage.measured, 6);
  assert.equal(s.coverage.applicable, 6);
  const item = s.coverage.items.find((i) => i.key === "own:slow");
  assert.deepEqual(item, { key: "own:slow", kind: "own", label: `the repo's own "SLOW"`, state: "measured" });
  assert.equal(healthOwnCount(s.coverage), 1);
});

test("a target missed pulls the mean down and can cap the headline by name", () => {
  // lower is better: 20 against 5 scores 25; the five entries score 100.
  const rows = [quiet({ own: own(reading("slow", 20, { target: 5 })) })];
  const series = healthIndex(rows, null);
  const p = series.points[0];
  assert.deepEqual(p.own.map((o) => [o.id, o.score]), [["own:slow", 25]]);
  const mean = Math.exp((5 * Math.log(100) + Math.log(25)) / 6);
  assert.ok(Math.abs(p.mean - mean) < 1e-9, "joins the geometric mean as a sixth entry");
  assert.equal(p.index, 25 + HEALTH_SCORE_CAP_GAP, "and the worst-entry cap");
  assert.equal(p.capKind, "worst");
  assert.equal(p.cappedBy, "own:slow");
  assert.deepEqual(p.alerts, [], "an own reading raises no alert; the cap names it");
  const w = healthHeadlineWords({ value: p.index, mean: p.mean, cappedBy: p.cappedBy, capKind: p.capKind, coverage: p.coverage });
  assert.match(w.cap, /^Capped at 55 by the repo's own "SLOW" \(25 of 100\)/);
  assert.match(healthCapWords({ value: p.index, mean: p.mean, cappedBy: p.cappedBy }), /by the repo's own "slow"/, "no coverage at hand: named by its key");
  assert.equal(repoHealthIndexOf(series).cappedBy, "own:slow");
  // higher is better: half the target scores 50.
  const h = healthRowScore(quiet({ own: own(reading("cover", 30, { better: "higher", target: 60 })) }), null);
  assert.equal(h.mean, Math.exp((5 * Math.log(100) + Math.log(50)) / 6));
});

test("an absent reading is UNKNOWN with its reason, never 0 — and counts against coverage", () => {
  const s = healthRowScore(quiet({ own: own(reading("slow", null, { target: 5, reason: "exited 1: boom" })) }), null);
  assert.equal(Math.round(s.mean), 100, "no score: out of the mean");
  assert.equal(s.coverage.measured, 5);
  assert.equal(s.coverage.applicable, 6);
  assert.equal(s.capKind, "coverage");
  assert.ok(Math.abs(s.index - (100 * 5) / 6) < 1e-9);
  const item = s.coverage.items.find((i) => i.key === "own:slow");
  assert.equal(item.state, "unknown");
  assert.equal(item.reason, "no reading (exited 1: boom)");
  const w = healthHeadlineWords({ value: s.index, mean: s.mean, cappedBy: s.cappedBy, capKind: s.capKind, coverage: s.coverage });
  assert.match(w.coverage, /5 of 6 dimensions measured\. Unknown: the repo's own "SLOW": no reading \(exited 1: boom\)\./);
});

test("a refused target, an unapproved run and a keyless entry are each unknown, never scored", () => {
  const rows = healthOwnTargetsOf(quiet({ own: { ...own(reading("bad", 3, { target: { invalid: `"target" must be above 0: the score is a ratio to it` } })), unreadTargets: 2 } }));
  assert.deepEqual(rows.map((r) => [r.id, r.why]), [
    ["own:bad", `"target" must be above 0: the score is a ratio to it`],
    ["own:-unread", "2 declared readings with a target have no usable key and could not be read"],
  ]);
  const notRun = { file: "f", notRun: "not run — not approved", gates: [{ key: "slow", name: "Slow", unit: "", better: "lower", target: 5, value: null, reason: "not run — not approved" }] };
  const s = healthRowScore(quiet({ own: notRun }), null);
  assert.equal(s.coverage.items.find((i) => i.key === "own:slow").state, "unknown");
  assert.equal(s.coverage.gates.length, 0, "a target is not a gate");
  assert.deepEqual(healthOwnTargetsOf(quiet({ own: { file: "f", refused: "not JSON" } })), [], "a refused file is one unknown gate already");
});

test("own ids never clash with waterplane's entries", () => {
  const s = healthRowScore(quiet({ own: own(reading("size", 20, { target: 5 }), reading("retouch", 1, { target: 5 })) }), null);
  const keys = s.coverage.items.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("size") && keys.includes("own:size"));
  assert.equal(Math.round(s.scores.size), 100, "the engine's size is untouched by a repo key named size");
  assert.equal(s.cappedBy, "own:size");
});

test("declaring, re-targeting or dropping a target marks the week a coverage gap; a steady target links and contributes", () => {
  const wk = (day, v, target = 5) => quiet({ day, own: own(reading("slow", v, { target })) });
  const pts = healthIndex([quiet({ day: "2026-10-21" }), wk("2026-10-28", 10), wk("2026-11-04", 20), wk("2026-11-11", 20, 4)], null).points;
  assert.deepEqual(pts.map((p) => p.gap), [false, true, false, true]);
  assert.equal(pts[1].gapReason, "coverage");
  const c = pts[2].own[0].contribution;
  assert.ok(c < 0, "the reading moved away from its target");
  assert.ok(Math.abs(c - (pts[1].mean * (Math.log(25) - Math.log(50))) / 6) < 1e-9);
  assert.equal(pts[3].gapReason, "coverage", "a new target is a new yardstick");
});

test("a move carried by an own reading is worded as the repo's own", () => {
  const wk = (day, v) => quiet({ day, own: own(reading("slow", v, { target: 5 })) });
  const pts = healthIndex([wk("2026-10-28", 5), wk("2026-11-04", 6)], null).points;
  const w = healthMoveWords(pts, { kind: "drop", horizon: "week", delta: pts[1].index - pts[0].index }, "2026-11-02");
  assert.match(w.body, /the repo's own "SLOW" moved away from its target/);
});
