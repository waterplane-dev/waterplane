import test from "node:test";
import assert from "node:assert/strict";

import { BG_FRESH_DEFAULT, BG_FRESH_STEPS, bgFreshLabel, bgFreshNote, catchUpMs, parksWhenHidden, parseBgFresh, sweepsWhenHidden } from "./bgFresh.ts";

test("an unset or unknown value reads as the 1-minute default, never as live", () => {
  assert.equal(BG_FRESH_DEFAULT, 60_000);
  for (const raw of [null, undefined, "", "abc", "NaN", "-5", "0"]) assert.equal(parseBgFresh(raw), 60_000);
});

test("R-offline-009: no stop is past the 300 s the WebView is frozen after; an old 5 or 15 min value maps to 1 min", () => {
  for (const v of BG_FRESH_STEPS) if (typeof v === "number") assert.ok(v < 300_000);
  for (const raw of ["300000", "900000", "12345"]) assert.equal(parseBgFresh(raw), 60_000);
});

test("every stop round-trips through storage's string", () => {
  for (const v of BG_FRESH_STEPS) assert.equal(parseBgFresh(String(v)), v);
});

test("live keeps streaming; every other stop parks the terminal when hidden", () => {
  assert.equal(parksWhenHidden("live"), false);
  assert.equal(parksWhenHidden("off"), true);
  assert.equal(parksWhenHidden(60_000), true);
  assert.equal(catchUpMs("off"), null);
  assert.equal(catchUpMs("live"), null);
  assert.equal(catchUpMs(60_000), 60_000);
});

test("the readout says the interval in minutes", () => {
  assert.equal(bgFreshLabel(60_000), "every 1 min");
  assert.match(bgFreshNote(60_000), /about five minutes after the app is hidden/);
  assert.match(bgFreshNote(60_000), /alerts only/);
  assert.equal(bgFreshLabel("off"), "off");
});

test("only the APK tops up transcripts while hidden, and never on off", () => {
  assert.equal(sweepsWhenHidden(60_000, true), true);
  assert.equal(sweepsWhenHidden("live", true), true);
  assert.equal(sweepsWhenHidden("off", true), false);
  assert.equal(sweepsWhenHidden(60_000, false), false);
});
