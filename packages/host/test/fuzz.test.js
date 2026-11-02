/**
 * Property tests (fast-check) over the regex heuristics that read the rendered screen. The rule
 * they hold: ANY screen text never throws, finishes fast (a catastrophic-backtracking regex is a
 * host stalled on one repaint), and answers null/absent or a well-formed value, never a wrong
 * number. Fixed seed, capped runs. (`.js` on purpose: OpenSSF Scorecard's Fuzzing check scans
 * only js/ts files.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { detectContext, contextMeterRow } from "../dist/context.js";
import { detectLimitText, detectSpendText, parseResetTime, isSpendLine, detectHeadlessLimit } from "../dist/limit.js";
import { detectPrompt, dialogStillUp, hasDialogFooter, dialogEvidence } from "../dist/prompt.js";
import { looksLikeQuestion, askLine, questionText, sameAsk } from "../dist/question.js";
import { readPermMode, readUltracode } from "../dist/permmode.js";

const RUNS = { seed: 42, numRuns: 200 };
// Generous on purpose: a loaded CI box doubles a 10 ms call; backtracking blow-ups cost seconds.
const BUDGET_MS = 250;

/** Real-looking screen lines, so the generators reach past the first regex gate. */
const LINES = [
  "Context left until auto-compact: 42%", "42% context left", "123k/200k tokens", "1.5m/2m context",
  "Resets Jul 9 at 7pm (Europe/Berlin)", "resets in 2 hours", "will reset at 14:00", "resets Tue 3am",
  "5-hour limit reached", "weekly limit", "Stop and wait for limit to reset",
  "API Error: credit balance is too low", "Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No, and tell Claude what to do differently",
  "Esc to cancel · Tab to amend", "Enter to select · ↑/↓ to navigate", "╭────────╮", "│ > │", "? for shortcuts",
  "⏵⏵ accept edits on (shift+tab to cycle)", "Should I go ahead?", "Which one do you prefer?", "Want me to run the tests?",
  "\u001b[1m\u001b[31mred\u001b[0m", "\r", "\t",
];
const screen = fc.oneof(
  fc.string({ maxLength: 4000 }),
  fc.string({ unit: "binary", maxLength: 3000 }),
  fc.array(fc.oneof(fc.constantFrom(...LINES), fc.string({ maxLength: 120 })), { maxLength: 120 }).map((a) => a.join("\n")),
  fc.array(fc.constantFrom(...LINES, " ", "0", "9", "%", "/", "k", ".", "reset", "Resets"), { maxLength: 800 }).map((a) => a.join("")),
);
/** Pathological repeats: what backtracking regexes choke on. */
const hostile = fc.tuple(fc.constantFrom(...LINES, " ", "1", "9.", "a", "resets ", "context "), fc.integer({ min: 200, max: 4000 }), fc.string({ maxLength: 8 }))
  .map(([unit, n, tail]) => (unit.repeat(n) + tail).slice(0, 6000));
const anyScreen = fc.oneof(screen, hostile);

/** Run f(text), assert it is fast, return its value. */
function timed(f, text) {
  const t0 = performance.now();
  const v = f(text);
  const ms = performance.now() - t0;
  assert.ok(ms < BUDGET_MS, `${f.name} took ${ms.toFixed(0)}ms on ${text.length} chars: ${JSON.stringify(text.slice(0, 120))}`);
  return v;
}
const pctOk = (n) => n === null || (Number.isInteger(n) && n >= 0 && n <= 100);
const epochOk = (n) => n === null || (Number.isFinite(n) && n >= 0);

test("context: detectContext never throws, is fast, and reports sane numbers", () => {
  fc.assert(fc.property(anyScreen, (text) => {
    const c = timed(detectContext, text);
    assert.ok(pctOk(c.leftPct), `leftPct ${c.leftPct}`);
    for (const k of ["usedTok", "totalTok"]) if (c[k] !== undefined) assert.ok(Number.isFinite(c[k]) && c[k] >= 0, `${k} ${c[k]}`);
    if (c.usedTok !== undefined && c.totalTok !== undefined) assert.ok(c.usedTok <= c.totalTok);
    const row = timed(contextMeterRow, text);
    assert.ok(row === null || (typeof row === "string" && row.length > 0));
  }), RUNS);
});

