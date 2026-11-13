/**
 * Reading Anthropic's price page (`pricefetch.ts`): a good read installs and is
 * kept, a bad page keeps what was there, the on-demand read is rate-limited,
 * and `WATERPLANE_PRICE_FETCH=0` never fetches. The fetch is INJECTED — no
 * network in this file.
 *
 *     node --test packages/host/test/pricefetch.test.mjs
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPriceList, priceGeneration, priceListSource, rateFor } from "@waterplane/shared";
import { createPriceFetch, priceHostOk, priceListRow, welcomePrices, PRICE_FETCH_FILE } from "../dist/pricefetch.js";
import { notePriceGap, onPriceGap } from "../dist/pricegap.js";

const PAGE = readFileSync(new URL("../../shared/test/fixtures/pricing-2026-11-12.md", import.meta.url), "utf8");
// The real page plus one model the built-in table has never heard of.
const NEW_ROW = "| Claude Fable 9 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |";
const PAGE_WITH_NEW = PAGE.replace(/^\| Claude Fable 5\.2 .*$/m, (row) => `${NEW_ROW}\n${row}`);
const DAY = 86_400_000;

const dir = () => mkdtempSync(join(tmpdir(), "pricefetch-"));
const quiet = () => {};
/** A fetch that answers from a list and counts its calls. */
function fake(...answers) {
  const f = async (url) => {
    f.calls.push(url);
    const a = answers[Math.min(f.calls.length - 1, answers.length - 1)];
    return typeof a === "string" ? { ok: true, text: a } : a;
  };
  f.calls = [];
  return f;
}

afterEach(() => { installPriceList(null); onPriceGap(null); });

test("the test page really does add a model", () => {
  assert.equal(rateFor("claude-fable-9"), null);
  assert.notEqual(PAGE_WITH_NEW, PAGE);
});

test("a good read installs the rates, persists them, and a restart installs the cache without fetching", async () => {
  const stateDir = dir();
  const now = Date.UTC(2026, 10, 12, 12);
  const fetchText = fake(PAGE_WITH_NEW);
  const gen = priceGeneration();
  const pf = createPriceFetch({ stateDir, fetchText, now: () => now, enabled: () => true, log: quiet });
  await pf.start();
  pf.stop();
  assert.equal(fetchText.calls.length, 1, "no cache ⇒ one read at boot");
  assert.deepEqual(rateFor("claude-fable-9"), { input: 1, output: 5, cacheRead: 0.1 });
  assert.deepEqual({ ...priceListSource(), pricesKey: undefined }, { pricesAsOf: "2026-11-12", pricesFrom: "list", pricesKey: undefined });
  assert.ok(priceGeneration() > gen, "a rate change bumps the generation the ledgers' caches key on");
  const saved = JSON.parse(readFileSync(join(stateDir, PRICE_FETCH_FILE), "utf8"));
  assert.equal(saved.good.fetchedAt, now);
  assert.ok(saved.good.rates["claude-fable-9"]);
  assert.equal(saved.lastError, undefined);

  installPriceList(null);
  assert.equal(rateFor("claude-fable-9"), null);
  const again = fake(PAGE_WITH_NEW);
  const pf2 = createPriceFetch({ stateDir, fetchText: again, now: () => now + DAY / 2, enabled: () => true, log: quiet });
  await pf2.start();
  pf2.stop();
  assert.equal(again.calls.length, 0, "a read under a day old is not fetched again");
  assert.ok(rateFor("claude-fable-9"), "the cached read is installed at boot");
});

test("a cached read is installed at any age, then refreshed when over a day old", async () => {
  const stateDir = dir();
  const t0 = Date.UTC(2026, 9, 1);
  const a = createPriceFetch({ stateDir, fetchText: fake(PAGE_WITH_NEW), now: () => t0, enabled: () => true, log: quiet });
  await a.start(); a.stop();
  installPriceList(null);
  const refresh = fake(PAGE);
  const b = createPriceFetch({ stateDir, fetchText: refresh, now: () => t0 + 40 * DAY, enabled: () => true, log: quiet });
  await b.start(); b.stop();
  assert.equal(refresh.calls.length, 1);
  assert.equal(rateFor("claude-fable-9"), null, "the newer page no longer lists it");
});

