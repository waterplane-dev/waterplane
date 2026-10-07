/**
 * The demo engine's clock jump, a session's own budget, and the usage wall
 * (demo/host desk.ts, budget.ts, usagewall.ts, waiting.ts):
 *
 *   - a `clock` step moves the demo's time FORWARD only, fires what fell due,
 *     lays the rest of its list out from the new now, survives a reload, and
 *     `nextAt` stays on the injected clock's scale;
 *   - `session.budget.set` is answered the way the host answers it, and a spend
 *     crossing the cap is judged by the shared rule and told ONCE;
 *   - a `wall` parks the session until its reset and the auto-continue there
 *     clears it as the turn starts.
 *
 *     node --test packages/web/src/demo/host/clockwall.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, sessionBudgetHeld } from "@waterplane/shared";
import { createDemoHost, restoreDemoHost } from "./index.ts";
import { BUDGET_GARBAGE, BUDGET_NO_SESSION } from "./budget.ts";

const T0 = 1_000_000;
const HOUR = 3_600_000;

const session = (over = {}) => ({ id: "s1", cwd: "/r", title: "todo · main", remoteControl: true, running: true, idle: true, ...over });

function harness(model = {}, script = []) {
  const sc = {
    meta: { id: "t", protocol: PROTOCOL_VERSION, stamp: "s1" },
    clock: { start: T0 },
    state: { bootId: "b", model: { sessions: [session()], ...model } },
    script,
  };
  let now = T0;
  const clock = { now: () => now };
  const host = createDemoHost(sc, clock);
  const outs = [];
  const conn = host.connect((o) => outs.push(o));
  conn.receive({ t: "hello" });
  const frames = () => outs.filter((o) => o.kind === "frame").map((o) => o.msg);
  const sess = () => host.snapshot().state.model.sessions.find((s) => s.id === "s1");
  return { sc, host, conn, frames, sess, clock, tick: (ms) => { now += ms; host.advance(); } };
}

const toasts = (frames) => frames().filter((m) => m.t === "toast").map((m) => m.text);

test("a clock step jumps forward, fires what fell due in order, and paces the rest from the new now", () => {
  const h = harness({
    replies: [{
      steps: [
        { kind: "frame", msg: { t: "toast", text: "before" }, afterMs: 100 },
        { kind: "clock", to: T0 + 2 * HOUR, afterMs: 100 },
        { kind: "frame", msg: { t: "toast", text: "after" }, afterMs: 1_000 },
      ],
    }],
  });
  h.conn.receive({ t: "session.input", id: "s1", data: "go", submit: true, ackId: "a1" });
  h.tick(200);
  assert.deepEqual(toasts(h.frames), ["before"]);
  assert.equal(h.host.clockShift(), 2 * HOUR - 200, "the demo is now at the clock step's `to`");
  // The step after the jump waits its own 1s from the NEW now, not from when it was laid out.
  h.tick(500);
  assert.deepEqual(toasts(h.frames), ["before"]);
  assert.equal(h.host.nextAt(), T0 + 200 + 1_000, "nextAt is on the injected clock's scale, not the shifted one");
  h.tick(500);
  assert.deepEqual(toasts(h.frames), ["before", "after"]);
});

test("a clock step never runs backwards, and its shift survives a reload", () => {
  const h = harness({}, [
    { at: 100, event: { kind: "clock", to: T0 + HOUR } },
    { at: 200, event: { kind: "clock", to: T0 } },
  ]);
  h.tick(100);
  assert.equal(h.host.clockShift(), HOUR - 100);
  h.tick(100);
  assert.equal(h.host.clockShift(), HOUR - 100, "a `to` already passed changes nothing");
  const back = restoreDemoHost(h.sc, h.clock, JSON.parse(JSON.stringify(h.host.snapshot())));
  assert.equal(back.clockShift(), HOUR - 100, "the jump is in the snapshot");
});

test("a usage step is a reading taken as it runs: kept, broadcast, stamped with the demo's now", () => {
  const h = harness({}, [
    { at: 0, event: { kind: "clock", to: T0 + HOUR } },
    { at: 0, event: { kind: "usage", usage: { ok: true, sessionPct: 40, weeklyPct: 10, sessionResetAt: null, weeklyResetAt: null } } },
  ]);
  h.tick(0);
  const u = h.frames().filter((m) => m.t === "usage.status").at(-1).usage;
  assert.equal(u.checkedAt, T0 + HOUR);
  h.conn.receive({ t: "usage.get" });
  assert.deepEqual(h.frames().at(-1), { t: "usage.status", usage: u }, "a later read answers what was pushed");
});

test("session.budget.set: set and cleared on session.updated; garbage and a closed session refused in the host's words", () => {
  const h = harness();
  h.conn.receive({ t: "session.budget.set", id: "s1", budget: { unit: "tok", max: 1000 } });
  const up = h.frames().filter((m) => m.t === "session.updated").at(-1).session;
  assert.deepEqual(up.budget.cfg, { unit: "tok", max: 1000, interrupt: true });
  assert.equal(up.budget.verdict.state, "unknown", "no spark yet: unknown, which never holds");
  assert.equal(up.budget.verdict.why, "noSpark");
  assert.equal(h.frames().filter((m) => m.t === "op.ack" || m.t === "input.ack").length, 0, "no receipt — the message is not durable");
  h.conn.receive({ t: "session.budget.set", id: "s1", budget: { unit: "tok", max: -1 } });
  assert.deepEqual(h.frames().at(-1), { t: "toast", text: BUDGET_GARBAGE });
  h.conn.receive({ t: "session.budget.set", id: "nope", budget: { unit: "tok", max: 5 } });
  assert.deepEqual(h.frames().at(-1), { t: "toast", text: BUDGET_NO_SESSION });
  h.conn.receive({ t: "session.budget.set", id: "s1", budget: null });
  assert.equal(h.frames().filter((m) => m.t === "session.updated").at(-1).session.budget, undefined);
});

test("the spend crossing the cap is judged by the shared rule and told once; raising the cap lets it go", () => {
  const spark = (usageTok) => ({ pts: [1], marks: [], peak: 1, usageTok, windowTok: 200_000, windowFrom: "model", autoCompactTok: null });
  const h = harness({ sessions: [session({ contextSpark: spark(900) })] }, [
    { at: 100, event: { kind: "session", sessionId: "s1", patch: { contextSpark: spark(1_100) } } },
    { at: 200, event: { kind: "session", sessionId: "s1", patch: { contextSpark: spark(1_200) } } },
  ]);
  h.conn.receive({ t: "session.budget.set", id: "s1", budget: { unit: "tok", max: 1_000, interrupt: false } });
  assert.equal(h.sess().budget.verdict.state, "ok");
  h.tick(100);
  assert.equal(h.sess().budget.verdict.state, "over");
  assert.equal(sessionBudgetHeld(h.sess()), true, "the phone's queue would hold this lane");
  h.tick(100);
  const told = h.frames().filter((m) => m.t === "notification.list").at(-1).items;
  assert.equal(told.length, 1, "still over is not a second crossing");
  assert.match(told[0].title, /^Session budget hit · /);
  assert.match(told[0].body, /held until you raise or clear the budget\. No Esc was sent: this budget is set not to interrupt\.$/);
  h.conn.receive({ t: "session.budget.set", id: "s1", budget: { unit: "tok", max: 3_000, interrupt: false } });
  assert.equal(h.sess().budget.verdict.state, "ok");
  assert.equal(sessionBudgetHeld(h.sess()), false);
});

test("a wall parks the session until its reset; the clock gets there; auto-continue clears it as the turn starts and the reply finishes once", () => {
  const resetAt = T0 + 2 * HOUR;
  const h = harness({
    limitConfig: { enabled: true },
    replies: [{
      steps: [
        { kind: "output", text: "working\r\n", afterMs: 100 },
        {
          kind: "wall", resetAt, afterMs: 100,
          meanwhile: [{ kind: "clock", to: resetAt + 1_000, afterMs: 1_000 }],
          resumed: [{ kind: "output", text: "finished\r\n", afterMs: 500 }],
        },
      ],
    }],
  });
  h.conn.receive({ t: "session.attach", id: "s1" });
  h.conn.receive({ t: "session.input", id: "s1", data: "go", submit: true, ackId: "a1" });
  h.tick(200);
  let s = h.sess();
  assert.equal(s.limit.blocked, true);
  assert.equal(s.limit.resetAt, resetAt);
  assert.equal(s.limit.blockedSince, T0 + 200);
  assert.equal(s.limit.autoContinue, true);
  assert.equal(s.turnActive, false, "the turn stopped at the wall");
  const rows = () => h.frames().filter((m) => m.t === "decisions.log").at(-1).entries;
  assert.deepEqual(rows().map((r) => r.phase), ["blocked"]);
  h.tick(1_000); // the clock jump: reset passed, auto-continue fires, the turn starts
  s = h.sess();
  assert.equal(s.limit.blocked, false, "cleared by the turn starting");
  assert.equal(s.turnActive, true);
  assert.deepEqual(rows().map((r) => r.phase), ["resumed", "attempt", "blocked"]);
  assert.match(rows()[0].rationale, /^1 attempt · blocked 2h 0m$/);
  h.tick(500);
  s = h.sess();
  assert.equal(s.turnActive, false, "the reply's own end of turn ran after `resumed`");
  const pty = h.frames().filter((m) => m.t === "pty").map((m) => Buffer.from(m.dataB64, "base64").toString("utf8")).join("")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.equal(pty.match(/❯ go\r\n/g)?.length ?? 0, 1, "the prompt was typed once");
  assert.match(pty, /continue\r\n[\s\S]*finished/);
  h.conn.receive({ t: "decisions.get" });
  assert.equal(h.frames().at(-1).entries.length, 3, "a later read answers the same rows");
});

test("with auto-continue off the wall parks the session and nothing continues it", () => {
  const h = harness({ replies: [{ steps: [{ kind: "wall", resetAt: T0 + 1_000, afterMs: 10 }] }] });
  h.conn.receive({ t: "session.input", id: "s1", data: "go", submit: true, ackId: "a1" });
  h.tick(10);
  assert.equal(h.sess().limit.autoContinue, false);
  h.tick(5_000);
  assert.equal(h.sess().limit.blocked, true, "only a person resumes it now");
  assert.match(h.frames().filter((m) => m.t === "decisions.log").at(-1).entries[0].rationale, /^Auto-continue is off — resume manually\.$/);
});
