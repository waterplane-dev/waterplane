/**
 * The host's socket liveness and PTY backpressure policy (`server/liveness.ts`).
 *
 * Pure decisions, pinned here because the socket half (`wsops.ts`'s pinger,
 * `sessionEvents.ts`'s fan-out) only applies them: when a socket that stopped
 * answering pings is let go, and what one PTY delta does on a socket whose
 * send buffer is past the threshold. The ping half end to end, against a real
 * client that does not answer, is `scripts/e2e-wsliveness.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { pingTick, ptyFrameAction, MISSED_PONGS_TO_TERMINATE } = await import("../dist/server/liveness.js");

test("a socket is pinged until it misses two in a row, then terminated", () => {
  assert.equal(MISSED_PONGS_TO_TERMINATE, 2);
  let missed = 0;
  const actions = [];
  for (let i = 0; i < 3; i++) {
    const t = pingTick(missed);
    actions.push(t.action);
    missed = t.missed;
  }
  // Tick 1 pings (1 outstanding), tick 2 pings again (2 outstanding), tick 3
  // finds both unanswered and terminates — never one miss, which a ping
  // queued behind a draining backlog could cost a live phone.
  assert.deepEqual(actions, ["ping", "ping", "terminate"]);
});

test("a pong in between resets the count, so a live socket is never terminated", () => {
  let missed = 0;
  for (let i = 0; i < 50; i++) {
    const t = pingTick(missed);
    assert.equal(t.action, "ping", `tick ${i}`);
    missed = t.missed;
    if (i % 2 === 1) missed = 0; // a pong lands every other tick — slow, but alive
  }
});

test("terminate does not keep counting up", () => {
  assert.deepEqual(pingTick(2), { action: "terminate", missed: 2 });
  assert.deepEqual(pingTick(5), { action: "terminate", missed: 5 });
});

test("a delta is sent while the buffer is at or under the threshold", () => {
  assert.equal(ptyFrameAction(0, 1024, false), "send");
  assert.equal(ptyFrameAction(1024, 1024, false), "send");
});

test("past the threshold a delta is skipped, starved or not", () => {
  assert.equal(ptyFrameAction(1025, 1024, false), "skip");
  assert.equal(ptyFrameAction(10 * 1024 * 1024, 1024, true), "skip");
});

test("a starved socket that has drained gets one full replay instead of the delta", () => {
  assert.equal(ptyFrameAction(0, 1024, true), "resync");
  assert.equal(ptyFrameAction(1024, 1024, true), "resync");
});

test("a sequence: send, starve, stay starved, heal once, send again", () => {
  const T = 100;
  let starved = false;
  const seen = [];
  for (const buffered of [0, 50, 500, 400, 20, 0, 0]) {
    const a = ptyFrameAction(buffered, T, starved);
    seen.push(a);
    if (a === "skip") starved = true;
    if (a === "resync") starved = false;
  }
  assert.deepEqual(seen, ["send", "send", "skip", "skip", "resync", "send", "send"]);
});

test("a threshold of 0 turns the guard off", () => {
  assert.equal(ptyFrameAction(50 * 1024 * 1024, 0, false), "send");
  assert.equal(ptyFrameAction(50 * 1024 * 1024, -1, false), "send");
});