test("a bad page, a non-200 and a network failure keep the previous read and record why", async () => {
  const stateDir = dir();
  let now = Date.UTC(2026, 10, 12);
  const f = fake(PAGE_WITH_NEW, "# Pricing\n\nThe table moved.", { ok: false, why: "Anthropic's price page answered 503 instead of the page." });
  const pf = createPriceFetch({ stateDir, fetchText: f, now: () => now, enabled: () => true, log: quiet });
  assert.equal(await pf.fetchNow(), true);
  const good = pf.state().good;

  now += DAY;
  assert.equal(await pf.fetchNow(), false);
  assert.ok(rateFor("claude-fable-9"), "a page the parser refuses changes no price");
  assert.equal(pf.state().good, good);
  assert.match(pf.state().lastError, /model table/);

  now += DAY;
  assert.equal(await pf.fetchNow(), false);
  assert.match(pf.state().lastError, /503/);
  const saved = JSON.parse(readFileSync(join(stateDir, PRICE_FETCH_FILE), "utf8"));
  assert.equal(saved.good.fetchedAt, good.fetchedAt, "the good read on disk survives the failures");
  assert.equal(saved.lastTryAt, now);
});

test("an unpriced Anthropic model asks for the page at most once an hour, and only for recent tokens", async () => {
  const stateDir = dir();
  let now = Date.UTC(2026, 10, 12, 12);
  const f = fake(PAGE);
  const pf = createPriceFetch({ stateDir, fetchText: f, now: () => now, enabled: () => true, log: quiet });
  onPriceGap((m, at) => pf.noteGap(m, at));

  notePriceGap("claude-fable-9", now - 60_000);
  await pf.fetchNow(); // settle the one in flight
  assert.equal(f.calls.length, 1);
  notePriceGap("claude-fable-9", now - 60_000);
  notePriceGap("claude-fable-9", now - 30_000);
  await pf.fetchNow();
  assert.equal(f.calls.length, 2, "the two gaps inside the hour fetched nothing (the second call is fetchNow's own)");

  now += 3_600_000 + 1;
  notePriceGap("claude-fable-9", now - 60_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 3, "past the hour, a gap fetches again");

  now += 3_600_000 + 1;
  notePriceGap("claude-fable-9", now - 30 * DAY);
  notePriceGap("gpt-oss:20b", now);
  notePriceGap("<synthetic>", now);
  notePriceGap("claude-opus-5", now);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 3, "old tokens, a local model, <synthetic> and a priced model ask for nothing");
  assert.deepEqual(Object.keys(pf.state().gaps), ["claude-fable-9"]);

  const row = priceListRow(pf.state(), true, now);
  assert.equal(row.status, "warn");
  assert.match(row.detail, /claude-fable-9 is not on Anthropic's price page yet; its tokens are counted but not priced\./);
});

test("WATERPLANE_PRICE_FETCH=0 never fetches, still installs nothing new, and the row says why", async () => {
  const stateDir = dir();
  const f = fake(PAGE_WITH_NEW);
  const pf = createPriceFetch({ stateDir, fetchText: f, now: () => Date.UTC(2026, 10, 12), enabled: () => false, log: quiet });
  onPriceGap((m, at) => pf.noteGap(m, at));
  await pf.start(); pf.stop();
  assert.equal(await pf.fetchNow(), false);
  notePriceGap("claude-fable-9", Date.UTC(2026, 10, 12));
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 0);
  assert.equal(rateFor("claude-fable-9"), null);
  assert.deepEqual(priceListSource().pricesFrom, "builtin");
  const row = priceListRow(pf.state(), false);
  assert.equal(row.status, "pass");
  assert.match(row.detail, /Built-in prices dated \d{4}-\d{2}-\d{2} are used, because WATERPLANE_PRICE_FETCH=0/);
});

