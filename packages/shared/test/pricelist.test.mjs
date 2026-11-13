// The price list read off Anthropic's page: strict, all-or-nothing, and the
// built-in table kept in step with it. Fixture: the page as served 2026-11-12.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LONG_PROMPT, PRICES, costOf, costOfRequest, installPriceList, priceKeyLabel, priceKeyOf, priceListSource, rateFor, PRICES_AS_OF } from "../dist/pricing.js";
import { parsePriceList, priceListDiff } from "../dist/pricelist.js";

const PAGE = readFileSync(new URL("./fixtures/pricing-2026-11-12.md", import.meta.url), "utf8");
const M = 1_000_000;

test("the real page parses, every model with all four rates", () => {
  const r = parsePriceList(PAGE);
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.rates["claude-fable-5-2"], { input: 8, output: 40, cacheRead: 0.2 });
  assert.deepEqual(r.rates["claude-sonnet-5-5"], { input: 2, output: 10, cacheRead: 0.1 });
  assert.deepEqual(r.rates["claude-mythos-5-1"], { input: 10, output: 50, cacheRead: 0.25 }, "status link stripped");
  assert.deepEqual(r.rates["claude-opus-4"], { input: 15, output: 75, cacheRead: 1.5 });
  assert.deepEqual(r.rates["claude-sonnet-5"], { input: 2, output: 10, cacheRead: 0.2 }, "footnote marker ignored");
  assert.deepEqual(r.rates["claude-haiku-5-5"], { input: 0.1, output: 0.5, cacheRead: 0.01 }, "the short card is the rate");
  assert.deepEqual(r.longPrompt["claude-haiku-5-5"], { input: 0.5, output: 2.5, cacheRead: 0.05, overTokens: 100_000 });
  assert.deepEqual(r.skipped, []);
});

test("the built-in table agrees with the page it was checked against", () => {
  // A release that ships a stale table fails here, not on somebody's bill.
  const r = parsePriceList(PAGE);
  assert.deepEqual(priceListDiff(r.rates, PRICES), []);
});

test("a page whose shape changed gives NO prices, never wrong ones", () => {
  const renamed = PAGE.replace("| Cache hits and refreshes |", "| Cache reads |");
  assert.equal(parsePriceList(renamed).ok, false);
  // Columns swapped: output where input was. The arithmetic catches it.
  const swapped = PAGE.replace(/(\| Claude Opus 5 +\| )\$5 \/ MTok( +\|.*\| )\$25 \/ MTok/,
    (_, a, b) => `${a}$25 / MTok${b}$5 / MTok`);
  assert.notEqual(swapped, PAGE);
  const s = parsePriceList(swapped);
  assert.equal(s.ok, false);
  assert.match(s.why, /claude-opus-5/);
  const unreadable = PAGE.replace("$0.20 / MTok<sup>2</sup>", "20 cents");
  assert.equal(parsePriceList(unreadable).ok, false);
  assert.equal(parsePriceList("").ok, false);
  assert.equal(parsePriceList("<html>Access denied</html>").ok, false);
});

test("a row we cannot name is skipped, not fatal", () => {
  const extra = PAGE.replace("| Claude Haiku 4.5 ", "| Claude Mythos Preview | $25 / MTok | $31.25 / MTok | $50 / MTok | $2.50 / MTok | $125 / MTok |\n| Claude Haiku 4.5 ");
  const r = parsePriceList(extra);
  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped, ["Claude Mythos Preview"]);
});

