import test from "node:test";
import assert from "node:assert/strict";

import { pullSummary } from "./logic.ts";

const rec = (state, received, size, evicted) => ({ state, received, evicted, item: { size } });

test("an empty queue is zero everything", () => {
  assert.deepEqual(pullSummary([]), { active: 0, onPhone: 0, stuck: false, pct: 0 });
});

test("progress is bytes over the ACTIVE transfers, not finished files", () => {
  const s = pullSummary([
    rec("downloading", 12, 24),
    rec("queued", 0, 24),
    rec("queued", 0, 24),
    rec("done", 24, 24),
  ]);
  assert.equal(s.active, 3);
  assert.equal(s.pct, 16); // 12 of 72
  assert.equal(s.onPhone, 1);
  assert.equal(s.stuck, false);
});

test("an evicted file is not on the phone; failed or paused is stuck", () => {
  const s = pullSummary([rec("done", 5, 5, true), rec("paused", 1, 10)]);
  assert.equal(s.onPhone, 0);
  assert.equal(s.stuck, true);
  assert.equal(pullSummary([rec("failed", 0, 10)]).stuck, true);
});

test("an unknown size counts as what has arrived, and pct never passes 100", () => {
  assert.equal(pullSummary([rec("downloading", 40, 0)]).pct, 100);
  assert.equal(pullSummary([rec("downloading", 50, 10)]).pct, 100);
});
