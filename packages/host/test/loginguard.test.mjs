/** LAN login guard: growing wait, lockout, trusted kinds never guarded, one source cannot lock another. */
import { test } from "node:test";
import assert from "node:assert/strict";

const { LoginGuard, guarded, FREE_FAILS, LOCK_AT, LOCK_MS, MAX_WAIT_MS } = await import("../dist/loginguard.js");

test("a source is guarded when the gate demands a password from it, never loopback", () => {
  assert.equal(guarded("loopback", false), false);
  assert.equal(guarded("loopback", true), false);
  assert.equal(guarded("tailscale", false), false, "ungated Tailscale is trusted");
  assert.equal(guarded("tailscale", true), true, "gated Tailscale (passive device paired) must present the password");
  assert.equal(guarded("lan", true), true);
  assert.equal(guarded("other", true), true);
});

test("parked requests that all passed the header check do not all get a guess", () => {
  const g = new LoginGuard();
  // 160 requests pass check() before any failure is counted (bodies withheld) ...
  const parked = Array.from({ length: 160 }, () => g.check("a", 0).allowed);
  assert.ok(parked.every(Boolean));
  // ... then their bodies arrive together: the verdict is re-read per guess.
  let verified = 0, refused = 0;
  for (let i = 0; i < parked.length; i++) {
    const r = g.attempt("a", () => { verified++; return false; }, 0);
    if (r.refused) refused++;
  }
  assert.equal(verified, FREE_FAILS + 1, "free typos plus the one that starts the wait");
  assert.equal(refused, 160 - (FREE_FAILS + 1));
});

test("attempt: a correct password clears the source; a refused one is never verified", () => {
  const g = new LoginGuard();
  g.fail("a", 0); g.fail("a", 0);
  assert.equal(g.attempt("a", () => true, 0).ok, true);
  for (let i = 0; i < LOCK_AT; i++) g.fail("a", 0);
  let ran = false;
  const r = g.attempt("a", () => { ran = true; return true; }, 1);
  assert.equal(r.refused, true);
  assert.equal(r.ok, false, "even the right password is refused while locked");
  assert.equal(ran, false);
});

test("typos are free, then the wait doubles", () => {
  const g = new LoginGuard();
  let t = 1_000_000;
  for (let i = 0; i < FREE_FAILS; i++) assert.equal(g.fail("a", t).allowed, true);
  const v1 = g.fail("a", t);
  assert.equal(v1.allowed, false);
  assert.equal(v1.retryAfterMs, 2000);
  t += 2000;
  assert.equal(g.check("a", t).allowed, true);
  assert.equal(g.fail("a", t).retryAfterMs, 4000);
});

test("wait is capped, then the source is locked", () => {
  const g = new LoginGuard();
  let t = 0, v;
  for (let i = 0; i < LOCK_AT - 1; i++) { v = g.fail("a", t); t += v.retryAfterMs; }
  assert.ok(v.retryAfterMs <= MAX_WAIT_MS);
  v = g.fail("a", t);
  assert.equal(v.locked, true);
  assert.equal(v.retryAfterMs, LOCK_MS);
  assert.equal(g.check("a", t + LOCK_MS - 1).allowed, false);
  assert.equal(g.check("a", t + LOCK_MS).allowed, true);
});

test("one source cannot lock another; success clears", () => {
  const g = new LoginGuard();
  for (let i = 0; i < LOCK_AT; i++) g.fail("attacker", 0);
  assert.equal(g.check("attacker", 1).allowed, false);
  assert.equal(g.check("owner-lan", 1).allowed, true);
  g.success("attacker");
  assert.equal(g.check("attacker", 1).allowed, true);
});

test("after a lock runs out the next wrong guess waits again", () => {
  const g = new LoginGuard();
  for (let i = 0; i < LOCK_AT; i++) g.fail("a", 0);
  const v = g.fail("a", LOCK_MS + 1);
  assert.equal(v.allowed, false);
  assert.equal(v.locked, false);
});

test("reading has counts only and logs lines", () => {
  const lines = [];
  const g = new LoginGuard((l) => lines.push(l));
  for (let i = 0; i < LOCK_AT; i++) g.fail("1.2.3.4", 100);
  const r = g.reading(200);
  assert.equal(r.lockedNow, 1);
  assert.equal(r.recentFailures, LOCK_AT);
  assert.ok(lines.some((l) => /locked/.test(l)));
  assert.ok(!JSON.stringify(r).includes("1.2.3.4"));
});
