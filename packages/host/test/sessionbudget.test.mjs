/**
 * A session's own budget, on the host: the calibrator that turns a `/usage`
 * reading into dollars per window point, the judge that decides when a session
 * crossed its cap, and the gate on the one Esc that crossing may write.
 *
 * Every rule here fails silently in the field — a second notification for one
 * overspend, an Esc into a box it then answers, a percent cap judged on a
 * figure from a window that has already rolled over — so each is pinned
 * against fakes: a stubbed `windowSeries`, a fake `SessionCore`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { calSpecs, calCosts, createBudgetCalibrator, SESSION_WINDOW_MS, WEEK_WINDOW_MS } = await import("../dist/sessionbudget.js");
const { BudgetSlice } = await import("../dist/sessions/budgetwatch.js");
const { budgetEscBlocker, budgetEscScreenBlocker } = await import("../dist/server/sessionEvents.js");

const H = 3_600_000;
const NOW = Date.now();

/** A reading taken a minute ago: 2 hours into the 5-hour window, 3 days into the week. */
const reading = (over = {}) => ({
  ok: true, sessionPct: 20, weeklyPct: 10,
  sessionResetAt: NOW + 3 * H, weeklyResetAt: NOW + 4 * 24 * H,
  checkedAt: NOW - 60_000, ...over,
});

/** A windowSeries answer: newest cell priced at `session`/`weekly` dollars. */
const doc = (session, weekly) => ({
  scannedAt: NOW,
  series: [
    { id: "session", anchor: 0, lenMs: 1, oldestHour: 0, newestHour: 0, windows: session == null ? [] : [{ back: 0, cost: { total: session } }] },
    { id: "weekly", anchor: 0, lenMs: 1, oldestHour: 0, newestHour: 0, windows: weekly == null ? [] : [{ back: 0, cost: { total: weekly } }] },
  ],
});

// ── the calibrator ───────────────────────────────────────────────────────────

test("each grid runs from the window's OPENING to the reading, anchored at the reading", () => {
  const u = reading();
  const specs = calSpecs(u);
  assert.deepEqual(specs.map((s) => s.id), ["session", "weekly"]);
  for (const s of specs) assert.equal(s.anchor, u.checkedAt);
  assert.equal(specs[0].lenMs, u.checkedAt - (u.sessionResetAt - SESSION_WINDOW_MS));
  assert.equal(specs[1].lenMs, u.checkedAt - (u.weeklyResetAt - WEEK_WINDOW_MS));
});

test("a window with no reset instant, or one already past, has no grid", () => {
  assert.deepEqual(calSpecs(reading({ sessionResetAt: null })).map((s) => s.id), ["weekly"]);
  const u = reading();
  assert.deepEqual(calSpecs({ ...u, weeklyResetAt: u.checkedAt - 1 }).map((s) => s.id), ["session"]);
});

test("the newest cell's money is the window's cost; an empty grid is null, never zero", () => {
  assert.deepEqual(calCosts(doc(12, 180)), { session: 12, weekly: 180 });
  assert.deepEqual(calCosts(doc(null, 180)), { session: null, weekly: 180 });
});

test("a reading becomes dollars per point, once per checkedAt, and a reading that is not ok calibrates nothing", async () => {
  const applied = [];
  let calls = 0;
  const calibrate = createBudgetCalibrator({
    windowSeries: async () => { calls++; return doc(12, 180); },
    apply: (cal) => applied.push(cal),
  });
  const u = reading();
  assert.equal(await calibrate(u), true);
  assert.deepEqual(applied, [{ checkedAt: u.checkedAt, sessionUsdPerPct: 12 / 20, weeklyUsdPerPct: 180 / 10 }]);
  assert.equal(await calibrate(u), false, "the same reading is not folded twice");
  assert.equal(calls, 1);
  assert.equal(await calibrate({ ...u, ok: false, checkedAt: u.checkedAt + 1 }), false);
  assert.equal(await calibrate(null), false);
  assert.equal(applied.length, 1);
});

test("a window too young to calibrate is null on its own; a failed fold keeps the last figure", async () => {
  const applied = [];
  let fail = false;
  const calibrate = createBudgetCalibrator({
    windowSeries: async () => { if (fail) throw new Error("ledger unreadable"); return doc(0.4, 180); },
    apply: (cal) => applied.push(cal),
  });
  await calibrate(reading());
  assert.equal(applied[0].sessionUsdPerPct, null, "$0.40 is under the floor — no figure, not a tiny one");
  assert.equal(applied[0].weeklyUsdPerPct, 18);
  fail = true;
  assert.equal(await calibrate(reading({ checkedAt: NOW - 30_000 })), false);
  assert.equal(applied.length, 1, "nothing replaced the last good figure");
});

