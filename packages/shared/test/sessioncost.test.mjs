/**
 * What a session is allowed to SAY about its own cost.
 *
 * The numbers here are the ones measured on this desktop before the readout
 * existed: a fresh session in the repo carried ~71k per turn, the long-running
 * ones sat at 300-400k, and the handful that dominated a fortnight's usage ran
 * past 700k. Every threshold below is checked against those, because a chip
 * that lights on a session nobody would call expensive is a chip people learn
 * to ignore — and this one has exactly one job, which is to be believed.
 *
 * The rule it must never break: this is a reminder, so it may understate and it
 * may say nothing, but it may not claim a session is cheap when it is not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_LARGE_TOK,
  AGENT_LIVE_MS,
  liveAgentText,
  agentPushText,
  replanPromptText,
  MIN_TURNS,
  agentAdvice,
  compactionCostText,
  compactionCountText,
  compactionMethodText,
  compactionPendingText,
  compactionRatioText,
  compactionReading,
  compactionRowFacts,
  compactionRowLabel,
  compactionSavedText,
  compactionUnmeasuredText,
  compactionWindowText,
  MULT_HEAVY,
  MULT_STEEP,
  MULT_WARM,
  breakEvenTurns,
  cacheLikelyCold,
  coldStartChip,
  coldStartText,
  isColdRebuild,
  CACHE_TTL_MS,
  CACHE_COLD_AFTER_MS,
  fmtMultiple,
  sessionCost,
  sessionCostOf,
  costChip,
  turnCostParts,
  turnTokensText,
  nextTurnText,
  weekShareText,
  weekUsdPerPct,
  WEEK_CAL_MIN_PCT,
  costDoorsText,
  costText,
  usageChip,
  usageText,
} from "../dist/sessioncost.js";

const BASE = 71_000;

const at = (tok, over = {}) => sessionCost({ tok, baseTok: BASE, turns: 50, spentTok: null, ...over });

test("a fresh session says nothing", () => {
  const r = at(BASE);
  assert.equal(r.level, "fresh");
  assert.equal(r.chip, null);
  assert.equal(r.advice, null);
});

test("the measured session sizes land on the levels they were chosen for", () => {
  assert.equal(at(BASE * 1.5).level, "fresh");   // still warming up
  assert.equal(at(180_000).level, "warm");       // 2.5x
  assert.equal(at(360_000).level, "heavy");      // 5x
  assert.equal(at(700_000).level, "steep");      // ~10x, the monsters
});

test("thresholds are inclusive at their own boundary", () => {
  assert.equal(at(BASE * MULT_WARM).level, "warm");
  assert.equal(at(BASE * MULT_HEAVY).level, "heavy");
  assert.equal(at(BASE * MULT_STEEP).level, "steep");
});

test("the first turns of any session are not a verdict on it", () => {
  // A session reading the files it was pointed at climbs steeply off its own
  // baseline. That IS the fresh session, so it may not be labelled expensive.
  assert.equal(at(400_000, { turns: MIN_TURNS - 1 }).level, "fresh");
  assert.equal(at(400_000, { turns: MIN_TURNS }).level, "heavy");
});

test("no baseline means no claim, never a guessed one", () => {
  const r = at(500_000, { baseTok: null });
  assert.equal(r.level, "fresh");
  assert.equal(r.multiple, null);
  assert.equal(r.breakEven, null);
  assert.equal(r.chip, null);
  // It says WHY it cannot answer rather than pretending the session is cheap.
  assert.match(r.note, /not known/);
  assert.match(r.note, /longer than the host reads/);
});

test("break-even is the turn count the cache multipliers imply", () => {
  // n = base(W - R) / (R (tok - base)), W = 2.0, R = 0.1.
  //
  // W is the ONE-HOUR write tier, which is what the fresh session would
  // actually pay: 8,160 of 8,160 main-conversation cache writes in this
  // desktop's logs are 1-hour, and the 5-minute tier appears only in subagent
  // logs. Read at 1.25 these were 8 / 3 / 2 / 1 — about 65% low, the one
  // number in this module that was wrong rather than absent.
  assert.equal(breakEvenTurns(BASE * 2.5, BASE), 13);
  assert.equal(breakEvenTurns(BASE * 5, BASE), 5);
  assert.equal(breakEvenTurns(BASE * 9, BASE), 3);
  assert.equal(breakEvenTurns(BASE * 13, BASE), 2);
});

test("a caller that measured its own write tier may say so", () => {
  // The old 5-minute answers are still reachable, which is what makes the
  // default a measurement rather than a constant nobody can argue with.
  assert.equal(breakEvenTurns(BASE * 2.5, BASE, 1.25), 8);
  assert.equal(breakEvenTurns(BASE * 5, BASE, 1.25), 3);
});

test("break-even refuses the cases where it would be meaningless", () => {
  assert.equal(breakEvenTurns(BASE, BASE), null);        // no gap to amortise
  assert.equal(breakEvenTurns(BASE - 1, BASE), null);    // below its own baseline
  assert.equal(breakEvenTurns(100_000, null), null);     // no baseline
  assert.equal(breakEvenTurns(100_000, 0), null);        // no baseline
  assert.equal(breakEvenTurns(BASE * 1.2, BASE), null);  // ~58 turns away: noise
});

test("a quick question is never talked out of the WARM session", () => {
  // The write premium is real: one turn in a 10x session still beats paying to
  // re-write a baseline. Whatever else the advice says, it says this.
  for (const tok of [180_000, 360_000, 700_000]) {
    assert.match(at(tok).advice, /quick question is still cheaper here/);
  }
});

// ── What a COLD cache is allowed to change ───────────────────────────────────
//
// The rule at the top of this file, applied to the one case where the module
// used to break it: "a quick question is still cheaper here" is advice about a
// window that can be re-READ. On a window nobody has touched for hours it has
// to be re-WRITTEN first, at up to twenty times the rate, and the sentence is
// then wrong by an order of magnitude in the one direction this file forbids.

test("the cold sentence replaces the quick-question advice, and only it", () => {
  for (const tok of [180_000, 360_000, 700_000]) {
    const warm = at(tok);
    const cold = at(tok, { cacheCold: true });
    assert.match(warm.advice, /quick question is still cheaper here/);
    assert.doesNotMatch(cold.advice, /quick question is still cheaper here/);
    assert.match(cold.advice, /no cheap turn left here/);
    // The multiple is unchanged: a cold resume re-writes the fresh session's
    // baseline too, so the RATIO cancels. Only the first turn's price moves.
    assert.equal(cold.multiple, warm.multiple);
    assert.equal(cold.level, warm.level);
    assert.equal(cold.breakEven, warm.breakEven);
  }
});

test("a cold window is named as a likelihood, with no clock and no money", () => {
  const r = at(400_000, { cacheCold: true });
  assert.match(r.note, /very likely expired/);
  assert.match(r.note, /re-WRITES/);
  // No countdown and no figure: the hour is a cliff 33% wide at its edge, and
  // the share of a cold resume still served from cache runs 3% to 30%. Both
  // are numbers that would be plausible and wrong.
  assert.doesNotMatch(r.note + r.advice, /\$|minutes?\b|\d+\s*(min|h)\b/);
});

test("only TRUE changes anything — false and unknown read as they always did", () => {
  const plain = at(400_000);
  for (const cacheCold of [false, null, undefined]) {
    const r = at(400_000, { cacheCold });
    assert.equal(r.note, plain.note);
    assert.equal(r.advice, plain.advice);
  }
});

test("a cold session that carries no more than a fresh one says nothing extra", () => {
  // At `fresh` WITH a baseline the re-write is the price of starting anywhere,
  // so warning about it would light up every idle session on the list. The
  // truncated-log case is the opposite — only the longest conversations
  // truncate — and keeps the warning.
  const small = at(BASE, { cacheCold: true });
  assert.doesNotMatch(small.note, /very likely expired/);
  assert.equal(small.advice, null);
  const huge = at(900_000, { baseTok: null, cacheCold: true });
  assert.match(huge.note, /very likely expired/);
  assert.match(huge.advice, /paid for again/);
});

test("cold is claimed only past the TTL plus a margin, and never mid-turn", () => {
  const now = 1_700_000_000_000;
  const ago = (ms) => now - ms;
  assert.equal(cacheLikelyCold(ago(30 * 60_000), now), false);
  // The hour itself is not enough: the log stamps a turn when GENERATION
  // ENDED (p99 49 s later, worst 9 min), and a 66-minute gap that came back
  // warm is in this desktop's own logs. Half an hour of margin puts the claim
  // in the 96%-cold band.
  assert.equal(cacheLikelyCold(ago(CACHE_TTL_MS + 60_000), now), false);
  assert.equal(cacheLikelyCold(ago(75 * 60_000), now), false);
  assert.equal(cacheLikelyCold(ago(CACHE_COLD_AFTER_MS), now), true);
  assert.equal(cacheLikelyCold(ago(6 * 60 * 60_000), now), true);
  // A running turn refreshes the entry continuously, and nothing recorded is
  // nothing claimed.
  assert.equal(cacheLikelyCold(ago(6 * 60 * 60_000), now, true), null);
  assert.equal(cacheLikelyCold(null, now), null);
  assert.equal(cacheLikelyCold(undefined, now), null);
  assert.equal(cacheLikelyCold(0, now), null);
});

// ── The doors the advice is talking about ───────────────────────────────────
//
// `advice` argues the work would be cheaper somewhere else and the context
// sheet draws two buttons under it. They are different offers, so the sentence
// has to name both — and it may only name `/compact` where `/compact` is a
// thing this backend takes.

test("the doors sentence names both, and what each one keeps", () => {
  const d = costDoorsText(true);
  assert.match(d, /Compacting/);
  assert.match(d, /keeps this conversation/);
  assert.match(d, /new session keeps nothing/);
});

test("a backend with no slash commands is offered no compacting clause", () => {
  // Never a sentence about a control that is not on the screen: the `/compact`
  // button is withheld there (the `headerCmds.ts` bug), so the clause goes too.
  assert.equal(costDoorsText(false), null);
});

test("the doors sentence prices nothing", () => {
  // Same rule as the rest of this file: what a compaction actually returned is
  // the ledger's measured figure, not a promise made before one has run.
  assert.doesNotMatch(costDoorsText(true), /\$|\d/);
});

test("nothing here can refuse anything", () => {
  const r = at(900_000, { spentTok: 210_000_000 });
  assert.equal(typeof r.note, "string");
  assert.equal(typeof r.advice, "string");
  // No boolean a caller could mistake for a gate.
  for (const v of Object.values(r)) assert.notEqual(typeof v, "boolean");
});

test("the sentences quote the facts they rest on", () => {
  const r = at(360_000, { spentTok: 210_000_000 });
  assert.match(r.note, /360k/);          // what a turn costs now
  assert.match(r.note, /5\.1×|5\.0×/);   // against the baseline
  assert.match(r.note, /71k/);           // the baseline itself, named
  assert.match(r.note, /210M tokens/);   // what it has spent
  assert.match(r.advice, /5 turns/);      // at the measured 1-hour write tier
});

test("a compaction makes the next turn cheap again", () => {
  // The reading is the LAST sample, not the peak: a conversation that compacted
  // is genuinely back near its baseline and must stop being flagged.
  const spark = { pts: [70_000, 400_000, 600_000, 90_000], baseTok: BASE, turns: 40, spentTok: 5_000_000 };
  assert.equal(sessionCostOf(spark).level, "fresh");
});

test("sessionCostOf reads the spark and refuses an empty one", () => {
  assert.equal(sessionCostOf(null), null);
  assert.equal(sessionCostOf({ pts: [] }), null);
  assert.equal(sessionCostOf({ pts: [0] }), null);
  const r = sessionCostOf({ pts: [70_000, 355_000], baseTok: BASE, turns: 50 });
  assert.equal(r.level, "heavy");
  assert.equal(r.tok, 355_000);
});

test("the multiple is formatted at the precision it deserves", () => {
  assert.equal(fmtMultiple(2.54), "2.5×");
  assert.equal(fmtMultiple(4.96), "5.0×");
  assert.equal(fmtMultiple(12.4), "12×");
});

// ── What the session has USED ─────────────────────────────────────────────
//
// A different fact from the volume the curve integrates to: that one is the
// input side of this conversation, and this one adds what each turn wrote and
// everything its subagents spent. A session can carry 30k and have cost
// millions, and until this existed nothing on any screen could say so.

test("the total, where the host measured one, replaces the carried volume", () => {
  const r = at(360_000, { spentTok: 210_000_000, usageTok: 240_000_000, agentTok: 30_000_000 });
  assert.match(r.note, /used 240M tokens so far/);
  assert.match(r.note, /30M of it in subagents/);
  // One number twice is one number too many: the carried volume is inside the
  // total, so it is not also printed.
  assert.equal(/210M/.test(r.note), false);
});

test("when the agents are most of the bill, the advice says compacting does not reach them", () => {
  // Measured: 786M of 817M in agents, and the panel offered only /compact.
  const r = at(360_000, { usageTok: 817_000_000, agentTok: 786_000_000 });
  assert.match(r.advice, /786M of 817M/);
  assert.match(r.advice, /narrower task/);
  // Under half, the parent's window is the bigger lever and nothing is added.
  assert.equal(agentAdvice(240_000_000, 30_000_000), null);
  assert.equal(agentAdvice(null, 5), null);
  // Said even where the parent is at `fresh` and would otherwise say nothing.
  assert.match(at(70_000, { usageTok: 100_000_000, agentTok: 90_000_000 }).advice ?? "", /subagents/);
});

test("no subagents ⇒ no clause about them", () => {
  const r = at(360_000, { usageTok: 1_400_000, agentTok: 0 });
  assert.match(r.note, /used 1\.4M tokens so far\./);
  assert.equal(/subagent/.test(r.note), false);
});

test("an unmeasured total leaves the old sentence exactly as it was", () => {
  // An older host sends no such field. The reading falls back to the volume it
  // has always quoted rather than inventing a total out of it.
  const r = at(360_000, { spentTok: 210_000_000 });
  assert.match(r.note, /carried 210M tokens in total/);
  assert.equal(r.usageTok, null);
  assert.equal(r.agentTok, null);
});

test("usageChip is absent rather than zero, and reads the spark", () => {
  assert.equal(usageChip(null), null);
  assert.equal(usageChip(undefined), null);
  assert.equal(usageChip(0), null);
  assert.equal(usageChip(1_440_000), "1.4M");
  const r = sessionCostOf({ pts: [70_000, 355_000], baseTok: BASE, turns: 50, usageTok: 4_000_000, agentTok: 2_500_000 });
  assert.equal(r.usageTok, 4_000_000);
  assert.equal(r.agentTok, 2_500_000);
});

test("costChip is absent rather than $0 — the row falls back to tokens", () => {
  // The chip on a launcher row is money now. Every "no figure" case has to come
  // back null so the caller can fall through to the token total: a `$0` beside
  // a session that visibly ran reads as "this was free", which is the one thing
  // a cost readout must never say.
  assert.equal(costChip(null), null);
  assert.equal(costChip(undefined), null);
  assert.equal(costChip(0), null);
  assert.equal(costChip(NaN), null);
  assert.equal(costChip(4.207), "$4.21");
  assert.equal(costChip(0.004), "<$0.01", "a real amount under a cent is not nothing");
  assert.equal(costChip(1234), "$1.2k");
});

test("a dollar figure never appears without the sentence that says it is not a bill", () => {
  // `costText` is the one wording, and the framing is the point: this app drives
  // a CLI that is usually on a subscription, which is a flat fee. A figure with
  // no framing is read as an invoice.
  const t = costText(4.21, 2.5, 0);
  assert.match(t, /\$4\.21 so far/);
  assert.match(t, /\$2\.50 of it in subagents/);
  assert.match(t, /not what a subscription costs/);
  assert.match(t, /list prices/);
  // No agents ⇒ no clause about them; "$0 of it in subagents" is a sentence
  // about nothing.
  assert.doesNotMatch(costText(4.21, 0, 0), /subagents/);
  assert.doesNotMatch(costText(4.21, null, null), /subagents/);
  // Tokens nothing could price are NAMED, never charged at zero in silence.
  assert.match(costText(4.21, null, 900_000), /900k tokens ran on a model with no published rate/);
  assert.doesNotMatch(costText(4.21, null, 0), /no published rate/);
});

test("the total is worded the same way wherever it is printed", () => {
  // `usageText` is the one wording: the row's title, the session header, the
  // sheet's panel and the toast all say this sentence, so a reword happens here
  // or it happens nowhere.
  assert.equal(usageText(1_440_000, 900_000), "This session has used 1.4M tokens so far — 900k of it in subagents.");
  assert.equal(usageText(1_440_000, null), "This session has used 1.4M tokens so far.");
});

test("even a FRESH session says what it has used", () => {
  // The chip is absent below `MIN_TURNS` and the multiple means nothing there,
  // but a session that has already spent millions in agents has still spent
  // them — that sentence does not wait for a threshold.
  const r = at(BASE, { turns: 2, usageTok: 3_000_000, agentTok: 2_000_000 });
  assert.equal(r.level, "fresh");
  assert.match(r.note, /used 3\.0M tokens so far/);
});

// ── The compaction ledger's sentences ─────────────────────────────────────

/** A ledger row, with the money fields absent unless asked for. */
const row = (o = {}) => ({ count: 0, shedTok: 0, savedTok: 0, rebuildTok: 0, ...o });
const ledger = (auto = {}, manual = {}, unmeasured = 0) =>
  ({ auto: row(auto), manual: row(manual), unmeasured });

