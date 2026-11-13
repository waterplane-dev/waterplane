/**
 * The delivery path's timing rules, in VIRTUAL time (`waitclock.ts`): the
 * ladder, the inbox hold, `waitReady`, `startPrompt`/`deliverChain` and
 * settle's ask of a backend's channel.
 *
 * Every deadline and hold window used to be testable only in real seconds, so
 * 79b2d0cf (a prompt typed 53 s before the picture it names arrived) was found
 * live. `fakeClock.sleep(ms)` advances the clock and resolves on a microtask:
 * these run in milliseconds, and the numbers asserted are the stated constants
 * (written out here, on purpose — a test that read them from the code would
 * pass when someone cut them).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverPrompt } from "../dist/deliver.js";
import { createDeliveries } from "../dist/server/deliveries.js";
import { waitReady } from "../dist/sessions/drive.js";
import { awaitLanded, ranMatch } from "../dist/settle.js";
import { setLiveSourceLookup } from "../dist/livesources.js";
import { fakeClock } from "./lib/fakeclock.mjs";

/** A session whose typed words show up on screen (or, `blind`, never do). */
function fakeSessions(clock, { blind = false, cwd = "/nowhere" } = {}) {
  const writes = [];
  let screen = "";
  const info = { id: "s1", running: true, turnActive: false, remoteControl: true, cwd };
  return {
    writes,
    get: () => info,
    idleMs: () => 300,
    waitReady: async () => true,
    screenText: async () => screen,
    scrollback: () => "",
    recordPrompt: () => {},
    isHooked: () => false,
    stopCount: () => 0,
    geometry: () => ({ cols: 80, rows: 30 }),
    claimSubmittedPrompt: () => false,
    lastSubmittedPrompt: () => null,
    turnFromHook: () => false,
    keepsClaudeLog: () => true,
    getTranscript: () => null,
    noteHookFallback: () => {},
    healthScope: () => true,
    settleBudgetEsc: () => {},
    write: (_id, data) => {
      writes.push({ data, at: clock.elapsed() });
      if (!blind && data !== "\r" && data.length > 1) screen = data;
    },
  };
}

test("a screen that never echoes ends at echo window + log window + sweep, in virtual time", async () => {
  const clock = fakeClock();
  const sessions = fakeSessions(clock, { blind: true });
  const real0 = Date.now();
  const res = await deliverPrompt(sessions, "s1", "a prompt that the screen never shows back", "prompt", { clock, interactive: true });
  assert.equal(res, "unconfirmed");
  assert.ok(Date.now() - real0 < 2000, "ran on virtual time, not the 6.6 real seconds the ladder waits (bound loose so a loaded machine cannot flake it)");
  const text = sessions.writes[0];
  assert.equal(text.at, 0);
  // ECHO_WAIT_MS (4000) of polling, then the conversation-log proof (LOG_PROOF_MS 2500), then the
  // composer sweep begins with its Esc.
  const esc = sessions.writes.find((w) => w.data === "\x1b");
  assert.equal(esc.at, 4000 + 2500);
  // the sweep: Esc, 150 ms, then six ctrl-U 120 ms apart
  assert.equal(clock.elapsed(), 4000 + 2500 + 150 + 6 * 120);
});

const TEXT_OF = (path) => `look at ${path} and describe it`;

function inboxHarness({ appearAfterMs }) {
  const clock = fakeClock();
  const cwd = mkdtempSync(join(tmpdir(), "waterplane-inboxhold-"));
  mkdirSync(join(cwd, ".claude", "inbox"), { recursive: true });
  const rel = `.claude/inbox/photo-${clock.now().toString(36)}abc123.png`;
  if (appearAfterMs != null) clock.at(appearAfterMs, () => writeFileSync(join(cwd, rel), "x"));
  const sessions = fakeSessions(clock, { cwd });
  const logs = [];
  const log = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };
  const ctx = {
    sessions,
    netstats: { noteDelivery: () => {} },
    openDeliveries: { has: () => false },
    notify: () => {},
  };
  const run = async () => {
    try { return await createDeliveries(ctx, clock).deliverInput("s1", TEXT_OF(rel), "ack1"); }
    finally { console.log = log; }
  };
  return { clock, sessions, logs, run, rel };
}

