/**
 * The recovery primitives every automatic `continue` shares (`recover/`):
 * the writer's preconditions and its two writes, the ONE give-up latch (the
 * wall's max-attempts branch used to emit `gaveup` past it — bug 4), the net
 * retry's stall entry announced once per episode, and the push worded per wall
 * kind (a spend wall was pushed as "Usage limit", with a stale "every N min").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { continueBlocker, continueBlockerNow, composerDraft, draftReader, ownMenuOption, writeContinue, CONTINUE_TEXT, MENU_HELD_DETAIL } = await import("../dist/recover/recoverwrite.js");
const { CLAUDE_COMPOSER } = await import("../dist/composer.js");
const { giveUpOnce, giveUpHeld, endGiveUp, holdGiveUp } = await import("../dist/recover/giveuplatch.js");
const { wallEventWords, wallPlan } = await import("../dist/recover/blockpush.js");
const { WallSlice } = await import("../dist/sessions/wall.js");
const { NetRetrySlice, draftParkMs } = await import("../dist/sessions/apiretry.js");
const { LIMIT_MAX_ATTEMPTS, NET_RETRY_MAX } = await import("../dist/sessions/knobs.js");
const { detectLimitText, detectSpendText, STOP_WAIT_RE } = await import("../dist/limit.js");
const { blockOf, LIMIT_HELD_DRAFT } = await import("@waterplane/shared");

// ── continueBlocker: one ladder, one order, each question the caller's choice ──

const NET = { quietMs: 3000, wallBlocks: true, turnBlocks: true, dialogBlocks: true };
const WALL = { quietMs: 3000, ownMenu: STOP_WAIT_RE };
const calm = (over = {}) => ({ info: { prompt: null, awaitingInput: false, limit: null }, turnActive: false, lastDataAt: 0, ...over });
const box = (label) => ({ question: "q", options: [{ index: 1, label }, { index: 2, label: "Other" }] });
// The wall's own option, built from halves (limit.ts: no banner phrase in a source string).
const OWN = ["Stop and wa", "it for limit to re", "set"].join("");

test("continueBlocker asks gone > halted > wall > turn > box > unsettled, in that order", () => {
  const now = 10_000;
  const busy = calm({ info: { prompt: box("Yes"), awaitingInput: true, limit: { blocked: true } }, turnActive: true, lastDataAt: now });
  assert.equal(continueBlocker(busy, false, NET, now, true), "gone");
  assert.equal(continueBlocker(busy, true, NET, now, true), "halted");
  assert.equal(continueBlocker(busy, true, NET, now, false), "wall");
  assert.equal(continueBlocker({ ...busy, info: { ...busy.info, limit: null } }, true, NET, now, false), "turn");
  assert.equal(continueBlocker({ ...busy, turnActive: false, info: { ...busy.info, limit: null } }, true, NET, now, false), "box");
  assert.equal(continueBlocker(calm({ lastDataAt: now - 100 }), true, NET, now, false), "unsettled");
  assert.equal(continueBlocker(calm(), true, NET, now, false), null);
});

test("the wall's policy: its own menu is not a box, a running turn and an unreadable dialog are not asked", () => {
  const now = 10_000;
  assert.equal(continueBlocker(calm({ info: { prompt: box(OWN) } }), true, WALL, now, false), null, "the stop-and-wait menu is answered, not waited on");
  assert.equal(continueBlocker(calm({ info: { prompt: box("Yes") } }), true, WALL, now, false), "box", "a foreign box still holds");
  assert.equal(continueBlocker(calm({ turnActive: true }), true, WALL, now, false), null, "a wall-rejected turn may leave the flag up");
  assert.equal(continueBlocker(calm({ info: { awaitingInput: true } }), true, WALL, now, false), null);
  assert.equal(continueBlocker(calm({ info: { limit: { blocked: true } } }), true, WALL, now, false), null, "the wall does not wait on itself");
  assert.equal(ownMenuOption(box(OWN), STOP_WAIT_RE), 1);
  assert.equal(ownMenuOption(box("Yes"), STOP_WAIT_RE), null);
});

// ── writeContinue: the two writes, the rows, and the Return skipped when it stopped being ours ──

function writer(over = {}) {
  const log = [];
  const rows = [];
  const w = {
    sessionId: "s1", kind: "limit", detail: "d",
    stillOurs: () => true,
    write: (d) => log.push(["write", d]),
    recordPrompt: (t) => log.push(["history", t]),
    ...over,
  };
  const io = { sleep: async (ms) => { log.push(["sleep", ms]); }, recordSent: (r) => { rows.push(r); return null; } };
  return { w, io, log, rows };
}

test("writeContinue: menu first (raw), then continue and Return as two writes, history + sent rows", async () => {
  const { w, io, log, rows } = writer();
  w.menu = { index: 1, press: (d) => log.push(["press", d]) };
  assert.equal(await writeContinue(w, io), "written");
  assert.deepEqual(log, [
    ["press", "1\r"], ["sleep", 1200],
    ["write", CONTINUE_TEXT], ["sleep", 250], ["write", "\r"],
    ["history", "continue (auto, usage limit reset)"],
  ]);
  assert.equal(CONTINUE_TEXT, "continue");
  assert.deepEqual(rows.map((r) => [r.source, r.kind, r.text, r.result]), [["limit", "answer", "1", "written"], ["limit", "prompt", "continue", "written"]]);
});

test("writeContinue: no longer ours after the gap ⇒ no Return, no prompt row", async () => {
  let ours = true;
  const { w, io, log, rows } = writer({ kind: "net", stillOurs: () => ours });
  w.write = (d) => { log.push(["write", d]); ours = false; }; // a person typed between the two writes
  assert.equal(await writeContinue(w, io), "gone");
  assert.deepEqual(log, [["write", "continue"], ["sleep", 250]]);
  assert.deepEqual(rows, []);
});

test("writeContinue: the sent source per kind — spend and net each their own", async () => {
  for (const [kind, source, history] of [["spend", "spend", "continue (auto, usage limit reset)"], ["net", "netretry", "continue (auto, network error)"]]) {
    const { w, io, log, rows } = writer({ kind });
    await writeContinue(w, io);
    assert.equal(rows[0].source, source);
    assert.deepEqual(log.at(-1), ["history", history]);
  }
});

// ── The draft rung: a person's words in the composer are never typed over ──

const RULE = "─".repeat(40);
/** A claude composer frame: `plain` as rendered, `dim` the part of it drawn dim (blanked in `undimmed`). */
const grid = (plain, dim = "") => [
  { text: "● some earlier output", undimmed: "● some earlier output" },
  { text: RULE, undimmed: RULE },
  { text: `❯ ${plain}`, undimmed: `❯ ${dim ? plain.replace(dim, " ".repeat(dim.length)) : plain}`.trimEnd() },
  { text: RULE, undimmed: RULE },
  { text: "  ? for shortcuts", undimmed: "  ? for shortcuts" },
];
const draftOf = (rows) => composerDraft(async () => rows, CLAUDE_COMPOSER);

