// The health index (`shared/src/healthindex.ts`): the one layer over the
// repo-health series that takes a side. Hand-built rows only, so every number
// asserted here can be checked by hand.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTEXT_LIMITS,
  HEALTH_INDEX_DEFAULT_WARN_CHARS,
  HEALTH_INDEX_EPSILON,
  HEALTH_INDEX_MIN_WEEKS,
  assessHealthMove,
  healthEntryValues,
  healthIndex,
  healthMoveWords,
  healthWeeks,
  healthIndexVs,
  centralOf,
  isoWeekOf,
  repoHealthIndexOf,
} from "../dist/index.js";

const PREREG = "2026-09-22a+test";

/** Monday 2026-01-05 + w weeks, plus `d` days. */
function dayOf(w, d = 0) {
  return new Date(Date.UTC(2026, 0, 5) + (w * 7 + d) * 86_400_000).toISOString().slice(0, 10);
}

/** One row; every family present unless overridden. */
function row(w, o = {}) {
  const day = o.day ?? dayOf(w, 2);
  return {
    sha: `s${w}`,
    day,
    ts: o.ts ?? Date.parse(`${day}T12:00:00Z`),
    batch: false,
    prereg: o.prereg ?? PREREG,
    size: o.size === null ? { value: null, reason: "x" } : { value: { p95: o.size ?? 500 } },
    retouch: o.retouch === null ? { value: null, reason: "x" } : { value: { rate: o.retouch ?? 0.5 } },
    hatches: o.hatches === null ? { value: null, reason: "x" } : { value: { todo: o.hatches ?? 100 } },
    context: o.context === null ? { value: null, reason: "x" }
      : { value: { claudeMdChars: o.md ?? 12_000, descChars: o.desc === undefined ? 4_000 : o.desc } },
    untested: o.untested === null ? { value: null, reason: "x" } : { value: Array.from({ length: o.untested ?? 400 }, (_, i) => `m${i}`) },
    classics: { value: { loc: o.loc ?? 100_000, files: o.files ?? 1000 } },
  };
}

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test("the default warn line is the setup checklist's", () => {
  assert.equal(HEALTH_INDEX_DEFAULT_WARN_CHARS, DEFAULT_CONTEXT_LIMITS.maxChars);
});

test("ISO weeks start Monday, UTC", () => {
  assert.equal(isoWeekOf("2026-01-05"), "2026-01-05"); // Monday
  assert.equal(isoWeekOf("2026-01-11"), "2026-01-05"); // Sunday
  assert.equal(isoWeekOf("2026-01-12"), "2026-01-12");
  assert.equal(isoWeekOf("garbage"), null);
});

test("the last row of a week is its reading, whatever the input order", () => {
  const late = row(0, { day: dayOf(0, 6), size: 900 });
  const early = row(0, { day: dayOf(0, 0), size: 100 });
  const weeks = healthWeeks([late, early]);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].row.size.value.p95, 900);
});

test("baseline is the first week with all five entries, at 100", () => {
  const s = healthIndex([row(0, { untested: null }), row(1, { context: null }), row(2), row(3)], null);
  assert.equal(s.baselineWeek, dayOf(2));
  assert.equal(s.points.length, 2);
  assert.equal(s.points[0].index, 100);
  assert.equal(s.points[0].lnLink, null);
});

test("no week with all five entries is no index — null, never a 100", () => {
  assert.equal(healthIndex([row(0, { untested: null }), row(1, { untested: null })], null), null);
  assert.equal(healthIndex([], null), null);
  assert.equal(repoHealthIndexOf(null), null);
});

test("one metric halving moves the index by the fifth root of 2", () => {
  const s = healthIndex([row(0), row(1, { size: 250 })], null);
  near(s.points[1].index, 100 * Math.pow(2, 1 / 5));
  assert.equal(s.points[1].comparable, 5);
});

test("chaining skips a missing metric without breaking", () => {
  // week 1 has no hatches: weeks 0→1 compare four, 1→2 compare four, 2→3 all five.
  const s = healthIndex([row(0), row(1, { hatches: null, size: 400 }), row(2, { size: 400 }), row(3, { size: 400 })], null);
  const [, p1, p2, p3] = s.points;
  assert.equal(p1.comparable, 4);
  near(p1.index, 100 * Math.exp(Math.log(500 / 400) / 4));
  assert.equal(p2.comparable, 4);
  near(p2.index, p1.index); // nothing comparable moved
  assert.equal(p3.comparable, 5);
  near(p3.index, p2.index);
  assert.equal(p1.contributions.hatches, undefined);
});

