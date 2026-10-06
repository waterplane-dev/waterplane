import test from "node:test";
import assert from "node:assert/strict";
import { nextFireAt } from "@waterplane/shared";
import { anchorWords, weekBar, WEEK_MS } from "./scheduleWeekPlot.ts";

const H = 3600e3;
const NOW = Date.UTC(2026, 9, 1, 9);
const usage = { sessionPct: 42, weeklyPct: 61, sessionResetAt: NOW + 2 * H, weeklyResetAt: NOW + 77 * H };
const entry = (id, rule, over = {}) => ({
  id, rule, enabled: true, createdAt: 0, name: id,
  nextAt: nextFireAt(rule, NOW, usage),
  action: { kind: "backlog", repoDir: "/r", text: id }, ...over,
});

test("the resets come off the usage reading and sit on the bar where they fall", () => {
  const b = weekBar([], usage, NOW);
  assert.equal(b.weekly.resetAt, usage.weeklyResetAt);
  assert.equal(b.weekly.pct, 61);
  assert.ok(Math.abs(b.weekly.x - 77 * H / WEEK_MS) < 1e-9);
  assert.equal(b.session.resetAt, usage.sessionResetAt);
});

test("a window-anchored rule's pin is the host's nextAt, and its words name the reset", () => {
  const spend = entry("spend", { kind: "window", window: "weekly", edge: "before", offsetMin: -180 });
  const b = weekBar([spend], usage, NOW);
  assert.equal(b.fires.length, 1);
  assert.equal(b.fires[0].at, usage.weeklyResetAt - 3 * H);
  assert.equal(b.fires[0].anchor, "weekly");
  assert.equal(anchorWords(b.fires[0], b), "3h before the weekly reset");
});

test("an unread window is absent, never placed — and a rule waiting on it is named", () => {
  const b = weekBar([entry("w", { kind: "window", window: "session", edge: "after" }, { nextAt: null })], null, NOW);
  assert.equal(b.session, null);
  assert.equal(b.weekly, null);
  assert.deepEqual(b.unread, ["w"]);
});

test("a reset already behind us is the previous window's reading, not drawn", () => {
  const b = weekBar([], { ...usage, sessionResetAt: NOW - H }, NOW);
  assert.equal(b.session, null);
});

test("past the seven days a fire is listed, not drawn; paused rules are neither; close pins take two lanes", () => {
  const far = entry("far", { kind: "once", at: NOW + 9 * 24 * H });
  const off = entry("off", { kind: "once", at: NOW + 5 * H }, { enabled: false });
  const a = entry("a", { kind: "once", at: NOW + 10 * H });
  const c = entry("c", { kind: "once", at: NOW + 11 * H });
  const b = weekBar([far, off, c, a], usage, NOW);
  assert.deepEqual(b.later.map((l) => l.id), ["far"]);
  assert.deepEqual(b.fires.map((f) => [f.id, f.n, f.lane]), [["a", 1, 0], ["c", 2, 1]]);
  assert.equal(b.lanes, 2);
  assert.equal(anchorWords(b.fires[0], b), "on the clock");
});