test("inbox hold: a prompt naming a picture is typed only after the picture appears", async () => {
  const h = inboxHarness({ appearAfterMs: 53_000 });
  await h.run();
  const typed = h.sessions.writes.find((w) => w.data.includes(h.rel));
  assert.ok(typed, "the prompt was typed");
  assert.ok(typed.at >= 53_000, `typed at ${typed.at} ms, before the file existed`);
  assert.ok(typed.at < 53_000 + 1000 + 1, "typed within one poll (INBOX_POLL_MS 1000) of the file appearing");
  assert.ok(h.logs.some((l) => /inbox hold .*landed after 53 s/.test(l)), h.logs.join("\n"));
});

test("inbox hold: a picture that never comes is given up on after INBOX_HOLD_MS, and the prompt is typed anyway", async () => {
  const h = inboxHarness({ appearAfterMs: null });
  await h.run();
  const typed = h.sessions.writes.find((w) => w.data.includes(h.rel));
  assert.ok(typed, "typed anyway");
  assert.equal(typed.at, 300_000); // INBOX_HOLD_MS = 5 min
  assert.ok(h.logs.some((l) => /inbox hold .*gave up after 300 s, typing anyway/.test(l)), h.logs.join("\n"));
});

// ── waitReady (`sessions/drive.ts`) on the delivery's clock ───────────────

/** A drive core holding one session; `lastDataAt` may be a getter (a TUI that keeps repainting). */
function driveCore(s) {
  // Descriptors, not a spread: a spread would read a `lastDataAt` getter once.
  const sess = Object.defineProperties({ sawData: true, hooksActive: false, turnActive: false, info: { running: true } }, Object.getOwnPropertyDescriptors(s));
  return { sessions: new Map([["s1", sess]]) };
}

test("waitReady: a session quiet since the start is ready at the first 150 ms poll past quietMs", async () => {
  const clock = fakeClock();
  const core = driveCore({ lastDataAt: clock.now() });
  assert.equal(await waitReady(core, "s1", 1000, 30000, clock), true);
  assert.equal(clock.elapsed(), 1050); // polls at 0, 150, … 1050 — the first with quiet ≥ 1000
});

test("waitReady: a hooked idle session needs only min(quietMs, 400) of quiet", async () => {
  const clock = fakeClock();
  const core = driveCore({ lastDataAt: clock.now(), hooksActive: true });
  assert.equal(await waitReady(core, "s1", 1200, 45000, clock), true);
  assert.equal(clock.elapsed(), 450);
});

test("waitReady: a TUI that never stops repainting times out at exactly timeoutMs, in virtual time", async () => {
  const clock = fakeClock();
  const core = driveCore({ get lastDataAt() { return clock.now(); } });
  const real0 = Date.now();
  assert.equal(await waitReady(core, "s1", 1200, 45000, clock), false);
  assert.equal(clock.elapsed(), 45000);
  assert.ok(Date.now() - real0 < 2000, "45 virtual seconds, not real ones");
});

// ── startPrompt / deliverChain / the re-send carry the clock ─────────────

function deliveriesHarness({ ready = true } = {}) {
  const clock = fakeClock();
  const sessions = fakeSessions(clock);
  const core = driveCore(ready ? { lastDataAt: clock.now() } : { get lastDataAt() { return clock.now(); } });
  const asked = [];
  sessions.waitReady = (id, quietMs, timeoutMs, c) => { asked.push({ quietMs, timeoutMs, clock: c }); return waitReady(core, id, quietMs, timeoutMs, c); };
  const backlog = [];
  const notes = [];
  const ctx = {
    sessions,
    netstats: { noteDelivery: () => {} },
    openDeliveries: { has: () => false },
    backlog: { add: (text) => { backlog.push(text); } },
    notify: (kind, n) => { notes.push({ kind, ...n }); },
  };
  return { clock, sessions, asked, backlog, notes, d: createDeliveries(ctx, clock) };
}

