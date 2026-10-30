/** `resetWhen` across a 25 h day (design review 2026-10-30 W1). */
import test from "node:test";
import assert from "node:assert/strict";
import { resetWhen, spanDays } from "./when.ts";

test("on the fall-back evening a reset tomorrow still says tomorrow (Berlin)", () => {
  const prev = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    const now = new Date(2026, 9, 25, 23, 30).getTime(); // 25 Oct 23:30, the day is 25 h long
    const reset = new Date(2026, 9, 26, 9, 0).getTime();
    assert.match(resetWhen(reset, now), /^tomorrow /);
    assert.doesNotMatch(resetWhen(new Date(2026, 9, 25, 23, 45).getTime(), now), /tomorrow/);
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});

test("resetWhen says tomorrow in the 00:00-01:00 window of a 25 h day and the 23:00-24:00 eve of a 23 h day (Berlin)", () => {
  const prev = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    // 25 Oct 00:30: +24 h is still 25 Oct 23:30, so ms arithmetic prints a bare date for 26 Oct
    const a = new Date(2026, 9, 25, 0, 30).getTime();
    assert.match(resetWhen(new Date(2026, 9, 26, 9, 0).getTime(), a), /^tomorrow /);
    // 28 Mar 23:30: +24 h is already 30 Mar 00:30
    const b = new Date(2026, 2, 28, 23, 30).getTime();
    assert.match(resetWhen(new Date(2026, 2, 29, 9, 0).getTime(), b), /^tomorrow /);
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});

test("spanDays counts calendar days across fall-back", () => {
  const prev = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    const doc = { firstAt: new Date(2026, 9, 25, 0, 30).getTime(), lastAt: new Date(2026, 9, 26, 23, 30).getTime() };
    assert.equal(spanDays(doc), 2);
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});
