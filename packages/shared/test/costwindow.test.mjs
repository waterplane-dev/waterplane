/**
 * The cost window, read: the one bucketing function (the count on an hour IS
 * the list it opens), launches folded into one row per fan-out, ranked repos,
 * dollars per weekly point — refused in words rather than guessed — and the two
 * per-session/per-run sentences.
 */
process.env.TZ = "UTC";
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_MODEL_MIN_PCT, COST_CONVOS_CAP, LAUNCH_KIND_WORD, agentModelInsight, fanoutHintText, fanoutTextKey, foldLaunches,
  hourFloor, hourKey, hourKeyMs, isPtsCal, pickSimilarRun, ptsCalibration, ptsRefusalText, ptsText, rankRepos, repoRowAsGroup, weekCut,
  windowStartHour,
} from "../dist/index.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-06T10:00:00Z"); // a Tuesday

const tot = (tok, turns = 1) => ({ input: 0, output: 0, cacheRead: tok, cacheWrite: 0, cacheWrite1h: 0, turns });
const usd = (total) => ({ input: 0, output: 0, cacheRead: total, cacheWrite: 0, total });
const slice = (model, tok, d) => ({ model, totals: tot(tok), cost: usd(d) });

function convo(id, repo, hours, extra = {}) {
  const byHour = hours.map(([i, d, tok]) => ({ hour: hourKey(T0 + i * HOUR), usd: d, tok }));
  const d = byHour.reduce((s, h) => s + h.usd, 0);
  const tok = byHour.reduce((s, h) => s + h.tok, 0);
  return {
    id, repo, label: repo ? repo.split("/").pop() : "unknown repo",
    firstAt: byHour.length ? hourKeyMs(byHour[0].hour) : null,
    lastAt: byHour.length ? hourKeyMs(byHour[byHour.length - 1].hour) : null,
    totals: tot(tok), cost: usd(d), agentTotals: tot(0, 0), agentCost: usd(0), agents: 0,
    byModel: [slice("claude-opus-5", tok, d)], agentByModel: [], byHour, live: false, ...extra,
  };
}

function doc(convos) {
  const hours = new Map();
  for (const c of convos) {
    for (const h of c.byHour) {
      const cur = hours.get(h.hour) ?? { hour: h.hour, t: hourKeyMs(h.hour), totals: tot(0, 0), cost: usd(0), byRepo: [], byModel: [] };
      cur.totals.cacheRead += h.tok; cur.cost.total += h.usd; cur.cost.cacheRead += h.usd;
      cur.byRepo.push({ repo: c.repo, label: c.label, totals: tot(h.tok), cost: usd(h.usd) });
      hours.set(h.hour, cur);
    }
  }
  return {
    from: T0, to: T0 + 24 * HOUR, fromHour: T0, hours: [...hours.values()].sort((a, b) => a.t - b.t),
    convos: convos.slice().sort((a, b) => b.cost.total - a.cost.total),
    totals: tot(0, 0), cost: usd(0), agentTotals: tot(0, 0), agentCost: usd(0), unpriced: tot(0, 0),
    pricesAsOf: "2026-09-28", scannedAt: T0,
  };
}

const A = convo("aaaaaaaa-1", "/dev/alpha", [[0, 5, 100], [1, 3, 50]], { launch: { kind: "fanout", runId: "run1", label: "architect review" } });
const B = convo("bbbbbbbb-2", "/dev/beta", [[1, 4, 80]], { launch: { kind: "fanout", runId: "run1", label: "architect review" } });
const C = convo("cccccccc-3", "/dev/gamma", [[1, 2, 40], [5, 1, 10]], { launch: { kind: "fanout", runId: "run1" } });
const D = convo("dddddddd-4", "/dev/alpha", [[5, 9, 300]], { title: "fix the login race" });
const E = convo("eeeeeeee-5", "", [[3, 0.5, 5]]);
const DOC = doc([A, B, C, D, E]);

// ── the hour ──

test("hourFloor / hourKey / hourKeyMs agree on the local hour", () => {
  const t = T0 + 37 * 60_000 + 5_000;
  assert.equal(hourFloor(t), T0);
  assert.equal(hourKey(t), "2026-10-06T10");
  assert.equal(hourKeyMs(hourKey(t)), T0);
});

