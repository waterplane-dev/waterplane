// The six index entries P2 added from readings the engine already takes
// (`shared/src/healthindex/readings.ts` `optionalReadings`): duplicate code,
// dead exports, import cycles, co-change, fixes after a change, tests changed
// with code. Calibration and the argument for each good line:
// docs/analysis/health-metrics/P2.md.
import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_ALERT_WARN,
  HEALTH_ENTRIES,
  HEALTH_GOOD,
  HEALTH_HIGHER_IS_BETTER,
  HEALTH_OPTIONAL_ENTRIES,
  HEALTH_SCORE_FLOOR,
  assessHealthMove,
  healthEntryReadings,
  healthEntryScore,
  healthHeadlineWords,
  healthIndex,
  healthMoveWords,
  healthRowScore,
  noScoredWeekWords,
} from "../dist/index.js";

const list = (n) => Array.from({ length: n }, (_, i) => `m${i}`);
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

/** Five quiet core entries, and the six P2 readings at the values `o` gives (all good by default). */
function row(o = {}) {
  const day = o.day ?? "2026-11-04";
  const r = {
    sha: o.sha ?? "s", day, ts: Date.parse(`${day}T12:00:00Z`), batch: false, prereg: "p",
    size: { value: { p95: 300, max: 900, maxPath: "a", lineMean: 300 } },
    retouch: { value: { rate: 0.1 } },
    hatches: { value: { todo: 1 }, split: { unexplained: 1, explained: 0 } },
    context: { value: { claudeMdChars: 8000, descChars: 2000 } },
    untested: { value: list(10) },
    classics: { value: { loc: 100_000, files: 500 } },
    dups: { value: { degenerateBuckets: 0, pairs: [], pairsPerKloc: o.dups ?? 0.01 } },
    deadExports: { value: list(o.dead ?? 50) },
    graph: { value: { files: 400, cycleFiles: o.cycleFiles ?? 0, edges: 900 } },
    cochange: { value: { hotspots: (o.cochange ?? [1, 2, 3]).map((m, i) => ({ path: `f${i}`, median: m })) } },
    habits: { value: {
      windowDays: 28,
      fix: { value: { rate: o.fix ?? 0.02, commits: 100, fixes: 2, fixesAfter: 2 } },
      testsWithCode: { value: { rate: o.twc ?? 0.7, commits: 100, withTests: 70 } },
    } },
  };
  for (const k of o.drop ?? []) delete r[k];
  return { ...r, ...(o.patch ?? {}) };
}

test("the calibrated good lines (P2.md) are pinned", () => {
  assert.equal(HEALTH_GOOD.dups, 0.25);
  assert.equal(HEALTH_GOOD.deadExports, 1.5);
  assert.equal(HEALTH_GOOD.cycles, 0.01);
  assert.equal(HEALTH_GOOD.cochange, 5);
  assert.equal(HEALTH_GOOD.fixAfterChange, 0.1);
  assert.equal(HEALTH_GOOD.testsWithCode, 0.5);
  assert.deepEqual([...HEALTH_OPTIONAL_ENTRIES], HEALTH_ENTRIES.slice(5));
  assert.deepEqual([...HEALTH_HIGHER_IS_BETTER], ["testsWithCode"]);
});

test("each reading is taken off the field the engine writes, normalised where a count would punish size", () => {
  const v = healthEntryReadings(row({ dups: 0.4, dead: 300, cycleFiles: 8, cochange: [1, 9, 4, 6], fix: 0.2, twc: 0.3 })).values;
  near(v.dups, 0.4);
  near(v.deadExports, 3, 1e-12); // 300 per 100,000 lines
  near(v.cycles, 0.02); // 8 of 400 graph files
  near(v.cochange, 5); // median of 1, 4, 6, 9
  near(v.fixAfterChange, 0.2);
  near(v.testsWithCode, 0.3);
});

test("at or under every good line, all eleven entries score 100", () => {
  const s = healthRowScore(row(), null);
  assert.equal(Object.keys(s.scores).length, 11);
  for (const [e, x] of Object.entries(s.scores)) near(x, 100, 1e-9);
  assert.equal(Math.round(s.index), 100);
  assert.equal(s.coverage.measured, 11);
});

test("each entry past its line costs points and says so in one plain sentence", () => {
  const s = healthRowScore(row({ dups: 1, dead: 600, cycleFiles: 20, cochange: [20], fix: 0.4, twc: 0.1 }), null);
  near(s.scores.dups, 25);
  near(s.scores.deadExports, 25);
  near(s.scores.cycles, 20);
  near(s.scores.cochange, 25);
  near(s.scores.fixAfterChange, 25);
  near(s.scores.testsWithCode, 20, 1e-9);
  const p = healthIndex([row({ dups: 1, dead: 600, cycleFiles: 20, cochange: [20], fix: 0.4, twc: 0.1 })], null).points[0];
  const text = Object.fromEntries(p.alerts.map((a) => [a.subject, a.text]));
  assert.equal(text.dups, "warn: 1.00 near-duplicate block pairs per 1,000 lines (good: under 0.25)");
  assert.equal(text.deadExports, "warn: 6.0 exports per 1,000 lines that no other file uses (good: under 1.5)");
  assert.equal(text.cycles, "severe: 5.0% of the import graph's files sit in an import cycle (good: under 1.0%)");
  assert.equal(text.cochange, "warn: a change to one of the busiest files also changes 20.0 other files beside it (median; good: under 5.0)");
  assert.equal(text.fixAfterChange, "warn: 40% of recent source commits fix what a commit in the week before changed (good: under 10%)");
  assert.equal(text.testsWithCode, "severe: only 10% of recent source commits also change a test (good: at least 50%)");
});

