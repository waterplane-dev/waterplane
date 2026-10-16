/**
 * What the tokens would have cost at list prices.
 *
 * This is the one module in the feature that puts a DOLLAR figure on screen, so
 * the cases below are the ways it can be confidently wrong by a large factor:
 * pricing cache reads at the input rate (they are a tenth of it, and they are
 * 96% of all tokens), pricing every cache write at 1.25× when 84% of them are
 * the 2× one-hour tier, missing a model and silently charging zero for it, and
 * using today's rate for a day that was on an introductory one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_READ_MULT,
  CACHE_WRITE_1H_MULT,
  CACHE_WRITE_5M_MULT,
  PRICES,
  PRICES_AS_OF,
  addCost,
  costOf,
  fmtUsd,
  fmtUsdShort,
  isPriced,
  normalizeModel,
  rateFor,
  zeroCost,
  costOfAny, globMatch, isAnthropicModel, isPriceGap, parseUserPrices, priceGapText, userRateFor, fmtMoney, addPriced,
} from "../dist/pricing.js";

const M = 1_000_000;
const P = (o = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...o });

// ── the model key ─────────────────────────────────────────────────────────

test("a logged id normalises to the alias the table is keyed by", () => {
  // What the API actually returns is not always the alias: a dated snapshot and
  // the long-context marker both appear in real logs.
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(normalizeModel("claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(normalizeModel("claude-opus-4-5-20251101"), "claude-opus-4-5");
  assert.equal(normalizeModel("CLAUDE-OPUS-5"), "claude-opus-5");
  assert.equal(normalizeModel("claude-opus-5"), "claude-opus-5");
});

test("`<synthetic>` and other vendors are not models", () => {
  for (const id of ["<synthetic>", "gpt-4o", "", "   ", null, undefined]) {
    assert.equal(normalizeModel(id), null, String(id));
    assert.equal(rateFor(id), null, String(id));
    assert.equal(isPriced(id), false, String(id));
  }
});

test("a Claude model with no published rate prices to NULL, never to zero", () => {
  // Zero is a claim that it was free. Null is what lets the screen total up the
  // usage it could not price and name it.
  assert.equal(normalizeModel("claude-opus-9-3"), "claude-opus-9-3", "it IS one of ours");
  assert.equal(rateFor("claude-opus-9-3"), null, "…but there is no rate for it");
  assert.equal(costOf(P({ output: M }), "claude-opus-9-3"), null);
});

// ── the rates ─────────────────────────────────────────────────────────────

test("the table matches the published list prices", () => {
  // claude.com/pricing#api, read 2026-09-19. Every pair below is off that page.
  assert.deepEqual(rateFor("claude-fable-5-1"), { input: 10, output: 50, cacheRead: 0.25 });
  // Opus 5.5 publishes its own cache-read rate too: $0.20, half the 0.1× rule.
  assert.deepEqual(rateFor("claude-opus-5-5"), { input: 4, output: 20, cacheRead: 0.2 });
  assert.deepEqual(rateFor("claude-opus-5-5[1m]"), { input: 4, output: 20, cacheRead: 0.2 });
  assert.deepEqual(rateFor("claude-opus-5"), { input: 5, output: 25 });
  assert.deepEqual(rateFor("claude-opus-4-8"), { input: 5, output: 25 });
  assert.deepEqual(rateFor("claude-fable-5"), { input: 10, output: 50 });
  assert.deepEqual(rateFor("claude-sonnet-5"), { input: 2, output: 10 });
  // Missing once: two background subagents on it were left out of every dollar
  // figure while the header still printed a total.
  assert.deepEqual(rateFor("claude-sonnet-5-5"), { input: 2, output: 10 });
  assert.deepEqual(rateFor("claude-sonnet-4-6"), { input: 3, output: 15 });
  assert.deepEqual(rateFor("claude-haiku-4-5"), { input: 1, output: 5 });
  // Haiku 5.5's SHORT-prompt card (≤100K): the list's figure, cache at the multipliers.
  assert.deepEqual(rateFor("claude-haiku-5-5"), { input: 0.1, output: 0.5 });
  assert.ok(isPriced("claude-haiku-5-5[1m]"), "the long-context marker prices like the base id");
  assert.ok(PRICES_AS_OF.match(/^\d{4}-\d{2}-\d{2}$/), "the table says when it was taken");
});

test("Sonnet 5 is $2/$10 — the rate that was read as $3/$15 for a fortnight", () => {
  // It was carried as an INTRODUCTORY $2/$10 "until 2026-08-31" over a $3/$15
  // base, so from 1 September every sonnet session was priced half again too
  // dear. The list has one rate for it and this is that rate, on every day.
  for (const day of ["2026-07-01", "2026-08-31", "2026-09-01", undefined]) {
    assert.deepEqual(rateFor("claude-sonnet-5", day), { input: 2, output: 10 }, String(day));
  }
});

test("an introductory rate still applies to the days it is in force", () => {
  // No model on today's list carries one, but that is the shape a price change
  // takes and the day is threaded through every caller for it. Asserted
  // against a fixture rather than a shipped model, so the next real intro
  // needs no second mechanism.
  PRICES["claude-teapot-1"] = { input: 10, output: 50, intro: { input: 4, output: 20, until: "2026-03-31" } };
  try {
    assert.deepEqual(rateFor("claude-teapot-1", "2026-03-01"), { input: 4, output: 20 });
    assert.deepEqual(rateFor("claude-teapot-1", "2026-03-31"), { input: 4, output: 20 }, "inclusive");
    assert.deepEqual(rateFor("claude-teapot-1", "2026-04-01"), { input: 10, output: 50 });
    // With no day, the current rate — never the promotional one.
    assert.deepEqual(rateFor("claude-teapot-1"), { input: 10, output: 50 });
  } finally {
    delete PRICES["claude-teapot-1"];
  }
  // A model with no intro is unaffected by the day.
  assert.deepEqual(rateFor("claude-opus-5", "2026-01-01"), rateFor("claude-opus-5", "2026-12-31"));
});

test("a published cache-read rate beats the 0.1x rule", () => {
  // Fable 5.1 reads the cache at $0.25/MTok against a $10 input rate — 0.025x,
  // a quarter of the rule. Cache reads are 96% of this app's tokens, so the
  // rule alone makes its dominant line four times too dear.
  const read = costOf(P({ cacheRead: M }), "claude-fable-5-1");
  assert.equal(read.cacheRead, 0.25);
  assert.equal(read.total, 0.25);
  // Its twin at the same input/output rates has no such line and takes the
  // rule — which is the comparison that would hide a dropped override.
  assert.equal(costOf(P({ cacheRead: M }), "claude-fable-5").cacheRead, 10 * CACHE_READ_MULT);
  // The discount is on READS only: writes are the same multipliers.
  assert.equal(costOf(P({ cacheWrite: M }), "claude-fable-5-1").cacheWrite, 10 * CACHE_WRITE_5M_MULT);
  assert.equal(costOf(P({ input: M, output: M }), "claude-fable-5-1").total, 60);
});

// ── the arithmetic ────────────────────────────────────────────────────────

test("input and output are billed at the model's own two rates", () => {
  const c = costOf(P({ input: M, output: M }), "claude-opus-5");
  assert.equal(c.input, 5);
  assert.equal(c.output, 25);
  assert.equal(c.total, 30);
});

test("a cache READ is a tenth of input — the multiplier that keeps the total sane", () => {
  // 96% of all tokens are cache reads. Charging them at the input rate would
  // make the headline an order of magnitude too big.
  const c = costOf(P({ cacheRead: M }), "claude-opus-5");
  assert.equal(c.cacheRead, 5 * CACHE_READ_MULT);
  assert.equal(c.cacheRead, 0.5);
});

test("cache writes are split by TTL: 1.25x for 5-minute, 2x for 1-hour", () => {
  // Measured: 84% of writes in the real corpus are the 1-hour tier, so pricing
  // them all at 1.25x understates this line by ~60%.
  const all5m = costOf(P({ cacheWrite: M, cacheWrite1h: 0 }), "claude-opus-5");
  assert.equal(all5m.cacheWrite, 5 * CACHE_WRITE_5M_MULT);
  const all1h = costOf(P({ cacheWrite: M, cacheWrite1h: M }), "claude-opus-5");
  assert.equal(all1h.cacheWrite, 5 * CACHE_WRITE_1H_MULT);
  // Mixed: the 1-hour part is a SUBSET, so the rest is the 5-minute tier.
  const mixed = costOf(P({ cacheWrite: M, cacheWrite1h: M * 0.5 }), "claude-opus-5");
  assert.ok(Math.abs(mixed.cacheWrite - (2.5 * CACHE_WRITE_5M_MULT + 2.5 * CACHE_WRITE_1H_MULT)) < 1e-9);
  assert.ok(all1h.cacheWrite > all5m.cacheWrite, "the 1-hour tier is the dearer one");
});

test("a malformed 1-hour subset cannot make the bill smaller", () => {
  // If `cacheWrite1h` ever exceeded `cacheWrite`, an unclamped remainder would
  // go negative and quietly subtract from the total.
  const c = costOf(P({ cacheWrite: 1000, cacheWrite1h: 999_999 }), "claude-opus-5");
  assert.ok(c.cacheWrite > 0);
  assert.equal(c.cacheWrite, costOf(P({ cacheWrite: 1000, cacheWrite1h: 1000 }), "claude-opus-5").cacheWrite);
  const neg = costOf(P({ cacheWrite: 1000, cacheWrite1h: -5 }), "claude-opus-5");
  assert.ok(neg.cacheWrite > 0);
});

test("the breakdown adds up to the total, exactly", () => {
  const c = costOf(P({ input: 1234, output: 5678, cacheRead: 9_000_000, cacheWrite: 4321, cacheWrite1h: 4000 }), "claude-fable-5");
  assert.ok(Math.abs(c.total - (c.input + c.output + c.cacheRead + c.cacheWrite)) < 1e-12);
});

test("costs fold without losing the split", () => {
  const a = zeroCost();
  addCost(a, costOf(P({ output: M }), "claude-opus-5"));
  addCost(a, costOf(P({ output: M }), "claude-haiku-4-5"));
  assert.equal(a.output, 30);
  assert.equal(a.total, 30);
  assert.deepEqual(zeroCost(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("the same tokens cost different money on different models", () => {
  const t = P({ input: M, output: M, cacheRead: 10 * M, cacheWrite: M, cacheWrite1h: M });
  const opus = costOf(t, "claude-opus-5").total;
  const haiku = costOf(t, "claude-haiku-4-5").total;
  const fable = costOf(t, "claude-fable-5").total;
  assert.ok(haiku < opus && opus < fable, `${haiku} < ${opus} < ${fable}`);
  // Haiku's rates are exactly a fifth of Opus's, so the whole bill is too.
  assert.ok(Math.abs(haiku * 5 - opus) < 1e-9);
});

// ── the real shape ────────────────────────────────────────────────────────

test("on the real corpus's shape, output dominates the money and cache reads the tokens", () => {
  // 13.6B tokens of which 96% cache reads, but the money lands elsewhere — the
  // whole reason the screen shows a cost breakdown and not just a total.
  const real = P({ input: 979_000, output: 29_753_784, cacheRead: 13_164_640_644, cacheWrite: 459_872_040, cacheWrite1h: 387_106_000 });
  const c = costOf(real, "claude-opus-5");
  assert.ok(c.cacheRead > c.output, "cache reads are still the biggest line at this ratio");
  assert.ok(c.output > c.input * 100, "output dwarfs fresh input");
  // Sanity band: this much traffic on Opus rates is thousands of dollars, not
  // tens and not millions. A multiplier slip lands outside this.
  assert.ok(c.total > 1000 && c.total < 100_000, `total was ${c.total}`);
});

// ── the words ─────────────────────────────────────────────────────────────

test("money is formatted so a real amount is never rendered as $0.00", () => {
  assert.equal(fmtUsd(0), "$0");
  assert.equal(fmtUsd(0.0031), "$0.0031", "below a cent keeps four decimals");
  assert.equal(fmtUsd(4.207), "$4.21");
  assert.equal(fmtUsd(1284.4).replace(/,/g, ""), "$1284");
  assert.equal(fmtUsd(NaN), "—");
});

test("the short form fits an axis without lying about small values", () => {
  assert.equal(fmtUsdShort(0), "$0");
  assert.equal(fmtUsdShort(0.004), "<$0.01");
  assert.equal(fmtUsdShort(4.21), "$4.21");
  assert.equal(fmtUsdShort(421), "$421");
  assert.equal(fmtUsdShort(1234), "$1.2k");
  assert.equal(fmtUsdShort(12_345), "$12k");
});

test("every price in the table is a positive pair", () => {
  for (const [id, p] of Object.entries(PRICES)) {
    assert.ok(p.input > 0 && p.output > 0, id);
    assert.ok(p.output >= p.input, `${id}: output should not be cheaper than input`);
    if (p.intro) {
      assert.ok(p.intro.input <= p.input && p.intro.output <= p.output, `${id}: an intro rate is a discount`);
      assert.match(p.intro.until, /^\d{4}-\d{2}-\d{2}$/);
    }
    if (p.cacheRead != null) {
      // An override exists to correct the rule, and only ever downward: a
      // published cache read dearer than fresh input would be a typo, and one
      // at exactly the rule is an override that says nothing.
      assert.ok(p.cacheRead > 0 && p.cacheRead < p.input, `${id}: a cache read is cheaper than input`);
      assert.notEqual(p.cacheRead, p.input * CACHE_READ_MULT, `${id}: an override that equals the rule is noise`);
    }
  }
  assert.ok(CACHE_READ_MULT < 1 && CACHE_WRITE_5M_MULT > 1 && CACHE_WRITE_1H_MULT > CACHE_WRITE_5M_MULT);
});

// ── Prices a person supplied (`prices.json`) ─────────────────────────────────

test("the person's table can NEVER move a Claude price — every listed model, every day, a catch-all glob", () => {
  // The pin over the existing table: a glob that matches everything, plus an
  // exact line for every listed id at zero, and the answer is still `costOf`'s
  // to the last digit, with source `list`.
  const raw = { "*": { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, currency: "EUR" } };
  for (const id of Object.keys(PRICES)) raw[id] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const table = parseUserPrices(raw);
  const bag = P({ input: 1.3 * M, output: 0.7 * M, cacheRead: 40 * M, cacheWrite: 2 * M, cacheWrite1h: 1.5 * M });
  for (const id of Object.keys(PRICES)) {
    for (const logged of [id, `${id}-20251001`, `${id}[1m]`]) {
      for (const day of [undefined, "2026-01-01", "2026-09-30"]) {
        const any = costOfAny(bag, logged, day, table);
        assert.equal(isPriceGap(any), false, logged);
        assert.equal(any.source, "list", logged);
        assert.equal(any.currency, "USD", logged);
        assert.deepEqual(any.cost, costOf(bag, logged, day), `${logged} @ ${day}`);
      }
    }
  }
});

test("no entry is a GAP, never a zero — and the gap says how to add one", () => {
  const g = costOfAny(P({ input: M }), "qwen3-coder:30b-64k", undefined, parseUserPrices({}));
  assert.equal(isPriceGap(g), true);
  assert.equal(g.why, "no-entry");
  const s = priceGapText(g, "/home/x/.config/waterplane/prices.json");
  assert.match(s, /qwen3-coder:30b-64k/);
  assert.match(s, /prices\.json/);
  assert.equal(isPriceGap(costOfAny(P({ input: M }), "qwen3", undefined, null)), true);
});

test("a user rate prices per million, in its own currency, and says which line priced it", () => {
  const table = parseUserPrices({ "qwen/qwen3-coder": { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.25, currency: "eur" } });
  const p = costOfAny(P({ input: 2 * M, output: M, cacheRead: 10 * M, cacheWrite: 4 * M, cacheWrite1h: 4 * M }), "qwen/qwen3-coder", undefined, table);
  assert.equal(p.source, "user");
  assert.equal(p.currency, "EUR");
  assert.equal(p.pattern, "qwen/qwen3-coder");
  assert.ok(Math.abs(p.cost.input - 0.4) < 1e-9);
  assert.ok(Math.abs(p.cost.output - 0.8) < 1e-9);
  assert.ok(Math.abs(p.cost.cacheRead - 0.2) < 1e-9);
  // One write rate for both tiers — the person stated one, nothing is multiplied.
  assert.ok(Math.abs(p.cost.cacheWrite - 1.0) < 1e-9);
  assert.ok(Math.abs(p.cost.total - 2.4) < 1e-9);
});

test("a kind with tokens and no rate in the entry is a gap naming the kind — never input-rate, never free", () => {
  const table = parseUserPrices({ "llama*": { input: 1, output: 2 } });
  const g = costOfAny(P({ input: M, cacheRead: 5 * M }), "llama3.3:70b", undefined, table);
  assert.equal(isPriceGap(g), true);
  assert.equal(g.why, "missing-kinds");
  assert.deepEqual(g.kinds, ["cacheRead"]);
  assert.match(priceGapText(g, "f.json"), /"cacheRead"/);
  // The same entry prices a bag that used no cache.
  const ok = costOfAny(P({ input: M, output: M }), "llama3.3:70b", undefined, table);
  assert.equal(ok.cost.total, 3);
});

test("an exact id beats a glob, and the more literal glob beats the looser one", () => {
  const t = parseUserPrices({
    "*": { input: 9, output: 9 },
    "qwen*": { input: 2, output: 2 },
    "qwen3-coder*": { input: 1, output: 1 },
    "QWEN3-CODER:30B": { input: 0.5, output: 0.5 },
  });
  assert.equal(userRateFor(t, "qwen3-coder:30b").rate.input, 0.5);
  assert.equal(userRateFor(t, "qwen3-coder:480b").rate.input, 1);
  assert.equal(userRateFor(t, "qwen2.5:7b").rate.input, 2);
  assert.equal(userRateFor(t, "mistral").rate.input, 9);
  assert.equal(globMatch("a.b*", "aXb-1"), false, "a dot is literal");
  assert.equal(globMatch("a.b*", "a.b-1"), true);
});

test("a bad entry is refused WITH a sentence; the good ones still load; currency defaults to USD", () => {
  const t = parseUserPrices({
    good: { input: 1, output: 2 },
    noOut: { input: 1 },
    neg: { input: 1, output: 1, cacheRead: -1 },
    str: "cheap",
    cur: { input: 1, output: 1, currency: "" },
  });
  assert.deepEqual(t.entries.map((e) => e.pattern), ["good"]);
  assert.equal(t.entries[0].rate.currency, "USD");
  assert.equal(t.problems.length, 4);
  for (const k of ["noOut", "neg", "str", "cur"]) assert.ok(t.problems.some((p) => p.includes(`"${k}"`)), k);
  assert.equal(parseUserPrices([1, 2]).problems.length, 1);
  assert.deepEqual(parseUserPrices(null), { entries: [], problems: [] });
});

test("currencies are totalled apart, never converted", () => {
  const m = new Map();
  addPriced(m, { currency: "USD", cost: { ...zeroCost(), total: 1 }, source: "list" });
  addPriced(m, { currency: "EUR", cost: { ...zeroCost(), total: 2 }, source: "user" });
  addPriced(m, { currency: "USD", cost: { ...zeroCost(), total: 3 }, source: "user" });
  assert.deepEqual([...m], [["USD", 4], ["EUR", 2]]);
  assert.equal(fmtMoney(2, "EUR"), "2.00 EUR");
  assert.equal(fmtMoney(2, "USD"), "$2.00");
});

test("Anthropic's models wherever served; another vendor's model in Claude Code's log is not", () => {
  for (const id of ["claude-opus-5", "claude-haiku-4-5-20251001", "claude-opus-5[1m]", "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "anthropic/claude-sonnet-4.5", "claude-sonnet-4-5@20250929", "<synthetic>"]) {
    assert.equal(isAnthropicModel(id), true, id);
  }
  for (const id of ["qwen3-coder:30b-64k", "qwen/qwen3-coder", "llama3.3:70b", "gpt-oss:20b", "notclaude-x", "", null, undefined]) {
    assert.equal(isAnthropicModel(id), false, String(id));
  }
});
