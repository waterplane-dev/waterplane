/**
 * Usage-limit banner detection and reset parsing.
 *
 * Two different wrong answers matter here and they are not symmetric. A missed
 * block leaves a session silently dead until someone opens it; a false block
 * stops work that was fine. The banner text is upstream's and changes without
 * notice, which is what these fixtures exist to catch.
 *
 * Real banner phrases appear below. Same carve-out `scripts/claude-stub-limit.mjs`
 * takes: the repo-wide rule is about the daemon printing one onto a session's
 * screen, where it would false-positive its own detector. Nothing here is
 * rendered into a terminal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLimitText, parseResetTime } from "../dist/limit.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // Thu 15 Jan 2026, 12:00 UTC

test("a block is a block", () => {
  const d = detectLimitText("You've reached your usage limit.", NOW);
  assert.equal(d.blocked, true);
});

test("an approaching-limit line WARNS and must never block", () => {
  // It is printed while everything still works. Reading it as a block stops a
  // session that had nothing wrong with it.
  const d = detectLimitText("Note: approaching your usage limit for this window.", NOW);
  assert.equal(d.blocked, false);
  assert.equal(d.resetAt, null);
});

test("the wait option in the limit menu counts as blocked", () => {
  const d = detectLimitText("1. Stop and wait for the limit to reset", NOW);
  assert.equal(d.blocked, true);
});

test("a weekly block is flagged, because its reset time is a bare clock", () => {
  // The weekly banner prints a wall-clock time with no calendar date, so the
  // parsed reset lands on the wrong DAY — the real window is days out. The flag
  // is what stops the parsed time from being trusted.
  const d = detectLimitText("You've hit your weekly limit. Resets at 7pm", NOW);
  assert.equal(d.blocked, true);
  assert.equal(d.weekly, true);
});

test("nothing in ordinary output blocks", () => {
  const d = detectLimitText("Running tests…\n  42 passed", NOW);
  assert.equal(d.blocked, false);
});

test("the demo's stop line never reads as a block", () => {
  // `limit-and-budget`'s words where the CLI halts at the 5-hour wall (packages/web/src/demo/scenarios/
  // limit-and-budget.ts `stopLine`), drawn in the docs films: a screen showing them must not park a
  // real session that displays them.
  for (const line of [
    "5-hour window used up · back at 12:47 PM (demo)",
    "⏺ 5-hour window used up · back at 12:47 PM (demo)",
  ]) {
    const d = detectLimitText(`Update(src/components/TaskRow.tsx)\n  ⎿  Added 21 lines, removed 2 lines\n\n${line}`, NOW);
    assert.equal(d.blocked, false, line);
  }
});

test("a relative reset is measured from now", () => {
  assert.equal(parseResetTime("resets in 2 hours", NOW), NOW + 2 * 3600_000);
  assert.equal(parseResetTime("resets in 45 minutes", NOW), NOW + 45 * 60_000);
});

test("a bare hour is too ambiguous to guess at", () => {
  // "resets 3" could be 03:00 or 15:00, eight hours apart, and the number is
  // what a scheduled resume is armed against. Null beats a coin flip.
  assert.equal(parseResetTime("resets 3", NOW), null);
});

test("a clock time in the future today stays today", () => {
  const at = parseResetTime("resets at 3pm (UTC)", NOW);
  assert.ok(at, "an explicit zone and an am/pm clock is enough to resolve");
  assert.equal(at, Date.UTC(2026, 0, 15, 15, 0, 0));
});

test("a recently-past clock time means ALREADY RESET, not tomorrow", () => {
  // The banner outlives the reset on screen, and across host restarts. A stale
  // "resets 9am" read at 12:00 means the window already reopened — the caller
  // should catch up now, not wait a day. Session windows are 5h, so anything
  // inside the 6h grace is read as past-tense.
  const at = parseResetTime("resets at 9am (UTC)", NOW);
  assert.equal(at, Date.UTC(2026, 0, 15, 9, 0, 0), "returned as-is, in the past");
  assert.ok(at < NOW);
});

test("…but past the grace it really does mean tomorrow", () => {
  // "resets 3am" read at noon is 9h back — further than any session window, so
  // the banner can only be talking about the next one.
  const at = parseResetTime("resets at 3am (UTC)", NOW);
  assert.equal(at, Date.UTC(2026, 0, 16, 3, 0, 0));
});

test("the zone the banner NAMES is the zone that is used", () => {
  // The daemon's own TZ is irrelevant: claude prints the zone it means, and
  // honouring it is what keeps a resume from firing an hour off.
  const utc = parseResetTime("resets at 6pm (UTC)", NOW);
  const berlin = parseResetTime("resets at 6pm (Europe/Berlin)", NOW);
  assert.ok(utc && berlin);
  assert.notEqual(utc, berlin, "two zones cannot resolve to the same instant here");
  // Berlin is ahead of UTC in January, so its 6pm happens FIRST.
  assert.ok(berlin < utc, "Europe/Berlin is UTC+1 in January");
});

test("a stray clock elsewhere on screen does not win", () => {
  // Only text near the word "reset" is considered, so a timestamp in the
  // conversation above the banner cannot arm the resume.
  const at = parseResetTime("built at 4:05pm\nsomething else entirely", NOW);
  assert.equal(at, null);
});
