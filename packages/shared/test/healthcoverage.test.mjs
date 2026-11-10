// The honest headline (`shared/src/healthindex/coverage.ts`): which dimensions
// apply, which were measured, the repo's gates, and the caps both put on the
// score. The case behind it: picture-app read 100 with 391 of its 537 source
// files (Dart) never opened by the untested or escape-hatch readers.
import test from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_ALERT_WARN,
  HEALTH_COVERAGE_MAX_UNREAD,
  HEALTH_DIMENSIONS,
  HEALTH_DIMENSION_DEFS,
  HEALTH_ENTRIES,
  HEALTH_ENTRY_LABEL,
  HEALTH_GATE_CAP,
  healthCoverage,
  healthCoverageCap,
  healthGatesOf,
  healthHeadline,
  healthHeadlineWords,
  healthIndex,
  healthIndexCommits,
  healthRowScore,
  repoHealthIndexOf,
} from "../dist/index.js";

const list = (n) => Array.from({ length: n }, (_, i) => `m${i}`);

/** Every entry at or under its good line: 100 each, the case that read 100. */
function quiet(o = {}) {
  const day = o.day ?? "2026-11-04";
  return {
    sha: o.sha ?? "s", day, ts: Date.parse(`${day}T12:00:00Z`), batch: false, prereg: o.prereg ?? "p",
    size: { value: { p95: 300, max: 900, maxPath: "a", lineMean: 300 } },
    retouch: { value: { rate: 0.1 } },
    hatches: { value: { todo: 1 }, split: { unexplained: 1, explained: 0 } },
    context: { value: { claudeMdChars: 8000, descChars: 2000 } },
    untested: { value: list(10) },
    classics: { value: { loc: 100_000, files: 537 } },
    ...(o.reach === undefined ? {} : { reach: o.reach }),
    ...(o.own === undefined ? {} : { own: o.own }),
    ...(o.central === undefined ? {} : { central: o.central }),
  };
}

/** picture-app's packs at HEAD, 2026-11-08 (the row's own `(lang, N files at HEAD)` sentences). */
const PICTURE_REACH = { value: { packs: [
  { name: "c", files: 4, reads: [] },
  { name: "dart", files: 391, reads: [] },
  { name: "kotlin", files: 31, reads: ["hatches", "untested"] },
  { name: "python", files: 107, reads: ["hatches", "untested"] },
  { name: "shell", files: 4, reads: [] },
] } };
const TS_REACH = { value: { packs: [
  { name: "shell", files: 20, reads: [] },
  { name: "typescript", files: 517, reads: ["hatches", "untested"] },
] } };
const gateOwn = (value, gate, extra = {}) => ({
  file: ".waterplane-shared/health.json",
  readings: [{ key: "parity", name: "Backend parity", means: "m", better: "higher", unit: "%", value, ...(gate ? { gate } : {}), ...extra }],
});

test("the dimension table: scored ⇔ an index entry, every entry has a row and the same label", () => {
  for (const d of HEALTH_DIMENSIONS) {
    assert.equal(HEALTH_DIMENSION_DEFS[d].scored, HEALTH_ENTRIES.includes(d), d);
  }
  for (const e of HEALTH_ENTRIES) assert.equal(HEALTH_DIMENSION_DEFS[e].label, HEALTH_ENTRY_LABEL[e], e);
  // P2 scored six more; later packages' dimensions are named but not counted yet.
  for (const d of ["dups", "deadExports", "cycles", "cochange", "fixAfterChange", "testsWithCode"]) assert.equal(HEALTH_DIMENSION_DEFS[d].scored, true, d);
  for (const d of ["analyzer", "vulnDeps"]) {
    assert.ok(HEALTH_DIMENSIONS.includes(d), d);
    assert.equal(HEALTH_DIMENSION_DEFS[d].scored, false, d);
  }
});

test("picture-app: five quiet entries over mostly unread code never read 100", () => {
  const old = healthRowScore(quiet(), null);
  assert.equal(Math.round(old.index), 100, "without reach: the row says nothing about coverage, the score is what it was");
  assert.equal(old.coverage.reach, false);
  const s = healthRowScore(quiet({ reach: PICTURE_REACH }), null);
  const c = s.coverage;
  assert.equal(c.applicable, 5);
  assert.equal(c.measured, 3);
  assert.deepEqual(c.items.filter((i) => i.state === "unknown").map((i) => i.key), ["hatches", "untested"]);
  const untested = c.items.find((i) => i.key === "untested");
  assert.match(untested.reason, /^no rule for how a Dart, C and shell test names a module \(399 of 537 source files\)$/);
  assert.equal(s.index, 60, "100 · 3/5");
  assert.equal(s.capKind, "coverage");
  assert.equal(s.cappedBy, null);
  assert.equal(Object.keys(s.scores).sort().join(), "context,retouch,size", "an unknown entry is out of the mean");
});

