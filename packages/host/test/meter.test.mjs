/** meter.ts: an unknown model is COUNTED as unpriced, never read as a free call. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Meter, priceCall, isPriced } = await import("../dist/meter.js");

test("priceCall: known model priced, unknown is 0 and isPriced says which", () => {
  assert.ok(priceCall("gemini-2.5-pro", 1_000_000, 0) > 0);
  assert.equal(priceCall("mystery-1", 1000, 1000), 0);
  assert.equal(isPriced("gemini-2.5-pro-preview"), true);
  assert.equal(isPriced("mystery-1"), false);
});

test("summary counts unpriced calls and tokens beside the priced dollars", () => {
  const m = new Meter(mkdtempSync(join(tmpdir(), "meter-")));
  const ts = Date.now();
  m.record({ service: "x", model: "gemini-2.5-pro", kind: "k", inTok: 1000, outTok: 100, ts });
  m.record({ service: "x", model: "mystery-1", kind: "k", inTok: 400, outTok: 100, ts });
  const s = m.summary();
  if (!m.enabled) return;
  assert.equal(s.calls, 2);
  assert.equal(s.unpricedCalls, 1);
  assert.equal(s.unpricedTok, 500);
  assert.ok(s.costUsd > 0);
});
