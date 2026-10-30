/**
 * What a pile of token counts means — the derived figures and their wording.
 *
 * The shape of the real data these run against, measured on one machine: 13.6
 * billion tokens, 96% of them cache reads, fresh input at 0.007%, spread over
 * 76 active days. Almost every case below is a default that looks right and
 * breaks on numbers like that — a headline rounded to the nearest billion, a
 * share that prints "0%" for 21 million tokens, an "Other" bucket that replaces
 * one named row with an anonymous one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_KINDS,
  addTotals,
  cacheHitPct,
  cacheReading,
  cumulative,
  dayToMs,
  fmtCount,
  fmtExact,
  fmtShare,
  perTurn,
  tokenTotal,
  topGroups,
  zeroTotals,
} from "../dist/tokens.js";

const T = (input, output, cacheRead, cacheWrite, turns = 1, cacheWrite1h = 0) =>
  ({ input, output, cacheRead, cacheWrite, cacheWrite1h, turns });
/** The real machine's totals, rounded. */
const REAL = T(979_000, 30_000_000, 13_000_000_000, 459_000_000, 68_785);

test("a total is all four kinds, and nothing else", () => {
  assert.equal(tokenTotal(T(1, 2, 3, 4)), 10);
  assert.equal(tokenTotal(zeroTotals()), 0);
});

test("adding folds every field including the turn count", () => {
  const a = zeroTotals();
  addTotals(a, T(1, 2, 3, 4, 5));
  addTotals(a, T(10, 20, 30, 40, 50));
  assert.deepEqual(a, T(11, 22, 33, 44, 55));
  // The 1-hour subset folds too — it is what the 2x cache tier is priced on,
  // and a fold that dropped it would silently cheapen every total.
  const b = zeroTotals();
  addTotals(b, T(0, 0, 0, 100, 1, 80));
  addTotals(b, T(0, 0, 0, 50, 1, 10));
  assert.equal(b.cacheWrite, 150);
  assert.equal(b.cacheWrite1h, 90);
  // A partial patch must not produce NaN — the host folds tallies field by field.
  addTotals(a, { output: 1 });
  assert.equal(a.input, 11);
  assert.equal(a.output, 23);
});

test("cacheWrite1h is a SUBSET and is never added into the total", () => {
  // It is not a fifth kind. Adding it would double-count 84% of the cache
  // writes and inflate the headline by the same amount.
  assert.equal(tokenTotal(T(1, 2, 3, 4, 1, 4)), 10);
  assert.equal(tokenTotal(T(1, 2, 3, 4, 1, 0)), 10);
});

test("the four kinds have a FIXED order and distinct slots", () => {
  // The order IS the colour assignment: a hue follows the entity, never its
  // rank, so a re-sort must not repaint the survivors.
  assert.deepEqual(TOKEN_KINDS.map((k) => k.id), ["input", "output", "cacheRead", "cacheWrite"]);
  assert.deepEqual(TOKEN_KINDS.map((k) => k.slot), [0, 1, 2, 3]);
  // Every kind carries its own sentence, so no screen has to invent one.
  assert.ok(TOKEN_KINDS.every((k) => k.name && k.what && k.what.length > 30));
});

test("the cache ratio is over what went IN, not over everything", () => {
  // Output in the denominator would make the ratio drift with how talkative
  // the model was rather than with how well the cache worked.
  const hit = cacheHitPct(REAL);
  assert.ok(hit > 96 && hit < 97, `measured ${hit}`);
  // Doubling the OUTPUT must not move it.
  assert.equal(cacheHitPct({ ...REAL, output: REAL.output * 2 }), hit);
  assert.equal(cacheHitPct(zeroTotals()), null);
});

test("per-turn is null with no turns, never a division by zero", () => {
  assert.equal(perTurn(zeroTotals()), null);
  assert.equal(perTurn(T(0, 0, 100, 0, 4)), 25);
});

// ── is that share GOOD, or is it context pollution? ───────────────────────

test("a high cache share is the CHEAP shape, and the verdict says so", () => {
  // The real machine: 96% cache reads, each written token read back ~28×. The
  // one thing this must never do is read a big share as a symptom — a cache
  // read bills at a tenth of the input rate, and the only way to shrink the
  // share is to re-send the same context at full price.
  const r = cacheReading(REAL);
  assert.ok(r.reuse > 25, `measured ${r.reuse}`);
  assert.ok(r.payback > 1.3 && r.payback < 1.4, `5-minute writes pay back at ~1.39, got ${r.payback}`);
  assert.match(r.cacheNote, /cheap shape/i);
  assert.doesNotMatch(r.cacheNote, /only .*×/i);
});

test("the payback is derived from the tier mix, never a constant", () => {
  // 84% of the writes here are the 2x 1-hour tier, so a write has to earn back
  // more than the 1.39 reads a 5-minute one does.
  const all1h = cacheReading(T(0, 0, 1000, 100, 10, 100));
  const all5m = cacheReading(T(0, 0, 1000, 100, 10, 0));
  assert.ok(Math.abs(all1h.payback - 2 / 0.9) < 1e-9);
  assert.ok(Math.abs(all5m.payback - 1.25 / 0.9) < 1e-9);
  assert.ok(all1h.payback > all5m.payback);
});

