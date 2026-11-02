/**
 * The wave gate (`recover/wavegate.ts`): the first of a wave goes alone, its
 * success releases the rest, its failure holds them — one gate per SCOPE. The
 * account wall's policy over it (`sessions/resume.ts`) must be today's resume
 * queue, unchanged; the net retry's (`sessions/apiretry.ts`) is one wave per
 * host, the rest held until the probe's own next rung.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Knobs are read at import: short gaps so a wave plays out in a test.
process.env.WATERPLANE_LIMIT_RESUME_GAP_MS = "60";
process.env.WATERPLANE_LIMIT_RETRY_MS = "600000";

const { WaveGate } = await import("../dist/recover/wavegate.js");
const { ResumeSlice } = await import("../dist/sessions/resume.js");
const { NetRetrySlice, NET_WAVE_WHY } = await import("../dist/sessions/apiretry.js");
const { LIMIT_RETRY_MS } = await import("../dist/sessions/knobs.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A gate over a fake policy: `line` is the order, `sent` what was dispatched. */
function rig(over = {}) {
  const sent = [];
  const policy = {
    line: ["a", "b", "c"],
    modeIs: "all",
    order() { return this.line; },
    mode() { return this.modeIs; },
    group: (id) => (id === "c" ? "repo2" : "repo1"),
    dispatch: (id) => { sent.push(id); },
    holdFor: () => ({ until: Date.now() + 60_000 }),
    publish() {},
    gapMs: 20,
    releaseGapMs: () => 20,
    settleMs: 60_000,
    ...over,
  };
  const gate = new WaveGate(policy);
  return { gate, policy, sent };
}

test("a wave of three: the first goes alone; its success releases the rest", async (t) => {
  const { gate, sent } = rig();
  t.after(() => gate.dispose());
  gate.requestAll(["a", "b", "c"]);
  await sleep(80);
  assert.deepEqual(sent, ["a"], "the probe goes alone, however long the others wait");
  assert.equal(gate.waiting().length, 2);
  gate.release("a", "resumed");
  assert.equal(gate.proven(), true);
  await sleep(300);
  assert.deepEqual(sent, ["a", "b", "c"], "proven ⇒ `all` lets the rest go, spaced by the gap");
});

test("a failed probe holds the rest; a forced request overrules the hold, never the first-alone rule", async (t) => {
  const { gate, sent } = rig();
  t.after(() => gate.dispose());
  gate.requestAll(["a", "b", "c"]);
  await sleep(30);
  gate.release("a", "blocked");
  assert.ok(gate.holdUntil() > Date.now(), "the time-shaped hold is set");
  await sleep(80);
  assert.deepEqual(sent, ["a"], "nobody spends an attempt learning the block still stands");
  gate.requestAll(["c"], { forced: true });
  await sleep(10);
  assert.deepEqual(sent, ["a", "b"], "forced lifts the hold — and the head of the line goes, alone");
  gate.release("b", "timeout");
  await sleep(250);
  assert.deepEqual(sent, ["a", "b", "c"], "a timeout proves nothing but frees the slot");
});

test("the id-shaped hold: the rest wait until the probe asks again, and it goes first", async (t) => {
  const { gate, sent } = rig({ holdFor: (id) => ({ by: id }) });
  t.after(() => gate.dispose());
  gate.requestAll(["a", "b", "c"]);
  await sleep(30);
  gate.release("a", "blocked");
  assert.equal(gate.heldBy(), "a");
  await sleep(80);
  assert.deepEqual(sent, ["a"], "held: no clock lifts it");
  gate.request("a"); // its next rung
  await sleep(10);
  assert.deepEqual(sent, ["a", "a"], "the probe again, alone");
  gate.release("a", "gone"); // it parked on a box: nothing learnt, the hold stays its own
  await sleep(80);
  assert.equal(gate.heldBy(), "a");
  assert.deepEqual(sent, ["a", "a"], "a parked probe does not hand the probe to the rest");
  gate.request("a");
  assert.deepEqual(sent, ["a", "a", "a"]);
  gate.release("a", "resumed");
  assert.equal(gate.heldBy(), null);
  await sleep(200); // a gap is never under 50 ms
  assert.deepEqual(sent, ["a", "a", "a", "b", "c"]);
});