test("a prereg change is a gap: the index is carried, not linked", () => {
  const s = healthIndex([row(0), row(1, { size: 100, prereg: "2026-10-01b+x" }), row(2, { size: 100, prereg: "2026-10-01b+x" })], null);
  assert.equal(s.points[1].gap, true);
  assert.equal(s.points[1].index, 100);
  assert.equal(s.points[1].lnLink, null);
  assert.equal(s.points[2].gap, false);
  near(s.points[2].index, 100);
});

test("a week with zero comparable entries is a gap", () => {
  const s = healthIndex([row(0), row(1, { size: null, retouch: null, hatches: null, context: null, untested: null })], null);
  assert.equal(s.points[1].gap, true);
  assert.equal(s.points[1].index, 100);
});

test("zero values stay finite through the epsilon", () => {
  const v = healthEntryValues(row(0, { retouch: 0, hatches: 0, untested: 0 }), null);
  assert.equal(v.retouch, HEALTH_INDEX_EPSILON);
  assert.equal(v.hatches, HEALTH_INDEX_EPSILON);
  assert.equal(v.untested, HEALTH_INDEX_EPSILON);
  const s = healthIndex([row(0, { retouch: 0 }), row(1, { retouch: 0.5 }), row(2, { retouch: 0 })], null);
  for (const p of s.points) assert.ok(Number.isFinite(p.index));
  near(s.points[2].index, 100);
  // A p95 of 0 is not a reading.
  assert.equal(healthEntryValues(row(0, { size: 0 }), null).size, undefined);
});

test("untested is a share of classics.files", () => {
  near(healthEntryValues(row(0, { untested: 250, files: 1000 }), null).untested, 0.25 + HEALTH_INDEX_EPSILON);
  assert.equal(healthEntryValues(row(0, { files: 0 }), null).untested, undefined);
});

test("context floors at half the warn line, and null descChars counts as no descriptions", () => {
  assert.equal(healthEntryValues(row(0, { md: 1000, desc: 500 }), 16_000).context, 8000);
  assert.equal(healthEntryValues(row(0, { md: 1000, desc: 500 }), null).context, 0.5 * HEALTH_INDEX_DEFAULT_WARN_CHARS);
  assert.equal(healthEntryValues(row(0, { md: 20_000, desc: null }), 16_000).context, 20_000);
  assert.equal(healthEntryValues(row(0, { md: 9000, desc: 3000 }), 10_000).context, 12_000);
  // Below the floor, a doubling does not move the index.
  const s = healthIndex([row(0, { md: 400, desc: 0 }), row(1, { md: 800, desc: 0 })], 16_000);
  near(s.points[1].index, 100);
});

test("contributions are log points and sum to the move within tolerance", () => {
  const s = healthIndex([row(0), row(1, { size: 520, retouch: 0.55, hatches: 104, md: 12_500, untested: 410 })], null);
  const p = s.points[1];
  const sum = Object.values(p.contributions).reduce((a, b) => a + b, 0);
  near(sum, 100 * p.lnLink, 1e-9); // exact in log space
  near(sum, p.index - 100, 0.15); // ≈ the move in level space (second order: a 4.4-point move reads 4.5)
  assert.ok(p.contributions.size < 0, "a longer p95 counts against");
});

/** A wobbly but steady series of n weeks, then optional extra weeks. */
function steady(n, extra = []) {
  const rows = [];
  for (let w = 0; w < n; w++) rows.push(row(w, { size: 500 + (w % 2 ? 5 : -5) }));
  extra.forEach((o, i) => rows.push(row(n + i, o)));
  return rows;
}

test("under the minimum history, no move is called — null with a reason", () => {
  const s = healthIndex(steady(HEALTH_INDEX_MIN_WEEKS - 1, [{ size: 2000 }]), null);
  assert.equal(s.points.filter((p) => p.lnLink !== null).length, HEALTH_INDEX_MIN_WEEKS - 1);
  const m = assessHealthMove(s.points);
  assert.equal(m.kind, null);
  assert.match(m.reason, /a move is called after 8/);
});

