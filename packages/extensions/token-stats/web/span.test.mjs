/**
 * The token sheet's one span (`span.ts`), pinned without a browser.
 *
 * Every case is a way the global filter could quietly stand for a different span than its chip
 * says: "last 30 days" counted as the last 30 ACTIVE days, a live window's edge days dropped,
 * hours past the span's end, and a clock folded off the wrong hour.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hourKeyMs, zeroCost, zeroTotals } from "@waterplane/shared";
import {
  calendarFrom, clockOf, daysCut, dayKeyOf, hoursCover, isLiveSpan, spanDays, spanHours, spanRange,
} from "./span.ts";

const day = (key, input, extra = {}) => ({ day: key, ...zeroTotals(), input, turns: 1, cost: { ...zeroCost(), input, total: input }, ...extra });
const hour = (key, input) => ({ hour: key, ...zeroTotals(), input, cost: { ...zeroCost(), input, total: input } });
const NOW = new Date(2026, 9, 15, 20, 30).getTime();

test("a calendar span is calendar days, not the last n rows", () => {
  // Three active days spread over six weeks: "last 30 days" holds only the last one.
  const days = [day("2026-09-01", 1), day("2026-09-20", 2), day("2026-10-14", 3)];
  const r = spanRange({ id: "30", back: 0 }, null, NOW);
  assert.equal(dayKeyOf(r.from), "2026-09-16");
  assert.deepEqual(spanDays(days, r).map((d) => d.day), ["2026-09-20", "2026-10-14"]);
  assert.equal(calendarFrom(1, NOW), new Date(2026, 9, 15).getTime(), "today counts as one");
});

test("all time is every row and no instants", () => {
  const days = [day("2026-01-01", 1)];
  assert.equal(spanRange({ id: "all", back: 0 }, null, NOW), null);
  assert.deepEqual(spanDays(days, null), days);
});

test("a live span takes its cut's hour edge and stops at the reset or now", () => {
  const cut = { fromHour: new Date(2026, 9, 9, 19).getTime(), resetAt: new Date(2026, 9, 16, 19).getTime() };
  const r = spanRange({ id: "week", back: 0 }, cut, NOW);
  assert.deepEqual(r, { from: cut.fromHour, to: NOW });
  // Edge days are whole: the 9th (opened 19:00) and today both count.
  const days = [day("2026-10-08", 1), day("2026-10-09", 2), day("2026-10-15", 3)];
  assert.deepEqual(spanDays(days, r).map((d) => d.day), ["2026-10-09", "2026-10-15"]);
  assert.equal(spanRange({ id: "session", back: 0 }, null, NOW), null, "no cut, no instants");
  assert.ok(isLiveSpan("session") && !isLiveSpan("30"));
});

test("hours are cut exactly to [from, to)", () => {
  const hours = [hour("2026-10-15T15", 1), hour("2026-10-15T16", 2), hour("2026-10-15T20", 3)];
  const r = { from: new Date(2026, 9, 15, 16).getTime(), to: new Date(2026, 9, 15, 20).getTime() };
  assert.deepEqual(spanHours(hours, r, hourKeyMs).map((h) => h.hour), ["2026-10-15T16"]);
  assert.equal(hoursCover(r.from - 1, r), true);
  assert.equal(hoursCover(r.from + 1, r), false, "a record starting after the span does not cover it");
  assert.equal(hoursCover(null, r), false);
});

test("a run of days sums, and its model split is absent rather than empty on an old host", () => {
  const slice = (model, input) => ({ model, totals: { ...zeroTotals(), input }, cost: { ...zeroCost(), input, total: input } });
  const c = daysCut([day("2026-10-14", 2, { byModel: [slice("claude-opus-4-5", 2)] }), day("2026-10-15", 3, { byModel: [] })], []);
  assert.equal(c.totals.input, 5);
  assert.equal(c.cost.total, 5);
  assert.equal(c.modelSplit, true);
  assert.equal(c.models[0].key, "claude-opus-4-5");
  const old = daysCut([day("2026-10-14", 2)], []);
  assert.equal(old.modelSplit, false);
  assert.deepEqual(old.models, []);
});

test("the clock draws all 24 slots and folds by the bucket's own hour", () => {
  const slots = clockOf([hour("2026-10-14T09", 1), hour("2026-10-15T09", 2), hour("2026-10-15T23", 4)]);
  assert.equal(slots.length, 24);
  assert.equal(slots[9].input, 3);
  assert.equal(slots[23].cost.total, 4);
  assert.equal(slots[0].input, 0);
});

test("a calendar span refuses, with the ledger's sentence, when an undated record could fall in it (design round 4, r4-1 L1)", async () => {
  const { spanUndatedText, trendWithoutUndated } = await import("./span.ts");
  const now = new Date(2026, 9, 20, 12).getTime();
  const from = calendarFrom(30, now);
  assert.equal(spanUndatedText({ undated: 0 }, from), null);
  assert.equal(spanUndatedText({}, from), null, "an older host: cut as before");
  assert.match(spanUndatedText({ undated: 2 }, from), /2 records it could not date/, "no bound: refused");
  assert.match(spanUndatedText({ undated: 2, undatedUntil: from }, from), /could not date/);
  assert.equal(spanUndatedText({ undated: 2, undatedUntil: from - 1 }, from), null, "every such log was written before the span");
  // The 7-day mean: a point whose seven days reach back to the undated log's mtime is cut, never drawn short.
  const t = (d) => new Date(2026, 9, d).getTime();
  const pts = [10, 14, 17, 18].map((d) => ({ day: String(d), t: t(d), v: 1 }));
  const kept = trendWithoutUndated(pts, { undated: 2, undatedUntil: t(11) + 5 }).map((p) => p.day);
  assert.deepEqual(kept, ["18"], "17's week starts on the 11th, where the log was last written");
  assert.deepEqual(trendWithoutUndated(pts, { undated: 0 }).length, 4);
  assert.deepEqual(trendWithoutUndated(pts, { undated: 2 }), [], "no bound: no trend");
});

test("a span's undated count is per log: the old log's records are not said for a span opened after it (design round 5, r4-1b L1)", async () => {
  const { spanUndatedText } = await import("./span.ts");
  const from = Date.UTC(2026, 9, 20);
  const doc = { undated: 6, undatedUntil: from + 5, undatedLogs: [[from - 86_400_000, 5], [from + 5, 1]] };
  assert.equal(spanUndatedText(doc, from), "Claude Code: holds 1 record it could not date that could fall in this span, so the figure could be missing it.");
});

test("all time: records with no date are said to be in the total and in no day (design round 5, r4-1b L4)", async () => {
  const { allTimeUndatedText } = await import("./span.ts");
  assert.equal(allTimeUndatedText({ undated: 0 }), null);
  assert.equal(allTimeUndatedText({}), null, "an older host: nothing said, as before");
  assert.equal(allTimeUndatedText({ undated: 1 }),
    "1 record has no date: it is in the total above but in no day, so the days here add up to less than the total.");
  assert.equal(allTimeUndatedText({ undated: 3 }),
    "3 records have no date: they are in the total above but in no day, so the days here add up to less than the total.");
  // Per log or not, all time holds every one of them.
  assert.match(allTimeUndatedText({ undated: 3, undatedUntil: 1, undatedLogs: [[1, 3]] }), /^3 records/);
  assert.equal(allTimeUndatedText({ undated: -1 }), null, "not a count: no sentence with a wrong number");
});