test("windowStartHour: a window opening mid-hour starts at the NEAREST hour, never always the floor", () => {
  const m = 60_000;
  // A week resetting at 18:59 opens 18:59 a week earlier: flooring counted 59 minutes of the
  // PREVIOUS week (measured ≈ 4 weekly points); the nearest hour is 19:00.
  assert.equal(windowStartHour(T0 + 59 * m), T0 + HOUR);
  // A five-hour window opening at :20 starts at the top of its own hour (20 min wider).
  assert.equal(windowStartHour(T0 + 20 * m), T0);
  // The tie goes to the later hour, Math.round's way.
  assert.equal(windowStartHour(T0 + 30 * m), T0 + HOUR);
  assert.equal(windowStartHour(T0 + 30 * m - 1), T0);
  // Idempotent on a boundary — so the host's hourFloor(from) is the identity on what the phone sends.
  assert.equal(windowStartHour(T0), T0);
  assert.equal(hourFloor(windowStartHour(T0 + 49 * m)), windowStartHour(T0 + 49 * m));
  // Two windows back to back tile: the next one's start IS this one's end, so no hour is in both.
  const len = 5 * HOUR;
  for (const off of [0, 20, 30, 49, 59]) {
    const opened = T0 + off * m;
    const a = windowStartHour(opened), b = windowStartHour(opened + len), c = windowStartHour(opened + 2 * len);
    assert.equal(b - a, len, `${off}`);
    assert.equal(c - b, len, `${off}`);
  }
});

// ── weekCut ──

test("weekCut: the count on every bucket IS the cut it opens", () => {
  const cut = weekCut(DOC);
  assert.ok(cut.buckets.length > 0);
  for (const b of cut.buckets) {
    const opened = cut.convosIn(b.hour);
    assert.deepEqual(opened.map((c) => c.id).sort(), b.convoIds.slice().sort(), `bucket ${b.hour}`);
    assert.match(cut.filterText(b.hour), new RegExp(`^${b.convoIds.length} of 5 sessions · `));
  }
  assert.deepEqual(cut.convosIn(null).map((c) => c.id), DOC.convos.map((c) => c.id), "no filter is every session, in the document's order");
  assert.equal(cut.filterText(null), null);
});

test("weekCut: an hour nothing ran in is absent, never a zero bucket", () => {
  const cut = weekCut(DOC);
  assert.deepEqual(cut.buckets.map((b) => b.hour), [0, 1, 3, 5].map((i) => hourKey(T0 + i * HOUR)));
  const h1 = cut.buckets[1];
  assert.equal(h1.usd, 3 + 4 + 2);
  assert.equal(h1.tok, 50 + 80 + 40);
  assert.equal(h1.convoIds.length, 3);
});

test("weekCut: filterText names the day and the hour", () => {
  const cut = weekCut(DOC);
  assert.equal(cut.filterText(hourKey(T0 + HOUR)), "3 of 5 sessions · Tue 11:00–12:00");
  assert.equal(weekCut(doc([D])).filterText(hourKey(T0 + 5 * HOUR)), "1 of 1 session · Tue 15:00–16:00");
});

test("weekCut: filterText reads the bucket's own instant, never the host-local key on this clock", () => {
  // A host two hours ahead of this phone: its key says 10:00, the instant is 08:00 here.
  const key = hourKey(T0);
  const d = { ...DOC, hours: DOC.hours.map((h) => (h.hour === key ? { ...h, t: T0 - 2 * HOUR } : h)) };
  assert.equal(weekCut(d).filterText(key), "1 of 5 sessions · Tue 08:00–09:00");
  assert.equal(weekCut(DOC).filterText("2026-01-01T00"), "0 of 5 sessions", "an hour with no bucket names no clock at all");
});

// ── foldLaunches ──

