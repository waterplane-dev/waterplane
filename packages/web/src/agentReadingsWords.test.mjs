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

test("start context: measured tokens, parts grouped by whose they are (the repo's, yours, the CLI's, not split), subagents on their own line", async () => {
  const { startLine, startPartLines, startPartGroups, startSubLine, START_PARTS_CAP } = await import("./agentReadingsWords.ts");
  assert.equal(startLine({ median: 21000, n: 7 }), "21k tokens in the first request, measured — the median of 7 fresh interactive sessions.");
  const r = { fresh: 8, tok: { median: 21000, n: 7 },
    parts: [
      { id: "projectMd", chars: { median: 12000, n: 7 } },
      { id: "userMd", chars: { median: 3000, n: 7 } },
      { id: "system", chars: { median: 9000, n: 7 } },
      { id: "skills", chars: { absent: "3 fresh interactive sessions that measured this part here; a median needs at least 5." } },
      { id: "aNewPart", chars: { median: 10, n: 6 } },
    ],
    sub: { absent: "2 subagent logs with a first request here; a median needs at least 5." } };
  const g = startPartGroups(r);
  assert.deepEqual(g.map((x) => [x.id, x.heading]), [["repo", "the repo's"], ["yours", "yours"], ["cli", "the CLI's"], ["mixed", "not split"]]);
  assert.deepEqual(g[0].lines, ["CLAUDE.md, project: 12k chars (7 sessions)"]);
  assert.deepEqual(g[1].lines, ["CLAUDE.md, global and local: 3k chars (7 sessions)"]);
  // What the log does not split stays "not split", with the sentence saying why; an unknown part is named as such there.
  assert.match(g[3].note, /does not|without saying/);
  assert.deepEqual(g[3].lines, [
    "skill listing (the repo's and yours): 3 fresh interactive sessions that measured this part here; a median needs at least 5.",
    "a part this app version cannot name (aNewPart): 10 chars (6 sessions)",
  ]);
  assert.equal(startPartLines(r).length, 5);
  // A group with nothing measured has no heading.
  assert.deepEqual(startPartGroups({ ...r, parts: [r.parts[2]] }).map((x) => x.id), ["cli"]);
  assert.equal(startSubLine(r), "Subagents: 2 subagent logs with a first request here; a median needs at least 5.");
  assert.match(START_PARTS_CAP, /measured/);
  assert.match(START_PARTS_CAP, /estimated/);
});

test("skill loads: the mean per session and the share that loaded one, with the n — never a median", async () => {
  const { skillsLine, fmtMean } = await import("./agentReadingsWords.ts");
  assert.equal(skillsLine({ mean: 0.4, share: 0.25, n: 12 }), "0.40 skill loads per session on average; 25% of 12 fresh sessions loaded at least one, each in the week it started.");
  assert.equal(fmtMean(0.04), "0.04");
  assert.equal(fmtMean(2.25), "2.3");
  assert.doesNotMatch(skillsLine({ mean: 1, share: 1, n: 5 }), /median/);
});

