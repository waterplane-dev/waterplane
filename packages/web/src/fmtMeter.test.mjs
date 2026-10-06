import test from "node:test";
import assert from "node:assert/strict";

import { fmtTok, fmtUsd } from "./format.ts";

// The metering line's own formatters. They are NOT shared/sessioncost.ts's
// (which rounds to whole `k`), and these pins are what a swap would break.

test("fmtTok keeps one decimal at k and M", () => {
  assert.equal(fmtTok(999), "999");
  assert.equal(fmtTok(1234), "1.2k");
  assert.equal(fmtTok(1_250_000), "1.3M");
});

test("fmtUsd: cents from $1 up, four places below, $0 for nothing", () => {
  assert.equal(fmtUsd(0), "$0");
  assert.equal(fmtUsd(-1), "$0");
  assert.equal(fmtUsd(0.01234), "$0.0123");
  assert.equal(fmtUsd(12.345), "$12.35");
});
