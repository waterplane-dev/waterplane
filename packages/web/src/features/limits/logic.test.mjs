/**
 * The limit toggle's cycle and receipts — strings App carried inline in the
 * toolbar arm and the sheet's props.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { modeToast, nextOverride, overrideSource, overrideToast } from "./logic.ts";

test("the override cycles inherit → on → off → inherit", () => {
  assert.equal(nextOverride(undefined), true);
  assert.equal(nextOverride(null), true);
  assert.equal(nextOverride(true), false);
  assert.equal(nextOverride(false), null);
});

test("the receipt names what inherit means right now", () => {
  assert.equal(overrideToast(null, true), "auto-continue: inherit (on)");
  assert.equal(overrideToast(null, false), "auto-continue: inherit (off)");
  assert.equal(overrideToast(true, false), "auto-continue: on for this session");
  assert.equal(overrideToast(false, true), "auto-continue: off for this session");
});

test("the source is the global setting until a session sets its own", () => {
  assert.equal(overrideSource(null, true), "global (on)");
  assert.equal(overrideSource(undefined, false), "global (off)");
  assert.equal(overrideSource(false, true), "session override");
});

test("each release mode has its own receipt", () => {
  assert.equal(modeToast("one"), "resuming one session at a time");
  assert.equal(modeToast("repo"), "resuming one session per repo at a time");
  assert.equal(modeToast("all"), "resuming every queued session once the limit lifts");
});