test("where the readings come from: one sentence, this desktop against git (R-metrics-069)", async () => {
  const { agentSourceText } = await import("@waterplane/shared");
  const t = agentSourceText();
  assert.match(t, /this desktop/);
  assert.match(t, /conversation logs, settings, memory, model and CLI/);
  assert.match(t, /git/);
  assert.match(t, /same on every desktop/);
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

test("headline: dollars at list price with tokens beside, its split by whose, tokens alone where unpriced (R-metrics-070)", async () => {
  const { setupCostFigure, setupCostLine, setupCostBeside, setupSplitLine, headlineHelp, PROBE_NONE } = await import("./agentReadingsWords.ts");
  const c = { tok: 3_000_000, usd: 0.9, startTok: 20000, requests: 150, n: 40, nPriced: 40, models: ["claude-opus-5-5"],
    split: [{ group: "repo", label: "the repo's", share: 0.2, chars: 2 }, { group: "yours", label: "yours", share: 0.3, chars: 3 }, { group: "cli", label: "the CLI's", share: 0.5, chars: 5 }],
    nSplit: 38, from: 0, to: 1 };
  assert.equal(setupCostFigure(c), "$0.90");
  assert.equal(setupCostLine(c), "per median session at list price · 3M tokens");
  assert.equal(setupSplitLine(c), "Whose it is (of the 38 of 40 sessions that recorded parts, pooled over characters): the repo's 20% · yours 30% · the CLI's 50%.");
  assert.equal(setupSplitLine({ ...c, nSplit: c.n }), "Whose it is: the repo's 20% · yours 30% · the CLI's 50%.", "same sessions as the figure: no basis to state");
  assert.equal(setupCostBeside(c, 14, "built-in price table from 2026-11-12"), "40 fresh interactive sessions, last 14 days · built-in price table from 2026-11-12 · errs low.");
  assert.match(headlineHelp(c), /start × requests .* median start 20k tokens, median 150 requests, on claude-opus-5-5; the split is over 38 sessions/);
  assert.doesNotMatch(headlineHelp(c), /From this desktop/, "the source is the caption under the headline, not repeated in its `?`");
  const mixed = { ...c, nPriced: 12 };
  assert.equal(setupCostLine(mixed), "per median priced session at list price (12 of 40 sessions had a list price) · 3M tokens per median session over all 40");
  const unpriced = { ...c, usd: undefined, nPriced: 30 };
  assert.equal(setupCostFigure(unpriced), "3M tokens");
  assert.equal(setupCostLine(unpriced), "per median session; no dollar figure: 10 sessions of 40 ran a model with no list price.");
  assert.match(setupSplitLine({ ...c, split: [] }), /not measured/);
  assert.match(PROBE_NONE, /none/);
});

test("where the readings come from is said ONCE in the region, and on every card only in its `?` (R-metrics-069)", () => {
  const src = readFileSync(new URL("./AgentReadingsRegion.tsx", import.meta.url), "utf8");
  // The Headline's caption and its `?` share one call; every Reading's `?` quotes it; no card prints it visibly.
  assert.equal((src.match(/agentSourceText\(\)/g) ?? []).length, 2, "one in the Headline, one in the Reading's Explain");
  assert.match(src, /<Explain of=\{title\}>\{rule\} \{agentSourceText\(\)\}<\/Explain>/);
  assert.match(src, /<div className="rh-cap">\{source\}<\/div>/);
});

test("compare by model: no row unless two models have enough sessions; one pair, ratio and band word, model + CLI said (R-metrics-072)", async () => {
  const { byModelRow } = await import("./agentReadingsWords.ts");
  const none = { absent: "Only one model ran these sessions.", kind: "oneModel", models: [], unnamed: 0 };
  assert.equal(byModelRow([{ reading: "start", r: none }, { reading: "look", r: none }], 14), null);
  const side = (model, cli) => ({ model, n: 20, days: 7, value: 10, clis: [cli] });
  const r = (ratio, inside, extra = {}) => ({ reading: "look", days: 14, a: side("m1", "2.1.1"), b: side("m2", "2.1.2"), ratio, band: [0.8, 1.2], inside, others: [], unnamed: 0, ...extra });
  const row = byModelRow([
    { reading: "start", r: r(1.02, true) },
    { reading: "look", r: r(0.394, false, { cliTogether: true }) },
    { reading: "req", r: { absent: "too few", kind: "tooFew", models: [], unnamed: 0 } },
  ], 14);
  assert.equal(row.line, "By model, last 14 days, m2 against m1: start context ×1.02, within normal variation · looks before the first edit ×0.39, outside normal variation · requests per committing session not compared.");
  assert.deepEqual(row.notes, [], "the CLI note follows the first compared reading's pair");
  const cli = byModelRow([{ reading: "look", r: r(0.4, false, { cliTogether: true }) }], 14);
  assert.match(cli.notes[0], /^Every m1 session here ran CLI 2\.1\.1, every m2 session CLI 2\.1\.2: the model and the CLI version changed together/);
});

test("read again re-reads the headline's points and markers too, not only the weekly doc", () => {
  const src = readFileSync(new URL("./AgentReadingsRegion.tsx", import.meta.url), "utf8");
  assert.match(src, /const readAgain = \(\) => \{ res\.reload\(\{ quiet: true \}\); pts\.reload\(\{ quiet: true \}\); mk\.reload\(\{ quiet: true \}\); probeView\.reload\(\{ quiet: true \}\); probes\.reload\(\{ quiet: true \}\); \};/);
  assert.match(src, /<RefreshKey busy=\{busy\} [^>]*onClick=\{readAgain\} \/>/);
  assert.match(src, /<Headline pts=\{pts\} mk=\{mk\} probes=\{probes\} \/>/, "the headline reads the region's resources, not its own");
});

test("R-metrics-073: compare setups words — two figures side by side, never a ranking; the repo half flagged when not identical", async () => {
  const w = await import("./agentReadingsWords.ts");
  const theirs = { kind: "agent-setup-block", schema: 1, from: "Ben", backend: "claude", models: ["claude-opus-4-1"], cli: ["2.1.300"],
    repo: { name: "waterplane", key: "0123456789abcdef" }, days: { from: "2026-10-31", to: "2026-11-14" }, startTok: 41000, groups: [] };
  assert.equal(w.shareRowLine("yours", 3000, 4500, "Ben"), "yours: you 3k chars · Ben 4.5k chars");
  assert.equal(w.shareRowLine("yours", undefined, 4500, "Ben"), "yours: you – · Ben 4.5k chars");
  const halves = ["identical", "differs", "otherRepo", "unknownRepo"].map((h) => w.shareRepoHalfText(h, theirs));
  assert.equal(new Set(halves).size, 4);
  assert.match(halves[0], /identical: the files the log types Project, normally committed/);
  assert.match(halves[1], /differs, which committed files would not/);
  assert.equal(w.shareStartLine(theirs, "Ben"), "Ben: start 41k tokens, the median first request");
  assert.equal(w.shareProbeLine(theirs, "Ben"), "Ben: no search test in the block");
  assert.equal(w.shareProbeLine({ ...theirs, probe: { day: "2026-11-13", kind: "models", correct: 0.9, tokPerQuestion: 31235, repeats: 3 } }, "Ben"),
    "Ben: search test on 2026-11-13 (model against model), 90% right, 31.2k tokens a question, 3 repeats");
  // The line names the model and how many questions; a note says when the two probes are not one setup difference.
  const withProbe = (probe) => ({ ...theirs, probe: { day: "2026-11-13", kind: "baseline", correct: 0.9, tokPerQuestion: 31235, repeats: 3, ...probe } });
  assert.equal(w.shareProbeLine(withProbe({ model: "haiku", questions: 20 }), "Ben"),
    "Ben: search test on 2026-11-13 (a baseline) on haiku, 20 questions, 90% right, 31.2k tokens a question, 3 repeats");
  const anna = withProbe({ model: "haiku", questions: 20, draw: "aaaaaaaa" });
  assert.equal(w.shareProbeNote(anna, withProbe({ model: "haiku", questions: 20, draw: "aaaaaaaa" })), "");
  assert.match(w.shareProbeNote(anna, withProbe({ model: "opus", questions: 20, draw: "bbbbbbbb" })), /different models \(haiku and opus\).*not the same ones\.$/);
  assert.match(w.shareProbeNote(anna, withProbe({})), /older version does not name the model.*older version does not say which questions/);
  assert.equal(w.shareProbeNote(null, anna), "");
  assert.equal(w.shareProbeNote(anna, theirs), "");
  // No cost figure travels (a behaviour reading), and the words say so.
  assert.match(w.SHARE_LEAVES, /no cost figure/);
  assert.doesNotMatch(w.SHARE_LEAVES, /setup cost figure/);
  assert.match(w.SHARE_CAPTION, /setup, not skill/);
  assert.match(w.SHARE_LEAVES, /No session counts, no cost figure, file, skill or plugin names, prompts, paths/);
  assert.match(w.shareSavedText(".claude/outbox/setup-ana-2026-11-14.json"), /\.claude\/outbox\/setup-ana-2026-11-14\.json.*not committed/);
  assert.equal(w.shareImportedText("Ben", ["markers", "sessions"]), "Imported Ben's setup; 2 fields this phone does not read were left out.");
  for (const s of [...halves, w.SHARE_CAPTION, w.SHARE_HELP, w.shareRowLine("a", 1, 2, "B")]) {
    for (const bad of [/\branks?\b/i, /\bwinner\b/i, /\bbest\b/i, /\bahead\b/i, /\bbehind\b/i, /\bmore efficient\b/i]) assert.doesNotMatch(s, bad);
  }
});

test("R-metrics-073: the share card asks with ConfirmButton, never window.confirm, and previews the exact text it sends", () => {
  const src = readFileSync(new URL("./SetupShareCard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /window\.confirm/);
  assert.match(src, /<ConfirmButton/);
  assert.match(src, /setupShareText\(block\)/);
});