test("foldLaunches: one row per fan-out run, repos counted distinct; unrecorded sessions one row each", () => {
  const rows = foldLaunches(DOC.convos);
  assert.equal(rows.length, 3);
  const run = rows.find((r) => r.key === "run1");
  assert.equal(run.kind, "fanout");
  assert.equal(run.convos.length, 3);
  assert.equal(run.repos, 3);
  assert.equal(run.cost.total, 5 + 3 + 4 + 2 + 1);
  assert.equal(run.label, "architect review · 3 repos");
  assert.deepEqual(run.convos.map((c) => c.id), ["aaaaaaaa-1", "bbbbbbbb-2", "cccccccc-3"], "descending by cost");
  assert.equal(run.firstAt, T0);
  assert.equal(run.lastAt, T0 + 5 * HOUR);
  const hand = rows.find((r) => r.key === "c:dddddddd-4");
  assert.equal(hand.kind, "unrecorded", "no launch record is never read as 'by hand'");
  assert.equal(hand.label, "fix the login race");
  assert.equal(hand.more, 0);
  assert.equal(rows.find((r) => r.key === "c:eeeeeeee-5").label, "unknown repo · eeeeeeee", "nobody named it: repo · id8, never dropped");
  assert.deepEqual(rows.map((r) => r.key), ["run1", "c:dddddddd-4", "c:eeeeeeee-5"], "descending by cost");
});

test("foldLaunches: a backlog item groups by itemId; a lone repo says no count", () => {
  const x = convo("x1", "/dev/alpha", [[0, 1, 1]], { launch: { kind: "backlog", itemId: "it-9", label: "tidy the README" } });
  const y = convo("y1", "/dev/alpha", [[1, 1, 1]], { launch: { kind: "backlog", itemId: "it-9", label: "tidy the README" } });
  const rows = foldLaunches([x, y]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "tidy the README");
  assert.equal(rows[0].repos, 1);
});

test("foldLaunches: a run's kind is the run's — one resumed target never makes a fan-out read 'resumed at reset'", () => {
  // The resumed target is the DEAREST member, which is what the kind used to be read off.
  const r1 = convo("r1", "/dev/alpha", [[0, 50, 10]], { launch: { kind: "resurrect", runId: "run7", itemId: "run7#1" } });
  const r2 = convo("r2", "/dev/beta", [[0, 1, 10]], { launch: { kind: "fanout", runId: "run7", itemId: "run7#2", label: "sweep" } });
  const [row] = foldLaunches([r1, r2]);
  assert.equal(row.kind, "fanout");
  assert.equal(row.label, "sweep · 2 repos");
  // A backlog item whose session was resumed is still the backlog item.
  const b1 = convo("b1", "/dev/alpha", [[0, 9, 10]], { launch: { kind: "resurrect", itemId: "it-3", label: "fix it" } });
  const b2 = convo("b2", "/dev/alpha", [[1, 1, 10]], { launch: { kind: "backlog", itemId: "it-3", label: "fix it" } });
  assert.equal(foldLaunches([b1, b2])[0].kind, "backlog");
  // Only resumes: that IS what is known.
  assert.equal(foldLaunches([b1])[0].kind, "resurrect");
});

test("LAUNCH_KIND_WORD: every kind has its one word, and no record is not 'by hand'", () => {
  for (const k of ["fanout", "backlog", "schedule", "agent", "resurrect", "hand", "fork", "unrecorded"]) assert.ok(LAUNCH_KIND_WORD[k], k);
  assert.equal(LAUNCH_KIND_WORD.unrecorded, "no launch record");
  assert.notEqual(LAUNCH_KIND_WORD.unrecorded, LAUNCH_KIND_WORD.hand);
});

// ── the cap: folded conversations keep every aggregate whole ──

const restOf = (repo, count, d, launch, extra = {}) => ({
  repo, label: repo ? repo.split("/").pop() : "unknown repo", ...(launch ? { launch } : {}), count, agents: 0,
  totals: tot(d * 10), cost: usd(d), agentTotals: tot(0, 0), agentCost: usd(0),
  byModel: [slice("claude-sonnet-5", d * 10, d)], firstAt: T0, lastAt: T0 + HOUR, ...extra,
});

test("cap: COST_CONVOS_CAP is a positive whole number the host and phone share", () => {
  assert.ok(Number.isInteger(COST_CONVOS_CAP) && COST_CONVOS_CAP > 0);
});

