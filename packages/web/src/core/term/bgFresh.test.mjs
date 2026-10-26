import test from "node:test";
import assert from "node:assert/strict";

import { BG_FRESH_DEFAULT, BG_FRESH_STEPS, bgFreshLabel, catchUpMs, parksWhenHidden, parseBgFresh, sweepsWhenHidden } from "./bgFresh.ts";

test("an unset or unknown value reads as the 5-minute default, never as live", () => {
  assert.equal(BG_FRESH_DEFAULT, 300_000);
  for (const raw of [null, undefined, "", "abc", "12345", "NaN"]) assert.equal(parseBgFresh(raw), 300_000);
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
  assert.equal(catchUpMs(900_000), 900_000);
});

test("the readout says the interval in minutes", () => {
  assert.equal(bgFreshLabel(60_000), "every 1 min");
  assert.equal(bgFreshLabel(300_000), "every 5 min");
  assert.equal(bgFreshLabel("off"), "off");
});

test("only the APK tops up transcripts while hidden, and never on off", () => {
  assert.equal(sweepsWhenHidden(300_000, true), true);
  assert.equal(sweepsWhenHidden("live", true), true);
  assert.equal(sweepsWhenHidden("off", true), false);
  assert.equal(sweepsWhenHidden(300_000, false), false);
});
