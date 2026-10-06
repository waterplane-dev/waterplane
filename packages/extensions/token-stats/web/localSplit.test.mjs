import test from "node:test";
import assert from "node:assert/strict";
import { tokenTotal } from "@waterplane/shared";
import { splitLocal, splitNoteText, allNoteText, subTotals, subCost, UNSPLIT } from "./localSplit.ts";

const T = (n, o = {}) => ({ input: n, output: n, cacheRead: n * 10, cacheWrite: n, cacheWrite1h: 0, turns: n, ...o });
const C = (usd) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd });
const Q = "qwen3-coder:30b-64k";
const O = "claude-opus-5";

/** Opus on both days, qwen on the second; one repo ran both. */
function doc(over = {}) {
  const slice = (model, n, usd) => ({ model, totals: T(n), cost: C(usd) });
  const days = [
    { day: "2026-09-29", ...T(2), cost: C(4), byModel: [slice(O, 2, 4)], agents: [{ model: O, count: 1 }] },
    { day: "2026-09-30", ...T(5), cost: C(6), byModel: [slice(O, 3, 6), slice(Q, 2, 0)], agents: [{ model: Q, count: 2 }] },
    { day: "2026-10-01", ...T(1), cost: C(0), byModel: [slice(Q, 1, 0)], agents: [] },
  ];
  return {
    totals: T(8), cost: C(10), subagentCost: C(1), unpriced: T(3), subagents: T(1), subagentLogs: 1, fastTurns: 0,
    days,
    hours: [{ hour: "2026-09-30T10", ...T(5), cost: C(6), byModel: [slice(O, 3, 6), slice(Q, 2, 0)] }],
    hoursFrom: 0, hourOfDay: Array.from({ length: 24 }, (_, h) => ({ hour: h, ...T(0) })),
    models: [
      { key: O, label: O, ...T(5), cost: C(10), priced: true },
      { key: Q, label: Q, ...T(3), cost: C(0), priced: false },
    ],
    repos: [{ key: "/r", label: "r", ...T(8), cost: C(10), byModel: [slice(O, 5, 10), slice(Q, 3, 0)] }],
    conversations: 2, pricesAsOf: "x", firstAt: 0, lastAt: 1, scannedAt: 2, logs: 2, reread: 0,
    ...over,
  };
}

test("no local model: nothing to cut, the screen is what it was", () => {
  const d = doc({ models: [doc().models[0]] });
  assert.equal(splitLocal(d), null);
});

test("the cut takes a local model out of every bucket that carries a model split, exactly", () => {
  const s = splitLocal(doc());
  assert.deepEqual(s.local, [Q]);
  assert.equal(s.shown, 1);
  assert.equal(s.all, 2);
  assert.equal(s.localTok, tokenTotal(T(3)));
  assert.deepEqual(s.doc.totals, T(5));
  assert.equal(s.doc.cost.total, 10);
  assert.deepEqual(s.doc.unpriced, T(0));
  assert.deepEqual(s.doc.models.map((m) => m.key), [O]);
  // The qwen-only day is gone; the mixed day keeps only opus, and its launches only opus's.
  assert.deepEqual(s.doc.days.map((d) => d.day), ["2026-09-29", "2026-09-30"]);
  const mixed = s.doc.days[1];
  assert.equal(tokenTotal(mixed), tokenTotal(T(3)));
  assert.equal(mixed.turns, 3);
  assert.deepEqual(mixed.byModel.map((b) => b.model), [O]);
  assert.deepEqual(mixed.agents, []);
  assert.equal(s.doc.hours[0].turns, 3);
  assert.deepEqual(s.doc.repos[0].byModel.map((b) => b.model), [O]);
  assert.equal(s.doc.repos[0].turns, 5);
});

test("the cut and the claude-local slice together are the whole ledger — every token exactly once", () => {
  const d = doc();
  const s = splitLocal(d);
  const local = d.models.filter((m) => m.key === Q).reduce((n, m) => n + tokenTotal(m), 0);
  assert.equal(tokenTotal(s.doc.totals) + local, tokenTotal(d.totals));
});

test("readings the store does not cross with the model are NAMED, not silently mixed", () => {
  const d = doc();
  const s = splitLocal(d);
  assert.deepEqual(s.unsplit, [...UNSPLIT]);
  assert.equal(s.doc.hourOfDay, d.hourOfDay, "the clock face is passed through uncut");
  assert.equal(s.doc.subagents, d.subagents);
  const note = splitNoteText(s, String, "Claude Code (local model)");
  assert.match(note, /^1 of 2 models shown/);
  assert.match(note, /on the Claude Code \(local model\) tab/);
  assert.match(note, /time-of-day clock/);
  assert.match(splitNoteText(s, String, null), /no tab for them/);
  assert.match(allNoteText(s, String), /^All 2 models shown, including one not Anthropic’s/);
});

test("an older host's document with no model split is REFUSED in words, never half-cut", () => {
  const d = doc();
  delete d.days[1].byModel;
  const r = splitLocal(d);
  assert.ok("refused" in r);
  assert.match(r.refused, /qwen3-coder/);
  assert.match(r.refused, /every model is counted/);
});

test("subtraction clamps at zero and never makes a bucket negative", () => {
  assert.deepEqual(subTotals(T(1), T(5)), T(0));
  assert.equal(subCost(C(1), C(3)).total, 0);
});