test("an installed list overlays the built-in table and says where its rates came from", () => {
  try {
    assert.deepEqual(priceListSource(), { pricesAsOf: PRICES_AS_OF, pricesFrom: "builtin" });
    assert.equal(rateFor("claude-fable-9"), null);
    installPriceList({ rates: { "claude-fable-9": { input: 6, output: 30, cacheRead: 0.15 }, "claude-opus-5": { input: 3, output: 15, cacheRead: 0.3 } }, fetchedAt: Date.UTC(2026, 11, 1, 12) });
    assert.deepEqual(rateFor("claude-fable-9[1m]"), { input: 6, output: 30, cacheRead: 0.15 }, "a model new to the page is priced");
    assert.equal(costOf({ input: 0, output: M, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, "claude-opus-5").output, 15, "the page wins over the table");
    assert.deepEqual(rateFor("claude-haiku-4-5"), { input: 1, output: 5 }, "a model the page omits falls back to the table");
    assert.deepEqual(priceListSource(), { pricesAsOf: "2026-12-01", pricesFrom: "list" });
  } finally {
    installPriceList(null);
  }
  assert.deepEqual(priceListSource().pricesFrom, "builtin");
});

test("a hostile first-column cell is refused fast, not scanned quadratically", () => {
  const evil = "Claude Opus 4 " + "([a](".repeat(40_000);
  const page = PAGE.replace(/^\| Claude Opus 4 .*$/m, (row) => row.replace(/^\| Claude Opus 4 +/, `| ${evil} `));
  assert.notEqual(page, PAGE);
  const t = Date.now();
  const r = parsePriceList(page);
  assert.ok(Date.now() - t < 500, "bounded work");
  assert.equal(r.ok === true && r.rates["claude-opus-4"] !== undefined, false, "the oversized row prices nothing");
});

// ── Haiku 5.5's long-prompt card ─────────────────────────────────────────────

const fixtureMd = readFileSync(new URL("./fixtures/pricing-2026-11-12.md", import.meta.url), "utf8");

test("the built-in long-prompt cards match the page", () => {
  const p = parsePriceList(fixtureMd);
  assert.equal(p.ok, true);
  assert.deepEqual(p.longPrompt, LONG_PROMPT);
});

test("a request is long only past the line, counting cache reads and writes", () => {
  const at = (input, cacheRead, cacheWrite) => priceKeyOf("claude-haiku-5-5-20261001", { input, cacheRead, cacheWrite });
  assert.equal(at(100, 99_000, 900), "claude-haiku-5-5-20261001"); // exactly 100K: short
  assert.equal(at(100, 99_000, 901), "claude-haiku-5-5@long");
  assert.equal(priceKeyOf("claude-opus-5-5", { input: 900_000, cacheRead: 0, cacheWrite: 0 }), "claude-opus-5-5");
  assert.equal(priceKeyOf(null, { input: 1, cacheRead: 0, cacheWrite: 0 }), null);
  // Idempotent: a key already marked stays as it is.
  assert.equal(priceKeyOf("claude-haiku-5-5@long", { input: 0, cacheRead: 0, cacheWrite: 0 }), "claude-haiku-5-5@long");
});

test("a long request pays the long card for all its tokens, a short one the short card", () => {
  const big = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, cacheWrite1h: 0 };
  assert.equal(costOfRequest(big, "claude-haiku-5-5", "2026-11-12").total, 0.5 + 2.5 + 0.05);
  const small = { input: 10_000, output: 1_000, cacheRead: 50_000, cacheWrite: 0, cacheWrite1h: 0 };
  assert.deepEqual(costOfRequest(small, "claude-haiku-5-5", "2026-11-12"), costOf(small, "claude-haiku-5-5", "2026-11-12"));
  assert.deepEqual(rateFor("claude-haiku-5-5@long"), { input: 0.5, output: 2.5, cacheRead: 0.05 });
  assert.equal(priceKeyLabel("claude-haiku-5-5@long"), "claude-haiku-5-5 (prompts over 100K)");
  assert.equal(priceKeyLabel("claude-haiku-5-5-20261001"), "claude-haiku-5-5");
});

test("the page's long card overrides the built-in one, and goes with it", () => {
  try {
    installPriceList({ rates: { "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 } },
      longPrompt: { "claude-haiku-5-5": { input: 0.6, output: 3, cacheRead: 0.06, overTokens: 200_000 } }, fetchedAt: Date.parse("2026-11-13") });
    assert.equal(priceKeyOf("claude-haiku-5-5", { input: 150_000, cacheRead: 0, cacheWrite: 0 }), "claude-haiku-5-5");
    assert.deepEqual(rateFor("claude-haiku-5-5@long"), { input: 0.6, output: 3, cacheRead: 0.06 });
    assert.equal(priceKeyLabel("claude-haiku-5-5@long"), "claude-haiku-5-5 (prompts over 200K)");
  } finally { installPriceList(null); }
  assert.deepEqual(rateFor("claude-haiku-5-5@long"), { input: 0.5, output: 2.5, cacheRead: 0.05 });
});