test("a clear drop is called on the week horizon, and worded", () => {
  const s = healthIndex(steady(10, [{ size: 800, untested: 480 }]), null);
  const m = assessHealthMove(s.points);
  assert.equal(m.kind, "drop");
  assert.equal(m.horizon, "week");
  assert.ok(m.delta <= -2);
  const lastWeek = s.points[s.points.length - 1].week;
  const w = healthMoveWords(s.points, m, lastWeek);
  assert.match(w.title, /^Health index \d+ \(−\d+ this week\)$/);
  // The latest MEASURED week is not this week (no commits since): it is named, never "this week".
  const old = healthMoveWords(s.points, m, "2099-01-05");
  assert.equal(old.title.replace(/\(.*\)/, "()"), w.title.replace(/\(.*\)/, "()"));
  assert.ok(old.title.includes(`in the week of ${lastWeek}`), old.title);
  assert.ok(old.body.includes(`in the week of ${lastWeek}`) && !/this week/.test(old.body), old.body);
  assert.ok(!/this week/.test(healthMoveWords(s.points, m).title), "a caller that did not say which week it is gets the week named");
  assert.match(w.body, /slipped/);
  assert.match(w.body, /files grew longer/);
  assert.match(w.body, /more untested modules/);
  assert.ok(w.body.indexOf("files grew longer") < w.body.indexOf("more untested modules"), "biggest first");
  for (const word of ["score", "grade", "healthy", "good", "bad", "should", "worse", "better"]) {
    assert.doesNotMatch(`${w.title} ${w.body} ${w.chip}`, new RegExp(`\\b${word}\\b`, "i"));
  }
  const wire = repoHealthIndexOf(s, m);
  assert.equal(wire.move, "drop");
  near(wire.deltaWeek, m.delta);
});

test("a clear rise is called and worded with the falling metrics", () => {
  const s = healthIndex(steady(10, [{ size: 300, hatches: 60 }]), null);
  const m = assessHealthMove(s.points);
  assert.equal(m.kind, "rise");
  assert.equal(m.horizon, "week");
  const w = healthMoveWords(s.points, m, s.points[s.points.length - 1].week);
  assert.match(w.title, /\(\+\d+ this week\)/);
  assert.match(w.body, /rose/);
  assert.match(w.body, /files got shorter/);
  assert.match(w.body, /fewer escape hatches/);
});

test("a slow slide is called on the month horizon when no single week stands out", () => {
  const rows = steady(12);
  // Four weeks of a 4% p95 rise each: one metric of five, so each week moves the
  // index ~0.8 points (under the 2-point floor) while the month moves ~3.1.
  for (let i = 0; i < 4; i++) rows.push(row(12 + i, { size: 505 * Math.pow(1.04, i + 1) }));
  const s = healthIndex(rows, null);
  const m = assessHealthMove(s.points);
  assert.equal(m.kind, "drop");
  assert.equal(m.horizon, "month");
  const lastWeek = s.points[s.points.length - 1].week;
  assert.match(healthMoveWords(s.points, m, lastWeek).title, /over four weeks\)/);
  assert.ok(healthMoveWords(s.points, m, "2099-01-05").title.includes(`over the four weeks to ${lastWeek}`));
});

test("a flat series calls nothing and words nothing", () => {
  const s = healthIndex(steady(14), null);
  const m = assessHealthMove(s.points);
  assert.equal(m.kind, null);
  assert.equal(healthMoveWords(s.points, m), null);
});

test("one entry's weekly pull is capped at a halving or doubling", async () => {
  const { HEALTH_INDEX_MAX_LN } = await import("../dist/index.js");
  // retouch 0.01 → 0.79 is ln(0.02/0.80) ≈ −3.7 uncapped; capped to −ln 2, over five entries.
  const s = healthIndex([row(0, { retouch: 0.01 }), row(1, { retouch: 0.79 })], null);
  assert.ok(s);
  near(s.points[1].lnLink, -HEALTH_INDEX_MAX_LN / 5);
  near(s.points[1].index, 100 * Math.exp(-HEALTH_INDEX_MAX_LN / 5));
});

// ── a repo's say over the central readings (`central` on the row) ──────────

const withCentral = (r, central) => ({ ...r, central });

test("a disabled entry leaves the mean — the link averages the four that remain", () => {
  const off = { fp: "f1", disabled: { size: { why: "generated" } } };
  const s = healthIndex([
    withCentral(row(0), off),
    withCentral(row(1, { size: 50, retouch: 0.25 - HEALTH_INDEX_EPSILON / 2 }), off),
  ], null);
  const p = s.points[1];
  assert.equal(p.comparable, 4, "size is not in the basket at all");
  assert.equal(p.contributions.size, undefined, "a 10× drop in size moved nothing");
  assert.deepEqual(p.disabled, ["size"]);
  assert.equal(p.values.size, undefined);
});

