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

// The calibrator reads WINDOWS now (`calSpecsOf`, WP5); claude's two are the same grids as before.
const { calSpecsOf } = await import("../dist/sessionbudget.js");
/** The pre-WP5 `calSpecs`, verbatim, as the pin. */
function oldCalSpecs(u) {
  const out = [];
  const add = (id, resetAt, len) => {
    if (resetAt == null || !(resetAt > u.checkedAt)) return;
    const lenMs = u.checkedAt - (resetAt - len);
    if (lenMs > 0 && lenMs <= len) out.push({ id, anchor: u.checkedAt, lenMs });
  };
  add("session", u.sessionResetAt, SESSION_WINDOW_MS);
  add("weekly", u.weeklyResetAt, WEEK_WINDOW_MS);
  return out;
}

test("claude's grids are byte-identical through the windows path", () => {
  const u = reading();
  for (const r of [
    u, reading({ sessionResetAt: null }), reading({ weeklyResetAt: null }), reading({ sessionPct: null }),
    { ...u, weeklyResetAt: u.checkedAt - 1 }, { ...u, sessionResetAt: u.checkedAt + 6 * H }, { ...u, weeklyResetAt: u.checkedAt + 8 * 24 * H },
    reading({ sessionResetAt: null, weeklyResetAt: null }),
  ]) assert.deepEqual(JSON.stringify(calSpecs(r)), JSON.stringify(oldCalSpecs(r)));
});