test("deliverChain: every step waits for readiness on the deliveries' clock", async () => {
  const h = deliveriesHarness();
  const real0 = Date.now();
  const out = await h.d.deliverChain("s1", ["first step of the chain", "second step of the chain"]);
  assert.deepEqual(out, { last: "ok", step: 2 });
  assert.equal(h.asked.length, 2);
  assert.ok(h.asked.every((a) => a.clock === h.clock), "waitReady was handed the deliveries' clock");
  const typed = h.sessions.writes.filter((w) => w.data.includes("step of the chain"));
  assert.equal(typed.length, 2);
  assert.ok(typed[1].at > typed[0].at, "the second step is typed after the first, in virtual time");
  assert.ok(Date.now() - real0 < 2000);
});

test("startPrompt: a session that never becomes ready gives up after two 45 s waits, in virtual time, and keeps the words", async () => {
  const h = deliveriesHarness({ ready: false });
  const real0 = Date.now();
  const res = await h.d.startPrompt("s1", "the first prompt of a session that never settles");
  assert.equal(res, "retry");
  assert.equal(h.sessions.writes.length, 0, "nothing typed");
  // deliverToNewSession tries twice; each readiness wait is 45 s.
  assert.equal(h.clock.elapsed(), 2 * 45000);
  assert.ok(h.asked.every((a) => a.clock === h.clock && a.timeoutMs === 45000));
  assert.deepEqual(h.backlog, ["the first prompt of a session that never settles"]);
  assert.equal(h.notes[0]?.kind, "undelivered");
  assert.ok(Date.now() - real0 < 2000, "90 virtual seconds, not real ones");
});

// ── settle's ask of a backend's own channel ──────────────────────────────

const ASKED = "did this prompt reach the other backend";
const sourceSessions = { keepsClaudeLog: () => false };
const withSource = (userTurns) => setLiveSourceLookup(() => ({ session: {}, sources: { delivery: { userTurns } }, health: () => null }));

test("settle's ask race: a channel that never answers is `unknown` once askMs has passed on the clock", async (t) => {
  t.after(() => setLiveSourceLookup(null));
  const clock = fakeClock();
  withSource(() => new Promise(() => {}));
  const real0 = Date.now();
  const m = await ranMatch(sourceSessions, "s1", ASKED, clock.now(), {}, 5000, clock);
  assert.equal(m.verdict, "unknown");
  assert.equal(clock.elapsed(), 5000);
  assert.ok(Date.now() - real0 < 2000, "the bound ran in virtual time");
});

test("settle's ask race: an answer before the bound wins, and the bound is called off", async (t) => {
  t.after(() => setLiveSourceLookup(null));
  const clock = fakeClock();
  const since = clock.now();
  withSource(() => new Promise((r) => clock.at(3000, () => r([{ id: "u1", text: ASKED, at: since + 3000 }]))));
  const m = await ranMatch(sourceSessions, "s1", ASKED, since, {}, 5000, clock);
  assert.equal(m.verdict, "landed");
  assert.equal(clock.elapsed(), 3000);
  assert.equal(clock.pending(), 0, "the 5 s bound was cancelled, not left to fire");
});

test("awaitLanded: a delivery's last proof asks a silent channel only until its own deadline", async (t) => {
  t.after(() => setLiveSourceLookup(null));
  const clock = fakeClock();
  withSource(() => new Promise(() => {}));
  // LOG_PROOF_MS is 2500: the ask is bounded by what is left of it, not by the 5 s default.
  assert.equal(await awaitLanded(sourceSessions, "s1", ASKED, clock.now(), 2500, undefined, undefined, clock), false);
  assert.equal(clock.elapsed(), 2500);
});