test("passing gates never raise the coverage cap; an entry the repo overrode counts as measured", () => {
  const own = (n) => ({
    file: "f",
    readings: Array.from({ length: n }, (_, i) => ({ key: `g${i}`, name: `G${i}`, means: "m", better: "higher", unit: "%", value: 90, gate: { fails: "below", at: 10 } })),
  });
  for (const n of [0, 1, 3, 10]) {
    const s = healthRowScore(quiet({ reach: PICTURE_REACH, ...(n ? { own: own(n) } : {}) }), null);
    assert.equal(s.coverage.measured, 3, `${n} passing gates`);
    assert.equal(s.coverage.applicable, 5, `${n} passing gates`);
    assert.equal(s.index, 60, `${n} passing gates: the unread code is the same`);
    assert.equal(s.coverage.gates.length, n);
  }
  const central = { fp: "x", override: { untested: { value: 0.2 }, hatches: { value: 1 } } };
  const o = healthRowScore(quiet({ reach: PICTURE_REACH, central }), null);
  assert.equal(o.coverage.measured, 5, "the repo's own whole-repo command measured both");
  assert.equal(o.coverage.applicable, 5);
  assert.equal(o.capKind, null);
  assert.ok(Object.keys(o.scores).includes("untested") && Object.keys(o.scores).includes("hatches"), "the repo's numbers are in the mean");
  assert.equal(o.coverage.items.find((i) => i.key === "untested").reason, undefined);
  const k = (c) => healthRowScore(quiet({ reach: PICTURE_REACH, central: c }), null).coverage.key;
  assert.equal(k(central), k({ fp: "y", override: central.override }), "two weeks with the same override are no coverage gap");
});

test("a small unread minority is measured, and still named", () => {
  const s = healthRowScore(quiet({ reach: TS_REACH }), null);
  assert.equal(s.coverage.measured, 5);
  assert.equal(Math.round(s.index), 100);
  assert.equal(s.capKind, null);
  const w = healthHeadlineWords({ value: s.index, mean: s.mean, cappedBy: s.cappedBy, capKind: s.capKind, coverage: s.coverage });
  assert.equal(w.coverage, null, "everything measured is no news: no line, no 'All 5 measured' prose on a healthy card");
  assert.match(w.notes, /untested modules: no rule for how a shell test names a module \(20 of 537 source files\)/);
  assert.equal(w.cap, null);
  // The line itself: exactly a fifth unread is still measured, past it is not.
  const at = (unread) => healthCoverage(quiet({ reach: { value: { packs: [
    { name: "dart", files: unread, reads: [] }, { name: "typescript", files: 100 - unread, reads: ["hatches", "untested"] },
  ] } } }), HEALTH_ENTRIES.slice(0, 5)).measured;
  assert.equal(HEALTH_COVERAGE_MAX_UNREAD, 0.2);
  assert.equal(at(20), 5);
  assert.equal(at(21), 3);
});

test("a disabled entry is not applicable, so it is neither measured nor unknown", () => {
  const row = { ...quiet({ reach: PICTURE_REACH }), central: { fp: "x", disabled: { untested: { why: "w" } } } };
  const s = healthRowScore(row, null);
  assert.equal(s.coverage.applicable, 4);
  assert.equal(s.coverage.measured, 3);
  assert.equal(s.index, 75);
});

