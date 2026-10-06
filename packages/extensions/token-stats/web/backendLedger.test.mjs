import test from "node:test";
import assert from "node:assert/strict";
import { ledgerBackends, kindRows, ledgerHero, ledgerAbsent, unitHero, recentDays, dayWords, turnsWords, scopeWords, costLines } from "./backendLedger.ts";

const doc = (over = {}) => ({
  available: true, totals: { kinds: { input: 30, output: 10, cacheRead: 60 }, turns: 4 },
  days: [{ day: "2026-09-30", kinds: { input: 5, output: 5 }, turns: 1 }],
  models: [], sessions: 1, firstAt: 1, lastAt: 2, scannedAt: 3, ...over,
});

test("a total always comes with its split, largest first, shares of the sum", () => {
  const h = ledgerHero(doc());
  assert.equal(h.total, 100);
  assert.deepEqual(h.rows.map((r) => r.kind), ["cacheRead", "input", "output"]);
  assert.equal(h.rows[0].share, 0.6);
});

test("kinds that no turn reported are not rows; no kinds is no hero, not 0", () => {
  assert.deepEqual(kindRows({ input: 0, output: 0 }), []);
  assert.equal(ledgerHero(doc({ totals: { kinds: {}, turns: 0 } })), null);
});

test("absent says why: the host's sentence, or an honest default, never a zero", () => {
  assert.equal(ledgerAbsent("X", { available: false, reason: "no ledger here" }), "no ledger here");
  assert.match(ledgerAbsent("X", { available: false, reason: " " }), /no token ledger/);
  assert.match(ledgerAbsent("X", doc({ totals: { kinds: {}, turns: 0 } })), /nothing is counted/);
  assert.equal(ledgerAbsent("X", doc()), null);
  assert.equal(ledgerAbsent("X", null), null);
});

test("a unit ledger sums its per-day map and names the unit", () => {
  const u = unitHero(doc({ unit: { name: "premium requests", perDay: { "2026-09-30": 3, "2026-09-29": 2 } } }));
  assert.equal(u.total, 5);
  assert.equal(u.name, "premium requests");
  assert.deepEqual(u.days.map((d) => d.day), ["2026-09-29", "2026-09-30"]);
  assert.equal(unitHero(doc()), null);
});

test("recent days keep their split", () => {
  const r = recentDays(doc());
  assert.equal(r[0].total, 10);
  assert.equal(r[0].rows.length, 2);
});

test("ledger tabs: every described backend but claude and those an extension draws itself; no list, no tabs", () => {
  const l = [{ id: "claude", label: "Claude Code" }, { id: "guestcli", label: "guestcli" }, { id: "claude-local", label: "Claude (local)" }];
  assert.deepEqual(ledgerBackends(l, ["guestcli"]), [{ id: "claude-local", label: "Claude (local)" }]);
  assert.deepEqual(ledgerBackends(l).map((b) => b.id), ["guestcli", "claude-local"], "no view ⇒ the generic tab");
  assert.deepEqual(ledgerBackends(null), []);
});

test("a unit with no per-day counts is absent, never a 0 premium requests", () => {
  const d = doc({ totals: { kinds: {}, turns: 0 }, unit: { name: "premium requests", perDay: {} } });
  assert.equal(unitHero(d), null);
  assert.match(ledgerAbsent("X", d), /nothing is counted/);
  // A unit that DID count on a day still shows, beside kinds that are absent.
  const u = doc({ totals: { kinds: {}, turns: 0 }, unit: { name: "premium requests", perDay: { "2026-09-30": 2 } } });
  assert.equal(ledgerHero(u), null);
  assert.equal(unitHero(u).total, 2);
  assert.equal(ledgerAbsent("X", u), null);
});

test("unit and kinds stay separate: the unit total is never added to the token hero", () => {
  const d = doc({ unit: { name: "premium requests", perDay: { "2026-09-30": 7 } } });
  assert.equal(ledgerHero(d).total, 100);
  assert.equal(unitHero(d).total, 7);
});

test("available:false is its sentence, never a figure", () => {
  assert.equal(ledgerAbsent("Copilot", { available: false, reason: "Copilot keeps no ledger here" }), "Copilot keeps no ledger here");
});

test("a day with no kinds says nothing was counted, with no dangling dash", () => {
  const empty = recentDays(doc({ days: [{ day: "2026-09-29", kinds: {}, turns: 2 }] }))[0];
  assert.equal(dayWords(empty), "nothing counted, 2 turns");
  assert.ok(!/0 tokens/.test(dayWords(empty)));
  assert.equal(dayWords(recentDays(doc())[0]), "10 tokens, 1 turns — input 5, output 5");
});

test("a ledger with no session count says turns only — absent is not 0 sessions", () => {
  assert.equal(turnsWords(doc(), 4), "over 4 turns, 1 sessions");
  const { sessions: _s, ...noSessions } = doc();
  assert.equal(turnsWords(noSessions, 4), "over 4 turns");
});

test("a slice of Claude's ledger says so in its scope sentence", () => {
  assert.match(scopeWords("Local", doc({ sliceOf: "the non-Anthropic models in Claude Code's own logs" })), /^Local: the non-Anthropic models/);
  assert.match(scopeWords("Copilot", doc(), "premium requests"), /Copilot sessions only.*premium requests/);
});

test("the per-day model split rides through to the rows", () => {
  const d = doc({ days: [{ day: "2026-09-30", kinds: { input: 5 }, turns: 1, byModel: [{ key: "q", kinds: { input: 3, output: 1 }, turns: 1 }] }] });
  assert.deepEqual(recentDays(d)[0].byModel, [{ key: "q", total: 4, turns: 1 }]);
  assert.equal(recentDays(doc())[0].byModel, undefined, "absent stays absent");
});

test("money: one total per currency, a loopback zero says it runs here, an unpriced model is the host's sentence", () => {
  assert.equal(costLines(doc(), String), null, "a ledger the host never prices says nothing about money");
  const c = costLines(doc({
    cost: {
      totals: [{ currency: "EUR", total: 2 }, { currency: "USD", total: 1.5 }],
      models: [
        { key: "a", currency: "USD", total: 1.5, source: "user", pattern: "a*" },
        { key: "b", currency: "EUR", total: 2, source: "user" },
        { key: "loc", currency: "USD", total: 0, source: "local" },
        { key: "q", unpriced: "q: no price — add …" },
      ],
      pricesFile: "/p.json",
      problems: ["\"x\": bad"],
    },
  }), (n, cur) => `${n} ${cur}`);
  assert.deepEqual(c.totals, ["2 EUR", "1.5 USD"]);
  assert.match(c.lines[0].text, /your price for a\*/);
  assert.match(c.lines[2].text, /runs on this machine/);
  assert.deepEqual(c.lines[3], { key: "q", text: "q: no price — add …", priced: false });
  assert.deepEqual(c.problems, ["\"x\": bad"]);
});
