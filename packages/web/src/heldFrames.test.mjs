// A socket's boot frames reach the subscribers that register a moment later
// (WebKit ran the demo socket before App's effect and lost the hello batch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HELD_FRAMES_MAX, HeldFrames } from "./heldFrames.ts";

/** A tiny HostConnection: listeners, and `deliver` through the hold. */
function conn() {
  const hold = new HeldFrames();
  const listeners = new Set();
  const tasks = [];
  const fanOut = (m) => { for (const l of listeners) l(m); };
  return {
    tasks,
    deliver(m) { if (!hold.keep(m, listeners.size)) fanOut(m); },
    on(l) { listeners.add(l); hold.subscribed((fn) => tasks.push(fn), fanOut); return () => listeners.delete(l); },
    runLater() { while (tasks.length) tasks.shift()(); },
  };
}

test("frames before any listener reach every listener of the same pass, in order", () => {
  const c = conn();
  c.deliver("welcome"); c.deliver("session.list");
  const a = [], b = [];
  c.on((m) => a.push(m));
  c.on((m) => b.push(m));
  assert.deepEqual(a, [], "handed over after the pass, not mid-registration");
  c.deliver("session.updated"); // arrives before the hand-over: queued behind the held ones
  c.runLater();
  assert.deepEqual(a, ["welcome", "session.list", "session.updated"]);
  assert.deepEqual(b, ["welcome", "session.list", "session.updated"]);
  c.deliver("pong-ish");
  assert.deepEqual(a.at(-1), "pong-ish", "after the hand-over frames go straight through");
});

test("boot only: after the hand-over a frame with no listener is dropped, never held", () => {
  const c = conn();
  const off = c.on(() => {});
  c.runLater();
  off();
  c.deliver("lost");
  const got = [];
  c.on((m) => got.push(m));
  c.runLater();
  assert.deepEqual(got, []);
});

test("bounded: a page that never subscribes keeps at most HELD_FRAMES_MAX, the first ones", () => {
  const c = conn();
  for (let i = 0; i < HELD_FRAMES_MAX + 5; i++) c.deliver(i);
  const got = [];
  c.on((m) => got.push(m));
  c.runLater();
  assert.equal(got.length, HELD_FRAMES_MAX);
  assert.equal(got[0], 0);
});