test("gates: pass, fail, absent reading, refused declaration", () => {
  const pass = healthGatesOf(quiet({ own: gateOwn(70, { fails: "below", at: 60 }) }))[0];
  assert.equal(pass.state, "pass");
  assert.equal(pass.text, `Gate "Backend parity" passes: 70%, needs at least 60%.`);
  const fail = healthGatesOf(quiet({ own: gateOwn(42.4, { fails: "below", at: 60 }) }))[0];
  assert.equal(fail.state, "fail");
  assert.equal(fail.text, `Gate "Backend parity" fails: 42.4%, the repo requires at least 60%.`);
  assert.equal(healthGatesOf(quiet({ own: gateOwn(60, { fails: "below", at: 60 }) }))[0].state, "pass", "the line itself passes");
  assert.equal(healthGatesOf(quiet({ own: gateOwn(61, { fails: "above", at: 60 }) }))[0].state, "fail");
  const absent = healthGatesOf(quiet({ own: gateOwn(null, { fails: "below", at: 60 }, { reason: "exited 1" }) }))[0];
  assert.equal(absent.state, "unknown");
  assert.match(absent.text, /unknown: no reading \(exited 1\); it needs at least 60%/);
  const refused = healthGatesOf(quiet({ own: gateOwn(null, { invalid: `"gate" "at" must be a number` }) }))[0];
  assert.equal(refused.state, "unknown");
  assert.match(refused.text, /"at" must be a number/);
  assert.deepEqual(healthGatesOf(quiet({ own: gateOwn(5, null) })), [], "a reading with no gate is no gate");
  assert.deepEqual(healthGatesOf(quiet()), [], "no own: nothing said");
});

test("a failing gate caps the headline under the warn line; an unknown gate counts against coverage", () => {
  const fail = healthRowScore(quiet({ reach: TS_REACH, own: gateOwn(42, { fails: "below", at: 60 }) }), null);
  assert.equal(fail.index, HEALTH_GATE_CAP);
  assert.equal(HEALTH_GATE_CAP, HEALTH_ALERT_WARN - 1);
  assert.equal(fail.capKind, "gate");
  assert.equal(fail.coverage.applicable, 5, "a failing gate is known, and adds nothing to the entry share");
  assert.equal(fail.coverage.measured, 5);
  const w = healthHeadlineWords({ value: fail.index, mean: fail.mean, cappedBy: fail.cappedBy, capKind: fail.capKind, coverage: fail.coverage });
  assert.equal(w.cap, `Capped at 49: a gate the repo declared fails ("Backend parity"), and a failing gate holds the score under 50.`);
  assert.deepEqual(w.gates, [`Gate "Backend parity" fails: 42%, the repo requires at least 60%.`]);

  const unknown = healthRowScore(quiet({ reach: TS_REACH, own: gateOwn(null, { fails: "below", at: 60 }) }), null);
  assert.equal(unknown.coverage.measured, 5);
  assert.equal(unknown.coverage.applicable, 6);
  assert.ok(Math.abs(unknown.index - 500 / 6) < 1e-9, "never passed: 100 · 5/6");
  assert.equal(unknown.capKind, "coverage");
  const uw = healthHeadlineWords({ value: unknown.index, mean: unknown.mean, cappedBy: null, capKind: unknown.capKind, coverage: unknown.coverage });
  assert.match(uw.coverage, /^5 of 6 dimensions measured\. Unknown: gate "Backend parity"\.$/, "the gate's reason is its own sentence in gates, not said twice");
  assert.match(uw.gates[0], /^Gate "Backend parity" is unknown: no reading/);
  assert.match(uw.cap, /^Capped at 83: only 5 of 6 dimensions could be measured/);
});

test("healthHeadline: the lowest cap wins, and the mean stands when no cap is under it", () => {
  const cov = (measured, applicable, gates = []) => ({ measured, applicable, reach: true, items: [], gates, key: "" });
  assert.deepEqual(healthHeadline(80, 90, cov(5, 5)), { index: 80, capKind: null });
  assert.deepEqual(healthHeadline(80, 30, cov(5, 5)), { index: 60, capKind: "worst" });
  assert.deepEqual(healthHeadline(80, 90, cov(3, 5)), { index: 60, capKind: "coverage" });
  assert.deepEqual(healthHeadline(90, 10, cov(3, 5)), { index: 40, capKind: "worst" }, "the worst entry binds lower");
  assert.deepEqual(healthHeadline(90, 90, cov(5, 5, [{ state: "fail" }])), { index: 49, capKind: "gate" });
  assert.deepEqual(healthHeadline(80, 90, null), { index: 80, capKind: null });
  assert.equal(healthCoverageCap({ measured: 0, applicable: 0 }), 100);
});