test("the two triggers fold, and a zero folds to ABSENT money", () => {
  const r = compactionReading(ledger(
    { count: 2, shedTok: 300_000, savedTok: 1_000_000, savedUsd: 0.5, rebuildTok: 40_000, rebuildUsd: 0.4 },
    { count: 1, shedTok: 180_000, savedTok: 540_000, savedUsd: 0.27, rebuildTok: 20_000, rebuildUsd: 0.2 },
  ));
  assert.equal(r.count, 3);
  assert.equal(r.manual, 1);
  assert.equal(r.shedTok, 480_000);
  assert.equal(r.savedTok, 1_540_000);
  assert.ok(Math.abs(r.savedUsd - 0.77) < 1e-9);
  // Nothing priced anywhere ⇒ null, never 0. A `$0` saving reads as a verdict
  // on compacting; an absent one reads as what it is.
  assert.equal(compactionReading(ledger({ count: 1, savedTok: 9 })).savedUsd, null);
  assert.equal(compactionReading(ledger({ count: 1, savedTok: 9 })).rebuildUsd, null);
});

test("who compacted is said, and the singular is not 'all of them yours'", () => {
  const one = (o) => compactionCountText(compactionReading(ledger({}, { count: 1, ...o })));
  assert.match(one({}), /^One compaction, and you asked for it\./);
  assert.match(
    compactionCountText(compactionReading(ledger({ count: 1, shedTok: 1 }))),
    /^One compaction, the CLI's own\./,
  );
  assert.match(
    compactionCountText(compactionReading(ledger({ count: 4 }, { count: 2 }))),
    /^6 compactions — 2 you asked for, 4 the CLI's own\./,
  );
  assert.match(
    compactionCountText(compactionReading(ledger({ count: 3 }))),
    /^3 compactions, none of them yours\./,
  );
  // The shed rides on the same line, and only where there is one.
  assert.match(one({ shedTok: 180_000 }), /It took 180k out of the window/);
  assert.doesNotMatch(one({}), /out of the window/);
  // Nothing has compacted ⇒ no sentence at all, so no panel is drawn.
  assert.equal(compactionCountText(compactionReading(ledger())), null);
});