test("dropping the holder lifts its hold: the next one probes", async (t) => {
  const { gate, sent } = rig({ holdFor: (id) => ({ by: id }) });
  t.after(() => gate.dispose());
  gate.requestAll(["a", "b"]);
  await sleep(30);
  gate.release("a", "blocked");
  await sleep(80); // past the release's gap: only the hold stands
  gate.drop("a"); // a person typed into it: its episode is over
  await sleep(10);
  assert.deepEqual(sent, ["a", "b"]);
});

test("an event-shaped hold has no clock: only lift() or a forced request moves it (Phase D)", async (t) => {
  const { gate, sent } = rig({ holdFor: () => ({ until: Number.POSITIVE_INFINITY }) });
  t.after(() => gate.dispose());
  gate.requestAll(["a", "b"]);
  await sleep(30);
  gate.release("a", "blocked");
  await sleep(80);
  assert.deepEqual(sent, ["a"]);
  gate.lift();
  await sleep(10);
  assert.deepEqual(sent, ["a", "b"]);
});

test("`one` stays serial after proof; `repo` lets another checkout alongside, never the same one", async (t) => {
  const { gate, policy, sent } = rig();
  t.after(() => gate.dispose());
  policy.modeIs = "one";
  gate.requestAll(["a", "b", "c"]);
  await sleep(30);
  gate.setProven(true);
  gate.pump();
  await sleep(40);
  assert.deepEqual(sent, ["a"], "one: never two in flight");
  policy.modeIs = "repo";
  gate.pump();
  await sleep(40);
  assert.deepEqual(sent, ["a", "c"], "repo: `b` shares a's checkout, `c` does not");
});

test("the settle guard asks the policy; `wait` asks again, a verdict releases", async (t) => {
  let answer = "wait";
  const asked = [];
  const { gate } = rig({ settleMs: 15, settle: (id, elapsed) => { asked.push(elapsed); return answer; } });
  t.after(() => gate.dispose());
  gate.request("a");
  await sleep(120);
  assert.ok(asked.length >= 2, "re-armed while the policy says wait");
  assert.equal(gate.isInFlight("a"), true);
  answer = "resumed";
  await sleep(120);
  assert.equal(gate.isInFlight("a"), false);
  assert.equal(gate.proven(), true);
});

test("handOver moves the slot to a new id without releasing it", (t) => {
  const { gate } = rig();
  t.after(() => gate.dispose());
  gate.request("a");
  gate.handOver("a", "a2");
  assert.equal(gate.isInFlight("a"), false);
  assert.equal(gate.isInFlight("a2"), true);
});

// ── The account wall's policy: today's resume queue, unchanged ──

function limitRig(ids) {
  const continued = [];
  const rescheduled = [];
  const core = {
    root: mkdtempSync(join(tmpdir(), "wp-wave-")),
    sessions: new Map(),
    mode: "all",
    resumeMode() { return this.mode; },
    limitAuto: () => true,
    limitRetry: () => ({ kind: "ladder" }),
    doLimitContinue: async (s) => { continued.push(s.info.id); },
    scheduleLimitAttempt: (s) => { rescheduled.push(s.info.id); },
    clearLimitTimer() {},
    emit() {},
  };
  ids.forEach((id, i) => core.sessions.set(id, {
    info: { id, cwd: `/r/${id}`, running: true, limit: { blocked: true, blockedSince: 100 + i, nextAttemptAt: 5, attempts: 1 } },
    killed: false, resurrectTimer: null,
  }));
  const slice = new ResumeSlice(core);
  const done = () => { slice["gate"].dispose(); rmSync(core.root, { recursive: true, force: true }); };
  return { slice, core, continued, rescheduled, done };
}