test("writes that are never read back are named, and are NOT a big context", () => {
  // One read per written token: the caching is losing against simply sending
  // the tokens fresh. That is sessions dying before their prefix is re-read —
  // a different failure from a bloated window, and it must not be worded as one.
  const thin = cacheReading(T(1000, 500, 1000, 1000, 40));
  assert.ok(thin.reuse < thin.payback);
  assert.match(thin.cacheNote, /read back only/);
  assert.match(thin.cacheNote, /not a context that is too big/);
  assert.match(thin.advice, /ends sessions/);
});

test("the pollution number is context PER TURN, not the share", () => {
  // Same 96% share, two very different corpora: the verdict has to move with
  // the size of a turn and not with the share.
  const lean = cacheReading(T(0, 0, 960_000, 40_000, 40));   // 25k a turn
  const heavy = cacheReading(T(0, 0, 960_000_000, 40_000_000, 4_000)); // 250k a turn
  assert.equal(Math.round(lean.sharePct), Math.round(heavy.sharePct));
  assert.equal(lean.posture, "lean");
  assert.equal(heavy.posture, "heavy");
  assert.match(heavy.contextNote, /250k/);
  assert.match(heavy.advice, /new session/);
  // A lean mean is not a promise that there are no monsters — the measured
  // distribution was 1.4% of conversations holding 76% of the tokens.
  assert.match(lean.contextNote, /not the norm here/);
  assert.equal(heavy.posture !== "ordinary" && lean.posture !== "ordinary", true);
  // Whatever the posture, the sentence says it is a MEAN — the distribution it
  // comes out of is the most skewed measurement in this repo, and a reader who
  // takes 190k for "my turns are 190k" has read a ceiling off an average.
  for (const r of [lean, heavy, cacheReading(T(0, 0, 190_000 * 40, 0, 40))]) {
    assert.match(r.contextNote, /mean is not a ceiling/);
  }
  assert.equal(lean.advice, null);
});

test("no turns counted ⇒ no per-turn claim, and nothing sent in ⇒ no verdict", () => {
  const noTurns = cacheReading(T(0, 0, 1000, 100, 0));
  assert.equal(noTurns.perTurnCtx, null);
  assert.equal(noTurns.posture, null);
  assert.equal(noTurns.contextNote, null);
  assert.ok(noTurns.cacheNote.length > 0, "the share is still sayable");
  assert.equal(cacheReading(zeroTotals()), null);
  // Nothing written at all: a reuse ratio would be a division by zero with a
  // face on it, and the share sentence stands without one.
  const noWrites = cacheReading(T(100, 0, 900, 0, 2));
  assert.equal(noWrites.reuse, null);
  assert.equal(noWrites.payback, null);
  assert.match(noWrites.cacheNote, /tenth of the input rate/);
});

test("the reading produces sentences and never a gate", () => {
  // Same rule as sessionCost: no caller is handed a boolean it could act on.
  const r = cacheReading(REAL);
  assert.ok(!("blocked" in r) && !("ok" in r));
});

// ── the headline number ───────────────────────────────────────────────────

test("the hero keeps three significant figures", () => {
  // At 0 decimals a 13.62-billion total renders "14B", and rounding away 380
  // million tokens in the one number the screen exists to show is not a
  // formatting choice.
  assert.equal(fmtCount(13_621_060_941), "13.6B");
  assert.equal(fmtCount(3_500_000_000), "3.5B");
  assert.equal(fmtCount(459_000_000), "459M");
  assert.equal(fmtCount(29_750_000), "29.8M");
  assert.equal(fmtCount(979_000), "979k");
  assert.equal(fmtCount(68_785), "68.8k");
  assert.equal(fmtCount(840), "840");
  assert.equal(fmtCount(0), "0");
  assert.equal(fmtCount(NaN), "?");
});

test("the exact number is available in full, grouped", () => {
  assert.equal(fmtExact(13_621_060_941).replace(/[^0-9]/g, ""), "13621060941");
});

test("a share says <1% rather than 0% for something that happened", () => {
  // 21.3M against a 13.6B total rounds to 0%, which reads as "did not happen"
  // next to a bar that is visibly there.
  assert.equal(fmtShare(21_300_000 / 13_600_000_000), "<1%");
  assert.equal(fmtShare(0), "0%");
  assert.equal(fmtShare(0.27), "27%");
  assert.equal(fmtShare(1), "100%");
  // 99.8% rounds to 100, which reads as "and nothing else" beside a list that
  // visibly has more rows in it — the `<1%` rule, at the other end.
  assert.equal(fmtShare(0.998), ">99%");
  assert.equal(fmtShare(0.994), "99%");
});

// ── grouping ──────────────────────────────────────────────────────────────

const g = (key, total) => ({ key, label: key, ...T(0, 0, total, 0, 1), cost: { input: 0, output: 0, cacheRead: total / 1e7, cacheWrite: 0, total: total / 1e7 } });