test("a boundary the log could not describe is never called 'the CLI's own'", () => {
  // The one wrong number this sentence can produce: `count + unmeasured` and
  // then "the rest were automatic" attributes a trigger nobody recorded. It
  // gets its own sentence, outside the figures, exactly as unpriced tokens do.
  const r = compactionReading(ledger({}, { count: 1 }, 1));
  assert.match(compactionCountText(r), /^One compaction, and you asked for it\./);
  assert.doesNotMatch(compactionCountText(r), /CLI's own/);
  assert.match(compactionUnmeasuredText(r), /^One more compaction is in none of these figures/);
  assert.match(
    compactionUnmeasuredText(compactionReading(ledger({}, { count: 1 }, 3))),
    /^3 more compactions are in none of these figures/,
  );
  assert.equal(compactionUnmeasuredText(compactionReading(ledger({}, { count: 1 }))), null);
});

test("a row never wears a zero — 'saved 0' is the token spelling of $0", () => {
  // A compaction with no turn after it has saved nothing YET, which is not the
  // same claim as "compacting saved nothing", and a 0 makes them one row.
  assert.deepEqual(compactionRowFacts(row({ count: 1, shedTok: 180_000 })), ["nothing back yet"]);
  assert.deepEqual(
    compactionRowFacts(row({ count: 1, savedTok: 540_000, savedUsd: 0.27, rebuildTok: 58_000, rebuildUsd: 0.58 })),
    ["saved 540k · $0.27", "cost 58k · $0.58"],
  );
  // One side measured and the other not: the missing side is dropped, never
  // drawn as a zero beside a real number.
  assert.deepEqual(compactionRowFacts(row({ count: 1, savedTok: 540_000 })), ["saved 540k"]);
  assert.deepEqual(compactionRowFacts(row({ count: 1, rebuildTok: 58_000, rebuildUsd: 0.58 })), ["cost 58k · $0.58"]);
});

test("the saving is named as money that was never spent", () => {
  const r = compactionReading(ledger({}, { count: 1, shedTok: 180_000, savedTok: 540_000, savedUsd: 0.27 }));
  const t = compactionSavedText(r);
  assert.match(t, /540k tokens not re-sent/);
  assert.match(t, /\$0\.27/);
  // The framing is not optional: every other figure on that screen is spend.
  assert.match(t, /never actually spent/);
  // Priced by nothing ⇒ the tokens still get their sentence.
  const unpriced = compactionSavedText(compactionReading(ledger({}, { count: 1, savedTok: 540_000 })));
  assert.match(unpriced, /540k tokens not re-sent\.$/);
});

test("compacted but nothing run since is its own sentence, not a $0", () => {
  const r = compactionReading(ledger({}, { count: 1, shedTok: 180_000 }));
  assert.equal(compactionSavedText(r), null);
  assert.match(compactionPendingText(r), /No turn has run since/);
  // And the pending sentence is silent once something HAS been saved.
  assert.equal(
    compactionPendingText(compactionReading(ledger({}, { count: 1, savedTok: 1 }))),
    null,
  );
});

test("the cost says both what it includes and what the log cannot see", () => {
  const t = compactionCostText(compactionReading(ledger({}, { count: 1, rebuildTok: 58_000, rebuildUsd: 0.58 })));
  assert.match(t, /58k tokens \(\$0\.58\)/);
  // Read as a second bill on top of the session total, this figure is double
  // counting — it is inside that total, and the sentence says so.
  assert.match(t, /already counted in this session's total/);
  // The one part of the cost nothing here can measure, named rather than
  // quietly folded into a number that looks complete.
  assert.match(t, /summarising request itself is not in the CLI's log/);
});

test("the ratio is money only, and says so when it is upside down", () => {
  const good = compactionReading(ledger({}, { count: 1, savedTok: 1, savedUsd: 1.92, rebuildTok: 1, rebuildUsd: 0.58 }));
  assert.equal(compactionRatioText(good), "3.3× what it cost.");
  const bad = compactionReading(ledger({}, { count: 1, savedTok: 1, savedUsd: 0.1, rebuildTok: 1, rebuildUsd: 0.6 }));
  assert.match(compactionRatioText(bad), /\$0\.50 more than it has saved back so far\./);
  // A cache read against a cache write is not a ratio anybody can use, so
  // with one side unpriced there is no ratio at all.
  assert.equal(
    compactionRatioText(compactionReading(ledger({}, { count: 1, savedTok: 9, rebuildTok: 9 }))),
    null,
  );
});

test("past the window the saving is not a saving, and the words change", () => {
  // 40k carried, 180k shed, 200k window: uncompacted it would be 220k, which
  // is not an expensive conversation — it is a refused request.
  const ran = compactionReading(ledger({}, { count: 1, shedTok: 180_000, savedTok: 540_000 }));
  assert.match(
    compactionWindowText(ran, 40_000, 200_000),
    /Uncompacted it would be carrying 220k — past the 200k window, so those turns could not have run at all\./,
  );
  // Still inside the window ⇒ the ordinary saving stands on its own.
  const small = compactionReading(ledger({}, { count: 1, shedTok: 10_000, savedTok: 30_000 }));
  assert.equal(compactionWindowText(small, 40_000, 200_000), null);
  // Nothing is claimed about a ceiling nobody measured.
  assert.equal(compactionWindowText(ran, 40_000, null), null);
  // And "those turns could not have run" is about the turns SINCE — with none
  // of them, the sentence is a consequence asserted for work nobody did.
  const none = compactionReading(ledger({}, { count: 1, shedTok: 180_000 }));
  assert.equal(compactionWindowText(none, 40_000, 200_000), null);
});

test("both estimates err against compacting looking worthwhile", () => {
  const t = compactionMethodText();
  assert.match(t, /cache reads — the cheapest they could have been/);
  assert.match(t, /the whole first write after each boundary/);
  assert.match(t, /err against compacting looking worthwhile/);
});

test("a row is labelled by the verb, and the manual one names the command", () => {
  assert.equal(compactionRowLabel("manual", 1), "you typed /compact");
  assert.equal(compactionRowLabel("manual", 3), "you typed /compact 3×");
  assert.equal(compactionRowLabel("auto", 1), "the CLI compacted");
  assert.equal(compactionRowLabel("auto", 4), "the CLI compacted 4×");
});

// ── The turns that re-wrote a window they had already cached ────────────────
//
// The numbers here are this desktop's own: the tools-and-system preamble is a
// SEPARATE cache entry, measured at 32.5k-36.8k, kept warm by sibling sessions
// in the same repo. Every rule below exists because that preamble makes the
// obvious test wrong.

test("a rebuild is the read missing its own context, not write > read", () => {
  // The case that broke the first draft: a 60k conversation comes back cold,
  // reads the 36.8k preamble and writes its own 30.6k. Write is BELOW read and
  // it was stone cold.
  assert.equal(isColdRebuild(65_933, { cacheRead: 36_770, cacheWrite: 30_638 }), true);
  // This conversation's own resume after fourteen hours, measured.
  assert.equal(isColdRebuild(207_363, { cacheRead: 36_770, cacheWrite: 172_448 }), true);
  // A warm turn reads back everything it carried and writes only the new tail.
  assert.equal(isColdRebuild(358_973, { cacheRead: 359_309, cacheWrite: 124 }), false);
});

test("nothing before the first request can have been lost", () => {
  // The opening request of any conversation writes its baseline. That is the
  // price of starting anywhere, not a window somebody let go cold.
  assert.equal(isColdRebuild(0, { cacheRead: 0, cacheWrite: 80_000 }), false);
  assert.equal(isColdRebuild(null, { cacheRead: 0, cacheWrite: 80_000 }), false);
  assert.equal(isColdRebuild(undefined, { cacheRead: 0, cacheWrite: 80_000 }), false);
});

test("a compaction is not an expired cache, and is never billed as one", () => {
  // Measured: 380,483 -> 12,543 by hand, and the next request wrote 31,579
  // against a `prevTok` of 379,692. Identical in shape to a cold resume; those
  // tokens were discarded on purpose and `CompactionLedger` already prices the
  // rebuild. Counting it here would bill compacting twice.
  const req = { cacheRead: 32_510, cacheWrite: 31_579 };
  assert.equal(isColdRebuild(379_692, req, { afterCompaction: true }), false);
  // And the arithmetic refuses it on its own, which is what covers a boundary
  // the log never recorded: 31,579 written against 347,182 that was carried
  // and not read back is not a re-write of that window.
  assert.equal(isColdRebuild(379_692, req), false);
});

test("the sentence leads with the premium and never calls it waste", () => {
  const t = coldStartText({ count: 1, tok: 172_448, usd: 1.72, premiumUsd: 1.64 }, "session");
  assert.match(t, /One turn here/);
  assert.match(t, /172k/);
  assert.match(t, /\$1\.64 more than re-reading/);
  assert.match(t, /\$1\.72/);
  assert.doesNotMatch(t, /wast|should|too long/i);
  assert.match(coldStartText({ count: 12, tok: 2_000_000 }, "corpus"), /12 requests across this desktop/);
});

test("no rebuilds is not a line, and unpriced is not a free one", () => {
  assert.equal(coldStartText({ count: 0, tok: 0 }, "session"), null);
  assert.equal(coldStartText(null, "corpus"), null);
  assert.equal(coldStartText(undefined, "session"), null);
  // Priced at nothing — an unknown model — states the tokens and claims no
  // amount, rather than printing $0 beside a re-write that really happened.
  const t = coldStartText({ count: 2, tok: 90_000 }, "session");
  assert.doesNotMatch(t, /\$/);
  assert.match(t, /90k/);
  assert.equal(coldStartChip({ count: 2, tok: 90_000 }), "2 re-writes");
  assert.equal(coldStartChip({ count: 0, tok: 0 }), null);
});

// ── A large RUNNING subagent ──────────────────────────────────────────────

test("liveAgentText is silent below the threshold and speaks at it", () => {
  assert.equal(AGENT_LARGE_TOK, 500_000);
  assert.equal(liveAgentText(AGENT_LARGE_TOK - 1), null);
  assert.equal(liveAgentText(undefined), null);
  assert.equal(liveAgentText(null), null);
  assert.equal(liveAgentText(AGENT_LARGE_TOK),
    "A subagent is re-reading 500k on every step — agents with a narrower task that finish sooner cost less.");
  assert.match(liveAgentText(720_000), /re-reading 720k on every step/);
});

test("liveAgentText takes the person's own line, defaulting to AGENT_LARGE_TOK", () => {
  assert.equal(liveAgentText(300_000), null);
  assert.match(liveAgentText(300_000, null, undefined, 250_000), /re-reading 300k/);
  assert.equal(liveAgentText(300_000, null, undefined, 400_000), null);
  assert.equal(liveAgentText(AGENT_LARGE_TOK, null, undefined, undefined) !== null, true);
});

test("agentPushText names the agent, the size and the lever, and promises nothing stopped", () => {
  const p = agentPushText({ tok: 612_000, type: "general-purpose", title: "api work" });
  assert.equal(p.title, "api work: a general-purpose agent passed 612k");
  assert.match(p.body, /612k of context on every step/);
  assert.match(p.body, /context sheet to interrupt and re-plan/);
  assert.equal(agentPushText({ tok: 500_000 }).title, "an agent passed 500k");
  assert.doesNotMatch(p.body, /stopped|paused|killed/i);
});

test("replanPromptText is one plain paragraph that names the size, TaskStop and the 200k brief", () => {
  const t = replanPromptText(747_000, "Explore");
  assert.match(t, /^A subagent \(Explore\) was re-reading 747k of context on every step\./);
  assert.match(t, /TaskStop/);
  assert.match(t, /model set explicitly/);
  assert.match(t, /200k/);
  assert.doesNotMatch(t, /\n/);
  assert.match(replanPromptText(600_000), /^A subagent was re-reading 600k/);
});

test("liveAgentText goes quiet once the agent's last record is stale by the caller's clock", () => {
  const at = 1_000_000;
  assert.ok(liveAgentText(720_000, at, at + AGENT_LIVE_MS));
  assert.equal(liveAgentText(720_000, at, at + AGENT_LIVE_MS + 1), null);
});

test("liveAgentText refuses nothing — it is words, never a verdict", () => {
  assert.doesNotMatch(liveAgentText(967_000), /stop|blocked|refus|cannot/i);
});

test("turnCostParts: each part absent rather than zero, money always framed", () => {
  assert.equal(turnCostParts({}), null);
  assert.equal(turnCostParts({ costUsd: 0, cumCostUsd: 0, ctxTok: 0 }), null);
  const all = turnCostParts({ costUsd: 0.12, cumCostUsd: 0.9, ctxTok: 142_000 });
  assert.equal(all.turn, "$0.12 this prompt");
  assert.equal(all.total, "$0.90 session so far");
  assert.match(all.ctx, /context$/);
  assert.equal(all.note, "API list price");
  // Context alone carries no price framing — there is no dollar figure to frame.
  const ctxOnly = turnCostParts({ ctxTok: 5000 });
  assert.equal(ctxOnly.turn, null);
  assert.equal(ctxOnly.note, null);
  // Subagents are in neither figure; the turn line says so.
  assert.match(turnCostParts({ costUsd: 1, agents: 3 }).note, /subagents not included/);
  // A later turn with none of its own: its running total still leaves out the
  // earlier ones, which the header's total counts.
  assert.match(turnCostParts({ costUsd: 1, cumCostUsd: 9, agentsSoFar: true }).note, /subagents not included/);
  assert.equal(turnCostParts({ costUsd: 1, cumCostUsd: 9 }).note, "API list price");
});

test("turnCostParts: placed subagents are IN the figures, split out, and running ones say so", () => {
  const done = turnCostParts({ costUsd: 1.12, agentCostUsd: 9.2, cumCostUsd: 1.12, cumAgentCostUsd: 9.2, agents: 5, agentsSoFar: true });
  assert.equal(done.turn, "$10.32 this prompt");
  assert.equal(done.agents, "$9.20 of it in subagents");
  assert.equal(done.total, "$10.32 session so far");
  assert.equal(done.note, "API list price", "nothing left out, so nothing to caveat");
  const live = turnCostParts({ costUsd: 1, agentCostUsd: 2, agentsRunning: 2, agents: 3 });
  assert.equal(live.turn, "$3.00 this prompt so far");
  assert.equal(live.agents, "$2.00 of it in subagents · 2 subagents still running");
  // Just started: nothing spent yet, still said — the turn is not done.
  const fresh = turnCostParts({ costUsd: 1, agentsRunning: 1, agents: 1 });
  assert.equal(fresh.turn, "$1.00 this prompt so far");
  assert.equal(fresh.agents, "1 subagent still running");
  assert.equal(fresh.note, "API list price");
  // Placed on the turn but no running total (one agent could not be placed).
  assert.match(turnCostParts({ costUsd: 1, agentCostUsd: 2, cumCostUsd: 5, agentsSoFar: true }).note, /subagents not included/);
  assert.match(turnCostParts({ costUsd: 1, agentUnpricedTok: 50_000 }).note, /no published rate/);
});

test("weekUsdPerPct: calibrates only off a reading wide enough to divide by", () => {
  assert.equal(weekUsdPerPct(940, 94), 10);
  assert.equal(weekUsdPerPct(940, WEEK_CAL_MIN_PCT - 1), null); // ±0.5 of 4% is a wrong number
  assert.equal(weekUsdPerPct(0, 50), null);
  assert.equal(weekUsdPerPct(null, 50), null);
  assert.equal(weekUsdPerPct(100, null), null);
  assert.equal(weekUsdPerPct(100, 120), null);
});

test("weekShareText: a share, never a zero", () => {
  assert.equal(weekShareText(0.91, 17.9), "≈0.05% of week"); // the measured case
  assert.equal(weekShareText(1.2, 10), "≈0.1% of week");
  assert.equal(weekShareText(0.0001, 10), "<0.001% of week");
  assert.equal(weekShareText(45, 10), "≈4.5% of week");
  assert.equal(weekShareText(250, 10), "≈25% of week");
  assert.equal(weekShareText(0, 10), null);
  assert.equal(weekShareText(1, null), null);
});

test("turnCostParts: week share rides beside each money figure and the note says whose", () => {
  const p = turnCostParts({ costUsd: 4, cumCostUsd: 20, ctxTok: 113_000, usdPerWeekPct: 10 });
  assert.equal(p.turn, "$4.00 this prompt (≈0.4% of week)");
  assert.equal(p.total, "$20.00 session so far (≈2.0% of week)");
  assert.match(p.note, /^API list price; % of week estimated/);
  const none = turnCostParts({ costUsd: 4, cumCostUsd: 20, usdPerWeekPct: null });
  assert.equal(none.turn, "$4.00 this prompt");
  assert.equal(none.note, "API list price");
});

test("turnTokensText: the total never without its split, zeros dropped, absent is null", () => {
  assert.equal(turnTokensText({ input: 1_200, output: 830, cacheRead: 46_000, cacheWrite: 3_200 }), "51k tokens — 1k in · 830 out · 46k cache read · 3k cache write");
  assert.equal(turnTokensText({ input: 0, output: 400, cacheRead: 20_000, cacheWrite: 0 }), "20k tokens — 400 out · 20k cache read");
  assert.equal(turnTokensText({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(turnTokensText(undefined), null);
});

test("nextTurnText: tokens and the multiple, the comparison absent with no baseline", () => {
  assert.equal(nextTurnText(sessionCost({ tok: 142_000, baseTok: BASE, turns: 3, spentTok: null })), "Next prompt re-reads 142k of context — 2.0× what a fresh session here starts with (71k).");
  assert.equal(nextTurnText(sessionCost({ tok: 75_000, baseTok: BASE, turns: 3, spentTok: null })), "Next prompt re-reads 75k of context — about what a fresh session here starts with (71k).");
  assert.equal(nextTurnText(sessionCost({ tok: 90_000, baseTok: null, turns: 3, spentTok: null })), "Next prompt re-reads 90k of context.");
  assert.equal(nextTurnText(null), null);
});