test("cap: foldLaunches joins a folded group to its run and keeps the totals whole", () => {
  const rest = [
    restOf("/dev/delta", 30, 60, { kind: "fanout", runId: "run1", label: "architect review" }),
    restOf("/dev/alpha", 4, 2),
  ];
  const rows = foldLaunches(DOC.convos, rest);
  const run = rows.find((r) => r.key === "run1");
  assert.equal(run.convos.length, 3, "only carried rows are openable");
  assert.equal(run.more, 30);
  assert.equal(run.cost.total, 15 + 60);
  assert.equal(run.repos, 4, "a folded group's repo counts");
  assert.equal(run.label, "architect review · 4 repos");
  assert.equal(rows[0].key, "run1");
  const folded = rows.find((r) => r.key === "rest:/dev/alpha:unrecorded");
  assert.equal(folded.kind, "unrecorded");
  assert.equal(folded.convos.length, 0);
  assert.equal(folded.more, 4);
  assert.equal(folded.label, "4 more sessions · alpha");
  const sum = rows.reduce((s, r) => s + r.cost.total, 0);
  assert.equal(sum, DOC.convos.reduce((s, c) => s + c.cost.total, 0) + 62, "nothing lost, nothing counted twice");
});

test("cap: a folded run with no carried member is still its run, labelled by the run", () => {
  const rest = [restOf("/dev/a", 40, 80, { kind: "fanout", runId: "run9", label: "lint sweep" }), restOf("/dev/b", 2, 1, { kind: "fanout", runId: "run9", label: "lint sweep" })];
  const [row] = foldLaunches([], rest);
  assert.equal(row.kind, "fanout");
  assert.equal(row.more, 42);
  assert.equal(row.label, "lint sweep · 2 repos");
});

test("cap: rankRepos counts folded sessions in the repo's total", () => {
  const rows = rankRepos(DOC.convos, [restOf("/dev/alpha", 7, 20), restOf("/dev/zeta", 3, 1)]);
  const alpha = rows.find((r) => r.repo === "/dev/alpha");
  assert.equal(alpha.cost.total, 5 + 3 + 9 + 20);
  assert.equal(alpha.more, 7);
  assert.equal(alpha.convos.length, 2);
  assert.ok(alpha.byModel.some((m) => m.model === "claude-sonnet-5"), "folded models merge in");
  const zeta = rows.find((r) => r.repo === "/dev/zeta");
  assert.equal(zeta.label, "zeta");
  assert.equal(zeta.convos.length, 0);
  assert.equal(rows.find((r) => r.repo === "/dev/beta").more, 0);
});

test("cap: weekCut's N is every conversation, and the list says what it hides", () => {
  const d = { ...DOC, convosTotal: 12, rest: [restOf("/dev/alpha", 7, 3)], hours: DOC.hours.map((h, i) => (i === 1 ? { ...h, restConvos: 2 } : h)) };
  const cut = weekCut(d);
  assert.equal(cut.total, 12);
  const h1 = hourKey(T0 + HOUR);
  assert.match(cut.filterText(h1), /^3 of 12 sessions · /);
  assert.equal(cut.buckets[1].restConvos, 2);
  assert.deepEqual(cut.buckets[1].convoIds.slice().sort(), ["aaaaaaaa-1", "bbbbbbbb-2", "cccccccc-3"], "no folded id in an hour");
  assert.equal(cut.restText(h1), "2 more sessions in this hour are not listed");
  assert.equal(cut.restText(hourKey(T0)), null);
  assert.equal(cut.restText(null), "7 cheaper sessions not listed · $3.00");
  assert.equal(weekCut(DOC).restText(null), null, "nothing folded: nothing to say");
  assert.equal(weekCut(DOC).total, 5, "an older host: convos.length");
});

// ── rankRepos ──

test("rankRepos: descending by cost, sessions underneath, models merged", () => {
  const rows = rankRepos(DOC.convos);
  assert.deepEqual(rows.map((r) => r.label), ["alpha", "beta", "gamma", "unknown repo"]);
  const alpha = rows[0];
  assert.equal(alpha.cost.total, 5 + 3 + 9);
  assert.deepEqual(alpha.convos.map((c) => c.id), ["dddddddd-4", "aaaaaaaa-1"]);
  assert.equal(alpha.byModel.length, 1);
  assert.equal(alpha.byModel[0].totals.cacheRead, 150 + 300);
  const g = repoRowAsGroup(alpha);
  assert.equal(g.key, "/dev/alpha");
  assert.equal(g.cacheRead, 450);
  assert.equal(g.cost.total, 17);
  assert.equal(g.byModel, alpha.byModel);
});

