/**
 * When an unparsed conversation log counts against the `transcript.jsonl`
 * health signal. Since 2.1.301 the CLI writes ~5.6 KB of start-up bookkeeping
 * (`mode`, `permission-mode`, `bridge-session`, a SessionStart attachment) before
 * any prompt, and "bytes but no turns" filed a miss for every idle session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { logHealthOutcome } = await import("../dist/sessions/record.js");

const NOW = 1_800_000_000_000;
const BORN = NOW - 600_000;
const sent = (text, ago, kind = "prompt") => ({ id: text, kind, text, sentAt: NOW - ago });

test("a log with turns is good", () => {
  assert.equal(logHealthOutcome(3, 9000, [], BORN, NOW), "good");
});

test("start-up bookkeeping with nothing typed proves nothing", () => {
  assert.equal(logHealthOutcome(0, 5602, [], BORN, NOW), null);
});

test("an empty file proves nothing", () => {
  assert.equal(logHealthOutcome(0, 0, [sent("fix it", 120_000)], BORN, NOW), null);
});

test("a prompt typed long enough ago and still no turn is a miss", () => {
  assert.equal(logHealthOutcome(0, 5602, [sent("fix it", 120_000)], BORN, NOW), "miss");
});

test("a prompt typed seconds ago is not owed yet", () => {
  assert.equal(logHealthOutcome(0, 5602, [sent("fix it", 2_000)], BORN, NOW), null);
});

test("a prompt from before the log was born (a /clear) is not owed", () => {
  assert.equal(logHealthOutcome(0, 5602, [sent("old", 900_000)], BORN, NOW), null);
});

test("slash commands are never written as turns, so they owe nothing", () => {
  assert.equal(logHealthOutcome(0, 5602, [sent("/model", 120_000, "command"), sent("/btw x", 120_000)], BORN, NOW), null);
});

test("no birth time means no verdict", () => {
  assert.equal(logHealthOutcome(0, 5602, [sent("fix it", 120_000)], null, NOW), null);
});