test("composerDraft: empty, hint-only and proposal-only boxes are empty; typed words are a draft; unplaceable is no opinion", async () => {
  assert.equal(await draftOf(grid("")), null, "an empty box");
  assert.equal(await draftOf(grid('Try "fix the failing test"', 'Try "fix the failing test"')), null, "claude's dim hint is not typing");
  assert.equal(await draftOf(grid("run the e2e suite again", "run the e2e suite again")), null, "a dim proposal is not typing");
  assert.equal(await draftOf(grid("half a thou")), "half a thou", "typed words are a draft");
  assert.equal(await draftOf(grid("ok run the e2e suite again", "run the e2e suite again")), "ok", "typed in front of a dim tail: still a draft");
  assert.equal(await draftOf([{ text: "❯ words, but no rule", undimmed: "❯ words, but no rule" }]), null, "no box this rule can place: no opinion");
  assert.equal(await composerDraft(async () => { throw new Error("no grid"); }, CLAUDE_COMPOSER), null, "a failed read is no opinion");
  assert.equal(await composerDraft(async () => grid("typed"), null), null, "a backend with no anchors is asked nothing");
  assert.equal(await draftReader(null, async () => grid("typed"))(), null);
  assert.equal(await draftReader({ composerCursorRe: /^❯(?:\s|$)/, composerRuleRe: /^─{20,}$/ }, async () => grid("typed"))(), "typed");
});