// ── ptsCalibration ──

const WR1 = Date.parse("2026-10-08T19:00:00Z");
const WR2 = WR1 + 7 * 24 * HOUR;
const wk = (t, w, wr) => ({ t, s: null, w, sr: null, wr });
/** One hour row per hour in [a, b) at `perHour` dollars. */
const costHours = (a, b, perHour) => {
  const out = [];
  for (let t = a; t < b; t += HOUR) out.push({ hour: hourKey(t), t, totals: tot(1), cost: usd(perHour), byRepo: [], byModel: [] });
  return out;
};

test("ptsCalibration: the good case pools usd and dPts", () => {
  const samples = [wk(T0, 10, WR1), wk(T0 + 4 * HOUR, 14, WR1), wk(T0 + 8 * HOUR, 22, WR1)];
  const cal = ptsCalibration(samples, costHours(T0 - 2 * HOUR, T0 + 12 * HOUR, 21));
  assert.ok(isPtsCal(cal), JSON.stringify(cal));
  assert.equal(cal.usd, 8 * 21, "only the hours in [floor(a), floor(b)) — the partial last hour and the hours outside are left out");
  assert.equal(cal.dPts, 12);
  assert.equal(cal.usdPerPt, 14);
  assert.equal(cal.stretches, 1);
  assert.equal(cal.levelUsdPerPt, null);
});

test("ptsCalibration: a reset inside the span is two stretches and never a negative delta", () => {
  const reset = T0 + 10 * HOUR;
  const samples = [
    wk(T0, 70, WR1), wk(T0 + 8 * HOUR, 80, WR1),           // stretch 1: +10 in 8h
    wk(reset, 0, WR2), wk(reset + 8 * HOUR, 10, WR2),       // stretch 2: +10 in 8h, after the reset
  ];
  const cal = ptsCalibration(samples, costHours(T0, reset + 12 * HOUR, 14));
  assert.ok(isPtsCal(cal), JSON.stringify(cal));
  assert.equal(cal.stretches, 2);
  assert.equal(cal.dPts, 20, "the -80 across the reset is never counted");
  assert.equal(cal.usdPerPt, (16 * 14) / 20);
});

test("ptsCalibration: refusals are reasons, never numbers", () => {
  const hours = costHours(T0, T0 + 30 * HOUR, 10);
  assert.deepEqual(ptsCalibration([], hours), { why: "noSamples" });
  assert.deepEqual(ptsCalibration([wk(T0, 10, WR1)], hours), { why: "noSamples" });
  assert.deepEqual(ptsCalibration([wk(T0, 10, WR1), wk(T0 + 3 * HOUR, 30, WR1)], hours), { why: "shortStretches" }, "a single short stretch");
  assert.deepEqual(ptsCalibration([wk(T0, 10, WR1), wk(T0 + 8 * HOUR, 13, WR1)], hours), { why: "smallDelta" });
  assert.deepEqual(ptsCalibration([wk(T0, 10, WR1), wk(T0 + 8 * HOUR, 17, WR1)], hours), { why: "smallDelta" }, "one stretch alone must climb 10");
  assert.deepEqual(ptsCalibration([wk(T0, 10, WR1), wk(T0 + 8 * HOUR, 25, WR1)], []), { why: "noCost" });
  // Two stretches whose rates disagree past ±35% of the pooled one.
  const reset = T0 + 10 * HOUR;
  const unstable = [wk(T0, 70, WR1), wk(T0 + 8 * HOUR, 90, WR1), wk(reset, 0, WR2), wk(reset + 8 * HOUR, 5, WR2)];
  assert.deepEqual(ptsCalibration(unstable, costHours(T0, reset + 12 * HOUR, 10)), { why: "unstable" });
  // A level calibration that disagrees past ±40%.
  const good = [wk(T0, 10, WR1), wk(T0 + 8 * HOUR, 22, WR1)];
  const hrs = costHours(T0, T0 + 12 * HOUR, 21); // 8 × 21 / 12 = 14 $/pt
  assert.deepEqual(ptsCalibration(good, hrs, 30), { why: "disagreesWithLevel" });
  const agree = ptsCalibration(good, hrs, 15);
  assert.ok(isPtsCal(agree));
  assert.equal(agree.levelUsdPerPt, 15);
  for (const why of ["noSamples", "shortStretches", "smallDelta", "unstable", "disagreesWithLevel", "noCost"]) {
    const s = ptsRefusalText({ why });
    assert.ok(s.length > 20 && s.endsWith("."), `${why}: ${s}`);
    assert.ok(!/\d+ pts/.test(s), "a refusal never prints a points figure");
  }
});

