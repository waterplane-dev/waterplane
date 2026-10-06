/**
 * The session budget's pure half (`features/sessionBudget/logic.ts`).
 *
 *     node --test packages/web/src/features/sessionBudget/logic.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BUDGET_WHY_SHORT, HELD_SENDS, budgetStateLine, budgetSubject, budgetTagFacts, budgetToast, shouldNoticeBudget,
  budgetAskedToast, BUDGET_ASKED_CLEAR_TOAST, budgetConfirmed, BUDGET_UNCONFIRMED } from "./logic.ts";

const cfg = { unit: "usd", max: 0.5, interrupt: true };
const info = (state, extra = {}) => ({ cfg, verdict: { unit: "usd", max: 0.5, spent: state === "unknown" ? null : 0.52, agentShare: 0.12, state, ...extra } });

test("ok wears the chip, in the muted tag, and says the sentence in its title", () => {
  const f = budgetTagFacts({ running: true, budget: info("ok", { spent: 0.31 }) }, 0);
  assert.equal(f.text, "$0.31 / $0.50");
  assert.equal(f.cls, "ctx-ok");
  assert.match(f.title, /\$0\.31 so far, \$0\.12 of it in subagents — within the \$0\.50 budget/);
});

test("over says it is hit and that sends are held, in the chip's own text", () => {
  const f = budgetTagFacts({ running: true, budget: info("over") }, 0);
  assert.equal(f.text, "budget hit · $0.52 / $0.50 · sends held");
  assert.match(f.title, /over the \$0\.50 budget/);
  assert.ok(f.title.includes(HELD_SENDS));
});

test("unknown says why, never an amount, and the title ends on nothing being held", () => {
  for (const why of Object.keys(BUDGET_WHY_SHORT)) {
    const f = budgetTagFacts({ running: true, budget: info("unknown", { why }) }, 0);
    assert.equal(f.text, `budget ? — ${BUDGET_WHY_SHORT[why]}`);
    assert.match(f.title, /nothing is held$/);
    assert.ok(!f.text.includes("$"));
  }
});

test("a stale reading names its age from the calibration's own stamp", () => {
  const b = { ...info("unknown", { why: "stale" }), cal: { checkedAt: 0, sessionUsdPerPct: 1, weeklyUsdPerPct: 1 } };
  assert.match(budgetTagFacts({ running: true, budget: b }, 40 * 60_000).title, /40 min old/);
});

test("no budget, or a session that is not running, wears nothing", () => {
  assert.equal(budgetTagFacts({ running: true }, 0), null);
  assert.equal(budgetTagFacts({ running: false, budget: info("ok") }, 0), null);
});

test("the state line: none, within, over with the held sentence, unknown", () => {
  assert.equal(budgetStateLine(undefined, 0), "No budget on this session.");
  assert.match(budgetStateLine(info("ok"), 0), /within the \$0\.50 budget\.$/);
  assert.ok(budgetStateLine(info("over"), 0).endsWith(HELD_SENDS));
  assert.match(budgetStateLine(info("unknown", { why: "noSpark" }), 0), /has not logged a turn yet/);
});

test("the toast names the session and says the sends are held", () => {
  const t = budgetToast("app · main", info("over"));
  assert.match(t, /^app · main: \$0\.52 so far/);
  assert.match(t, /sends are held/);
});

test("one notice per crossing: fires once, silent while over, re-armed by leaving", () => {
  let seen = new Set();
  let r = shouldNoticeBudget("s1", true, seen);
  assert.equal(r.notice, true); seen = r.next;
  r = shouldNoticeBudget("s1", true, seen);
  assert.equal(r.notice, false); assert.equal(r.next, seen, "a no-op returns the same set so the caller can skip writing");
  r = shouldNoticeBudget("s1", false, seen);
  assert.equal(r.notice, false); seen = r.next;
  assert.equal(seen.has("s1"), false);
  assert.equal(shouldNoticeBudget("s1", true, seen).notice, true);
  // Another session is its own crossing.
  assert.equal(shouldNoticeBudget("s2", true, new Set(["s1"])).notice, true);
  // Never over and never seen: nothing, same set back.
  const empty = new Set();
  assert.equal(shouldNoticeBudget("s3", false, empty).next, empty);
});

test("the subject is the row's session, else the attached one, else null", () => {
  const a = { id: "a" }, b = { id: "b" };
  assert.equal(budgetSubject("b", [a, b], a), b);
  assert.equal(budgetSubject(null, [a, b], a), a);
  assert.equal(budgetSubject("gone", [a, b], a), a);
  assert.equal(budgetSubject(null, [], null), null);
});

test("a set is only ASKED until the desktop answers with exactly that cap", () => {
  // The send-time receipt never claims the cap holds: an older host ignores the frame.
  assert.match(budgetAskedToast("≤ $2.00"), /^asked the desktop to set/);
  assert.doesNotMatch(budgetAskedToast("≤ $2.00"), /^budget set/);
  assert.match(BUDGET_ASKED_CLEAR_TOAST, /^asked the desktop/);
  const cap = { unit: "usd", max: 2, interrupt: true };
  assert.equal(budgetConfirmed(cap, cap), true);
  assert.equal(budgetConfirmed(cap, { ...cap }), true);
  assert.equal(budgetConfirmed(cap, undefined), false);
  assert.equal(budgetConfirmed(cap, { ...cap, max: 3 }), false);
  assert.equal(budgetConfirmed(cap, { ...cap, interrupt: false }), false);
  assert.equal(budgetConfirmed(cap, { ...cap, unit: "tok" }), false);
  // A clear is confirmed by the budget being gone.
  assert.equal(budgetConfirmed(null, undefined), true);
  assert.equal(budgetConfirmed(null, cap), false);
  assert.match(BUDGET_UNCONFIRMED, /nothing is capped/);
});
