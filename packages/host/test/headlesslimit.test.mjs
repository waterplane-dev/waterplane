/**
 * A quota block seen through a HEADLESS run's own output.
 *
 * The bug this pins: `claude -p --output-format json`, refused by the account,
 * exits non-zero with the banner in the envelope's `result` and NOTHING on
 * stderr — so every caller reported `String(err)`, i.e. `Command failed: claude
 * -p …`, which names no fact and reads as a broken install. The fixture below
 * is the real envelope shape (measured, CLI 2.1.236) around the real sentence
 * found in a stored `checkDetail`.
 *
 * Real banner phrasing appears here for the same carve-out `limit.test.mjs`
 * takes: nothing in this file is ever rendered into a terminal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHeadlessLimit, limitNote } from "../dist/limit.js";

const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime(); // Thu 15 Jan 2026, 12:00 local

const envelope = (result) => JSON.stringify({
  type: "result", subtype: "success", is_error: true, result,
  session_id: "b0f3c1de-0000-4000-8000-000000000001",
});

test("the block is read out of the envelope, not out of stderr", () => {
  const d = detectHeadlessLimit(envelope("You've hit your session limit · resets 5:10pm (Europe/Berlin)"), "", NOW);
  assert.equal(d.blocked, true);
  assert.ok(d.resetAt, "the reset instant travels with the block");
});

test("a plain (un-enveloped) refusal on stderr still counts", () => {
  const d = detectHeadlessLimit("", "You've reached your usage limit.", NOW);
  assert.equal(d.blocked, true);
});

test("an ordinary failed run is NOT a quota block", () => {
  // The false positive that matters: reported as a limit, a broken install
  // would look like something that fixes itself in five hours.
  const d = detectHeadlessLimit(envelope('{"status":"not_done","note":"no such file"}'), "", NOW);
  assert.equal(d.blocked, false);
});

test("junk on stdout is not an envelope and is not a block", () => {
  assert.equal(detectHeadlessLimit("not json at all", "", NOW).blocked, false);
});

test("the sentence says what did NOT happen, and when to retry", () => {
  const d = detectHeadlessLimit(envelope("You've hit your session limit · resets 5:10pm (Europe/Berlin)"), "", NOW);
  const note = limitNote(d, "checked", NOW);
  assert.match(note, /Nothing was checked/);
  assert.match(note, /\d\d:\d\d/, "the reset is named, so the retry is actionable");
  // It must not imply a verdict on the work — that is the false error the
  // whole change exists to stop.
  assert.doesNotMatch(note, /failed/i);
});

test("with no reset in the text the sentence still stands, minus the clock", () => {
  const note = limitNote({ blocked: true, resetAt: null, weekly: false }, "assessed", NOW);
  assert.match(note, /Nothing was assessed/);
  assert.doesNotMatch(note, /until/);
});

test("a weekly window says so — its reset is days out, not hours", () => {
  const note = limitNote({ blocked: true, resetAt: NOW + 3600e3, weekly: true }, "checked", NOW);
  assert.match(note, /weekly/);
});