test("continueBlockerNow: the sync ladder first, then the draft rung — a draft blocks, nothing else changes", async () => {
  let reads = 0;
  const read = (v) => async () => { reads++; return v; };
  assert.equal(await continueBlockerNow(calm(), () => true, NET, read("half")), "draft");
  assert.equal(await continueBlockerNow(calm(), () => true, NET, read(null)), null);
  reads = 0;
  assert.equal(await continueBlockerNow(calm({ info: { prompt: box("Yes") } }), () => true, NET, read("half")), "box", "a box outranks, and no screen is read");
  assert.equal(reads, 0);
  let alive = true;
  assert.equal(await continueBlockerNow(calm(), () => alive, NET, async () => { alive = false; return null; }), "gone", "asked again after the read");
});

test("writeContinue: after the menu, a person's words in the composer ⇒ `draft`, continue NOT typed", async () => {
  const { w, io, log, rows } = writer();
  w.menu = { index: 1, press: (d) => log.push(["press", d]) };
  w.draft = async () => "half a thou";
  assert.equal(await writeContinue(w, io), "draft");
  assert.deepEqual(log, [["press", "1\r"], ["sleep", 1200]], "the menu answered, nothing typed after it");
  assert.deepEqual(rows.map((r) => r.kind), ["answer"]);
  assert.equal(rows[0].detail, MENU_HELD_DETAIL, "the menu row says the continue was held, not that it followed");
  const ok = writer();
  ok.w.menu = { index: 1, press: () => {} };
  ok.w.draft = async () => null;
  assert.equal(await writeContinue(ok.w, ok.io), "written");
});

test("the wall: a draft in the composer is the busy path — slot released, no attempt spent, nothing typed", async () => {
  const { wall, s, core, emits, released, done } = wallRig();
  try {
    s.info.limit.blocked = true;
    s.backend = { delivery: { composerCursorRe: /^❯(?:\s|$)/, composerRuleRe: /^─{20,}$/ } };
    core.screenCells = async () => grid("half a thou");
    await wall.doLimitContinue(s);
    assert.deepEqual(released, ["gone"]);
    assert.equal(s.info.limit.attempts, 0);
    assert.ok(!emits.includes("attempt"));
    // The phone is TOLD why (`SessionLimit.held`), and the block says it instead of a countdown.
    assert.equal(s.info.limit.held, LIMIT_HELD_DRAFT);
    assert.equal(blockOf(s.info).detail, LIMIT_HELD_DRAFT);
    assert.equal(blockOf(s.info).nextAt, null);
  } finally { done(); }
});

test("the wall: menu answered, then a draft ⇒ no attempt announced or spent, held said; words cleared ⇒ the attempt", async () => {
  const { wall, s, core, emits, released, done } = wallRig();
  const typed = [];
  try {
    s.info.limit.blocked = true;
    s.backend = { delivery: { composerCursorRe: /^❯(?:\s|$)/, composerRuleRe: /^─{20,}$/ } };
    s.info.prompt = box(OWN);
    s.proc = { write: (d) => typed.push(["press", d]) };
    // The ladder's read sees an empty box (the menu covers it); after the menu, words.
    let reads = 0;
    core.screenCells = async () => (++reads === 1 ? grid("") : grid("half a thou"));
    core.write = (_id, d) => typed.push(["write", d]);
    await wall.doLimitContinue(s);
    assert.deepEqual(typed, [["press", "1\r"]], "the menu answered, continue not typed");
    assert.equal(s.info.limit.attempts, 0);
    assert.ok(!emits.includes("attempt"), `no attempt announced (${emits})`);
    assert.equal(s.info.limit.held, LIMIT_HELD_DRAFT);
    // Next look: the words are gone, the menu too ⇒ the attempt, announced once written.
    s.info.prompt = null;
    core.screenCells = async () => grid("");
    released.length = 0;
    await wall.doLimitContinue(s);
    assert.deepEqual(typed.slice(1).map((t) => t[1]), ["continue", "\r"]);
    assert.equal(s.info.limit.attempts, 1);
    assert.deepEqual(emits.filter((e) => e === "attempt"), ["attempt"]);
    assert.equal(s.info.limit.held, null, "the hold ended with the attempt");
  } finally { done(); }
});

