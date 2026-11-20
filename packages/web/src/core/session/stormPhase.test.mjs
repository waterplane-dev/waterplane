/**
 * The storm overlay's phases (`stormPhase.ts`): only over nothing readable,
 * only after a held outage, no landing show after a short one, a go-around on
 * a drop, and a dismiss that lasts one outage.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LAND_MS, SHOW_MIN_MS, STABLE_MS, START_MS, nextStorm, stormShown } from "./stormPhase.ts";

const at = (phase, since = 0, shownAt = 0) => ({ phase, since, shownAt });
const inp = (now, o = {}) => ({ down: false, open: false, quiet: true, dismissed: false, now, ...o });

test("it waits START_MS of held outage before drawing anything", () => {
  const p = nextStorm(at("off"), inp(10, { down: true }));
  assert.equal(p.phase, "pending");
  assert.equal(stormShown(p), false);
  assert.equal(nextStorm(p, inp(10 + START_MS - 1, { down: true })).phase, "pending");
  const s = nextStorm(p, inp(10 + START_MS, { down: true }));
  assert.deepEqual(s, { phase: "storm", since: 10 + START_MS, shownAt: 10 + START_MS });
});

test("a cold start that connects inside the wait never shows the storm", () => {
  assert.equal(nextStorm(at("pending", 0), inp(500, { open: true })).phase, "off");
});

test("anything readable turns it off at once, in every phase", () => {
  for (const ph of ["pending", "storm", "approach", "landing"]) {
    assert.equal(nextStorm(at(ph), inp(5, { down: true, quiet: false })).phase, "off", ph);
  }
  assert.equal(nextStorm(at("off"), inp(5, { down: true, quiet: false })).phase, "off");
});

test("a short storm ends without a landing show", () => {
  assert.equal(nextStorm(at("storm", 0, 0), inp(SHOW_MIN_MS - 1, { open: true })).phase, "off");
  assert.equal(nextStorm(at("storm", 0, 0), inp(SHOW_MIN_MS, { open: true })).phase, "approach");
});

test("the plane lands only after the link stayed open for STABLE_MS", () => {
  const a = at("approach", 100);
  assert.equal(nextStorm(a, inp(100 + STABLE_MS - 1, { open: true })).phase, "approach");
  assert.equal(nextStorm(a, inp(100 + STABLE_MS, { open: true })).phase, "landing");
});

test("a drop on approach or on finals is a go-around", () => {
  assert.equal(nextStorm(at("approach"), inp(50)).phase, "storm");
  assert.equal(nextStorm(at("landing"), inp(50, { down: true })).phase, "storm");
});

test("landing ends the overlay after LAND_MS", () => {
  assert.equal(nextStorm(at("landing", 0), inp(LAND_MS - 1, { open: true })).phase, "landing");
  assert.equal(nextStorm(at("landing", 0), inp(LAND_MS, { open: true })).phase, "off");
});

test("dismissed holds it off, even while the link is down", () => {
  assert.equal(nextStorm(at("storm"), inp(5, { down: true, dismissed: true })).phase, "off");
  assert.equal(nextStorm(at("off"), inp(5, { down: true, dismissed: true })).phase, "off");
});
