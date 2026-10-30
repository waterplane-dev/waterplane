/**
 * Schedules anchored to a USAGE RESET, and the condition that may skip one.
 *
 * Every rule here decides whether real work runs unattended, and each fails
 * silently in a different direction: an occurrence placed at a guessed instant
 * runs at the wrong time, a condition tested at ARM time tests a figure hours
 * out of date, and a condition that fails OPEN fires a thirteen-repo sweep for
 * exactly the reason the person wrote the condition to avoid.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanRule, describeRule, nextFireAt, windowCondition, windowPct, windowResetAt } from "../dist/schedule.js";

const NOW = 1_700_000_000_000;
const H = 3600_000;
const resets = (over = {}) => ({
  sessionResetAt: NOW + 5 * H, weeklyResetAt: NOW + 50 * H,
  sessionPct: 40, weeklyPct: 10, ...over,
});

// ── Arming ──────────────────────────────────────────────────────────────────

test("`before` fires its lead time ahead of the reset it tracks", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -120 });
  assert.equal(nextFireAt(r, NOW, resets()), NOW + 3 * H); // 5h out, 2h before
});

test("`after` fires AT the reset, and a lead time cannot drag it before one", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "after", offsetMin: -120 });
  // A negative offset on `after` is meaningless — it would fire before the
  // reset it claims to follow, into the window it was waiting to escape.
  assert.equal(r.offsetMin, 0);
  assert.equal(nextFireAt(r, NOW, resets()), NOW + 5 * H);
});

test("the weekly anchor is a different instant from the session one", () => {
  const r = cleanRule({ kind: "window", window: "weekly", edge: "after" });
  assert.equal(nextFireAt(r, NOW, resets()), NOW + 50 * H);
});

test("an UNREAD reset arms nothing rather than guessing an instant", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "after" });
  // The tick re-asks on every pass, so the rule stays visibly un-armed until
  // the first scrape lands. Placing it at a guess means an occurrence that
  // moves under the user after they set it.
  assert.equal(nextFireAt(r, NOW, resets({ sessionResetAt: null })), null);
  assert.equal(nextFireAt(r, NOW, undefined), null);
});

test("an occurrence already behind us is not armed", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -600 });
  // 5h out, 10h before ⇒ five hours ago.
  assert.equal(nextFireAt(r, NOW, resets()), null);
});

// ── The condition, at FIRE time ─────────────────────────────────────────────

test("enough headroom left ⇒ it runs, and says how much there was", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -120, minPctLeft: 50 });
  const v = windowCondition(r, resets({ sessionPct: 40 })); // 60 left
  assert.equal(v.ok, true);
  assert.match(v.detail, /60% of the session window was left/);
});

test("too little left ⇒ skipped, and the sentence names both numbers", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -120, minPctLeft: 50 });
  const v = windowCondition(r, resets({ sessionPct: 80 })); // 20 left
  assert.equal(v.ok, false);
  assert.match(v.detail, /conditions not met/);
  assert.match(v.detail, /20%/);
  assert.match(v.detail, /at least 50%/);
});

test("an unreadable meter SKIPS — it does not fall through to running", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -120, minPctLeft: 50 });
  const v = windowCondition(r, resets({ sessionPct: null }));
  // `budgetVerdict` fails OPEN on an unreadable scrape and is right to: it is a
  // safety rail, and a parse broken upstream must not freeze every queue on
  // every host. This is the opposite object — a condition written to make work
  // happen only when it is worth it — so the same input must fail CLOSED, and
  // the skip is notified rather than silent.
  assert.equal(v.ok, false);
  assert.match(v.detail, /could not be read/);
});

test("no condition ⇒ nothing to fail, whatever the meter says", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -120 });
  assert.equal(windowCondition(r, resets({ sessionPct: null })).ok, true);
});

test("`after` is unconditional by nature — a just-reset window is empty", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "after", minPctLeft: 90 });
  // The sanitizer drops the condition rather than keeping a field that could
  // only ever mean "never run".
  assert.equal(r.minPctLeft, undefined);
  assert.equal(windowCondition(r, resets({ sessionPct: 99 })).ok, true);
});

test("a condition of 0 is a real condition and is kept", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -60, minPctLeft: 0 });
  assert.equal(r.minPctLeft, 0);
  assert.equal(windowCondition(r, resets({ sessionPct: 100 })).ok, true);
  // …and it still fails closed when there is no reading at all.
  assert.equal(windowCondition(r, resets({ sessionPct: null })).ok, false);
});

test("the weekly condition reads the WEEKLY figure, not the session one", () => {
  const r = cleanRule({ kind: "window", window: "weekly", edge: "before", offsetMin: -60, minPctLeft: 50 });
  assert.equal(windowPct(r, resets({ weeklyPct: 10, sessionPct: 99 })), 10);
  assert.equal(windowCondition(r, resets({ weeklyPct: 10, sessionPct: 99 })).ok, true);
});

// ── What it says ────────────────────────────────────────────────────────────

test("a rule is described by its ANCHOR, never by a resolved clock", () => {
  const before = cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -120, minPctLeft: 40 });
  const said = describeRule(before);
  // The anchor moves; a resolved "16:00" hides what has to be edited when it
  // does. `describeRule`'s own doc has said this since before there was a
  // reset to anchor to.
  assert.match(said, /2h before the session window resets/);
  assert.match(said, /only if 40% is left/);
  assert.equal(describeRule(cleanRule({ kind: "window", window: "weekly", edge: "after" })),
    "right after the weekly window resets");
});

test("windowResetAt refuses a zero or negative instant as unread", () => {
  const r = cleanRule({ kind: "window", window: "session", edge: "after" });
  assert.equal(windowResetAt(r, resets({ sessionResetAt: 0 })), null);
  assert.equal(windowResetAt(r, resets({ sessionResetAt: -1 })), null);
});

// ── The verdict: unread is not "switched off" ───────────────────────────────

import { intentVerdict } from "../dist/intent.js";

const facts = { now: NOW, autoFire: true, budgetBlocked: false, sessions: [], busyGroups: new Set(), repoSession: () => "s1", repoAnySession: () => true, sessionAlive: () => true };
const winIntent = (over = {}) => ({
  id: "w1", cwd: "/r", payload: { kind: "prompt", steps: ["go"] },
  target: { kind: "repo" }, state: "queued", createdAt: NOW - 1000,
  trigger: { kind: "at", graceMin: 30, rule: cleanRule({ kind: "window", window: "session", edge: "after" }) },
  ...over,
});

test("a window rule with nothing armed is WAITING FOR A READING, not switched off", () => {
  const v = intentVerdict(winIntent({ nextAt: null }), facts);
  // The same `nextAt` means two different things for the two rule kinds, and
  // saying "switched off — turn it back on" here offers a tap that re-arms to
  // the same nothing: what is missing is a usage scrape, not a decision.
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "notYet");
  assert.match(v.detail, /waiting for the first usage reading/);
  assert.doesNotMatch(v.detail, /switched off/);
});

test("a paused WEEKLY rule reads as switched off", () => {
  // The pause is its own flag (`trigger.paused`); `nextAt: null` alone no
  // longer means switched off (208aa148).
  const weekly = winIntent({ nextAt: null, trigger: { kind: "at", graceMin: 30, paused: true, rule: cleanRule({ kind: "weekly", hour: 9 }) } });
  const v = intentVerdict(weekly, facts);
  assert.equal(v.reason, "gate");
  assert.match(v.detail, /switched off/);
});

test("a CLOCK rule ignores the usage argument entirely", () => {
  // The host leans on this: `armFrom` asks its usage dependency only for
  // `window` rules, because `migrateLegacy()` arms every imported schedule
  // during the module body — before `usage` is constructed — and an
  // unconditional call reached a `const` in its temporal dead zone and threw,
  // taking the whole legacy import with it (`e2e-schedule.mjs` caught it).
  const once = cleanRule({ kind: "once", at: NOW + H });
  assert.equal(nextFireAt(once, NOW), nextFireAt(once, NOW, resets()));
  const weekly = cleanRule({ kind: "weekly", hour: 9, tz: "UTC" });
  assert.equal(nextFireAt(weekly, NOW), nextFireAt(weekly, NOW, resets()));
  // …and both still answer with no usage argument at all, which is the call
  // shape the host now makes for them.
  assert.equal(typeof nextFireAt(once, NOW), "number");
});
