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
  assert.equal(exploreLine(e), "1.2k tokens sent before the first edit — the median of 3 fresh sessions that edited.");
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
  assert.deepEqual(weekCells(w), { spend: "–", sessions: "–", start: "–", explore: "–", looks: "–", requests: "–", rework: "–", compact: "–", crash: "–", bugs: "2" });
  assert.equal(weekChip("2026-11-09"), "11/9");
});

test("no verdict or status words in the region's sentences", () => {
  const src = readFileSync(new URL("./agentReadingsWords.ts", import.meta.url), "utf8");
  for (const w of [/\bgood\b/i, /\bbad\b/i, /\bhealthy\b/i, /\bworse\b/i, /\bbetter\b/i, /\bwarn/i, /\bfail/i]) assert.doesNotMatch(src, w);
});

test("spend and activity: money never without the request count it divides, the subagent share with its whole", async () => {
  const { spendLine, spendBeside, activityLine, readout } = await import("./agentReadingsWords.ts");
  const s = { requests: 10, pricedRequests: 8, usd: 4, ctxTok: 50_000 };
  assert.equal(spendLine(s), "$4.00 at list price over 10 requests — $0.50 per priced request.");
  assert.match(spendLine({ requests: 13688, pricedRequests: 13688, usd: 1 }), /over 13,688 requests/);
  assert.match(spendBeside(s), /^5k tokens of context sent per request; 2 requests on a model with no list price/);
  assert.match(spendBeside({ requests: 1, pricedRequests: 1, usd: 1 }), /not on this ledger's rows\.$/);
  assert.match(activityLine({ sessions: 3, started: 1, agents: 4, mainTok: 750, agentTok: 250 }), /^3 conversations spent tokens \(1 started this week\) with 4 subagents under them — subagents 25% of /);
  assert.equal(readout("2026-11-09", true, null, "No request."), "11/9 (so far): No request.");
});

test("start context: measured tokens, parts by their app-wide names in START_PARTS order, subagents on their own line", async () => {
  const { startLine, startPartLines, startSubLine, START_PARTS_CAP } = await import("./agentReadingsWords.ts");
  assert.equal(startLine({ median: 21000, n: 7 }), "21k tokens in the first request, measured — the median of 7 fresh interactive sessions.");
  const r = { fresh: 8, tok: { median: 21000, n: 7 },
    parts: [{ id: "claudeMd", chars: { median: 12000, n: 7 } }, { id: "skills", chars: { absent: "3 fresh interactive sessions that measured this part here; a median needs at least 5." } }],
    sub: { absent: "2 subagent logs with a first request here; a median needs at least 5." } };
  assert.deepEqual(startPartLines(r), [
    "instruction files: CLAUDE.md: 12k chars (7 sessions)",
    "skill listing: 3 fresh interactive sessions that measured this part here; a median needs at least 5.",
  ]);
  assert.equal(startSubLine(r), "Subagents: 2 subagent logs with a first request here; a median needs at least 5.");
  assert.match(START_PARTS_CAP, /measured/);
  assert.match(START_PARTS_CAP, /estimated/);
});

test("looks and requests: a median of counts keeps its half, and says how many sessions it is over", async () => {
  const { looksLine, requestsLine, weekCells } = await import("./agentReadingsWords.ts");
  assert.equal(looksLine({ median: 2.5, n: 6 }), "2.5 look calls before the first edit — the median of the same 6 sessions.");
  assert.equal(requestsLine({ median: 40, n: 5 }), "40 requests — the median of 5 fresh sessions that committed, each in the week it started.");
  const w = { week: "2026-11-09", start: { fresh: 5, tok: { median: 9000, n: 5 }, parts: [], sub: { absent: "s" } },
    explore: { sessions: 5, noEdit: 0, skipped: 0, medianTok: 10, split: tot({}), medianRequests: 1, looks: { median: 3, n: 5 } },
    requests: { absent: "r" }, rework: { absent: "y" }, compact: { absent: "z" }, escaped: { crashMarks: 0, bugItems: 0 } };
  const c = weekCells(w);
  assert.deepEqual([c.start, c.looks, c.requests], ["9k", "3", "–"]);
});
