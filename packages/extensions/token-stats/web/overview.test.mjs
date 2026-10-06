import test from "node:test";
import assert from "node:assert/strict";
import { claudeCard, guestCard, ledgerCard, lastActiveDay, lastDayWords } from "./overview.ts";

const T = (n) => ({ input: n, output: n, cacheRead: n * 10, cacheWrite: n, cacheWrite1h: 0, turns: n });

test("each card carries its total WITH the split it is made of, in its own kinds", () => {
  const c = claudeCard({ totals: T(2), days: [{ day: "2026-09-29", ...T(1) }, { day: "2026-09-30", ...T(0) }] }, "Anthropic models only");
  assert.equal(c.total, 26);
  assert.deepEqual(c.rows.map((r) => r.kind), ["cacheRead", "cacheWrite", "input", "output"]);
  assert.equal(c.rows.reduce((a, r) => a + r.n, 0), c.total);
  assert.equal(c.lastDay, "2026-09-29", "an empty trailing day is not the last active one");
  assert.equal(c.scope, "Anthropic models only");

  const o = guestCard("guestcli", "guestcli", { kinds: { input: 1, output: 2, reasoning: 3, cacheRead: 0, cacheWrite: 0 }, turns: 1, lastDay: "2026-09-01", nothing: "-" });
  assert.equal(o.total, 6);
  assert.ok(o.rows.some((r) => r.kind === "reasoning"), "a guest's own kind is its own row, never folded into output");
  assert.equal(o.lastDay, "2026-09-01");
  assert.equal(o.turns, 1);
});

test("an unreadable or empty ledger is a SENTENCE, never a zero", () => {
  assert.equal(claudeCard(null).total, undefined);
  assert.match(claudeCard(null).absent, /not been read/);
  assert.match(claudeCard({ totals: T(0), days: [] }).absent, /nothing counted/);
  assert.equal(guestCard("g", "g", { absent: "no store here" }).absent, "no store here");
  assert.equal(guestCard("g", "g", { kinds: { input: 0 }, lastDay: null, nothing: "readable, nothing counted" }).absent, "readable, nothing counted");
  const l = ledgerCard("claude-local", "Local", { available: false, reason: "No non-Anthropic model has run" });
  assert.equal(l.absent, "No non-Anthropic model has run");
  assert.equal(l.total, undefined);
});

test("a billed unit rides on its own line, never added to the tokens", () => {
  const c = ledgerCard("copilot", "Copilot", {
    available: true, totals: { kinds: { input: 10, output: 5 }, turns: 2 },
    days: [{ day: "2026-09-02", kinds: { input: 10, output: 5 }, turns: 2 }], models: [],
    unit: { name: "premium requests", perDay: { "2026-09-02": 3 } }, firstAt: 1, lastAt: 2, scannedAt: 3,
  });
  assert.equal(c.total, 15);
  assert.deepEqual(c.billed, { name: "premium requests", total: 3 });
  assert.equal(c.lastDay, "2026-09-02");
});

test("a slice of another ledger says what it is cut from", () => {
  const c = ledgerCard("claude-local", "Local", {
    available: true, totals: { kinds: { input: 1 }, turns: 1 }, days: [], models: [],
    sliceOf: "the non-Anthropic models in Claude Code's own logs", firstAt: null, lastAt: null, scannedAt: 1,
  });
  assert.match(c.scope, /cut from the non-Anthropic models/);
  assert.equal(c.lastDay, null);
  assert.equal(lastDayWords(c.lastDay, String), "no dated activity");
  assert.equal(lastDayWords("2026-09-30", (d) => `<${d}>`), "last active <2026-09-30>");
});

test("lastActiveDay walks back from the end", () => {
  assert.equal(lastActiveDay([{ day: "a", n: 1 }, { day: "b", n: 0 }], (d) => d.n > 0), "a");
  assert.equal(lastActiveDay([]), null);
});
