/**
 * "The desktop is restarting" (`link/hostRestart.ts`): the three edges and the
 * strip's words, over explicit clocks.
 *
 *     node --test packages/web/src/link/hostRestart.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
const R = await import("./hostRestart.ts");

test("first welcome only remembers the boot; same boot again is just the link", () => {
  assert.equal(R.noteHostWelcome({ bootId: "a", hostId: "h" }, 1000), null);
  R.noteSocketDown(2000);
  assert.equal(R.noteHostWelcome({ bootId: "a", hostId: "h" }, 5000), null);
  assert.equal(R.restartLine(R.restartView(), 5000), null);
});

test("announced restart: counts while waiting, says back after, remembers the wait", () => {
  R.noteHostRestarting(10_000);
  assert.match(R.restartLine(R.restartView(), 22_000).text, /desktop restarting · 12 s/);
  R.noteSocketDown(10_100);
  const back = R.noteHostWelcome({ bootId: "b", hostId: "h", startedAt: 30_000, readyAt: 35_000 }, 41_000);
  assert.deepEqual(back, { downMs: 31_000, announced: true });
  assert.match(R.restartLine(R.restartView(), 42_000).text, /back after 31 s/);
  assert.equal(R.restartLine(R.restartView(), 41_000 + R.BACK_SHOWN_MS + 1), null);
  // the next one quotes the last wait, and calls three times that long
  R.noteHostRestarting(100_000);
  assert.match(R.restartLine(R.restartView(), 110_000).text, /usually ~31 s/);
  const slow = R.restartLine(R.restartView(), 100_000 + 31_000 * R.SLOW_FACTOR + 1);
  assert.ok(slow.slow);
  assert.match(slow.text, /longer than usual/);
});

test("a new boot with no announcement reads as a crash, timed from the drop", () => {
  R.noteHostWelcome({ bootId: "c", hostId: "h" }, 200_000);
  R.noteSocketDown(300_000);
  const back = R.noteHostWelcome({ bootId: "d", hostId: "h" }, 307_000);
  assert.deepEqual(back, { downMs: 7_000, announced: false });
  const line = R.restartLine(R.restartView(), 307_500);
  assert.ok(line.slow);
  assert.match(line.text, /unannounced \(crash\?\) — back after 7 s/);
});

test("a restart this page never saw (loaded after it) is remembered, not announced", () => {
  R.noteHostWelcome({ bootId: "e", hostId: "fresh" }, 400_000);
  assert.equal(R.noteHostWelcome({ bootId: "f", hostId: "fresh" }, 900_000), null);
});
