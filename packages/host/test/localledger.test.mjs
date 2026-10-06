/**
 * claude-local's ledger: a CUT of Claude's jsonl ledger by model id, priced per model.
 *
 *     node --test packages/host/test/localledger.test.mjs
 *
 * What is pinned: only the non-Anthropic models are in it, per model and per
 * day; a loopback model is zero only because its catalogue says so; a model
 * with no price is a SENTENCE naming the file, never a $0; the person's file
 * cannot reprice a Claude model; and a broken price file is a sentence, not a
 * throw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUserPrices, emptyUserPrices } from "@waterplane/shared";
import { forgetCatalogueCache, localSliceLedger, modelOwner, readUserPrices, pricesFilePath, rememberCatalogues } from "../dist/localledger.js";

const T = (n) => ({ input: n, output: n, cacheRead: n * 10, cacheWrite: 0, cacheWrite1h: 0, turns: n });
const C = (usd) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd });
const slice = (model, n, usd = 0) => ({ model, totals: T(n), cost: C(usd) });
const Q = "qwen3-coder:30b-64k";
const R = "qwen/qwen3-coder";
const O = "claude-opus-5";

function doc() {
  return {
    totals: T(9), cost: C(5), models: [
      { key: O, label: O, ...T(4), cost: C(5), priced: true },
      { key: Q, label: Q, ...T(3), cost: C(0), priced: false },
      { key: R, label: R, ...T(2), cost: C(0), priced: false },
    ],
    days: [
      { day: "2026-09-29", ...T(4), cost: C(5), byModel: [slice(O, 4, 5)] },
      { day: "2026-09-30", ...T(3), cost: C(0), byModel: [slice(Q, 3)] },
      { day: "2026-10-01", ...T(2), cost: C(0), byModel: [slice(R, 2)] },
    ],
    scannedAt: 42,
  };
}
const opts = (o = {}) => ({ label: "Local", prices: emptyUserPrices(), pricesFile: "/cfg/prices.json", zeroCost: new Set(), ...o });

test("only the non-Anthropic models, per model and per day, in their own kinds", () => {
  const l = localSliceLedger(doc(), opts());
  assert.equal(l.available, true);
  assert.deepEqual(l.models.map((m) => m.key), [Q, R]);
  assert.deepEqual(l.totals, { kinds: { input: 5, output: 5, cacheRead: 50, cacheWrite: 0 }, turns: 5 });
  assert.deepEqual(l.days.map((d) => d.day), ["2026-09-30", "2026-10-01"]);
  assert.deepEqual(l.days[0].byModel.map((m) => m.key), [Q]);
  assert.equal(l.sessions, undefined, "no per-model conversation count — absent, never 0");
  assert.match(l.sliceOf, /non-Anthropic models in Claude Code's own logs/);
  assert.equal(l.scannedAt, 42);
  assert.equal(typeof l.lastAt, "number");
});

test("no local model ⇒ its sentence, never an empty ledger of zeros", () => {
  const d = doc();
  d.models = d.models.filter((m) => m.key === O);
  const l = localSliceLedger(d, opts());
  assert.equal(l.available, false);
  assert.match(l.reason, /No non-Anthropic model/);
});

test("money: loopback zero from the catalogue, the person's price, and a sentence for the rest", () => {
  const prices = parseUserPrices({ "qwen*": { input: 1, output: 2, cacheRead: 0.1, currency: "USD" } });
  const l = localSliceLedger(doc(), opts({ prices, zeroCost: new Set([Q]) }));
  const byKey = Object.fromEntries(l.cost.models.map((m) => [m.key, m]));
  // The catalogue's zero wins over a glob written for the hosted twin.
  assert.deepEqual(byKey[Q], { key: Q, currency: "USD", total: 0, source: "local" });
  assert.equal(byKey[R].source, "user");
  assert.equal(byKey[R].pattern, "qwen*");
  // 2 input, 2 output, 20 cache read tokens: tiny, but exactly the rates.
  assert.ok(Math.abs(byKey[R].total - (2 * 1 + 2 * 2 + 20 * 0.1) / 1e6) < 1e-15);
  assert.deepEqual(l.cost.totals.map((t) => t.currency), ["USD"]);

  const bare = localSliceLedger(doc(), opts());
  for (const m of bare.cost.models) {
    assert.ok("unpriced" in m, m.key);
    assert.match(m.unpriced, /\/cfg\/prices\.json/);
  }
  assert.deepEqual(bare.cost.totals, [], "nothing priced ⇒ no total at all, never $0");
});

test("the price file: missing is no problem, broken JSON is a sentence, a change is re-read", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-prices-"));
  const file = join(dir, "prices.json");
  const prev = process.env.WATERPLANE_PRICES;
  process.env.WATERPLANE_PRICES = file;
  try {
    assert.equal(pricesFilePath(), file);
    assert.deepEqual(readUserPrices().table, { entries: [], problems: [] });
    writeFileSync(file, "{ not json");
    assert.match(readUserPrices().table.problems[0], /could not be read as JSON/);
    writeFileSync(file, JSON.stringify({ "llama*": { input: 1, output: 1 } }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    const t = readUserPrices().table;
    assert.deepEqual(t.entries.map((e) => e.pattern), ["llama*"]);
    assert.deepEqual(t.problems, []);
  } finally {
    if (prev === undefined) delete process.env.WATERPLANE_PRICES; else process.env.WATERPLANE_PRICES = prev;
  }
});

test("several backends share Claude's logs: each model lands on exactly one tab", () => {
  const sharers = [{ id: "claude-local", ids: [Q] }, { id: "claude-endpoint", ids: [R] }];
  assert.equal(modelOwner(Q, sharers), "claude-local");
  assert.equal(modelOwner(R, sharers), "claude-endpoint");
  // In no catalogue: the first sharer (a model Ollama dropped still ran off-Anthropic).
  assert.equal(modelOwner("gone:7b", sharers), "claude-local");
  assert.equal(modelOwner(Q, []), null);
  const local = localSliceLedger(doc(), opts({ keep: (m) => modelOwner(m, sharers) === "claude-local" }));
  const hosted = localSliceLedger(doc(), opts({ keep: (m) => modelOwner(m, sharers) === "claude-endpoint" }));
  assert.deepEqual(local.models.map((m) => m.key), [Q]);
  assert.deepEqual(hosted.models.map((m) => m.key), [R]);
  assert.ok(local.days.every((d) => d.byModel.every((m) => m.key === Q)));
  const none = localSliceLedger(doc(), opts({ keep: () => false }));
  assert.equal(none.available, false);
  assert.match(none.reason, /No model of Local's/);
});

test("an endpoint whose catalogue is down keeps its models: the remembered catalogue decides, persisted across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-cat-"));
  forgetCatalogueCache();
  // Both catalogues up: remembered.
  let sharers = rememberCatalogues(dir, [{ id: "claude-local", ids: [Q] }, { id: "claude-endpoint", ids: [R] }]);
  assert.deepEqual(sharers.map((b) => b.known), [[Q], [R]]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "backend-catalogue.json"), "utf8")), { v: 1, ids: { "claude-local": [Q], "claude-endpoint": [R] } });
  // "Restart" (memory dropped), and the endpoint is unreachable: its live list is empty.
  forgetCatalogueCache();
  sharers = rememberCatalogues(dir, [{ id: "claude-local", ids: [Q] }, { id: "claude-endpoint", ids: [] }]);
  assert.equal(modelOwner(R, sharers), "claude-endpoint", "the endpoint's model stays on its tab while it is down");
  assert.equal(modelOwner(R, sharers.map((b) => ({ id: b.id, ids: b.ids }))), "claude-local", "without the memory it would have migrated");
  assert.equal(modelOwner(Q, sharers), "claude-local");
  assert.equal(modelOwner("never-listed:1b", sharers), "claude-local", "a model no catalogue ever listed still goes to the first");
  const hosted = localSliceLedger(doc(), opts({ keep: (m) => modelOwner(m, sharers) === "claude-endpoint" }));
  assert.deepEqual(hosted.models.map((m) => m.key), [R]);
  // A LIVE listing wins over a remembered one: the model moved to claude-local.
  sharers = rememberCatalogues(dir, [{ id: "claude-local", ids: [Q, R] }, { id: "claude-endpoint", ids: [] }]);
  assert.equal(modelOwner(R, sharers), "claude-local");
  // A corrupt file is an empty memory, never a throw.
  writeFileSync(join(dir, "backend-catalogue.json"), "{not json");
  forgetCatalogueCache();
  sharers = rememberCatalogues(dir, [{ id: "claude-endpoint", ids: [] }]);
  assert.deepEqual(sharers[0].known, []);
});
