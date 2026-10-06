import test from "node:test";
import assert from "node:assert/strict";

import { shouldNotice, shouldNoticeAgent } from "./costNotice.ts";

test("a first crossing at a real level notices, and records it", () => {
  const { notice, next } = shouldNotice("s1", "warm", {});
  assert.equal(notice, true);
  assert.deepEqual(next, { s1: "warm" });
});

test("the same level again on a re-render does not re-fire", () => {
  const seen = { s1: "warm" };
  const { notice, next } = shouldNotice("s1", "warm", seen);
  assert.equal(notice, false);
  // No-op: the caller must be able to skip writing on a no-op.
  assert.equal(next, seen);
});

test("stepping UP notices and overwrites the recorded level", () => {
  const { notice, next } = shouldNotice("s1", "heavy", { s1: "warm" });
  assert.equal(notice, true);
  assert.deepEqual(next, { s1: "heavy" });
});

test("stepping DOWN never notices — a cooled-off session climbing back to a level it already crossed is silent", () => {
  const { notice, next } = shouldNotice("s1", "warm", { s1: "steep" });
  assert.equal(notice, false);
  assert.deepEqual(next, { s1: "steep" });
});

test("an unseen session starts at rank 0, so a 'fresh' crossing never notices anybody", () => {
  const { notice } = shouldNotice("new-session", "fresh", {});
  assert.equal(notice, false);
});

test("an existing key updates in place — reassigning its value does not move its position", () => {
  const seen = { a: "warm", b: "heavy" };
  const { next } = shouldNotice("a", "steep", seen);
  assert.deepEqual(Object.keys(next), ["a", "b"]);
});

test("bounded at 60 remembered sessions, oldest evicted first", () => {
  const seen = {};
  for (let i = 0; i < 60; i++) seen[`s${i}`] = "warm";
  const { next } = shouldNotice("s60", "heavy", seen);
  const ids = Object.keys(next);
  assert.equal(ids.length, 60);
  // s0 was the oldest insertion and is the one evicted; the new entry and the
  // rest of the run survive.
  assert.equal("s0" in next, false);
  assert.equal(next.s60, "heavy");
  assert.equal(next.s1, "warm");
});

test("does not mutate the seen map it was given", () => {
  const seen = { s1: "warm" };
  shouldNotice("s1", "heavy", seen);
  assert.deepEqual(seen, { s1: "warm" });
});

// ── The large-running-subagent toast ──────────────────────────────────────

test("an agent crossing the line is told once, and a re-render is silent", () => {
  const first = shouldNoticeAgent("s1", "a1", {});
  assert.equal(first.notice, true);
  assert.deepEqual(first.next, { s1: "a1" });
  const again = shouldNoticeAgent("s1", "a1", first.next);
  assert.equal(again.notice, false);
  assert.equal(again.next, first.next, "no-op keeps the reference");
});

test("dropping below re-arms the session; the next crossing is told", () => {
  const below = shouldNoticeAgent("s1", null, { s1: "a1" });
  assert.equal(below.notice, false);
  assert.deepEqual(below.next, {});
  assert.equal(shouldNoticeAgent("s1", "a1", below.next).notice, true);
});

test("below the line with nothing recorded is a no-op", () => {
  const seen = { s2: "x" };
  const v = shouldNoticeAgent("s1", null, seen);
  assert.equal(v.notice, false);
  assert.equal(v.next, seen);
});

test("a second agent crossing in the same session is a new crossing", () => {
  assert.equal(shouldNoticeAgent("s1", "a2", { s1: "a1" }).notice, true);
});

test("sessions are independent", () => {
  assert.equal(shouldNoticeAgent("s2", "a1", { s1: "a1" }).notice, true);
});

test("the agent record is bounded, oldest evicted first", () => {
  let seen = {};
  for (let i = 0; i < 61; i++) seen = shouldNoticeAgent(`s${i}`, "a", seen).next;
  assert.equal(Object.keys(seen).length, 60);
  assert.equal("s0" in seen, false);
  assert.equal("s60" in seen, true);
});
