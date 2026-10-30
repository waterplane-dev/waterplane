/**
 * The local hour bucket — `hourKey` / `hourKeyMs` / `hourFloor`, the ONE trio every
 * ledger, cut and chart keys an hour by. Pinned at ordinary hours in four zones
 * (whole-hour, DST, half-hour, half-hour DST), so moving every private copy onto the
 * trio cannot change a single ordinary bucket.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hourFloor, hourKey, hourKeyMs } from "../dist/index.js";

/** Run `fn` with the process in `zone`; restores TZ exactly, including "was unset". */
function withTZ(zone, fn) {
  const prev = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const Z = (iso) => Date.parse(iso);

const ORDINARY = [
  // zone, instant, key, top of that local hour
  ["UTC", "2026-10-06T10:17:00Z", "2026-10-06T10", "2026-10-06T10:00:00Z"],
  ["Europe/Berlin", "2026-10-06T10:17:00Z", "2026-10-06T12", "2026-10-06T10:00:00Z"],
  ["Europe/Berlin", "2026-01-15T23:59:59Z", "2026-01-16T00", "2026-01-15T23:00:00Z"],
  ["Asia/Kolkata", "2026-10-06T10:50:00Z", "2026-10-06T16", "2026-10-06T10:30:00Z"],
  ["Asia/Kolkata", "2026-10-06T10:20:00Z", "2026-10-06T15", "2026-10-06T09:30:00Z"],
  ["Australia/Lord_Howe", "2026-10-06T10:17:00Z", "2026-10-06T21", "2026-10-06T10:00:00Z"],
  ["Australia/Lord_Howe", "2026-06-10T03:10:00Z", "2026-06-10T13", "2026-06-10T02:30:00Z"],
];

test("hour trio at ordinary hours: key, parsed key and floor in four zones", () => {
  for (const [zone, at, key, top] of ORDINARY) {
    withTZ(zone, () => {
      assert.equal(hourKey(Z(at)), key, `${zone} ${at} key`);
      assert.equal(hourKeyMs(key), Z(top), `${zone} ${key} parse`);
      assert.equal(hourFloor(Z(at)), Z(top), `${zone} ${at} floor`);
    });
  }
});

test("hourKeyMs reads a key with a missing hour as the day's midnight, never NaN", () => {
  withTZ("UTC", () => {
    assert.equal(hourKeyMs("2026-10-06"), Z("2026-10-06T00:00:00Z"));
    assert.equal(hourKeyMs("2026-10-06Txx"), Z("2026-10-06T00:00:00Z"));
  });
});

test("withTZ restores an unset TZ as unset, never the string 'undefined'", () => {
  const prev = process.env.TZ;
  delete process.env.TZ;
  try {
    withTZ("Asia/Kolkata", () => {});
    assert.equal("TZ" in process.env, false);
  } finally {
    if (prev !== undefined) process.env.TZ = prev;
  }
});

const QUARTER = 15 * 60_000;
const HOUR = 3_600_000;
const STRETCHES = [
  ["Europe/Berlin", "2026-10-24T22:00:00Z", "2026-10-25T04:00:00Z"], // fall-back: 03:00 CEST → 02:00 CET
  ["Europe/Berlin", "2026-03-28T23:00:00Z", "2026-03-29T04:00:00Z"], // spring-forward: 02:00 → 03:00
  ["Asia/Kolkata", "2026-10-05T20:00:00Z", "2026-10-06T02:00:00Z"],
  ["Australia/Lord_Howe", "2026-04-04T12:00:00Z", "2026-04-04T17:00:00Z"], // fall-back: 02:00 → 01:30
  ["Australia/Lord_Howe", "2026-10-03T13:00:00Z", "2026-10-03T18:00:00Z"], // spring-forward: 02:00 → 02:30
];

test("hourKeyMs(hourKey(t)) === hourFloor(t) for every t, across DST switches and half-hour zones", () => {
  for (const [zone, a, b] of STRETCHES) {
    withTZ(zone, () => {
      for (let t = Z(a); t <= Z(b); t += QUARTER) {
        const at = `${zone} ${new Date(t).toISOString()}`;
        const f = hourFloor(t);
        assert.equal(hourKeyMs(hourKey(t)), f, `${at}: floor is the parsed key`);
        assert.equal(hourKey(f), hourKey(t), `${at}: the floor is inside its own bucket`);
        assert.ok(f <= t && t - f < 2 * HOUR, `${at}: floor at or before t, within the merged hour`);
      }
    });
  }
});

test("a fall-back hour is ONE bucket: both passes share a key and its first top", () => {
  withTZ("Europe/Berlin", () => {
    const first = Z("2026-10-25T00:30:00Z"); // 02:30 CEST
    const second = Z("2026-10-25T01:30:00Z"); // 02:30 CET
    assert.equal(hourKey(first), "2026-10-25T02");
    assert.equal(hourKey(second), "2026-10-25T02");
    assert.equal(hourFloor(first), Z("2026-10-25T00:00:00Z"));
    assert.equal(hourFloor(second), Z("2026-10-25T00:00:00Z"));
  });
});