test("the series marks a gap the week coverage changes, and the summary carries it", () => {
  const rows = [
    quiet({ sha: "a", day: "2026-10-28" }),
    quiet({ sha: "b", day: "2026-11-04", reach: PICTURE_REACH }),
  ];
  const s = healthIndex(rows, null);
  assert.equal(s.points.length, 2);
  assert.equal(Math.round(s.points[0].index), 100);
  assert.equal(s.points[1].index, 60);
  assert.equal(s.points[1].gap, true);
  assert.equal(s.points[1].gapReason, "coverage");
  assert.equal(s.points[1].lnLink, null, "not a health move: the basket changed");
  const hi = repoHealthIndexOf(s, null);
  assert.equal(hi.capKind, "coverage");
  assert.equal(hi.coverage.measured, 3);
  const w = healthHeadlineWords({ value: hi.value, mean: hi.mean, cappedBy: hi.cappedBy, capKind: hi.capKind, coverage: hi.coverage });
  assert.equal(w.cap, "Capped at 60: only 3 of 5 dimensions could be measured, and an unmeasured one counts for nothing, never for 100.");
  assert.match(w.coverage, /^3 of 5 dimensions measured\. Unknown: escape hatches: no Dart, C and shell escape-hatch patterns, only TODO\/FIXME counted \(399 of 537 source files\); untested modules: /);
});

test("an older host's summary (no capKind, no coverage) words only the worst-entry cap", () => {
  const w = healthHeadlineWords({ value: 46, mean: 66, cappedBy: "size" });
  assert.match(w.cap, /^Capped at 46 by file length \(16 of 100\)/);
  assert.equal(w.coverage, null);
  assert.deepEqual(w.gates, []);
  const noReach = healthHeadlineWords({ value: 100, mean: 100, cappedBy: null, capKind: null, coverage: healthCoverage(quiet(), HEALTH_ENTRIES) });
  assert.match(noReach.coverage, /was not recorded by the engine/);
  assert.doesNotMatch(noReach.coverage, /All \d+ dimensions/);
});

test("a declaration that cannot be read in full is UNKNOWN gates, never a pass", () => {
  const unknownGate = (own) => {
    const s = healthRowScore(quiet({ reach: TS_REACH, own }), null);
    assert.equal(s.coverage.applicable, 6, JSON.stringify(own));
    assert.equal(s.coverage.measured, 5);
    assert.equal(s.capKind, "coverage");
    assert.ok(Math.abs(s.index - 500 / 6) < 1e-9);
    const w = healthHeadlineWords({ value: s.index, mean: s.mean, cappedBy: null, capKind: s.capKind, coverage: s.coverage });
    assert.match(w.coverage, /^5 of 6 dimensions measured\. Unknown: /);
    assert.equal(w.gates.length, 1);
    return w;
  };
  assert.match(unknownGate({ file: "f", refused: "f is not JSON (Unexpected token)" }).gates[0], /not JSON/);
  assert.match(unknownGate({ file: "f", readings: [], unreadGates: 1 }).gates[0], /1 declared gate has no usable key/);
  // The commands were not approved: each declared gate rides in with no value.
  const notRun = unknownGate({ file: "f", notRun: "not run", gates: [
    { key: "parity", name: "Backend parity", unit: "%", gate: { fails: "below", at: 60 }, value: null, reason: "not run — unapproved" },
  ] });
  assert.match(notRun.gates[0], /^Gate "Backend parity" is unknown: no reading \(not run — unapproved\); it needs at least 60%\.$/);
  // No declaration at all stays no gate.
  assert.equal(healthRowScore(quiet({ reach: TS_REACH }), null).coverage.applicable, 5);
});

test("the commits axis marks a gap where coverage or a gate moves the number", () => {
  const rows = [
    quiet({ sha: "a", day: "2026-11-02" }),
    quiet({ sha: "b", day: "2026-11-03", reach: PICTURE_REACH }),
    quiet({ sha: "c", day: "2026-11-04", reach: PICTURE_REACH, own: gateOwn(42, { fails: "below", at: 60 }) }),
    quiet({ sha: "d", day: "2026-11-05", reach: PICTURE_REACH }),
  ];
  const c = healthIndexCommits(rows, null);
  assert.deepEqual(c.points.map((p) => p.gap), [false, true, true, true], "reach appears, a gate appears, the gate is gone");
});

test("no verdict words in anything the coverage layer says", () => {
  const s = healthRowScore(quiet({ reach: PICTURE_REACH, own: gateOwn(null, { fails: "below", at: 60 }) }), null);
  const w = healthHeadlineWords({ value: s.index, mean: s.mean, cappedBy: s.cappedBy, capKind: s.capKind, coverage: s.coverage });
  const all = [w.cap, w.coverage, w.notes, ...w.gates].filter(Boolean).join("\n");
  for (const word of ["grade", "healthy", "unhealthy", "bad", "should", "worse", "better"]) {
    assert.doesNotMatch(all, new RegExp(`\\b${word}\\b`, "i"), word);
  }
});