test("the row: a fresh read passes with its date, a week-old one warns with the last failure", () => {
  const now = Date.UTC(2026, 10, 20);
  const fresh = priceListRow({ good: { rates: {}, longPrompt: {}, fetchedAt: now - DAY } }, true, now);
  assert.equal(fresh.status, "pass");
  assert.equal(fresh.detail, "Prices read from Anthropic's price page on 2026-11-19.");
  assert.equal(fresh.id, "price-list");
  assert.equal(fresh.scope, "host");
  const stale = priceListRow({ good: { rates: {}, longPrompt: {}, fetchedAt: now - 8 * DAY }, lastError: "Anthropic's price page answered 503 instead of the page." }, true, now);
  assert.equal(stale.status, "warn");
  assert.match(stale.detail, /on 2026-11-12, over a week ago\. Last try: Anthropic's price page answered 503/);
});

test("a session's cost priced before the page was read is re-priced once the new rates are in", async () => {
  const { writeFileSync } = await import("node:fs");
  const { updateContextLog } = await import("../dist/ctxlog.js");
  const path = join(dir(), "conv.jsonl");
  const rec = { type: "assistant", timestamp: "2026-11-12T10:00:00.000Z", sessionId: "s",
    message: { id: "m1", role: "assistant", model: "claude-fable-9",
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  writeFileSync(path, JSON.stringify(rec) + "\n");
  const before = updateContextLog(path, null);
  assert.equal(before.cost.total, 0);
  assert.equal(before.unpriced, 1_000_000);
  const pf = createPriceFetch({ stateDir: dir(), fetchText: fake(PAGE_WITH_NEW), now: () => Date.UTC(2026, 10, 12), enabled: () => true, log: quiet });
  await pf.fetchNow();
  const after = updateContextLog(path, before);
  assert.equal(after.unpriced, 0, "the unchanged log was read again at the new rates");
  assert.equal(after.cost.total, 1);
});

test("WATERPLANE_PRICE_FETCH=0 after a cached read prices from the built-in table, not the cache", async () => {
  const stateDir = dir();
  const t0 = Date.UTC(2026, 9, 1);
  const a = createPriceFetch({ stateDir, fetchText: fake(PAGE_WITH_NEW), now: () => t0, enabled: () => true, log: quiet });
  await a.start(); a.stop();
  assert.equal(priceListSource().pricesFrom, "list");
  const f = fake(PAGE);
  const b = createPriceFetch({ stateDir, fetchText: f, now: () => t0 + DAY, enabled: () => false, log: quiet });
  await b.start(); b.stop();
  assert.equal(f.calls.length, 0);
  assert.equal(priceListSource().pricesFrom, "builtin");
  assert.equal(rateFor("claude-fable-9"), null);
});

test("the hourly limit survives a restart and counts the boot read too", async () => {
  const stateDir = dir();
  const now = Date.UTC(2026, 10, 12, 12);
  const a = createPriceFetch({ stateDir, fetchText: fake(PAGE), now: () => now, enabled: () => true, log: quiet });
  await a.start(); a.stop();
  const f = fake(PAGE);
  const b = createPriceFetch({ stateDir, fetchText: f, now: () => now + 60_000, enabled: () => true, log: quiet });
  b.noteGap("claude-fable-9", now);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 0, "a restart a minute after a read does not read again for a gap");
});

test("a gap is kept under the model's alias, and the row drops it once the model is priced", async () => {
  const stateDir = dir();
  const now = Date.UTC(2026, 10, 12, 12);
  const pf = createPriceFetch({ stateDir, fetchText: fake("not the page"), now: () => now, enabled: () => true, log: quiet });
  pf.noteGap("claude-fable-9-20261101[1m]", now - 60_000);
  await pf.fetchNow();
  assert.deepEqual(Object.keys(pf.state().gaps), ["claude-fable-9"]);
  assert.equal(priceListRow(pf.state(), true, now).status, "warn");
  installPriceList({ rates: { "claude-fable-9": { input: 1, output: 5, cacheRead: 0.1 } }, fetchedAt: now });
  assert.doesNotMatch(priceListRow(pf.state(), true, now).detail, /claude-fable-9/, "priced now, so not a gap any more");
});

test("the page is read only from Anthropic's own sites over HTTPS, redirects included", () => {
  assert.ok(priceHostOk("https://platform.claude.com/docs/en/about-claude/pricing.md"));
  assert.ok(priceHostOk("https://docs.anthropic.com/en/pricing.md"));
  assert.ok(priceHostOk("https://claude.com/pricing"));
  assert.equal(priceHostOk("http://platform.claude.com/x"), false);
  assert.equal(priceHostOk("https://evilclaude.com/x"), false);
  assert.equal(priceHostOk("https://claude.com.evil.example/x"), false);
  assert.equal(priceHostOk("not a url"), false);
});

test("welcome carries the installed read to the phone, and nothing when the built-in table is in use", () => {
  assert.deepEqual(welcomePrices(), {});
  const rates = { "claude-fable-9": { input: 1, output: 5, cacheRead: 0.1 } };
  installPriceList({ rates, fetchedAt: 5 });
  assert.deepEqual(welcomePrices(), { prices: { rates, fetchedAt: 5 } });
});
