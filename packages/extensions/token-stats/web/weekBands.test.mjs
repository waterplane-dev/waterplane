/**
 * The week card's pure half, pinned without a browser.
 *
 *     node --test packages/extensions/token-stats/web/weekBands.test.mjs
 *
 * Colour is identity here: a repo's hue must follow the REPO, never its rank in one column or
 * one re-read, and there are four validated hues, never a generated fifth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { foldLaunches, LAUNCH_KIND_WORD, rankRepos, weekCut, windowStartHour, zeroCost, zeroTotals } from "@waterplane/shared";
import {
  calText, columnBands, convoInWeek, docFor, foldStateText, hourText, legendEntries, listedText, moreText,
  OTHER_SLOT, priced, REPO_SLOTS, repoSlots, rowFacts, scopeSpan, usdOrTok, WEEK_MS, weekCaption, weekSpan,
} from "./weekBands.ts";

const HOUR = 3_600_000;
const r = (repo, usd) => ({ repo, label: repo.split("/").pop(), totals: zeroTotals(), cost: { ...zeroCost(), total: usd } });

test("four slots, then one fold; fewer than four repos ⇒ no fold", () => {
  assert.equal(REPO_SLOTS, 4);
  const s = repoSlots(["/a", "/b", "/c", "/d", "/e", "/f"]);
  assert.deepEqual([...s.entries()], [["/a", 0], ["/b", 1], ["/c", 2], ["/d", 3]]);
  assert.equal(s.has("/e"), false);
  const legend = legendEntries(["/a", "/b", "/c", "/d", "/e"].map((k) => ({ repo: k, label: k })), s);
  assert.equal(legend.length, 5);
  assert.equal(legend[4].slot, OTHER_SLOT);

  const few = repoSlots(["/a", "/b"]);
  const legend2 = legendEntries([{ repo: "/a", label: "a" }, { repo: "/b", label: "b" }], few);
  assert.deepEqual(legend2.map((e) => e.slot), [0, 1]);
});

test("a repo keeps its slot when another overtakes it, and a newcomer takes the free one", () => {
  const first = repoSlots(["/a", "/b", "/c", "/d", "/e"]);
  const next = repoSlots(["/c", "/a", "/e", "/b", "/d"], first);
  assert.equal(next.get("/a"), 0);
  assert.equal(next.get("/b"), 1);
  assert.equal(next.get("/c"), 2);
  // /d fell out of the top four; /e takes its slot rather than reshuffling the others.
  assert.equal(next.get("/e"), 3);
  assert.equal(next.has("/d"), false);
});

test("a column stacks in VALUE space, slotted repos in slot order from the bottom, the fold on top", () => {
  const slots = repoSlots(["/a", "/b"]);
  const bands = columnBands([r("/x", 3), r("/b", 5), r("/a", 2), r("/y", 1), r("/z", 0)], slots);
  assert.deepEqual(bands.map((b) => [b.slot, b.v0, b.v1]), [[0, 0, 2], [1, 2, 7], [OTHER_SLOT, 7, 11]]);
  // A repo that spent nothing is not a band.
  assert.equal(bands.some((b) => b.key === "/z"), false);
});

test("an hour's answer carries its split and its session count", () => {
  const t = new Date(2026, 9, 6, 14).getTime(); // a Tuesday
  const b = { hour: "", t, usd: 31, tok: 1, byRepo: [r("/tiptoi", 20), r("/garmin", 9), r("/x", 1), r("/y", 1)], convoIds: ["1", "2", "3", "4", "5", "6", "7"] };
  assert.equal(hourText(b), "Tue 14:00–15:00 · $31.00 · tiptoi $20.00, garmin $9.00, 2 others · 7 sessions");
  // Sessions the cap folded ran in that hour too: the count is all of them, listed or not.
  assert.match(hourText({ ...b, restConvos: 5 }), / · 12 sessions$/);
});

test("the week span needs a FUTURE reset, starts on the NEAREST hour, and the live week reuses the week read", () => {
  const now = Date.now();
  assert.equal(weekSpan(null, now), null);
  assert.equal(weekSpan({ weeklyResetAt: now - 1 }, now), null);
  const w = weekSpan({ weeklyResetAt: now + 2 * HOUR }, now);
  assert.equal(w.openedAt, now + 2 * HOUR - WEEK_MS);
  // `from` is SENT on the hour — the nearest one to the reset — so the host's floor is the identity.
  assert.equal(w.from, windowStartHour(w.openedAt));
  assert.equal(new Date(w.from).getMinutes(), 0);
  assert.equal(w.key, `${w.from}`);
  // Thu 18:59: the week's read starts 19:00, never 18:00 (59 minutes of last week, ≈ 4 points).
  const thu = new Date(2026, 9, 8, 18, 59).getTime();
  assert.equal(weekSpan({ weeklyResetAt: thu }, thu - HOUR).from, new Date(2026, 9, 1, 19, 0).getTime());
  assert.equal(scopeSpan({ id: "week", back: 0, fromHour: w.from, resetAt: now + 2 * HOUR }, w), "week");
  assert.equal(scopeSpan(null, w), null);
  // Any other cut reads its own span, ending where the NEXT window's cut starts.
  const h0 = new Date(2026, 9, 6, 9, 0).getTime();
  const s = scopeSpan({ id: "session", back: 1, fromHour: h0, resetAt: h0 + 5 * HOUR + 20 * 60_000 }, w);
  assert.deepEqual(s, { from: h0, toHour: h0 + 5 * HOUR, key: `${h0}:${h0 + 5 * HOUR}` });
});

test("the caption says which way the first hour errs: whole and wider, or minutes left out", () => {
  const thu = new Date(2026, 9, 1, 18, 59).getTime(); // opened Thu 18:59
  const doc = { from: windowStartHour(thu), fromHour: windowStartHour(thu) };
  const cap = weekCaption(doc, thu, thu + 2 * 24 * HOUR + 5 * HOUR);
  assert.equal(cap, "Since the weekly reset, Thu 18:59 — 2 d 5 h ago: the first minute of the week falls before the first column and is left out.");
  const early = new Date(2026, 9, 1, 18, 20).getTime();
  assert.match(weekCaption({ fromHour: windowStartHour(early) }, early, early + HOUR), /: the first hour is counted whole, 20 min wider than the week\.$/);
  const onHour = new Date(2026, 9, 1, 19, 0).getTime();
  assert.equal(weekCaption({ fromHour: onHour }, onHour, onHour + HOUR), "Since the weekly reset, Thu 19:00 — 1 h ago.");
});

test("a conversation wears the week's points only from the cut's own left edge", () => {
  const thu = new Date(2026, 9, 1, 18, 59).getTime();
  const edge = new Date(2026, 9, 1, 19, 0).getTime();
  assert.equal(convoInWeek({ firstAt: edge }, thu), true);
  assert.equal(convoInWeek({ firstAt: edge - 30_000 }, thu), false);
  assert.equal(convoInWeek({ firstAt: edge }, edge), true);
  assert.equal(convoInWeek({ firstAt: null }, thu), false);
});

test("a document is drawn only for the span it answers, and only whole", () => {
  const doc = { from: 5, to: 9, fromHour: 0, hours: [], convos: [], cost: zeroCost(), agentCost: zeroCost() };
  assert.equal(docFor(doc, 5), doc);
  assert.equal(docFor(doc, 6), null);
  assert.equal(docFor({ ...doc, convos: undefined }, 5), null);
  assert.equal(docFor(null, 5), null);
});

test("four read states, four sentences; an older host is named", () => {
  const texts = ["loading", "offline", "error"].map((state) => foldStateText({ state, error: "404 /api/costwindow" }, "window"));
  assert.equal(new Set(texts).size, 3);
  assert.match(texts[2], /predates/);
  assert.match(foldStateText({ state: "error", error: "500 x" }, "week"), /could not fold/);
});

test("the calibration sentence, or its refusal; nothing without a reading", () => {
  assert.equal(calText(null), null);
  assert.match(calText({ usdPerPt: 14, usd: 140, dPts: 10, stretches: 2 }), /\$14\.00 per weekly point, measured over 2 stretches/);
  assert.match(calText({ why: "unstable" }), /not shown/);
});

test("an unpriced figure reads in tokens, never $0; nothing measured is absent", () => {
  assert.equal(usdOrTok(12.5, 1e6), "$12.50");
  assert.equal(usdOrTok(0, 1_400_000), "1.4M tokens");
  assert.equal(usdOrTok(0, 0), null);
  assert.equal(usdOrTok(Number.NaN, 2000), "2k tokens");
  assert.equal(priced(0), false);
  assert.equal(priced(0.01), true);
});

test("an all-time conversation wears this week's points only when it ran wholly inside the week", () => {
  const from = new Date(2026, 9, 6, 14, 20).getTime();
  const top = new Date(2026, 9, 6, 14).getTime();
  assert.equal(convoInWeek({ firstAt: top }, from), true, "a week opening at :20 counts its first hour whole, as the cut does");
  assert.equal(convoInWeek({ firstAt: top }, new Date(2026, 9, 6, 14, 40).getTime()), false, "one opening at :40 starts on the next hour");
  assert.equal(convoInWeek({ firstAt: top + 5 * HOUR }, from), true);
  assert.equal(convoInWeek({ firstAt: new Date(2026, 7, 20).getTime() }, from), false, "an August conversation");
  assert.equal(convoInWeek({ firstAt: null }, from), false);
  assert.equal(convoInWeek({ firstAt: top }, null), false, "no week, no points");
});

// A doc with two listed sessions and 40 folded ones of one fan-out — the shapes the cap ships.
const tot = (n) => ({ ...zeroTotals(), input: n });
const cost = (usd) => ({ ...zeroCost(), total: usd });
const listed = (id, repo, usd, hour) => ({
  id, repo, label: repo.slice(1), firstAt: null, lastAt: null, totals: tot(100), cost: cost(usd), agentTotals: zeroTotals(),
  agentCost: zeroCost(), agents: 0, byModel: [], agentByModel: [], byHour: [{ hour, usd, tok: 100 }], live: false,
  launch: { kind: "fanout", runId: "run1", label: "architect review" },
});
const folded = { repo: "/c", label: "c", launch: { kind: "fanout", runId: "run1" }, count: 40, agents: 0, totals: tot(4000),
  cost: cost(8), agentTotals: zeroTotals(), agentCost: zeroCost(), byModel: [], firstAt: null, lastAt: null };
const capped = {
  from: 0, to: 1, fromHour: 0, convos: [listed("a", "/a", 30, "2026-10-06T14"), listed("b", "/b", 10, "2026-10-06T15")],
  hours: [{ hour: "2026-10-06T14", t: 1, totals: tot(2100), cost: cost(34), byRepo: [], byModel: [], restConvos: 20 }],
  convosTotal: 42, rest: [folded], totals: tot(4200), cost: cost(48), agentTotals: zeroTotals(), agentCost: zeroCost(),
  unpriced: zeroTotals(), pricesAsOf: "", scannedAt: 0,
};

test("a capped list says n of N, and each row counts its folded sessions in", () => {
  const cut = weekCut(capped);
  assert.equal(listedText(capped.convos.length, cut), "Lists 2 of 42 sessions — 40 cheaper sessions not listed · $8.00, counted in every total above.");
  assert.equal(listedText(1, { total: 1, restText: () => null }), null);
  const repos = rankRepos(capped.convos, capped.rest);
  assert.equal(repos.reduce((s, r) => s + r.cost.total, 0), 48, "the repo rows add up to the week");
  const c = repos.find((r) => r.repo === "/c");
  assert.equal(rowFacts(c.convos.length, c.more, 4000), "40 sessions · 4k tokens");
  assert.equal(moreText(c.more), "40 more sessions are in this row’s total, not listed.");
  assert.equal(moreText(0), null);
  // By launch the fan-out is ONE row with every target in it, worded by the shared table.
  const [run] = foldLaunches(capped.convos, capped.rest);
  assert.equal(run.cost.total, 48);
  assert.equal(`${LAUNCH_KIND_WORD[run.kind]} · ${rowFacts(run.convos.length, run.more, 4200)}`, "fan-out · 42 sessions · 4.2k tokens");
  // A picked hour lists what it can and names what it cannot.
  assert.equal(cut.restText("2026-10-06T14"), "20 more sessions in this hour are not listed");
});

test("a cost window over a ledger holding undated records is not drawn, and the shared sentence stands there (design round 4)", async () => {
  const { undatedText } = await import("@waterplane/shared");
  const doc = { from: 5, to: 9, fromHour: 0, hours: [], convos: [], cost: zeroCost(), agentCost: zeroCost() };
  assert.equal(docFor({ ...doc, undated: 0 }, 5).from, 5);
  assert.equal(docFor({ ...doc, undated: 3 }, 5), null);
  assert.equal(foldStateText({ state: "ready", data: { ...doc, undated: 3 } }, "week"), undatedText(3));
  assert.match(foldStateText({ state: "loading" }, "week"), /Folding/);
});
