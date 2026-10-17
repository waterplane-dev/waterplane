// The health score (`shared/src/healthindex.ts`): the one layer over the
// repo-health series that takes a side. Hand-built rows only, so every number
// asserted here can be checked by hand — and two literal rows shaped like the
// real readings of a photo app and a big monorepo of 2026-10-17, the pair that argued for
// the absolute score and the cap.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTEXT_LIMITS,
  HEALTH_GOOD,
  HEALTH_INDEX_DEFAULT_WARN_CHARS,
  HEALTH_INDEX_MIN_WEEKS,
  HEALTH_SCORE_CAP_GAP,
  assessHealthMove,
  centralOf,
  healthCapWords,
  healthEntryReadings,
  healthEntryValues,
  healthIndex,
  healthIndexVs,
  healthMoveWords,
  healthScore,
  healthWeeks,
  isoWeekOf,
  repoHealthIndexOf,
} from "../dist/index.js";

const PREREG = "2026-10-17a+test";

/** Monday 2026-01-05 + w weeks, plus `d` days. */
function dayOf(w, d = 0) {
  return new Date(Date.UTC(2026, 0, 5) + (w * 7 + d) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One row; every family present unless overridden. The defaults put EVERY
 * entry at exactly twice its good value — score 50 each, mean 50, no cap, no
 * alert — so a move of one entry is easy to work out by hand.
 */
function row(w, o = {}) {
  const day = o.day ?? dayOf(w, 2);
  return {
    sha: `s${w}`,
    day,
    ts: o.ts ?? Date.parse(`${day}T12:00:00Z`),
    batch: false,
    prereg: o.prereg ?? PREREG,
    size: o.size === null ? { value: null, reason: "x" }
      : { value: { p95: 500, max: o.max ?? 2000, maxPath: o.maxPath ?? "src/big.ts", ...(o.lineMean === null ? {} : { lineMean: o.lineMean ?? 1000 }) } },
    retouch: o.retouch === null ? { value: null, reason: "x" } : { value: { rate: o.retouch ?? 0.3 } },
    hatches: o.hatches === null ? { value: null, reason: "x" } : { value: { todo: o.hatches ?? 400 } },
    context: o.context === null ? { value: null, reason: "x" }
      : { value: { claudeMdChars: o.md ?? 12_000, descChars: o.desc === undefined ? 4_000 : o.desc } },
    untested: o.untested === null ? { value: null, reason: "x" } : { value: Array.from({ length: o.untested ?? 400 }, (_, i) => `m${i}`) },
    classics: { value: { loc: o.loc ?? 100_000, files: o.files ?? 1000 } },
  };
}

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const list = (n) => Array.from({ length: n }, (_, i) => `m${i}`);

// ── the two rows that argued for the design ────────────────────────────────

/** the photo app, 2026-10-17: one 8,397-line file, everything else quiet. */
const PHOTO_APP = {
  sha: "pa", day: "2026-10-14", ts: Date.parse("2026-10-14T12:00:00Z"), prereg: PREREG,
  size: { value: { p95: 1200, max: 8397, maxPath: "lib/services/android_backend.dart", lineMean: 2235, nearMax: 1 } },
  retouch: { value: { rate: 0.07 } },
  hatches: { value: { todo: 5, asAny: 15 }, split: { unexplained: 15, explained: 0 } },
  context: { value: { claudeMdChars: 9000, descChars: 1242 } },
  untested: { value: list(25) },
  classics: { value: { loc: 40_000, files: 146 } },
};

/** the monorepo, 2026-10-17: nothing on fire, a heavy CLAUDE.md + skill descriptions. */
const MONOREPO = {
  sha: "us", day: "2026-10-14", ts: Date.parse("2026-10-14T12:00:00Z"), prereg: PREREG,
  size: { value: { p95: 574, max: 1865, maxPath: "tools/release/publish.mjs", lineMean: 360 } },
  retouch: { value: { rate: 0.195 } },
  hatches: { value: { todo: 54, asAny: 25 }, split: { unexplained: 203, explained: 142 } },
  context: { value: { claudeMdChars: 20_000, descChars: 5957 } },
  untested: { value: list(583) },
  classics: { value: { loc: 312_308, files: 1716 } },
};

test("the photo app: mean ≈66, but the cap holds it at ≈46 by size, and the longest file is named", () => {
  const s = healthIndex([PHOTO_APP], 16_000);
  const p = s.points[0];
  near(p.sizeParts.lineMean.score, 100 * 500 / 2235);
  near(p.sizeParts.max.score, 100 * 1000 / 8397);
  near(p.scores.size, Math.sqrt(p.sizeParts.lineMean.score * p.sizeParts.max.score));
  assert.equal(Math.round(p.sizeParts.lineMean.score), 22);
  assert.equal(Math.round(p.sizeParts.max.score), 12);
  assert.equal(Math.round(p.scores.size), 16);
  assert.equal(p.scores.retouch, 100);
  assert.equal(p.scores.hatches, 100);
  assert.equal(Math.round(p.scores.context), 78);
  assert.equal(p.scores.untested, 100);
  assert.equal(Math.round(p.mean), 66);
  near(p.index, p.scores.size + HEALTH_SCORE_CAP_GAP);
  assert.equal(Math.round(p.index), 46);
  assert.equal(p.cappedBy, "size");
  assert.deepEqual(p.alerts.map((a) => [a.subject, a.level]), [["max", "severe"], ["lineMean", "severe"]]);
  assert.equal(p.alerts[0].text, "severe: lib/services/android_backend.dart is 8,397 lines (good: under 1,000)");
  assert.equal(p.alerts[0].path, "lib/services/android_backend.dart");
  assert.equal(healthCapWords({ value: p.index, mean: p.mean, cappedBy: p.cappedBy }),
    "Capped at 46 by file length (16 of 100): the entries average 66, and the score stays within 30 of its worst entry.");
  const wire = repoHealthIndexOf(s, null);
  assert.equal(wire.cappedBy, "size");
  assert.equal(wire.alert, "severe");
  assert.equal(wire.alertText, p.alerts[0].text);
  near(wire.mean, p.mean);
});

test("the monorepo: mean ≈63, capped at ≈61 by context — and lower than the photo app is no longer higher", () => {
  const p = healthIndex([MONOREPO], 16_000).points[0];
  assert.equal(p.sizeParts.lineMean.score, 100);
  assert.equal(Math.round(p.sizeParts.max.score), 54);
  assert.equal(Math.round(p.scores.size), 73);
  assert.equal(Math.round(p.scores.retouch), 77);
  assert.equal(p.scores.hatches, 100);
  assert.equal(Math.round(p.scores.context), 31);
  assert.equal(Math.round(p.scores.untested), 59);
  assert.equal(Math.round(p.mean), 63);
  assert.equal(Math.round(p.index), 61);
  assert.equal(p.cappedBy, "context");
  assert.deepEqual(p.alerts.map((a) => [a.subject, a.level]), [["context", "warn"]]);
  assert.equal(p.alerts[0].text, "warn: CLAUDE.md + skill descriptions are 25,957 chars (good: under 8,000)");
  // Before the cap the giant-file repo out-scored this one (66 vs 63); after it, not.
  assert.ok(healthIndex([PHOTO_APP], 16_000).points[0].index < p.index);
});

// ── the score itself ───────────────────────────────────────────────────────

test("the default warn line is the setup checklist's", () => {
  assert.equal(HEALTH_INDEX_DEFAULT_WARN_CHARS, DEFAULT_CONTEXT_LIMITS.maxChars);
});

test("an entry scores 100·min(1, good/value); at or under 0 is 100", () => {
  assert.equal(healthScore(0, 500), 100);
  assert.equal(healthScore(250, 500), 100);
  assert.equal(healthScore(500, 500), 100);
  assert.equal(healthScore(1000, 500), 50);
  const p = healthIndex([row(0)], null).points[0];
  for (const e of ["size", "retouch", "hatches", "context", "untested"]) near(p.scores[e], 50);
  near(p.mean, 50);
  near(p.index, 50);
  assert.equal(p.cappedBy, null);
  assert.deepEqual(p.alerts, []);
  // A zero rate is a perfect entry, never a dead series.
  const z = healthIndex([row(0, { retouch: 0, hatches: 0, untested: 0 })], null).points[0];
  assert.equal(z.scores.retouch, 100);
  assert.equal(z.scores.hatches, 100);
  assert.equal(z.scores.untested, 100);
});

test("context's good line is half the repo's own warn line", () => {
  near(healthIndex([row(0, { md: 8000, desc: 0 })], 32_000).points[0].scores.context, 100);
  near(healthIndex([row(0, { md: 8000, desc: 0 })], null).points[0].scores.context, 100);
  near(healthIndex([row(0, { md: 16_000, desc: null })], null).points[0].scores.context, 50);
  assert.equal(healthEntryValues(row(0, { md: 9000, desc: 3000 })).context, 12_000);
});

test("untested is a share of classics.files; hatches a density per kLOC", () => {
  near(healthEntryValues(row(0, { untested: 250, files: 1000 })).untested, 0.25);
  assert.equal(healthEntryValues(row(0, { files: 0 })).untested, undefined);
  near(healthEntryValues(row(0, { hatches: 300, loc: 150_000 })).hatches, 2);
});

test("a missing entry is no score that week — never a score over a partial basket", () => {
  const s = healthIndex([row(0, { untested: null }), row(1, { context: null }), row(2), row(3)], null);
  assert.equal(s.baselineWeek, dayOf(2));
  assert.deepEqual(s.points.map((p) => p.week), [dayOf(2), dayOf(3)]);
  assert.equal(healthIndex([row(0, { untested: null }), row(1, { retouch: null })], null), null);
  assert.equal(healthIndex([], null), null);
  assert.equal(repoHealthIndexOf(null), null);
});

test("size needs lineMean AND max: rows from before the engine bump score nothing", () => {
  assert.equal(healthIndex([row(0, { lineMean: null })], null), null);
  assert.equal(healthEntryReadings(row(0, { lineMean: null })).values.size, undefined);
  const r = healthEntryReadings(row(0, { lineMean: 700, max: 3000, maxPath: "a/b.ts" }));
  assert.equal(r.values.size, 700);
  assert.deepEqual(r.max, { value: 3000, path: "a/b.ts" });
});

test("the cap: the headline never sits more than 30 above the worst entry", () => {
  // Four perfect entries and one at 10 average 63; the cap makes it 40.
  const r = row(0, { lineMean: 100, max: 100, retouch: 0.0, hatches: 0, md: 0, desc: 0, untested: 0 });
  r.context = { value: { claudeMdChars: 80_000, descChars: 0 } }; // 8,000 / 80,000 → 10
  const p = healthIndex([r], null).points[0];
  near(p.scores.context, 10);
  near(p.mean, Math.exp((4 * Math.log(100) + Math.log(10)) / 5));
  near(p.index, 40);
  assert.equal(p.cappedBy, "context");
  assert.equal(healthCapWords({ value: 50, mean: 50, cappedBy: null }), null);
});

// ── alerts ──────────────────────────────────────────────────────────────────

test("alert levels at the boundaries: 50 is none, under 50 warn, 25 still warn, under 25 severe", () => {
  const at = (o) => healthIndex([row(0, o)], null).points[0].alerts.filter((a) => a.subject === "lineMean").map((a) => a.level);
  assert.deepEqual(at({ lineMean: 1000 }), []);
  assert.deepEqual(at({ lineMean: 1001 }), ["warn"]);
  assert.deepEqual(at({ lineMean: 2000 }), ["warn"]);
  assert.deepEqual(at({ lineMean: 2001 }), ["severe"]);
  const mx = (max) => healthIndex([row(0, { max })], null).points[0].alerts.filter((a) => a.subject === "max").map((a) => a.level);
  assert.deepEqual(mx(2000), []);
  assert.deepEqual(mx(2001), ["warn"]);
  assert.deepEqual(mx(4000), ["warn"]);
  assert.deepEqual(mx(4001), ["severe"]);
  // Every entry has its own sentence, and none of them is a banner or an emoji.
  const all = healthIndex([row(0, { lineMean: 3000, max: 5000, retouch: 0.9, hatches: 900, md: 40_000, untested: 900 })], null).points[0];
  assert.deepEqual(all.alerts.map((a) => a.subject).sort(), ["context", "hatches", "lineMean", "max", "retouch", "untested"]);
  for (const a of all.alerts) {
    assert.match(a.text, /^(warn|severe): .+ \(good: under .+\)$/);
    assert.doesNotMatch(a.text, /[\u{1F300}-\u{1FAFF}☀-➿]/u);
  }
  assert.ok(all.alerts.every((a, i, xs) => i === 0 || xs[i - 1].score <= a.score), "worst first");
  assert.equal(all.alerts.find((a) => a.subject === "untested").text, "severe: 90% of source files have no test reaching them (good: under 20%)");
  assert.equal(all.alerts.find((a) => a.subject === "hatches").text, "severe: 9.0 unexplained escape hatches per 1,000 lines (good: under 2.0)");
  // No path from the engine: the file is not invented.
  const r = row(0, { max: 5000 });
  delete r.size.value.maxPath;
  assert.equal(healthIndex([r], null).points[0].alerts.find((a) => a.subject === "max").text,
    "severe: the longest file is 5,000 lines (good: under 1,000)");
  assert.equal(HEALTH_GOOD.max, 1000);
});

// ── a repo's say over the central readings (`central` on the row) ──────────

const withCentral = (r, central) => ({ ...r, central });

test("a disabled entry leaves the mean, the cap and the alerts", () => {
  const off = { fp: "f1", disabled: { size: { why: "generated" } } };
  const p = healthIndex([withCentral(row(0, { lineMean: 50_000, max: 90_000 }), off)], null).points[0];
  assert.equal(p.scores.size, undefined);
  assert.equal(p.sizeParts, null);
  near(p.mean, 50, 1e-9);
  assert.equal(p.cappedBy, null);
  assert.deepEqual(p.alerts, []);
  assert.deepEqual(p.disabled, ["size"]);
  // A missing reading that is disabled does not block the score.
  assert.ok(healthIndex([withCentral(row(0, { untested: null }), { fp: "f2", disabled: { untested: { why: "w" } } })], null));
  const all = Object.fromEntries(["size", "retouch", "hatches", "context", "untested"].map((k) => [k, { why: "w" }]));
  assert.equal(healthIndex([withCentral(row(0), { fp: "f3", disabled: all })], null), null);
});

test("an override replaces lineMean (the longest file stays measured); a failed override is ABSENT", () => {
  const ov = (v) => ({ fp: "o1", override: { size: { value: v, why: "ours only" } } });
  const p = healthIndex([withCentral(row(0, { lineMean: 9000, max: 2000 }), ov(500))], null).points[0];
  assert.equal(p.sizeParts.lineMean.value, 500);
  assert.equal(p.sizeParts.lineMean.score, 100);
  assert.equal(p.sizeParts.max.value, 2000);
  near(p.scores.size, Math.sqrt(100 * 50));
  assert.deepEqual(p.overridden, ["size"]);
  assert.equal(healthEntryValues(withCentral(row(0), ov(null))).size, undefined);
  assert.equal(healthIndex([withCentral(row(0), ov(null))], null), null);
  const r = healthEntryValues(withCentral(row(0), { fp: "o2", override: { retouch: { value: 0, why: "w" } } }));
  assert.equal(r.retouch, 0);
  assert.deepEqual(centralOf(withCentral(row(0), ov(1))).overridden, ["size"]);
});

test("a prereg or central change marks the gap, but the score is shown as measured", () => {
  const s = healthIndex([row(0), row(1, { retouch: 0.6, prereg: "2026-11-01a+x" }), row(2, { retouch: 0.6, prereg: "2026-11-01a+x" })], null);
  const [, gap, link] = s.points;
  assert.equal(gap.gap, true);
  assert.equal(gap.gapReason, "prereg");
  assert.equal(gap.lnLink, null);
  near(gap.index, 50 * Math.pow(0.5, 1 / 5), 1e-9);
  assert.deepEqual(gap.contributions, {});
  assert.equal(link.gap, false);
  near(link.lnLink, 0);
  const c = healthIndex([row(0), withCentral(row(1), { fp: "o1", override: { retouch: { value: 0.15, why: "w" } } })], null);
  assert.equal(c.points[1].gapReason, "central");
  assert.equal(c.points[1].central, "o1");
  assert.ok(c.points[1].index > c.points[0].index, "the override's score stands");
});

test("contributions: log points of the mean, negative where an entry's score fell, summing exactly", () => {
  const s = healthIndex([row(0), row(1, { lineMean: 1100, retouch: 0.25, hatches: 440, md: 12_500, untested: 410 })], null);
  const p = s.points[1];
  const sum = Object.values(p.contributions).reduce((a, b) => a + b, 0);
  near(sum, 50 * Math.log(p.mean / 50), 1e-9);
  near(sum, p.mean - 50, 0.05);
  assert.ok(p.contributions.size < 0, "longer files count against");
  assert.ok(p.contributions.retouch > 0, "fewer re-touches count for");
  assert.equal(p.comparable, 5);
  near(p.lnLink, Math.log(p.index / s.points[0].index));
});

test("one metric doubling moves the mean by the fifth root of 2", () => {
  const s = healthIndex([row(0), row(1, { retouch: 0.6 })], null);
  near(s.points[1].index, 50 * Math.pow(2, -1 / 5));
});

// ── the trend, the second line ─────────────────────────────────────────────

/** A wobbly but steady series of n weeks, then optional extra weeks. */
function steady(n, extra = []) {
  const rows = [];
  for (let w = 0; w < n; w++) rows.push(row(w, { lineMean: 1000 + (w % 2 ? 10 : -10) }));
  extra.forEach((o, i) => rows.push(row(n + i, o)));
  return rows;
}

test("under the minimum history, no move is called — null with a reason", () => {
  const s = healthIndex(steady(HEALTH_INDEX_MIN_WEEKS, [{ lineMean: 4000 }]), null);
  assert.equal(s.points.filter((p) => p.lnLink !== null).length, HEALTH_INDEX_MIN_WEEKS);
  const short = healthIndex(steady(HEALTH_INDEX_MIN_WEEKS - 1, [{ lineMean: 4000 }]), null);
  const m = assessHealthMove(short.points);
  assert.equal(m.kind, null);
  assert.match(m.reason, /a move is called after 8/);
});

test("a clear drop is called on the week horizon, and worded", () => {
  const s = healthIndex(steady(10, [{ lineMean: 1600, untested: 480 }]), null);
  const m = assessHealthMove(s.points);
  assert.equal(m.kind, "drop");
  assert.equal(m.horizon, "week");
  assert.ok(m.delta <= -2);
  const lastWeek = s.points[s.points.length - 1].week;
  const w = healthMoveWords(s.points, m, lastWeek);
  assert.match(w.title, /^Health score \d+ \(−\d+ this week\)$/);
  const old = healthMoveWords(s.points, m, "2099-01-05");
  assert.ok(old.title.includes(`in the week of ${lastWeek}`), old.title);
  assert.ok(old.body.includes(`in the week of ${lastWeek}`) && !/this week/.test(old.body), old.body);
  assert.ok(!/this week/.test(healthMoveWords(s.points, m).title));
  assert.match(w.body, /slipped/);
  assert.match(w.body, /files grew longer/);
  assert.match(w.body, /more untested modules/);
  assert.ok(w.body.indexOf("files grew longer") < w.body.indexOf("more untested modules"), "biggest first");
  const wire = repoHealthIndexOf(s, m);
  assert.equal(wire.move, "drop");
  near(wire.deltaWeek, m.delta);
});

test("a clear rise is called and worded with the falling metrics", () => {
  const s = healthIndex(steady(10, [{ lineMean: 600, hatches: 240 }]), null);
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
  // Four weeks of lineMean ×1.2: ~0.9 points a week (under the 2-point floor), ~3.5 over the month.
  for (let i = 0; i < 4; i++) rows.push(row(12 + i, { lineMean: 1010 * Math.pow(1.2, i + 1) }));
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

test("ISO weeks start Monday, UTC; the last row of a week is its reading", () => {
  assert.equal(isoWeekOf("2026-01-05"), "2026-01-05");
  assert.equal(isoWeekOf("2026-01-11"), "2026-01-05");
  assert.equal(isoWeekOf("2026-01-12"), "2026-01-12");
  assert.equal(isoWeekOf("garbage"), null);
  const weeks = healthWeeks([row(0, { day: dayOf(0, 6), lineMean: 900 }), row(0, { day: dayOf(0, 0), lineMean: 100 })]);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].row.size.value.lineMean, 900);
});

test("spanDays: Monday to Monday since the previous scored week; null on the first", () => {
  const s = healthIndex([row(0), row(1), row(2, { untested: null }), row(4)], null);
  assert.deepEqual(s.points.map((p) => p.spanDays), [null, 7, 21]);
  assert.deepEqual(s.points[0].tree, { files: 1000, loc: 100_000 });
});

test("healthIndexVs: against the latest scored week at least 12 weeks earlier, null only when there is none", () => {
  const rows = Array.from({ length: 14 }, (_, w) => row(w, { lineMean: 1000 - w * 20 }));
  const s = healthIndex(rows, null);
  const vs = healthIndexVs(s.points);
  assert.equal(vs.then.week, dayOf(1));
  assert.equal(vs.weeks, 12);
  near(vs.ratio, s.points[13].index / s.points[1].index);
  near(vs.delta, s.points[13].index - s.points[1].index);
  assert.equal(healthIndexVs(s.points.slice(0, 12)), null);
  const holey = healthIndex([row(0), row(15)], null);
  assert.equal(healthIndexVs(holey.points).then.week, dayOf(0));
  assert.equal(healthIndexVs(holey.points).weeks, 15);
  const two = healthIndex([row(0), row(2), row(20)], null);
  assert.equal(healthIndexVs(two.points).then.week, dayOf(2));
  assert.equal(healthIndexVs(healthIndex([row(0), row(11)], null).points), null);
  assert.equal(healthIndexVs([]), null);
});

test("month horizon: a window spanning a gap is skipped as history, and the current one calls nothing", () => {
  // A slow slide that WOULD be called a month drop (as in the test above) ...
  const slide = (extraPrereg) => {
    const rows = steady(12);
    for (let i = 0; i < 4; i++) rows.push(row(12 + i, { lineMean: 1010 * Math.pow(1.2, i + 1), ...(extraPrereg && i === 1 ? { prereg: "2026-11-01a+x" } : {}) }));
    return rows;
  };
  assert.equal(assessHealthMove(healthIndex(slide(false), null).points).horizon, "month");
  // ... a definition change inside the current four weeks: no month move, with the reason.
  // (Later rows keep the new prereg, so only one point is a gap.)
  const rows = slide(false);
  for (let i = 13; i < 16; i++) rows[i] = { ...rows[i], prereg: "2026-11-01a+x" };
  const s = healthIndex(rows, null);
  assert.equal(s.points.filter((p) => p.gap).length, 1);
  const m = assessHealthMove(s.points);
  assert.equal(m.kind, null);
  assert.match(m.reason, /span a change of definition/);
  // An EARLIER gap only removes the windows it touches: the steady history still stands.
  const early = steady(12).map((r, i) => (i >= 3 ? { ...r, prereg: "2026-11-01a+x" } : r));
  for (let i = 0; i < 4; i++) early.push(row(12 + i, { lineMean: 1010 * Math.pow(1.2, i + 1), prereg: "2026-11-01a+x" }));
  const e = healthIndex(early, null);
  assert.equal(e.points[3].gap, true);
  assert.equal(assessHealthMove(e.points).horizon, "month");
});

test("a size override with no engine lineMean still reads the engine's max; without a max, size is absent either way", () => {
  const ov = { fp: "o1", override: { size: { value: 500, why: "ours only" } } };
  const noMean = row(0, { lineMean: null, max: 2000 });
  assert.equal(healthEntryValues(noMean).size, undefined, "no override: size needs lineMean");
  const withOv = healthEntryReadings(withCentral(noMean, ov));
  assert.equal(withOv.values.size, 500);
  assert.equal(withOv.max.value, 2000);
  const noMax = row(0, { lineMean: 900 });
  delete noMax.size.value.max;
  assert.equal(healthEntryValues(noMax).size, undefined, "no override: no max, no size");
  assert.equal(healthEntryValues(withCentral(noMax, ov)).size, undefined, "an override cannot invent the longest file");
});