test("another backend's windows: a known length gets a grid under its own id; a calendar month or an unknown unit gets none", () => {
  const at = NOW - 60_000;
  const specs = calSpecsOf(at, [
    { id: "premium", unit: "mo", pct: 40, resetAt: NOW + 10 * 24 * H },
    { id: "chat", unit: "5h", pct: 10, resetAt: NOW + 2 * H },
    { id: "odd", unit: "zz", pct: 10, resetAt: NOW + 2 * H },
    { id: "day", unit: "1d", pct: 10, resetAt: NOW + 2 * H },
  ]);
  assert.deepEqual(specs.map((s) => s.id), ["chat", "day"]);
  assert.equal(specs[0].lenMs, at - (NOW + 2 * H - 5 * H));
  assert.equal(specs[1].lenMs, at - (NOW + 2 * H - 24 * H));
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

const go = { interrupt: true, envOff: false, running: true, prompt: false, awaitingInput: false, openDelivery: false };

test("the Esc is written only with nothing on screen to answer and nothing unconfirmed (the running turn is the grid's to prove)", () => {
  assert.equal(budgetEscBlocker(go), null);
  for (const [k, v] of [["interrupt", false], ["envOff", true], ["running", false], ["prompt", true], ["awaitingInput", true], ["openDelivery", true]]) {
    const why = budgetEscBlocker({ ...go, [k]: v });
    assert.equal(typeof why, "string", `${k}=${v} must block the Esc`);
    assert.match(why, /\.$/, "and say why, as a sentence");
  }
});

test("the crossing OWES the Esc and every judge while still over asks for it again, until it is settled", () => {
  const { slice, s, events } = makeSlice({ usageTok: 1, costUsd: 0.6 });
  slice.judge(s);
  assert.equal(s.budgetEscOwed, true, "an interrupting budget owes its Esc from the crossing");
  slice.judge(s);
  slice.judge(s);
  assert.equal(events.filter((e) => e === "budgetEscDue").length, 2, "no turn to interrupt at the crossing is not the end of it");
  slice.settleEsc("s1");
  assert.equal(s.budgetEscOwed, undefined);
  slice.judge(s);
  assert.equal(events.filter((e) => e === "budgetEscDue").length, 2, "settled — sent, or a person sent by hand — is never asked again");
});

test("SOFT: a turn end owes nothing — the crossing's one Esc is all it ever sends", () => {
  const { slice, s } = makeSlice({ usageTok: 1, costUsd: 0.6 });
  s.stopCount = 0;
  slice.judge(s);
  slice.settleEsc("s1");
  s.stopCount = 1;
  slice.turnEnded("s1");
  assert.equal(s.budgetEscOwed, undefined);
});

test("HARD: every turn end while over owes the next turn its Esc", () => {
  const { slice, s, events } = makeSlice({ usageTok: 1, costUsd: 0.6 }, { unit: "usd", max: 0.5, interrupt: true, hard: true });
  s.stopCount = 0; s.stopPending = false;
  slice.judge(s);
  slice.settleEsc("s1"); // the crossing's Esc went out
  assert.equal(s.budgetEscOwed, undefined);
  s.stopCount = 1;
  slice.turnEnded("s1");
  assert.equal(s.budgetEscOwed, true, "the next turn — a task notification, a chain — is owed one");
  slice.judge(s);
  assert.equal(events.filter((e) => e === "budgetEscDue").length, 1);
  slice.settleEsc("s1");
  s.stopCount = 2;
  slice.turnEnded("s1");
  assert.equal(s.budgetEscOwed, true, "and the one after that");
});

test("HARD: a person's own send runs its turn — the grant ends with that turn, never earlier", () => {
  const { slice, s } = makeSlice({ usageTok: 1, costUsd: 0.6 }, { unit: "usd", max: 0.5, interrupt: true, hard: true });
  s.stopCount = 3; s.stopPending = true; // the previous turn's Stop has not settled yet
  slice.judge(s);
  slice.settleEsc("s1", true);
  assert.equal(s.budgetEscOwed, undefined, "the person's send settles what was owed");
  s.stopCount = 4; s.stopPending = false;
  slice.turnEnded("s1");
  assert.equal(s.budgetEscOwed, undefined, "the PREVIOUS turn closing out cannot spend the grant");
  s.stopCount = 5;
  slice.turnEnded("s1");
  assert.equal(s.budgetEscOwed, true, "the granted turn is over: the next is owed");
  assert.equal(s.budgetGrantStop, undefined);
});

test("HARD: under the cap, or switched back to soft, a turn end owes nothing", () => {
  const { slice, s } = makeSlice({ usageTok: 1, costUsd: 0.2 }, { unit: "usd", max: 0.5, interrupt: true, hard: true });
  s.stopCount = 1;
  slice.judge(s);
  slice.turnEnded("s1");
  assert.equal(s.budgetEscOwed, undefined, "ok is not over");
  s.info.contextSpark = { usageTok: 2, costUsd: 0.6 };
  slice.judge(s);
  slice.settleEsc("s1");
  slice.set("s1", { unit: "usd", max: 0.5, interrupt: true });
  s.stopCount = 2;
  slice.turnEnded("s1");
  assert.equal(s.budgetEscOwed, undefined);
});

test("nothing is owed by a budget that does not interrupt, and switching interrupt off drops what was owed", () => {
  const quiet = makeSlice({ usageTok: 1, costUsd: 0.6 }, { unit: "usd", max: 0.5, interrupt: false });
  quiet.slice.judge(quiet.s);
  quiet.slice.judge(quiet.s);
  assert.equal(quiet.s.budgetEscOwed, undefined);
  assert.ok(!quiet.events.includes("budgetEscDue"));
  const { slice, s, events } = makeSlice({ usageTok: 1, costUsd: 0.6 });
  slice.judge(s);
  slice.set("s1", { unit: "usd", max: 0.5, interrupt: false });
  assert.equal(s.budgetEscOwed, undefined);
  slice.set("s1", { unit: "usd", max: 0.5, interrupt: true });
  assert.equal(s.budgetEscOwed, undefined, "switching it back on is not a crossing: no late Esc");
  assert.ok(!events.includes("budgetEscDue"));
});

test("back under the cap settles what was owed", () => {
  const { slice, s } = makeSlice({ usageTok: 1, costUsd: 0.6 });
  slice.judge(s);
  slice.set("s1", { unit: "usd", max: 5, interrupt: true });
  assert.equal(s.info.budget.verdict.state, "ok");
  assert.equal(s.budgetEscOwed, undefined);
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

// ── P2: a backend's OWN spend (`TokenSource.session`) ────────────────────────

const { setLiveSourceLookup } = await import("../dist/livesources.js");
const { resolveBackend } = await import("../dist/backends/index.js");

/** One plugin-shaped session (a backend with no claude log) whose live source
 *  answers `reading()` — swapped per step by the test. */
function makeSourceSlice(cfg, reading) {
  const h = makeSlice(undefined, cfg);
  const sh = resolveBackend("shell"); // keeps no claude log; a plugin backend takes turns, a shell does not
  h.s.backend = { ...sh, caps: { ...sh.caps, turns: true } };
  let calls = 0;
  setLiveSourceLookup((id) => (id === "s1" ? {
    session: { id: "s1" },
    sources: { tokens: { ledger: async () => ({ available: false, reason: "n/a" }), session: () => { calls++; return reading(); } } },
    health: () => ({ state: "up", since: 0 }),
  } : null));
  return { ...h, calls: () => calls };
}

test("a plugin session's budget is judged from its source: over trips ONCE, the split rides", (t) => {
  t.after(() => setLiveSourceLookup(null));
  let r = { at: 1, tok: 1000, usd: 0.2 };
  const { slice, s, trips } = makeSourceSlice({ unit: "usd", max: 0.5, interrupt: true }, () => r);
  slice.judge(s);
  assert.equal(s.info.budget.verdict.state, "ok");
  assert.deepEqual(s.info.sourceSpend, r, "published for the phone's spent line");
  r = { at: 2, tok: 1500, usd: 0.4, agentUsd: 0.15 };
  slice.judge(s);
  assert.equal(s.info.budget.verdict.state, "over", "own 0.40 + agents 0.15 is past 0.50");
  assert.ok(Math.abs(s.info.budget.verdict.spent - 0.55) < 1e-9);
  assert.equal(s.info.budget.verdict.agentShare, 0.15);
  assert.equal(trips(), 1);
  r = { at: 3, tok: 2000, usd: 0.9 };
  slice.judge(s);
  assert.equal(trips(), 1, "still over is not a second crossing");
  assert.equal(s.budgetTripped, true);
});

test("a plugin session: tokens work where stated; unstated, refused, thrown and null never trip", (t) => {
  t.after(() => setLiveSourceLookup(null));
  let r = { at: 1, tok: 5000 };
  const { slice, s, trips } = makeSourceSlice({ unit: "tok", max: 4000, interrupt: true }, () => r);
  slice.judge(s);
  assert.equal(s.info.budget.verdict.state, "over");
  assert.equal(trips(), 1);
  // A fresh cap in dollars: the source states none.
  slice.set("s1", { unit: "usd", max: 1, interrupt: true });
  assert.equal(s.info.budget.verdict.state, "unknown");
  assert.equal(s.info.budget.verdict.why, "unstated");
  for (const bad of [null, { at: 2, tok: -1, usd: 5 }, { at: 3, usd: 5, native: { amount: 1, unit: "USD" } }, () => { throw new Error("x"); }]) {
    r = bad;
    const reading = typeof bad === "function" ? bad : () => bad;
    setLiveSourceLookup((id) => (id === "s1" ? { session: { id }, sources: { tokens: { ledger: async () => ({ available: false, reason: "n/a" }), session: reading } }, health: () => ({ state: "up", since: 0 }) } : null));
    slice.judge(s);
    assert.equal(s.info.budget.verdict.state, "unknown", `never over on ${JSON.stringify(bad)}`);
    assert.deepEqual(Object.keys(s.info.sourceSpend), ["at"], "a refused answer is dropped WHOLE, never part-kept");
  }
  assert.equal(trips(), 1, "no new crossing from any of them");
});

test("a plugin session: a percent cap is notClaude, never a conversion of its dollars", (t) => {
  t.after(() => setLiveSourceLookup(null));
  const { slice, s, trips } = makeSourceSlice({ unit: "weeklyPct", max: 1, interrupt: true }, () => ({ at: 1, usd: 50 }));
  slice.setCal({ checkedAt: Date.now(), sessionUsdPerPct: 1, weeklyUsdPerPct: 1 });
  assert.equal(s.info.budget.verdict.state, "unknown");
  assert.equal(s.info.budget.verdict.why, "notClaude");
  assert.equal(trips(), 0);
});

test("a shell session is never given sourceSpend: no source, no spend, no call", (t) => {
  t.after(() => setLiveSourceLookup(null));
  const { slice, s, calls } = makeSourceSlice({ unit: "tok", max: 1e9, interrupt: true }, () => ({ at: 1, tok: 10 }));
  s.backend = resolveBackend("shell");
  slice.judge(s);
  assert.equal(calls(), 0);
  assert.equal(s.info.sourceSpend, undefined);
});

test("a re-read that moved only `at` is not news; claude's sessions are never asked", (t) => {
  t.after(() => setLiveSourceLookup(null));
  let at = 1;
  const { slice, s, calls } = makeSourceSlice({ unit: "tok", max: 1e9, interrupt: true }, () => ({ at: at++, tok: 10 }));
  slice.judge(s);
  assert.equal(slice.judge(s), false, "same figures, later clock: no updated");
  delete s.info.budget;
  assert.equal(slice.judge(s), false, "no budget: the spend is still read, unchanged");
  assert.equal(calls(), 3);
  // Claude: no call, no field — today's path byte for byte.
  s.backend = resolveBackend("claude");
  delete s.info.sourceSpend;
  slice.judge(s);
  assert.equal(calls(), 3);
  assert.equal(s.info.sourceSpend, undefined);
});

test("a ledger holding undated records calibrates nothing: its window cost is a floor (design round 4)", () => {
  assert.deepEqual(calCosts({ ...doc(12, 180), undated: 0 }), { session: 12, weekly: 180 });
  assert.deepEqual(calCosts({ ...doc(12, 180), undated: 2 }), { session: null, weekly: null, sessionUndated: 2, weeklyUndated: 2 });
});

test("undated records bound by mtime: a window opened after every such log was written still calibrates (design round 4)", () => {
  const H = 3_600_000;
  const at = (h) => Date.UTC(2026, 9, 8, h);
  const grid = (id, total) => ({ id, anchor: at(20), lenMs: 5 * H, oldestHour: 0, newestHour: 0, windows: [{ back: 0, cost: { total } }] });
  const d = { scannedAt: NOW, series: [grid("session", 12), { ...grid("weekly", 180), lenMs: 168 * H }] };
  // The session window opens at 15:00; the undated log was last written at 10:00 — before it, so
  // none of its records can be in it. The weekly window opened days earlier and could hold them.
  assert.deepEqual(calCosts({ ...d, undated: 2, undatedUntil: at(10) }), { session: 12, weekly: null, weeklyUndated: 2 });
  // Written inside the session window: refused there too.
  assert.deepEqual(calCosts({ ...d, undated: 2, undatedUntil: at(16) }), { session: null, weekly: null, sessionUndated: 2, weeklyUndated: 2 });
  // No `undatedUntil` (an unknown mtime, or an older host): every window refuses.
  assert.deepEqual(calCosts({ ...d, undated: 2 }), { session: null, weekly: null, sessionUndated: 2, weeklyUndated: 2 });
});

test("calCosts hands the undated count of a refused window on, so the budget can name it (design round 4, r4-1 M2)", () => {
  const out = calCosts({ ...doc(12, 180), undated: 2 });
  assert.deepEqual(out, { session: null, weekly: null, sessionUndated: 2, weeklyUndated: 2 });
  assert.deepEqual(calCosts({ ...doc(12, 180), undated: -1 }), { session: null, weekly: null }, "not a count: refused, no count to carry");
});