test("topGroups sorts, folds the tail, and NAMES what it folded", () => {
  const rows = topGroups([g("a", 10), g("e", 1), g("b", 8), g("c", 5), g("d", 2)], 2, "repos");
  assert.deepEqual(rows.map((r) => r.label), ["a", "b", "Other (3 repos)"]);
  assert.equal(tokenTotal(rows[2]), 8);
  assert.equal(rows[2].turns, 3, "the fold carries every field, not just the total");
  assert.ok(Math.abs(rows[2].cost.total - 8 / 1e7) < 1e-12, "…including the money");
});

test("a tail of ONE is not folded — that loses a name and gains nothing", () => {
  const rows = topGroups([g("a", 10), g("b", 8), g("c", 5)], 2, "models");
  assert.deepEqual(rows.map((r) => r.label), ["a", "b", "c"]);
});

test("a folded tail of one is worded in the singular", () => {
  // Reachable only through the cap, not through the tail length — but "Other
  // (1 models)" shipped once and is exactly the kind of thing nobody re-reads.
  const rows = topGroups([g("a", 9), g("b", 8), g("c", 7), g("d", 1)], 2, "models");
  assert.equal(rows[2].label, "Other (2 models)");
  assert.equal(topGroups([g("a", 9), g("b", 8), g("c", 7)], 1, "models")[1].label, "Other (2 models)");
});

test("grouping an empty list is an empty list", () => {
  assert.deepEqual(topGroups([], 5), []);
});

// ── the cumulative series ─────────────────────────────────────────────────

test("cumulative only rises, keeps the day, and ends at the sum", () => {
  const run = cumulative([
    { day: "2026-05-01", total: 10 },
    { day: "2026-05-02", total: 0 },
    { day: "2026-05-09", total: 5 },
  ]);
  assert.deepEqual(run.map((r) => r.sum), [10, 10, 15]);
  assert.deepEqual(run.map((r) => r.day), ["2026-05-01", "2026-05-02", "2026-05-09"]);
  assert.deepEqual(cumulative([]), []);
});

test("a day key round-trips through LOCAL midnight", () => {
  // The host bucketed in its local zone, so reading it back in UTC would slide
  // every column by up to a day.
  const ms = dayToMs("2026-09-06");
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 6);
  assert.equal(d.getHours(), 0);
});

// ── whose tokens are being read ──────────────────────────────────────────

test("a session's reading does not send the reader to the screen they are on", () => {
  // The corpus wording's escape hatch — go and read the per-session figure —
  // is the context sheet itself, so on that screen it would be a sentence
  // pointing at its own page. Same arithmetic, two sentences reworded.
  const corpus = cacheReading(REAL);
  const session = cacheReading(REAL, "session");
  assert.equal(session.sharePct, corpus.sharePct);
  assert.equal(session.reuse, corpus.reuse);
  assert.equal(session.perTurnCtx, corpus.perTurnCtx);
  assert.equal(session.posture, corpus.posture);
  assert.equal(session.cacheNote, corpus.cacheNote);
  assert.match(corpus.contextNote, /per-session reading on the context screen/);
  assert.doesNotMatch(session.contextNote, /context screen/);
  assert.match(session.contextNote, /mean is not a ceiling/);
});

test("a session offers no advice — the cost panel above it has the button", () => {
  // Two paragraphs saying "start a new session", one of them with nowhere to
  // tap, is the shape this screen already refuses elsewhere.
  for (const t of [T(1000, 500, 1000, 1000, 40), T(0, 0, 960_000_000, 40_000_000, 4_000)]) {
    assert.ok(cacheReading(t).advice, "the corpus still advises");
    assert.equal(cacheReading(t, "session").advice, null);
  }
});

test("one conversation is not told what its own norm is", () => {
  const lean = cacheReading(T(0, 0, 960_000, 40_000, 40), "session");
  assert.doesNotMatch(lean.contextNote, /not the norm here/);
  assert.match(lean.contextNote, /well under/);
});

import { fmtNative as _fmtNative, besideFigure as _besideFigure } from "../dist/index.js";

test("fmtNative: integers via fmtCount, else one decimal (pinned through its call sites)", () => {
  assert.equal(_fmtNative(12), "12");
  assert.equal(_fmtNative(1500), "1.5k");
  assert.equal(_fmtNative(12.54), "12.5");
  assert.equal(_fmtNative(0.4), "0.4");
  assert.equal(_besideFigure({ kinds: {}, unit: { name: "AI credits", amount: 3.26 } }), "3.3 AI credits");
});

test("fmtNative: a positive amount never prints as 0; zero and negatives unchanged", () => {
  assert.equal(_fmtNative(0.02), "<0.1");
  assert.equal(_fmtNative(0.049), "<0.1");
  assert.equal(_fmtNative(0.05), "0.1");
  assert.equal(_fmtNative(0), "0");
  assert.equal(_fmtNative(-0.02), "0");
  assert.equal(_fmtNative(-3.26), "-3.3");
  assert.equal(_besideFigure({ kinds: {}, unit: { name: "AI credits", amount: 0.02 } }), "<0.1 AI credits");
});
