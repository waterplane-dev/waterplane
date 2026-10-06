/**
 * Scenario `limit-and-budget` played through the real DemoHost: the session's
 * own budget holds the next send before the account's wall; the cap raised,
 * the prompt runs into the wall, the session is parked, the scripted clock jump
 * reaches the reset, and the held prompt's turn finishes — typed exactly once.
 * Every figure is checked against the rule that would produce it.
 *
 *     node --test packages/web/src/demo/scenarios/limit-and-budget.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, sessionBudgetHeld, sessionBudgetVerdict } from "@waterplane/shared";
import { createDemoHost } from "../host/index.ts";
import { DEMO_SCENARIOS } from "./index.ts";
import { CLOCK_START } from "./first-look.ts";
import { findLeaks } from "../../../../../tools/demo-scenario.mjs";
import {
  ALL_READINGS, BUDGET_TOK, EARLIER, HELD_PROMPT, RAISED_TOK, WINDOW_TOK, limitAndBudget, usageAfter,
} from "./limit-and-budget.ts";

function play() {
  const sc = limitAndBudget(CLOCK_START);
  let now = sc.clock.start;
  const host = createDemoHost(sc, { now: () => now });
  const outs = [];
  const conn = host.connect((o) => outs.push(o));
  const frames = () => outs.filter((o) => o.kind === "frame").map((o) => o.msg);
  return { sc, host, conn, frames, tick: (ms) => { now += ms; host.advance(); } };
}

const ptyText = (frames, id) => frames.filter((m) => m.t === "pty" && m.id === id).map((m) => Buffer.from(m.dataB64, "base64").toString("utf8")).join("");

test("limit-and-budget is registered, shippable and clean, and follows `now`", () => {
  assert.ok(DEMO_SCENARIOS["limit-and-budget"]);
  assert.deepEqual(findLeaks(limitAndBudget(CLOCK_START)), []);
  const a = limitAndBudget(CLOCK_START).state.model.sessions[0].createdAt;
  const b = limitAndBudget(CLOCK_START + 1000).state.model.sessions[0].createdAt;
  assert.equal(b - a, 1000);
});

test("limit-and-budget: the budget holds the next send before the wall; at the reset the held prompt's turn finishes, run once", () => {
  const h = play();
  const id = "demo-g1";
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  h.conn.receive({ t: "session.attach", id });
  const sess = () => h.frames().filter((m) => m.t === "session.updated" && m.session.id === id).at(-1)?.session
    ?? h.frames().find((m) => m.t === "session.list").sessions.find((s) => s.id === id);
  const usage = () => h.frames().filter((m) => m.t === "usage.status").at(-1).usage;
  const e = EARLIER.length;

  // Opens mid-turn, within the cap, and the seeded verdict is the shared rule's own.
  assert.equal(sess().turnActive, true);
  assert.deepEqual(sess().budget.verdict, sessionBudgetVerdict(sess().budget.cfg, sess().contextSpark, null, CLOCK_START, true));
  assert.equal(sess().budget.verdict.state, "ok");
  assert.equal(h.frames().find((m) => m.t === "limit.config").enabled, true, "auto-continue is on");

  // The third request of the running turn crosses the cap; the turn still finishes (no interrupt).
  assert.ok(usageAfter(e + 2) < BUDGET_TOK && usageAfter(e + 3) >= BUDGET_TOK, "it is the third request that crosses");
  h.tick(4_500);
  assert.equal(sess().budget.verdict.state, "ok");
  h.tick(1_000);
  assert.equal(sess().budget.verdict.state, "over");
  assert.equal(sess().budget.verdict.spent, usageAfter(e + 3));
  assert.equal(sessionBudgetHeld(sess()), true, "the phone's queue holds this lane from here");
  assert.equal(h.frames().filter((m) => m.t === "notification.list").at(-1).items.length, 1, "told once");
  h.tick(5_000);
  assert.equal(sess().turnActive, false);
  assert.equal(sess().contextLeft, Math.round(100 * (1 - ALL_READINGS[e + 3] / WINDOW_TOK)), "the meter is the last reading against the window");
  assert.equal(usage().sessionPct, 94, "short of the wall while the budget holds");

  // *When it's free*: the host's ladder holds it on the session's own budget, in its own words.
  h.conn.receive({ t: "backlog.add", repoDir: "~/dev/todo-garden", text: HELD_PROMPT, targetSessionId: id, autoFire: true, ackId: "held-1" });
  const row = () => h.frames().filter((m) => m.t === "intent.changed").at(-1).intent;
  assert.equal(row().state, "blocked");
  assert.equal(row().blockReason, "sessionBudget");
  assert.match(row().blockDetail, /over its own budget/);
  h.tick(3_000);
  assert.equal(row().state, "blocked", "nothing runs while it holds");
  assert.equal(ptyText(h.frames(), id).includes(HELD_PROMPT), false, "the words are kept, not typed");

  // The person raises the cap: over → ok, the held prompt is let go and delivered once.
  h.conn.receive({ t: "session.budget.set", id, budget: { unit: "tok", max: RAISED_TOK, interrupt: false } });
  assert.equal(sessionBudgetHeld(sess()), false);
  assert.equal(row().state, "running");
  h.tick(6_000);
  assert.equal(usage().sessionPct, 100);
  const blocked = sess().limit;
  assert.equal(blocked.blocked, true, "parked at the wall");
  assert.equal(blocked.resetAt, usage().sessionResetAt, "parked until the window's own reset");

  // The scripted clock jump lands just past the reset: auto-continue, then the rest of the turn.
  h.tick(3_000);
  assert.equal(h.host.clockShift(), 0, "parked: nothing has jumped yet");
  h.tick(8_000);
  assert.ok(h.host.clockShift() > 60 * 60_000, "the demo skipped ahead");
  h.tick(15_000);
  const s = sess();
  assert.equal(s.limit.blocked, false);
  assert.equal(s.turnActive, false, "the resumed turn finished");
  assert.equal(s.budget.verdict.state, "ok", "within the raised cap");
  assert.equal(s.budget.verdict.spent, usageAfter(ALL_READINGS.length));
  assert.ok(usage().sessionPct < 10 && usage().sessionResetAt > blocked.resetAt, "a fresh 5-hour window");
  assert.deepEqual(h.frames().filter((m) => m.t === "decisions.log").at(-1).entries.map((x) => x.phase), ["resumed", "attempt", "blocked"]);
  const out = ptyText(h.frames(), id);
  assert.equal(out.split(HELD_PROMPT).length - 1, 1, "the held prompt was typed exactly once");
  assert.match(out, /continue\r\n[\s\S]*its due date moves with it/);
  h.conn.receive({ t: "session.history", id });
  const hist = h.frames().at(-1).entries.map((x) => x.text);
  assert.equal(hist.filter((t) => t === HELD_PROMPT).length, 1);
  assert.equal(row().state, "done", "the row settles when the resumed turn ends, not at the wall");
  assert.equal(h.host.nextAt(), null, "nothing left pending");
});
