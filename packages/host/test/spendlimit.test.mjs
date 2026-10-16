/**
 * The SPEND wall: an API-key / cloud account with no credit, or over a
 * workspace / organisation / gateway spend limit - on the screen and in the
 * CLI's log, and what the host does about it (spendwall.ts).
 *
 * The messages are BUILT from halves, never written out: the repo-wide rule
 * (limit.ts) is that no banner phrase appears in a source string, here included.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLimitText, limitNote } from "../dist/limit.js";
import { readLimitLog } from "../dist/limitlog.js";
import { spendRetry, setSpendPeriodSource } from "../dist/spendwall.js";

const CREDIT = ["Credit bal", "ance is too", " low"].join("");
const CREDIT_TUI = ["Credit bal", "ance too", " low · Add funds: https://example.test/billing"].join("");
const GATEWAY = (when) => ["spend li", "mit reached (daily; res", "ets ", when, " UTC)"].join("");
const WORKSPACE = (when) => ["You have reached your specified work", "space API usage li", "mits. You will regain ", "access on ", when, " UTC."].join("");

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

test("the credit message on screen is a spend wall with no reset", () => {
  for (const t of [CREDIT_TUI, "⎿  " + CREDIT, "Your " + CREDIT.toLowerCase() + " to access the Anthropic API."]) {
    const d = detectLimitText("some output\n" + t + "\n❯ ", NOW);
    assert.equal(d.blocked, true, t);
    assert.equal(d.spend, true);
    assert.equal(d.resetAt, null);
    assert.equal(d.weekly, false);
  }
});

test("a printed UTC reset is believed; a clock time is never guessed", () => {
  const g = detectLimitText(`API Error: 400 {"error":{"type":"billing_error","message":"${GATEWAY("2026-11-01 00:00")}"}}`, NOW);
  assert.equal(g.spend, true);
  assert.equal(g.resetAt, Date.UTC(2026, 10, 1, 0, 0));
  const w = detectLimitText(WORKSPACE("2026-11-01 at 00:00"), NOW);
  assert.equal(w.spend, true);
  assert.equal(w.resetAt, Date.UTC(2026, 10, 1, 0, 0));
});

test("prose that merely mentions the message is not a wall", () => {
  assert.equal(detectLimitText(`The user saw "${CREDIT}" earlier, so I checked billing.`, NOW).blocked, false);
  assert.equal(detectLimitText(`  - handle the ${GATEWAY("2026-11-01 00:00")} case`, NOW).blocked, false);
});

test("a plan banner is exactly what it was: not spend", () => {
  const d = detectLimitText("You've hit your session limit · resets 3am (UTC)", NOW);
  assert.equal(d.blocked, true);
  assert.equal(d.spend, false);
  assert.equal(detectLimitText("Thinking about the budget.", NOW).spend, false);
});

test("limitNote says no allowance and never a made-up clock", () => {
  const n = limitNote({ blocked: true, spend: true, resetAt: null, weekly: false }, "checked", NOW);
  assert.match(n, /no spend allowance/);
  assert.match(n, /no reset is known/);
});

// ── the CLI's log ────────────────────────────────────────────────────────────
const DIR = mkdtempSync(join(tmpdir(), "waterplane-spend-"));
let n = 0;
const iso = (ms) => new Date(ms).toISOString();
const apiError = (at, text, error = "billing_error") => JSON.stringify({
  type: "assistant", timestamp: iso(at), isApiErrorMessage: true, error,
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
});
const served = (at) => JSON.stringify({ type: "assistant", timestamp: iso(at), message: { model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "ok" }] } });
const log = (...rows) => { const p = join(DIR, `c${n++}.jsonl`); writeFileSync(p, rows.join("\n") + "\n"); return p; };
const HOUR = 3600e3;

test("the log: a credit error with nothing served after it is a standing spend block", () => {
  const v = readLimitLog(log(served(NOW - 2 * HOUR), apiError(NOW - HOUR, CREDIT)), NOW);
  assert.equal(v.state, "blocked");
  assert.equal(v.spend, true);
  assert.equal(v.resetAt, null);
  assert.equal(v.rejectedAt, NOW - HOUR);
});

test("the log: a turn served afterwards lifts it", () => {
  const v = readLimitLog(log(apiError(NOW - 2 * HOUR, CREDIT), served(NOW - HOUR)), NOW);
  assert.equal(v.state, "clear");
  assert.equal(v.clearedBy, "served");
});

test("the log: a printed reset that has passed is a clear, one ahead is a block with that instant", () => {
  const ahead = readLimitLog(log(apiError(NOW - HOUR, GATEWAY("2026-10-16 00:00"))), NOW);
  assert.equal(ahead.state, "blocked");
  assert.equal(ahead.resetAt, Date.UTC(2026, 9, 16));
  const past = readLimitLog(log(apiError(NOW - 5 * HOUR, GATEWAY("2026-10-15 09:00"))), NOW);
  assert.equal(past.state, "clear");
  assert.equal(past.clearedBy, "reset");
});

test("the log: other API errors are not a spend wall", () => {
  const v = readLimitLog(log(served(NOW - 2 * HOUR), apiError(NOW - HOUR, "Server is overloaded", "server_error")), NOW);
  assert.equal(v.spend, false);
  assert.equal(v.state, "clear");
});

// ── what to do about it ──────────────────────────────────────────────────────
const month = { id: "month", kind: "calendar", unit: "usd", cycle: "month", anchorDay: 1, tz: "UTC" };

test("no dollar calendar period: no reset, and the person is told", () => {
  setSpendPeriodSource(() => []);
  assert.equal(spendRetry(NOW).resetAt, null);
  const r = spendRetry(NOW, null, 0, 0);
  assert.equal(r.kind, "giveup");
  assert.match(r.why, /needs you/);
});

test("a configured dollar calendar period supplies its computed reset, once", () => {
  setSpendPeriodSource(() => [month, { id: "session", kind: "rolling", unit: "pct", lenMs: 5 * HOUR, scraped: true }]);
  const reset = spendRetry(NOW).resetAt;
  assert.equal(reset, Date.UTC(2026, 10, 1));
  const first = spendRetry(NOW, reset, 0, 60000);
  assert.equal(first.kind, "at");
  assert.equal(first.at, reset + 60000);
  assert.equal(spendRetry(NOW, reset, 1, 0).kind, "giveup");
});