test("the net retry's draft park backs off: 30 s doubling to 5 min, never below the base", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 40].map((n) => draftParkMs(n, 30_000)), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  assert.deepEqual([0, 1, 2].map((n) => draftParkMs(n, 1000)), [1000, 2000, 4000], "a shrunk base (the e2e's) doubles the same way");
  assert.equal(draftParkMs(0, 600_000), 600_000, "a base past the cap is the floor");
});

// ── The give-up latch ──

test("giveUpOnce announces once per lane per episode; endGiveUp re-arms; holdGiveUp is silent", () => {
  const s = {};
  let n = 0;
  assert.equal(giveUpOnce(s, "wall", () => n++), true);
  assert.equal(giveUpOnce(s, "wall", () => n++), false);
  assert.equal(n, 1);
  assert.equal(giveUpOnce(s, "net", () => n++), true, "the lanes are independent");
  endGiveUp(s, "wall");
  assert.equal(giveUpHeld(s, "wall"), false);
  assert.equal(giveUpOnce(s, "wall", () => n++), true, "a new episode is owed its own word");
  const r = {};
  holdGiveUp(r, "net");
  assert.equal(giveUpOnce(r, "net", () => n++), false, "a restored stall was announced before the restart");
  assert.equal(n, 3);
});

function wallRig() {
  const emits = [];
  const released = [];
  const core = {
    root: mkdtempSync(join(tmpdir(), "wp-recover-")),
    sessions: new Map(),
    noteFor() {}, setResumeProven() {}, publishQueue() {}, pumpResume() {}, dropResumeFirst() {},
    emit: (ev, _id, _info, phase) => { if (ev === "limit") emits.push(phase); },
    isResuming: () => false, resumeQueue: () => [], resumeHoldUntil: () => 0,
    releaseResume: (_id, why) => released.push(why),
    write() { throw new Error("nothing may be typed past the cap"); }, recordPrompt() {},
  };
  const wall = new WallSlice(core);
  const s = { info: { id: "s1", title: "t", running: true, limit: wall.newLimitState() }, limitTimer: null, lastDataAt: 0 };
  core.sessions.set("s1", s);
  const done = () => { wall.clearLimitTimer(s); rmSync(core.root, { recursive: true, force: true }); };
  return { wall, s, core, emits, released, done };
}

test("bug 4: the wall's max-attempts branch gives up through the latch — one `gaveup` per block", async () => {
  const { wall, s, emits, released, done } = wallRig();
  try {
    s.info.limit.blocked = true;
    s.info.limit.attempts = LIMIT_MAX_ATTEMPTS;
    await wall.doLimitContinue(s);
    await wall.doLimitContinue(s); // a forced resume re-enters the same branch
    wall.noteGaveUp(s, "the ladder's own give-up, later");
    assert.deepEqual(emits.filter((p) => p === "gaveup"), ["gaveup"], "said once");
    assert.deepEqual(released, ["gone", "gone"], "the queue slot is still released each time");
    assert.ok(!emits.includes("attempt"), "nothing typed past the cap");
  } finally { done(); }
});

test("a new wall clears the latch: its own give-up is announced", () => {
  const { wall, s, emits, done } = wallRig();
  try {
    wall.noteGaveUp(s, "first wall");
    wall.markLimitBlocked(s, Date.now() + 3_600_000, false, undefined, true); // the `!was` edge
    wall.noteGaveUp(s, "second wall");
    assert.equal(emits.filter((p) => p === "gaveup").length, 2);
  } finally { done(); }
});

// ── The net retry: the stall entry is the transition, never a probe ──

test("net: the stall entry is held once per episode; a probe's give-up re-announces nothing; the episode ending clears it", (t) => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { const l = a.join(" "); if (l.includes("net retry stalled")) lines.push(l); };
  t.after(() => { console.log = orig; });
  const core = { sessions: new Map(), emit() {}, loadLive: () => null, persistLive() {}, write() {}, recordPrompt() {} };
  const slice = new NetRetrySlice(core);
  const s = { info: { id: "s1", title: "t", running: true, cwd: "/nowhere", netRetry: null }, turnActive: false, lastDataAt: 0, stopCount: 0, netTimer: null, netRecheck: null };
  core.sessions.set("s1", s);
  t.after(() => slice.clear(s));
  const ERR = "Can't reach the API server (ENOTFOUND)";
  s.info.netRetry = { state: "sent", attempt: NET_RETRY_MAX, max: NET_RETRY_MAX, nextAt: null, error: ERR, at: 1 };
  assert.equal(slice["schedule"](s, Date.now(), ERR).net, "gaveup");
  assert.equal(giveUpHeld(s, "net"), true);
  s.info.netRetry = { ...s.info.netRetry, state: "sent", probe: true };
  assert.equal(slice["schedule"](s, Date.now(), ERR).net, "gaveup", "the probe falls back into the stall");
  assert.equal(lines.length, 1, "announced once, not per probe");
  slice["set"](s, null); // a served reply / a person typing ends the episode
  assert.equal(giveUpHeld(s, "net"), false);
});

