/**
 * Is the account limit-blocked, asked of the CLI's own conversation log.
 *
 * The bug these fixtures pin: a limit banner is the LAST thing a blocked
 * session prints, so it stays in the scrollback tail for as long as that
 * session sits idle. Every later screen scan re-affirmed a wall that came down
 * days earlier, and re-resolved its bare "resets 10pm" against today — a badge
 * that could neither be trusted nor lifted. The log rows are dated, so they can
 * say which.
 *
 * Real banner text appears in the fixtures. Same carve-out `limit.test.mjs`
 * takes: nothing here is rendered into a terminal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLimitLog } from "../dist/limitlog.js";

const DIR = mkdtempSync(join(tmpdir(), "waterplane-limitlog-"));
let n = 0;

const iso = (ms) => new Date(ms).toISOString();

/** The rejection row the CLI writes: a synthetic assistant turn + `quotaLimits`. */
const rejection = (at, resetAt, type = "five_hour") => JSON.stringify({
  type: "assistant",
  timestamp: iso(at),
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 10pm (Europe/Berlin)" }] },
  quotaLimits: { status: "rejected", resetsAt: Math.floor(resetAt / 1000), rateLimitType: type },
});

/** An ordinary served turn. */
const served = (at) => JSON.stringify({
  type: "assistant",
  timestamp: iso(at),
  message: { model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "on it" }] },
});

const user = (at) => JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: "go" } });

function log(...rows) {
  const p = join(DIR, `c${n++}.jsonl`);
  writeFileSync(p, rows.join("\n") + "\n");
  return p;
}

const NOW = Date.UTC(2026, 8, 5, 9, 0, 0);
const HOUR = 3600e3;

test("a rejection whose reset is still ahead is a live block", () => {
  const v = readLimitLog(log(user(NOW - HOUR), rejection(NOW - HOUR, NOW + 2 * HOUR)), NOW);
  assert.equal(v.state, "blocked");
  assert.equal(v.resetAt, NOW + 2 * HOUR);
  assert.equal(v.weekly, false);
});

test("a rejection whose reset has PASSED is not a block — this is the stale banner", () => {
  // The session has been sitting at the banner since Wednesday. Its screen
  // cannot say that; the row's own reset instant can.
  const v = readLimitLog(log(rejection(NOW - 40 * HOUR, NOW - 38 * HOUR)), NOW);
  assert.equal(v.state, "clear");
  assert.equal(v.rejectedAt, NOW - 40 * HOUR);
});

test("an assistant turn AFTER the rejection lifts it, with nobody typing", () => {
  // The positive half: the account served this session again. No continue was
  // attempted, no turn was started by us — and the block is provably over.
  const v = readLimitLog(log(rejection(NOW - HOUR, NOW + 2 * HOUR), served(NOW - 60_000)), NOW);
  assert.equal(v.state, "clear");
  assert.equal(v.servedAt, NOW - 60_000);
});

test("the rejection's own synthetic turn never counts as service", () => {
  // It is written as an assistant row. Counting it would clear every block the
  // instant it was recorded.
  const v = readLimitLog(log(rejection(NOW - HOUR, NOW + 2 * HOUR)), NOW);
  assert.equal(v.state, "blocked");
  assert.equal(v.servedAt, null);
});

test("a served turn BEFORE the rejection proves nothing", () => {
  const v = readLimitLog(log(served(NOW - 2 * HOUR), rejection(NOW - HOUR, NOW + 2 * HOUR)), NOW);
  assert.equal(v.state, "blocked");
});

test("the newest rejection wins over an older one", () => {
  const v = readLimitLog(log(
    rejection(NOW - 40 * HOUR, NOW - 38 * HOUR),
    served(NOW - 30 * HOUR),
    rejection(NOW - HOUR, NOW + HOUR),
  ), NOW);
  assert.equal(v.state, "blocked");
  assert.equal(v.resetAt, NOW + HOUR);
});

test("a log with no rejection at all is clear, not unknown", () => {
  const v = readLimitLog(log(user(NOW - HOUR), served(NOW - HOUR)), NOW);
  assert.equal(v.state, "clear");
  assert.equal(v.rejectedAt, null);
});

test("WHY a clear is clear is reported — the three are not one fact", () => {
  // The caller acts differently on each: `served` is proof about the account,
  // `reset` is only the clock moving past an instant (nothing ran, and an
  // auto-continue is still owed), and `none` is a log that has not caught up
  // with a banner already on screen.
  const served_ = readLimitLog(log(rejection(NOW - HOUR, NOW + 2 * HOUR), served(NOW - 60_000)), NOW);
  assert.equal(served_.clearedBy, "served");
  const clock = readLimitLog(log(rejection(NOW - 40 * HOUR, NOW - 38 * HOUR)), NOW);
  assert.equal(clock.clearedBy, "reset");
  const none = readLimitLog(log(user(NOW - HOUR), served(NOW - HOUR)), NOW);
  assert.equal(none.clearedBy, "none");
  const blocked = readLimitLog(log(rejection(NOW - HOUR, NOW + 2 * HOUR)), NOW);
  assert.equal(blocked.clearedBy, null, "a block is not cleared by anything");
});

test("being served again outranks the clock when both hold", () => {
  // The reset passed AND a turn was served after the rejection. The second is a
  // fact about the account; the first is only a fact about the clock.
  const v = readLimitLog(log(rejection(NOW - 4 * HOUR, NOW - HOUR), served(NOW - 30 * 60e3)), NOW);
  assert.equal(v.state, "clear");
  assert.equal(v.clearedBy, "served");
});

test("a missing log is UNKNOWN — never a verdict", () => {
  // The caller keeps its screen heuristic. Turning an absent file into "clear"
  // would silently disable limit detection for every session whose conversation
  // id we have not learned yet.
  const v = readLimitLog(join(DIR, "nope.jsonl"), NOW);
  assert.equal(v.state, "unknown");
});

test("an empty log is unknown too", () => {
  const v = readLimitLog(log(), NOW);
  assert.equal(v.state, "unknown");
});

test("a non-five_hour window is flagged weekly", () => {
  const v = readLimitLog(log(rejection(NOW - HOUR, NOW + 2 * HOUR, "weekly")), NOW);
  assert.equal(v.state, "blocked");
  assert.equal(v.weekly, true);
});

test("a reset in milliseconds is read as milliseconds", () => {
  // Defensive: the rows seen so far carry seconds. A unit change upstream must
  // not become a reset 56 000 years out, which would pin a block for ever.
  const row = JSON.parse(rejection(NOW - HOUR, NOW + HOUR));
  row.quotaLimits.resetsAt = NOW + HOUR;
  const v = readLimitLog(log(JSON.stringify(row)), NOW);
  assert.equal(v.resetAt, NOW + HOUR);
});

test("a truncated first line (tail read) does not throw", () => {
  const v = readLimitLog(log('{"type":"assis', rejection(NOW - HOUR, NOW + HOUR)), NOW);
  assert.equal(v.state, "blocked");
});
