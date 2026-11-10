/**
 * The Agent readings region's words: a total never without its split, an
 * absent reading quoted as the host said it, and no verdict words.
 *
 *     node --test packages/web/src/agentReadingsWords.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compactBeside, compactLine, escapedLines, exploreBeside, exploreLine, reworkLine, reworkWhole, weekCells, weekChip,
} from "./agentReadingsWords.ts";

const tot = (o) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 0, ...o });

test("rework names all three classes against the whole, and the bar's bag sums them", () => {
  const r = { totalTok: 1000, byClass: { rework: tot({ cacheRead: 250 }), feature: tot({ cacheRead: 50 }), unknown: tot({ cacheRead: 700 }) },
    sessions: { rework: 1, feature: 1, unknown: 3 }, repairRuns: 0 };
  assert.match(reworkLine(r), /^Rework 25% · feature 5% · unknown 70% of /);
  assert.equal(reworkWhole(r).cacheRead, 1000);
});

test("exploration and compaction lines print both counts the figure is made of", () => {
  const e = { sessions: 3, noEdit: 1, skipped: 4, medianTok: 1200, split: tot({ cacheRead: 1200 }), medianRequests: 1 };
  assert.match(exploreLine(e), /median of 3 fresh sessions, 1 request in/);
  assert.equal(exploreBeside(e), "1 fresh session never edited a file; 4 left out (forked, continued or headless).");
  const c = { committed: 4, compactions: 2, sessionsAll: 10, compactionsAll: 5 };
  assert.match(compactLine(c), /^0\.50 compactions per committed session — 2 compactions over 4 sessions/);
  assert.equal(compactBeside(c), "Every session that week: 5 compactions over 10 sessions.");
});

test("an absent count is the host's sentence, a zero is a zero", () => {
  const e = escapedLines({ crashMarks: { absent: "No exposure watch reading is stored for this repo." }, bugItems: 0 });
  assert.equal(e.crash, "Crash marks: No exposure watch reading is stored for this repo.");
  assert.equal(e.bugs, "Bugs on the backlog: 0 items added.");
});

test("the table marks a reading not taken with a dash, never 0", () => {
  const w = { week: "2026-11-09", explore: { absent: "x" }, rework: { absent: "y" }, compact: { absent: "z" },
    escaped: { crashMarks: { absent: "a" }, bugItems: 2 } };
  assert.deepEqual(weekCells(w), { explore: "–", rework: "–", compact: "–", crash: "–", bugs: "2" });
  assert.equal(weekChip("2026-11-09"), "11/9");
});

test("no verdict or status words in the region's sentences", () => {
  const src = readFileSync(new URL("./agentReadingsWords.ts", import.meta.url), "utf8");
  for (const w of [/\bgood\b/i, /\bbad\b/i, /\bhealthy\b/i, /\bworse\b/i, /\bbetter\b/i, /\bwarn/i, /\bfail/i]) assert.doesNotMatch(src, w);
});