// ── The words, per kind ──

const fixed = (ms) => `@${ms}`;
const limitOf = (over) => ({ blocked: true, blockedSince: 1, resetAt: null, nextAttemptAt: null, attempts: 0, weekly: false, autoContinue: true, autoContinueOverride: null, queuePos: null, resuming: false, first: false, ...over });

test("bug 5: a spend wall is pushed as out of credit, never as the usage limit, and promises no cadence", () => {
  const w = wallEventWords("blocked", "s1", { title: "T", limit: limitOf({ spend: true }) }, 2, fixed);
  assert.equal(w.push.title, "Out of credit · T");
  assert.doesNotMatch(w.push.body, /every|retry/i);
  assert.match(w.push.body, /add credit/);
  assert.match(w.log.question, /out of credit/);
  const dated = wallEventWords("blocked", "s1", { title: "T", limit: limitOf({ spend: true, resetAt: 99 }) }, 2, fixed);
  assert.match(dated.push.body, /one try after the reset \(~@99\)/);
  const gave = wallEventWords("gaveup", "s1", { title: "T", limit: limitOf({ spend: true, attempts: 1 }) }, 2, fixed);
  assert.match(gave.push.body, /^still out of credit after 1 attempt —/);
  const back = wallEventWords("resumed", "s1", { title: "T", limit: { ...limitOf({ spend: true, attempts: 1 }), blocked: false } }, 2, fixed);
  assert.match(back.push.body, /^spend wall lifted after 1 attempt/);
});

test("the usage limit keeps its words; the stale 'every N min' cadence is gone", () => {
  const dated = wallEventWords("blocked", "s1", { title: "T", limit: limitOf({ resetAt: 5 }) }, 2, fixed);
  assert.equal(dated.push.title, "Usage limit · T");
  assert.equal(dated.push.body, "auto-continue after the reset (~@5)");
  assert.equal(dated.log.question, "Session stopped at the Claude usage limit.");
  const undated = wallPlan(limitOf({}), fixed);
  assert.doesNotMatch(undated, /every \d+ min/);
  assert.match(undated, /less often/);
  assert.match(wallPlan(limitOf({ nextAttemptAt: 7 }), fixed), /tries again ~@7/);
  assert.equal(wallPlan(limitOf({ needsYou: "top up" }), fixed), "nothing is retried by itself — it needs you: top up");
  assert.equal(wallPlan(limitOf({ autoContinue: false }), fixed), "auto-continue is off — resume manually");
  assert.equal(wallEventWords("scheduled", "s1", { title: "T", limit: limitOf({}) }).push, null);
  const gave = wallEventWords("gaveup", "s1", { title: "T", limit: limitOf({ attempts: 3 }) }, 2, fixed);
  assert.equal(gave.push.body, "still limit-blocked after 3 attempts — resume manually");
  assert.equal(gave.push.key, "limit:s1");
});

test("no word this module says trips the screen's own detectors (a session printing it must not block)", () => {
  const all = [];
  for (const phase of ["blocked", "attempt", "resumed", "gaveup"]) {
    for (const lim of [limitOf({}), limitOf({ spend: true }), limitOf({ resetAt: 5 }), limitOf({ spend: true, resetAt: 5 }), limitOf({ needsYou: "x" })]) {
      const w = wallEventWords(phase, "s1", { title: "T", limit: lim }, 2, fixed);
      for (const x of [w.push?.title, w.push?.body, w.log?.question, w.log?.rationale]) if (x) all.push(x);
    }
  }
  for (const x of all) {
    assert.equal(detectLimitText(x).blocked, false, x);
    assert.equal(detectSpendText(x).spend, false, x);
  }
});