// ── the judge ────────────────────────────────────────────────────────────────

/** A fake hub with one session in it, and the events it emitted. */
function makeSlice(spark, cfg = { unit: "usd", max: 0.5, interrupt: true }) {
  const events = [];
  const persisted = [];
  const s = {
    info: { id: "s1", running: true, title: "t", contextSpark: spark, budget: { cfg, verdict: { state: "unknown", unit: cfg.unit, max: cfg.max, spent: null, why: "noSpark" } } },
  };
  const core = {
    sessions: new Map([["s1", s]]),
    emit: (e, ...args) => { events.push(e); return true; },
    loadLive: (id) => ({ id }),
    persistLive: (m) => persisted.push(m),
  };
  return { slice: new BudgetSlice(core), s, events, persisted, trips: () => events.filter((e) => e === "budgetTripped").length };
}

test("the crossing emits ONCE; re-judging a session still over emits nothing", () => {
  const { slice, s, trips } = makeSlice({ usageTok: 1000, costUsd: 0.2 });
  slice.judge(s);
  assert.equal(s.info.budget.verdict.state, "ok");
  assert.equal(trips(), 0);
  s.info.contextSpark = { usageTok: 2000, costUsd: 0.5, agentCostUsd: 0.1 };
  slice.judge(s);
  assert.equal(s.info.budget.verdict.state, "over", "at the cap is over");
  assert.equal(s.info.budget.verdict.agentShare, 0.1, "the split rides with the total");
  assert.equal(trips(), 1);
  s.info.contextSpark = { usageTok: 3000, costUsd: 0.9 };
  slice.judge(s);
  slice.judge(s);
  assert.equal(trips(), 1, "still over is not a second crossing");
  assert.equal(s.budgetTripped, true);
});

test("an UNKNOWN in between is not a second crossing; only ok clears the latch", () => {
  const { slice, s, trips } = makeSlice({ usageTok: 1, costUsd: 0.6 });
  slice.judge(s);
  assert.equal(trips(), 1);
  s.info.contextSpark = undefined; // the reading went away
  slice.judge(s);
  assert.equal(s.info.budget.verdict.state, "unknown");
  s.info.contextSpark = { usageTok: 1, costUsd: 0.7 };
  slice.judge(s);
  assert.equal(trips(), 1, "back to over without an ok in between says nothing new");
});

test("unknown never trips — an unpriced session or an uncalibrated percent cap", () => {
  const a = makeSlice({ usageTok: 9e9 }); // no money: unpriced
  a.slice.judge(a.s);
  assert.equal(a.s.info.budget.verdict.state, "unknown");
  assert.equal(a.s.info.budget.verdict.why, "unpriced");
  assert.equal(a.trips(), 0);
  const b = makeSlice({ usageTok: 1, costUsd: 500 }, { unit: "weeklyPct", max: 1, interrupt: true });
  b.slice.judge(b.s);
  assert.equal(b.s.info.budget.verdict.why, "noReading", "no calibration yet");
  assert.equal(b.trips(), 0);
});

test("a percent cap is judged at the calibration's rate, and a new calibration re-judges", () => {
  const { slice, s, events, trips } = makeSlice({ usageTok: 1, costUsd: 30 }, { unit: "weeklyPct", max: 2, interrupt: true });
  slice.setCal({ checkedAt: Date.now(), sessionUsdPerPct: null, weeklyUsdPerPct: 18 });
  assert.equal(s.info.budget.verdict.state, "ok");
  assert.ok(Math.abs(s.info.budget.verdict.spent - 30 / 18) < 1e-9);
  assert.equal(s.info.budget.cal.weeklyUsdPerPct, 18, "the phone reads the host's figure off SessionInfo.budget.cal");
  assert.ok(events.includes("updated"));
  slice.setCal({ checkedAt: Date.now(), sessionUsdPerPct: null, weeklyUsdPerPct: 10 });
  assert.equal(s.info.budget.verdict.state, "over");
  assert.equal(trips(), 1);
});