test("limit: a wave of three resumes the longest-blocked alone, then the rest once one started a turn", async () => {
  const { slice, core, continued, done } = limitRig(["s1", "s2", "s3"]);
  try {
    for (const id of ["s3", "s2", "s1"]) slice.requestResume(core.sessions.get(id));
    assert.deepEqual(continued, ["s3"], "the first request goes at once");
    await sleep(100);
    assert.deepEqual(continued, ["s3"], "unproven: nobody alongside, in any mode");
    assert.equal(core.sessions.get("s1").info.limit.nextAttemptAt, null, "a request clears the booked attempt");
    assert.equal(core.sessions.get("s1").info.limit.queuePos, 1, "longest blocked heads the published line");
    assert.equal(core.sessions.get("s3").info.limit.resuming, true);
    slice.releaseResume("s3", "resumed");
    await sleep(400);
    assert.deepEqual(continued, ["s3", "s1", "s2"], "proven: the rest in queue order, a gap apart");
    assert.deepEqual(slice.resumeState().resumingIds.sort(), ["s1", "s2"]);
  } finally { done(); }
});

test("limit: still blocked holds every other session for LIMIT_RETRY_MS and re-books attempts inside it", async () => {
  const { slice, core, continued, rescheduled, done } = limitRig(["s1", "s2"]);
  try {
    slice.requestResume(core.sessions.get("s1"));
    slice.requestResume(core.sessions.get("s2"));
    core.sessions.get("s2").info.limit.nextAttemptAt = Date.now() + 1000; // booked before the hold ends
    const t0 = Date.now();
    slice.releaseResume("s1", "blocked");
    const hold = slice.holdUntil();
    assert.ok(hold >= t0 + LIMIT_RETRY_MS && hold <= Date.now() + LIMIT_RETRY_MS);
    assert.equal(slice.proven(), false);
    assert.deepEqual(rescheduled, ["s2"], "the countdown the phone shows is one the attempt will fire at");
    await sleep(100);
    assert.deepEqual(continued, ["s1"], "held");
    slice.resumeNow("s2");
    await sleep(10);
    assert.deepEqual(continued, ["s1", "s2"], "resume-now overrules the hold");
  } finally { done(); }
});

// ── The net's policy: one wave per host ──

function netRig(ids) {
  const writes = [];
  const core = {
    sessions: new Map(), emit() {}, loadLive: () => null, persistLive() {}, recordPrompt() {},
    write: (id, data) => { writes.push([id, data]); },
  };
  const slice = new NetRetrySlice(core);
  ids.forEach((id, i) => core.sessions.set(id, {
    info: { id, title: id, running: true, cwd: `/nowhere/${id}`, limit: null, prompt: null, awaitingInput: false,
      netRetry: { state: "waiting", attempt: 0, max: 3, nextAt: Date.now(), error: "Can't reach the API server (ENOTFOUND)", at: 100 + i } },
    turnActive: false, lastDataAt: 0, stopCount: 0, netTimer: null, netRecheck: null,
  }));
  const done = () => { for (const s of core.sessions.values()) slice.clear(s); slice["gate"].dispose(); };
  return { slice, core, writes, done };
}

test("net: three rungs due together — one continue is typed, the others wait and say why", async () => {
  const { slice, core, writes, done } = netRig(["n1", "n2", "n3"]);
  try {
    for (const id of ["n3", "n1", "n2"]) slice["gate"].request(id); // the rungs fire
    await sleep(400); // the writer's text/Return gap
    assert.deepEqual([...new Set(writes.map(([id]) => id))], ["n3"], "the first rung due is the probe; nothing typed elsewhere");
    assert.equal(core.sessions.get("n3").info.netRetry.state, "sent");
    for (const id of ["n1", "n2"]) {
      const n = core.sessions.get(id).info.netRetry;
      assert.equal(n.state, "waiting");
      assert.equal(n.why, NET_WAVE_WHY);
      assert.equal(n.heldBy, "n3", "the holder is a field, not only a sentence");
      assert.equal(n.attempt, 0, "a held session spends no rung");
    }
    // The probe's give-up: the rest stay held until ITS next rung.
    slice["schedule"](core.sessions.get("n3"), Date.now(), "Can't reach the API server (ENOTFOUND)");
    assert.equal(slice["gate"].heldBy(), "n3");
    await sleep(100);
    assert.deepEqual([...new Set(writes.map(([id]) => id))], ["n3"]);
  } finally { done(); }
});

test("net: the probe's served reply releases the rest", async () => {
  const { slice, core, writes, done } = netRig(["n1", "n2"]);
  try {
    slice["gate"].request("n1");
    slice["gate"].request("n2");
    await sleep(350);
    slice["verdict"](core.sessions.get("n1"), "resumed"); // `turnEnded` on a served reply
    await sleep(400);
    assert.deepEqual([...new Set(writes.map(([id]) => id))], ["n1", "n2"]);
  } finally { done(); }
});

