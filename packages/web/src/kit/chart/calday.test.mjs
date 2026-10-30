/**
 * Calendar-day arithmetic under a DST zone (design review 2026-10-30 W1).
 * Berlin 2026-10-25 is 25 h long: any `N * 86_400_000` step lands an hour off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rollingMean, dayKey } from "./statsPlot.ts";
import { addLocalDays, dayToMs, localDaysBetween } from "@waterplane/shared";

function inBerlin(fn) {
  const prev = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try { fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}
const pt = (day, v) => ({ day, t: dayToMs(day), v });

test("addLocalDays keeps the local clock across the fall-back day, both ways", () => {
  inBerlin(() => {
    assert.equal(dayKey(addLocalDays(dayToMs("2026-10-24"), 2)), "2026-10-26");
    assert.equal(addLocalDays(dayToMs("2026-10-24"), 2), dayToMs("2026-10-26"));
    assert.equal(addLocalDays(dayToMs("2026-10-26"), -2), dayToMs("2026-10-24"));
    assert.equal(addLocalDays(dayToMs("2026-03-28"), 2), dayToMs("2026-03-30"));
  });
});

test("localDaysBetween counts calendar days, not 24 h units", () => {
  inBerlin(() => {
    assert.equal(localDaysBetween(dayToMs("2026-10-25"), dayToMs("2026-10-26")), 1);
    assert.equal(localDaysBetween(dayToMs("2026-10-20"), dayToMs("2026-10-31")), 11);
    // 23:00 on the 25th to 23:00 on the 26th is 25 h but one calendar day
    assert.equal(localDaysBetween(dayToMs("2026-10-25") + 23 * 3_600_000, dayToMs("2026-10-26") + 23 * 3_600_000), 1);
    assert.equal(localDaysBetween(dayToMs("2026-10-26"), dayToMs("2026-10-25")), -1);
  });
});

test("a flat 70/day series has a 7-day mean of 70 on every day across fall-back (Berlin)", () => {
  inBerlin(() => {
    const days = [];
    for (let d = 20; d <= 31; d++) days.push(pt(`2026-10-${d}`, 70));
    const mean = rollingMean(days, 7);
    assert.deepEqual(mean.map((m) => m.day), days.slice(6).map((d) => d.day));
    for (const m of mean) assert.ok(Math.abs(m.v - 70) < 1e-9, `${m.day}: ${m.v}`);
  });
});

test("spring-forward: the first full window is emitted on its seventh day, not a day early (Berlin)", () => {
  inBerlin(() => {
    const days = [];
    for (let d = 24; d <= 31; d++) days.push(pt(`2026-03-${d}`, 70));
    const mean = rollingMean(days, 7);
    assert.equal(mean[0].day, "2026-03-30");
    assert.equal(mean.length, 2);
    for (const m of mean) assert.ok(Math.abs(m.v - 70) < 1e-9);
  });
});

test("rollingMean with today at 60 reads 60/7 contributions correctly (Berlin)", () => {
  inBerlin(() => {
    const days = [];
    for (let d = 20; d <= 31; d++) days.push(pt(`2026-10-${d}`, d === 31 ? 60 : 70));
    const last = rollingMean(days, 7).pop();
    assert.equal(last.day, "2026-10-31");
    assert.ok(Math.abs(last.v - (70 * 6 + 60) / 7) < 1e-9);
  });
});

test("a flat series keeps its 7-day mean on the day DST switches AT midnight (Santiago, 2026-09-06)", () => {
  const prev = process.env.TZ;
  process.env.TZ = "America/Santiago";
  try {
    const days = [];
    for (let d = 25; d <= 31; d++) days.push(pt(`2026-08-${d}`, 70));
    for (let d = 1; d <= 12; d++) days.push(pt(`2026-09-${String(d).padStart(2, "0")}`, 70));
    const mean = rollingMean(days, 7);
    assert.ok(mean.some((m) => m.day === "2026-09-06"));
    for (const m of mean) assert.ok(Math.abs(m.v - 70) < 1e-9, `${m.day}: ${m.v}`);
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});