test("tests changed with code: more is better, and no tests at all is floored above 0 so the mean stays defined", () => {
  assert.equal(healthEntryScore("testsWithCode", 0.9, 0.5), 100);
  near(healthEntryScore("testsWithCode", 0.25, 0.5), 50);
  assert.equal(healthEntryScore("testsWithCode", 0, 0.5), HEALTH_SCORE_FLOOR);
  const s = healthRowScore(row({ twc: 0 }), null);
  assert.ok(Number.isFinite(s.mean) && s.mean > 0);
  assert.equal(s.cappedBy, "testsWithCode");
  assert.equal(Math.round(s.index), HEALTH_SCORE_FLOOR + 30);
});

test("an absent reading is UNKNOWN with the engine's reason, never 100, and the coverage cap counts it", () => {
  const kotlin = "no Kotlin parser is available, so no Kotlin file was read as code (kotlin, 218 files at HEAD)";
  const s = healthRowScore(row({ patch: {
    dups: { value: null, reason: kotlin },
    habits: { value: { fix: { value: null, reason: "no non-batch commit touched source or test files in the trailing 28d" }, testsWithCode: { value: { rate: 0.7 } } } },
  } }), null);
  assert.equal(s.scores.dups, undefined, "out of the mean");
  assert.equal(s.scores.fixAfterChange, undefined);
  assert.equal(s.coverage.applicable, 11);
  assert.equal(s.coverage.measured, 9);
  near(s.index, (100 * 9) / 11);
  assert.equal(s.capKind, "coverage");
  const w = healthHeadlineWords({ value: s.index, mean: s.mean, cappedBy: s.cappedBy, capKind: s.capKind, coverage: s.coverage });
  assert.ok(w.coverage.includes(`duplicate code: ${kotlin}`), w.coverage);
  assert.ok(w.coverage.includes("fixes after a change: no non-batch commit touched source"), w.coverage);
  // A long engine reason (a graph naming files) is cut, never dropped.
  const long = healthRowScore(row({ patch: { graph: { value: null, reason: `the imports of 2 files could not be read: ${"x".repeat(400)}` } } }), null);
  const item = long.coverage.items.find((i) => i.key === "cycles");
  assert.equal(item.state, "unknown");
  assert.ok(item.reason.length <= 160 && item.reason.endsWith("…"));
  // A family-wide habits absence is each sub-reading's.
  const shallow = healthRowScore(row({ patch: { habits: { value: null, reason: "shallow clone" } } }), null);
  assert.deepEqual(shallow.coverage.items.filter((i) => i.state === "unknown").map((i) => [i.key, i.reason]), [["fixAfterChange", "shallow clone"], ["testsWithCode", "shallow clone"]]);
});

test("a row with no field at all (an engine that never took the reading) leaves the entry out on that row", () => {
  const s = healthRowScore(row({ drop: ["dups", "deadExports", "graph", "cochange", "habits"] }), null);
  assert.equal(s.coverage.applicable, 5);
  assert.equal(Math.round(s.index), 100);
  assert.equal(healthEntryReadings(row({ drop: ["graph"] })).unrecorded.join(), "cycles");
});

test("a core entry absent still leaves the week unscored, and the no-score words name only core entries", () => {
  const r = row({ patch: { untested: { value: null, reason: "no test convention" }, dups: { value: null, reason: "no parser" } } });
  assert.equal(healthRowScore(r, null), null);
  assert.match(noScoredWeekWords([r]), /the latest week has no untested modules \(no test convention\)$/);
});

test("a per-language entry turns unknown past a fifth of unread files, and a value under an older reach is measured with a note", () => {
  const reach = (reads) => ({ value: { packs: [
    { name: "kotlin", files: 30, reads: ["hatches", "untested"] },
    { name: "typescript", files: 70, reads: ["hatches", "untested", ...reads] },
  ] } });
  const now = healthRowScore(row({ patch: { reach: reach(["cycles", "deadExports", "dups"]) } }), null);
  assert.deepEqual(now.coverage.items.filter((i) => i.state === "unknown").map((i) => i.key), ["dups", "deadExports", "cycles"]);
  assert.match(now.coverage.items.find((i) => i.key === "dups").reason, /^no Kotlin parser \(30 of 100 source files\)$/);
  assert.match(now.coverage.items.find((i) => i.key === "cycles").reason, /^no Kotlin import-graph rule/);
  const older = healthRowScore(row({ patch: { reach: reach([]) } }), null);
  const d = older.coverage.items.find((i) => i.key === "dups");
  assert.equal(d.state, "measured");
  assert.match(d.reason, /not recorded/);
  // A core entry keeps P1's rule: no pack reading it is unknown, never "not recorded".
  const shell = healthRowScore(row({ patch: { reach: { value: { packs: [{ name: "shell", files: 100, reads: [] }] } } } }), null);
  assert.equal(shell.coverage.items.find((i) => i.key === "hatches").state, "unknown");
});