test("net: alone, a rung types at once — the ladder's timing is today's", async () => {
  const { slice, writes, done } = netRig(["n1"]);
  try {
    slice["gate"].request("n1");
    await sleep(5);
    assert.deepEqual(writes.map(([id, d]) => [id, d]).slice(0, 1), [["n1", "continue"]], "the text is written in the same tick");
  } finally { done(); }
});

const ENOTFOUND = "Can't reach the API server (ENOTFOUND)";
const typedBy = (writes) => [...new Set(writes.map(([id]) => id))];

/** n1 probes, n2 waits behind it; n1's dispatch is its OWN stall probe when `stall`. */
async function heldBehindProbe(stall) {
  const r = netRig(["n1", "n2"]);
  r.slice["gate"].request("n1");
  r.slice["gate"].request("n2");
  await sleep(350); // the writer's text/Return gap
  const p1 = r.core.sessions.get("n1");
  assert.equal(p1.info.netRetry.state, "sent");
  if (stall) p1.info.netRetry.probe = true; // as `probe()` dispatched it
  r.slice["schedule"](p1, Date.now(), ENOTFOUND);
  return r;
}

test("net: held sessions borrow the holder's real clock — published after its record is final", async () => {
  const { slice, core, done } = await heldBehindProbe(false);
  try {
    const lead = core.sessions.get("n1").info.netRetry;
    const held = core.sessions.get("n2").info.netRetry;
    assert.equal(slice["gate"].heldBy(), "n1");
    assert.equal(lead.state, "waiting");
    assert.ok(lead.nextAt > Date.now(), "the holder's next rung");
    assert.equal(held.why, NET_WAVE_WHY);
    assert.equal(held.heldBy, "n1");
    assert.equal(held.nextAt, lead.nextAt, "the held line carries the holder's clock, not null");
    assert.equal(held.probe, undefined, "a rung is not a stall: nothing to borrow");
  } finally { done(); }
});

test("net: behind a STALLED holder the held read stalled — and the lent probe never runs their own ladder", async () => {
  const { slice, core, writes, done } = await heldBehindProbe(true);
  try {
    const lead = core.sessions.get("n1").info.netRetry;
    const held = core.sessions.get("n2").info.netRetry;
    assert.equal(lead.state, "gaveup");
    assert.ok(lead.nextAt != null, "the stall's next probe");
    assert.equal(held.probe, true, "work waiting on a held session is stalled too");
    assert.equal(held.nextAt, lead.nextAt);
    // The holder stops being in the way (a person typed into it): n2 goes — as ITS rung.
    await sleep(100);
    writes.length = 0;
    slice.typed(core.sessions.get("n1"));
    await sleep(350);
    assert.deepEqual(typedBy(writes), ["n2"]);
    const sent = core.sessions.get("n2").info.netRetry;
    assert.equal(sent.state, "sent");
    assert.equal(sent.probe, undefined, "the borrowed probe stays behind: its line says retried (n/max), not tried once more");
    // Its give-up is a ladder rung, never a stall probe's give-up.
    assert.deepEqual(slice["schedule"](core.sessions.get("n2"), Date.now(), ENOTFOUND), { net: "retrying" });
    assert.equal(core.sessions.get("n2").info.netRetry.state, "waiting");
  } finally { done(); }
});

test("net: the switch off types nothing — stopping a holder's probe cannot dispatch a session later in the walk", async () => {
  const { slice, core, writes, done } = await heldBehindProbe(true);
  try {
    assert.equal(slice["gate"].heldBy(), "n1");
    await sleep(100); // past the release gap, so a pump would dispatch at once
    writes.length = 0;
    slice.switched(false);
    await sleep(350);
    assert.deepEqual(writes, [], "no continue after the switch went off");
    assert.equal(core.sessions.get("n2").info.netRetry, null, "the held rung is cancelled");
    const n1 = core.sessions.get("n1").info.netRetry;
    assert.equal(n1.state, "gaveup");
    assert.equal(n1.nextAt, null, "probing stopped; the stall stands");
  } finally { done(); }
});