test("raising the cap clears the latch and releases; the same cap again changes nothing", () => {
  const { slice, s, trips, persisted } = makeSlice({ usageTok: 1, costUsd: 0.6 });
  slice.judge(s);
  assert.equal(trips(), 1);
  const before = persisted.length;
  slice.set("s1", { unit: "usd", max: 0.5, interrupt: true });
  assert.equal(s.budgetTripped, true, "the same budget again is idempotent");
  assert.equal(persisted.length, before);
  slice.set("s1", { unit: "usd", max: 1, interrupt: true });
  assert.equal(s.info.budget.verdict.state, "ok", "released");
  assert.equal(s.budgetTripped, undefined);
  assert.equal(trips(), 1);
  slice.set("s1", null);
  assert.equal(s.info.budget, undefined, "cleared");
  assert.equal(slice.set("nope", null), null, "an unknown session is answered null");
});

test("the usage poll is wanted only for a RUNNING session with a percent cap", () => {
  const a = makeSlice({}, { unit: "usd", max: 1, interrupt: true });
  assert.equal(a.slice.wantsUsage(), false);
  const b = makeSlice({}, { unit: "sessionPct", max: 1, interrupt: true });
  assert.equal(b.slice.wantsUsage(), true);
  b.s.info.running = false;
  assert.equal(b.slice.wantsUsage(), false);
});

// ── the Esc gate ─────────────────────────────────────────────────────────────

const go = { interrupt: true, envOff: false, running: true, hooked: true, hookTurn: true, prompt: false, awaitingInput: false, openDelivery: false };

test("the Esc is written only into a PROVEN running turn with nothing on screen and nothing unconfirmed", () => {
  assert.equal(budgetEscBlocker(go), null);
  for (const [k, v] of [["interrupt", false], ["envOff", true], ["running", false], ["hooked", false], ["hookTurn", false], ["prompt", true], ["awaitingInput", true], ["openDelivery", true]]) {
    const why = budgetEscBlocker({ ...go, [k]: v });
    assert.equal(typeof why, "string", `${k}=${v} must block the Esc`);
    assert.match(why, /\.$/, "and say why, as a sentence");
  }
});

test("a turn read off the SCREEN is not one the Esc may interrupt — only the hooks' turn", () => {
  // `sessionEvents.ts` feeds `hookTurn` from `sessions.turnFromHook`, which is
  // false for a /compact or a turn nobody announced even while `turnActive` is set.
  assert.match(budgetEscBlocker({ ...go, hookTurn: false }), /no turn announced by the hooks/);
});

// ── the live grid, read in the write's own tick ──────────────────────────────

const WORKING = [
  "⏺ Reading the notes",
  "",
  "✻ Crafting… (9m 35s · ↓ 9.7k tokens)",
  "",
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

const BOX = [
  "✻ Crafting… (9m 35s · ↓ 9.7k tokens)",
  "",
  "Do you want to make this edit to api.ts?",
  "",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");

test("the live grid passes only when it shows the CLI working NOW with no box on it", () => {
  assert.equal(budgetEscScreenBlocker(WORKING), null);
});

test("a box painted since the detector last looked refuses the Esc — Esc there would DECLINE", () => {
  assert.match(budgetEscScreenBlocker(BOX), /question is on screen right now/);
  // An unparsed dialog (no numbered options the strict pass accepts) refuses too.
  const dialog = ["✻ Crafting… (12s)", "", "Trust this folder?", "  ❯ Yes, proceed", "    No, exit", "", "Enter to confirm · Esc to cancel"].join("\n");
  assert.match(budgetEscScreenBlocker(dialog), /question is on screen/);
});

test("no working line on the live grid refuses — a turn that has just ended is not one to interrupt", () => {
  const idle = WORKING.replace("✻ Crafting… (9m 35s · ↓ 9.7k tokens)", "");
  assert.match(budgetEscScreenBlocker(idle), /does not show the CLI working/);
});

test("an unreadable grid refuses, never passes", () => {
  assert.match(budgetEscScreenBlocker(""), /could not be read/);
  assert.match(budgetEscScreenBlocker("  \n \n"), /could not be read/);
});

test("flipping only `interrupt` keeps the latch: one crossing is told once and never Esc'd late", () => {
  const { slice, s, trips } = makeSlice({ usageTok: 1, costUsd: 0.6 });
  slice.judge(s);
  assert.equal(trips(), 1);
  slice.set("s1", { unit: "usd", max: 0.5, interrupt: false });
  assert.equal(s.budgetTripped, true, "the latch survives an interrupt flip");
  slice.set("s1", { unit: "usd", max: 0.5, interrupt: true });
  assert.equal(trips(), 1, "flipping it back is not a second crossing");
  slice.set("s1", { unit: "tok", max: 1, interrupt: true });
  assert.equal(s.budgetTripped, true, "a new unit is a new cap: cleared, then re-tripped by the judge");
  assert.equal(trips(), 2);
});