test("the baseline needs only the ENABLED entries; all five disabled is no index, never 100", () => {
  const off = { fp: "f1", disabled: { untested: { why: "no tests here, by design" } } };
  const s = healthIndex([withCentral(row(0, { untested: null }), off)], null);
  assert.ok(s, "a missing reading that is disabled does not block the baseline");
  assert.equal(s.points[0].index, 100);
  const all = Object.fromEntries(["size", "retouch", "hatches", "context", "untested"].map((k) => [k, { why: "w" }]));
  assert.equal(healthIndex([withCentral(row(0), { fp: "f2", disabled: all })], null), null);
});

test("an override takes the slot; a failed override is ABSENT, never the engine's number", () => {
  const ov = (v) => ({ fp: "o1", override: { size: { value: v, why: "ours only" } } });
  const v1 = healthEntryValues(withCentral(row(0), ov(250)), null);
  assert.equal(v1.size, 250);
  const v2 = healthEntryValues(withCentral(row(0), ov(null)), null);
  assert.equal(v2.size, undefined);
  const r = healthEntryValues(withCentral(row(0), { fp: "o2", override: { retouch: { value: 0, why: "w" } } }), null);
  assert.equal(r.retouch, HEALTH_INDEX_EPSILON, "an override goes through the same epsilon as the engine's value");
  assert.deepEqual(centralOf(withCentral(row(0), ov(1))).overridden, ["size"]);
});

test("a change of the repo's central config is a CARRIED link, exactly like a prereg change", () => {
  const s = healthIndex([
    row(0),
    withCentral(row(1, { size: 100 }), { fp: "o1", override: { size: { value: 100, why: "w" } } }),
    withCentral(row(2, { size: 100 }), { fp: "o1", override: { size: { value: 50, why: "w" } } }),
  ], null);
  const [, carried, link] = s.points;
  assert.equal(carried.gap, true);
  assert.equal(carried.gapReason, "central");
  assert.equal(carried.index, 100, "the tweak is not a health move");
  assert.equal(carried.central, "o1");
  assert.equal(link.gap, false);
  assert.ok(link.index > 100, "within one config the override's own move counts");
  const pre = healthIndex([row(0), row(1, { prereg: "other" })], null);
  assert.equal(pre.points[1].gapReason, "prereg");
});

test("spanDays: Monday to Monday since the previous measured week; null on the baseline", () => {
  const s = healthIndex([row(0), row(1), row(4)], null);
  assert.deepEqual(s.points.map((p) => p.spanDays), [null, 7, 21]);
  assert.deepEqual(s.points[0].tree, { files: 1000, loc: 100_000 });
});

test("healthIndexVs: against the latest measured week at least 12 weeks earlier, null only when there is none", () => {
  const rows = Array.from({ length: 14 }, (_, w) => row(w, { size: 500 - w * 10 }));
  const s = healthIndex(rows, null);
  const vs = healthIndexVs(s.points);
  assert.equal(vs.then.week, dayOf(1));
  assert.equal(vs.weeks, 12);
  near(vs.ratio, s.points[13].index / s.points[1].index);
  near(vs.delta, s.points[13].index - s.points[1].index);
  assert.equal(healthIndexVs(s.points.slice(0, 12)), null, "a series younger than the horizon has no comparison");
  // A hole: weeks 0 and 15 only — the comparison is the week it actually has, and says which.
  const holey = healthIndex([row(0), row(15)], null);
  assert.equal(healthIndexVs(holey.points).then.week, dayOf(0));
  assert.equal(healthIndexVs(holey.points).weeks, 15, "no slack window: any distance at or past the horizon, named");
  // The LATEST such week wins, never the oldest: weeks 0, 2 and 20 → week 2 (18 back).
  const two = healthIndex([row(0), row(2), row(20)], null);
  assert.equal(healthIndexVs(two.points).then.week, dayOf(2));
  // Nothing at least 12 back: null, even with an 11-week-old point.
  assert.equal(healthIndexVs(healthIndex([row(0), row(11)], null).points), null);
  assert.equal(healthIndexVs([]), null);
});