// ── ptsText ──

test("ptsText: two significant figures, '<0.1 pt', singular, absent without a calibration", () => {
  const cal = { usdPerPt: 14, usd: 140, dPts: 10, stretches: 1 };
  assert.equal(ptsText(210, cal), "≈ 15 pts");
  assert.equal(ptsText(14, cal), "≈ 1 pt");
  assert.equal(ptsText(20, cal), "≈ 1.4 pts");
  assert.equal(ptsText(2000, cal), "≈ 140 pts");
  assert.equal(ptsText(0.5, cal), "<0.1 pt");
  assert.equal(ptsText(0, cal), null, "zero is absent, never '0 pts'");
  assert.equal(ptsText(null, cal), null);
  assert.equal(ptsText(100, { why: "unstable" }), null);
  assert.equal(ptsText(100, null), null);
});

// ── agentModelInsight ──

test("agentModelInsight: the dearest agent family over the threshold; null on zero cost", () => {
  const c = { cost: usd(100), agentByModel: [slice("claude-opus-5-20260101", 1, 50), slice("claude-opus-5[1m]", 1, 12), slice("claude-haiku-4-5", 1, 20)] };
  assert.equal(agentModelInsight(c), "Opus subagents: 62% of this session's cost");
  assert.equal(agentModelInsight({ cost: usd(100), agentByModel: [slice("claude-sonnet-5", 1, AGENT_MODEL_MIN_PCT - 1)] }), null);
  assert.equal(agentModelInsight({ cost: usd(100), agentByModel: [slice("claude-sonnet-5", 1, AGENT_MODEL_MIN_PCT)] }), "Sonnet subagents: 15% of this session's cost");
  assert.equal(agentModelInsight({ cost: usd(0), agentByModel: [slice("claude-opus-5", 1, 0)] }), null);
  assert.equal(agentModelInsight({ cost: usd(10) }), null, "an older host: no slices, no sentence");
  assert.equal(agentModelInsight({ cost: usd(10), agentByModel: [slice("claude-opus-5", 1, 30)] }), null, "slices past the total are inconsistent: absent");
});

// ── fan-out hint ──

const run = (id, text, startedAt, finishedAt) => ({ id, text, startedAt, finishedAt, targets: [] });

test("pickSimilarRun: same text first, then the most recent finished run, never a running one", () => {
  const runs = [
    run("old-same", "Senior  architect\nreview", 1, 2),
    run("new-other", "bump deps", 10, 11),
    run("running-same", "senior architect review", 20, undefined),
  ];
  assert.equal(pickSimilarRun(runs, "senior architect review").id, "old-same");
  assert.equal(pickSimilarRun(runs, "something new").id, "new-other");
  assert.equal(pickSimilarRun([run("r", "x", 1, undefined)], "x"), null);
  assert.equal(pickSimilarRun([], "x"), null);
  assert.equal(fanoutTextKey("  Senior  architect\nREVIEW "), "senior architect review");
});

test("fanoutHintText: the week clause is omitted on null, never '0%'", () => {
  assert.equal(fanoutHintText({ same: true, usd: 218, weekPct: 15.4, agentPct: 66.2, repos: 36 }),
    "last similar run (36 repos): $218.00 ≈ 15% of week, 66% subagents");
  assert.equal(fanoutHintText({ same: false, usd: 218, weekPct: null, agentPct: 66, repos: 36 }),
    "last run (different prompt, 36 repos): $218.00, 66% subagents");
  assert.ok(!/% of week/.test(fanoutHintText({ same: true, usd: 0, weekPct: 0, agentPct: 0, repos: 1 })));
  assert.match(fanoutHintText({ same: true, usd: 5, weekPct: 0.35, agentPct: 0, repos: 1 }), /≈ 0\.3% of week|≈ 0\.4% of week/);
});