test("limit: banner and spend detection are fast, boolean-clean, and reset times are finite", () => {
  fc.assert(fc.property(anyScreen, fc.integer({ min: 1.5e12, max: 2.2e12 }), (text, now) => {
    const d = timed((t) => detectLimitText(t, now), text);
    assert.equal(typeof d.blocked, "boolean");
    assert.equal(typeof d.spend, "boolean");
    assert.equal(typeof d.weekly, "boolean");
    assert.ok(epochOk(d.resetAt), `resetAt ${d.resetAt}`);
    if (!d.blocked) assert.equal(d.resetAt, null);
    const s = timed(detectSpendText, text);
    assert.ok(epochOk(s.resetAt));
    assert.ok(epochOk(timed((t) => parseResetTime(t, now), text)));
    timed(isSpendLine, text);
    const h = timed((t) => detectHeadlessLimit(t, t, now), text);
    assert.ok(epochOk(h.resetAt));
  }), RUNS);
});

test("prompt: choice-box detection never throws, is fast, and returns a well-formed prompt or null", () => {
  fc.assert(fc.property(anyScreen, (text) => {
    for (const opts of [{}, { lenient: true }]) {
      const p = timed((t) => detectPrompt(t, opts), text);
      if (p === null) continue;
      assert.ok(Array.isArray(p.options) && p.options.length > 0, "a prompt with no options");
      for (const o of p.options) assert.equal(typeof o.label, "string");
      assert.equal(typeof p.question, "string");
    }
    timed(dialogStillUp, text);
    timed(hasDialogFooter, text);
    timed(dialogEvidence, text);
  }), RUNS);
});

test("question: the no-box question reader is fast and returns bounded text", () => {
  fc.assert(fc.property(anyScreen, (text) => {
    assert.equal(typeof timed(looksLikeQuestion, text), "boolean");
    assert.ok(timed(questionText, text).length <= 240);
    const a = timed((t) => askLine(t), text);
    assert.ok(typeof a === "string" && a.length <= 200, `askLine ${a.length}`);
    if (/[\p{L}\p{N}]/u.test(a)) assert.equal(sameAsk(a, a), true); // letterless asks are never "the same" by design
  }), RUNS);
});

test("permmode: the footer reader answers a mode or null and never throws", () => {
  fc.assert(fc.property(anyScreen, (text) => {
    const m = timed(readPermMode, text);
    assert.ok(m === null || typeof m === "string");
    const u = timed(readUltracode, text);
    assert.equal(typeof u, "object");
  }), RUNS);
});

// Found by this file: the old one-regex gate was cubic on a row of "context" words with no
// left|remaining|free|window|used|auto-compact after them ("context ".repeat(500): ~1.3 s).
test("context: a long line of 'context' words is not quadratic", () => {
  const t0 = performance.now();
  contextMeterRow("context ".repeat(500));
  assert.ok(performance.now() - t0 < BUDGET_MS);
});

// The linear gate must take exactly the rows the old one-regex gate took. One row at a time, always
// carrying a figure and never a conversation mark, so the gate is the only thing deciding. Short
// rows only: the old form is the cubic one. Words drawn so most rows sit near the gate's edge.
const OLD_GATE_RE = /[^\n]*\bcontext\b[^\n]*\b(?:left|remaining|free|window|used|auto-?compact)\b[^\n]*/i;
test("context: the linear meter gate takes the same rows as the old regex", () => {
  const word = fc.constantFrom("context", "Context", "CONTEXT", "contextual", "context-", "_context", "left", "remaining",
    "free", "window", "windows", "used", "autocompact", "auto-compact", "auto-", "compact", "leftover", "x", "-", ":", "/", "é");
  const row = fc.tuple(fc.array(word, { maxLength: 30 }), fc.constantFrom("", " ", "-")).map(([a, sep]) => a.join(sep || " ") + " 42%");
  fc.assert(fc.property(row, (r) => (contextMeterRow(r) !== null) === OLD_GATE_RE.test(r)), { seed: 42, numRuns: 3000 });
});