test("the weekly move words name a gate that flipped as the cause", () => {
  const gate = (value) => ({ file: "f", readings: [{ key: "parity", name: "Backend parity", means: "m", better: "higher", unit: "%", value, gate: { fails: "below", at: 60 } }] });
  const days = Array.from({ length: 11 }, (_, w) => new Date(Date.parse("2026-08-03T00:00:00Z") + w * 7 * 86_400_000).toISOString().slice(0, 10));
  const rows = days.map((day, w) => row({ day, sha: `s${w}`, patch: { own: gate(w < 10 ? 90 : 40) } }));
  const s = healthIndex(rows, null);
  const last = s.points.at(-1);
  assert.equal(last.capKind, "gate");
  assert.equal(last.gap, false, "a gate flip is not a change of what is measured");
  const m = assessHealthMove(s.points);
  assert.equal(m.kind, "drop");
  const w = healthMoveWords(s.points, m, last.week);
  assert.match(w.body, new RegExp(`gate "Backend parity" now fails and holds the score under ${HEALTH_ALERT_WARN} \\(−51\\)`));
  // …and passing again is named on the way back up.
  const back = healthIndex([...rows, row({ day: "2026-10-19", sha: "s11", patch: { own: gate(90) } })], null);
  const m2 = assessHealthMove(back.points);
  assert.equal(m2.kind, "rise");
  assert.match(healthMoveWords(back.points, m2, back.points.at(-1).week).body, /gate "Backend parity" passes again and no longer holds the score under 50/);
});

test("the weekly move words name each new entry, in the right direction (tests changed with code is inverted)", () => {
  const days = Array.from({ length: 12 }, (_, w) => new Date(Date.parse("2026-08-03T00:00:00Z") + w * 7 * 86_400_000).toISOString().slice(0, 10));
  const bad = {
    dups: [{ dups: 1 }, "more duplicate code", "less duplicate code"],
    deadExports: [{ dead: 600 }, "more dead exports", "fewer dead exports"],
    cycles: [{ cycleFiles: 20 }, "more files in import cycles", "fewer files in import cycles"],
    cochange: [{ cochange: [20] }, "changes touch more files at once", "changes touch fewer files at once"],
    fixAfterChange: [{ fix: 0.4 }, "more fixes after a change", "fewer fixes after a change"],
    testsWithCode: [{ twc: 0.1 }, "fewer commits changed a test", "more commits changed a test"],
  };
  for (const [key, [o, worse, better]] of Object.entries(bad)) {
    // Good until the last week, then bad: the entry carries the drop.
    const down = healthIndex(days.map((day, w) => row({ day, sha: `s${w}`, ...(w < 11 ? {} : o) })), null);
    const md = assessHealthMove(down.points);
    assert.equal(md.kind, "drop", key);
    assert.match(healthMoveWords(down.points, md, down.points.at(-1).week).body, new RegExp(`${worse} \\(−\\d+\\)`), `${key} drop`);
    // Bad until the last week, then good: the same entry carries the rise.
    const up = healthIndex(days.map((day, w) => row({ day, sha: `s${w}`, ...(w < 11 ? o : {}) })), null);
    const mu = assessHealthMove(up.points);
    assert.equal(mu.kind, "rise", key);
    assert.match(healthMoveWords(up.points, mu, up.points.at(-1).week).body, new RegExp(`${better} \\(\\+\\d+\\)`), `${key} rise`);
  }
});

test("the weekly move words name the share of dimensions measured as the cause of a coverage cap", () => {
  // A same-basket coverage cap cannot move on its own in a real series (the basket's fingerprint marks a gap), so the points are set by hand.
  const base = healthIndex([row({ day: "2026-11-02", sha: "a" })], null).points[0];
  const cov = { ...base.coverage, measured: 6, applicable: 11 };
  const free = { ...base, index: 80, mean: 80, capKind: null, cappedBy: null, gap: false, contributions: {} };
  const held = { ...free, index: 55, capKind: "coverage", coverage: cov };
  const week = "2026-11-02";
  const drop = healthMoveWords([{ ...free, week: "2026-10-26" }, { ...held, week }], { kind: "drop", horizon: "week", delta: -25, reason: "" }, week);
  assert.match(drop.body, /too few dimensions measured hold the score down \(6 of 11 measured\) \(−25\)/);
  const rise = healthMoveWords([{ ...held, week: "2026-10-26" }, { ...free, week }], { kind: "rise", horizon: "week", delta: 25, reason: "" }, week);
  assert.match(rise.body, /the share of dimensions measured no longer holds the score down \(6 of 11 measured\) \(\+25\)/);
});
