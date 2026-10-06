// The protocol behaviour the real desktop and the demo's fake desktop must
// share (demo-mode plan §6). Each check is written ONCE against `Target`
// (targets.mjs) and runs against both. Where the two legitimately differ —
// the plan's tier B, which the fake refuses and the real host runs — the check
// says so per target in its own words; it is never loosened until both pass.
// A disagreement anywhere else means the FAKE is wrong (plan §6).
//
// A check is `{ name, run(target, t) }`: it throws (node:assert) on the first
// broken rule, and may call `t.note(sentence)` for what it chose not to assert
// on this target and why.
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
let n = 0;
/** ackIds unique per run AND per target, so a ledger kept on disk by the real
 *  host can never answer one check with another's verdict. */
const ack = (tag) => `contract-${tag}-${process.pid}-${++n}`;

/**
 * Does this receipt END its sender's wait in the phone's queue? A mirror of
 * `packages/web/src/core/queue/wire.ts` (`onOpAck` / `onBacklogAck` /
 * `onInputAck`): an `op.ack` or `backlog.ack` drops or fails the row whatever
 * it says; an `input.ack` does too unless it is `ok:false` + `retryable`,
 * the one verdict the queue puts back. A refusal that did not terminate would
 * be a row retried until its give-up budget ran out.
 */
export function terminates(r) {
  if (r.t === "op.ack" || r.t === "backlog.ack") return true;
  if (r.t === "input.ack") return r.ok === true || !r.retryable;
  return false;
}

/** A refusal's shape: ok:false, a sentence to show, never auto-retryable —
 *  `backlog.ack` included: its sentence rides on the receipt (routes/work.ts),
 *  which is what the phone fails the row with. */
function assertRefusal(r, what) {
  assert.equal(r.ok, false, `${what}: refused (${JSON.stringify(r)})`);
  assert.ok(typeof r.reason === "string" && r.reason.trim().length > 0, `${what}: the refusal carries a sentence (${JSON.stringify(r)})`);
  assert.ok(!r.retryable, `${what}: a refusal is never auto-retryable (${JSON.stringify(r)})`);
  assert.ok(terminates(r), `${what}: the phone's queue would END this row, not retry it`);
}

/** The receipt fields that are the verdict, for "the replay says the same". */
const verdictOf = (r) => JSON.stringify({ t: r.t, ok: r.ok, reason: r.reason ?? null, state: r.state ?? null, sessionId: r.sessionId ?? null, runId: r.runId ?? null, itemId: r.itemId ?? null });

const opAckFor = (id) => (m) => m.t === "op.ack" && m.ackId === id;
const inputAckFor = (id) => (m) => m.t === "input.ack" && m.ackId === id;
const backlogAckFor = (id) => (m) => m.t === "backlog.ack" && m.ackId === id;

/** Open a session in the target's repo through the durable op, the way the
 *  phone does, and wait until it is listed. */
async function openSession(c, target, tag) {
  const id = ack(`create-${tag}`);
  const since = c.mark();
  c.send({ t: "session.create", cwd: target.repoDir, cols: 80, rows: 24, ackId: id });
  const r = await c.waitFor(opAckFor(id), { since, what: `op.ack for ${id}`, ms: 20_000 });
  assert.equal(r.ok, true, `session.create in the repo is accepted (${JSON.stringify(r)})`);
  assert.ok(typeof r.sessionId === "string" && r.sessionId, "the create's op.ack names the session");
  await c.waitFor((m) => m.t === "session.created" && m.session?.id === r.sessionId, { since, what: "session.created" });
  return r.sessionId;
}

async function listSessions(c) {
  const since = c.mark();
  c.send({ t: "session.list" });
  const m = await c.waitFor((x) => x.t === "session.list", { since, what: "session.list" });
  return m.sessions;
}

async function historyOf(c, id) {
  const since = c.mark();
  c.send({ t: "session.history", id });
  const m = await c.waitFor((x) => x.t === "session.history" && x.id === id, { since, what: "session.history" });
  return m.entries;
}

/** Submit `text` as the phone's compose bar does and wait for its receipt. */
async function submitPrompt(c, sessionId, text, ackId = ack("submit")) {
  const since = c.mark();
  c.send({ t: "session.input", id: sessionId, data: text, submit: true, ackId });
  return c.waitFor(inputAckFor(ackId), { since, what: `input.ack for ${ackId}`, ms: 60_000 });
}

export const CHECKS = [
  {
    name: "hello is answered with welcome at this build's protocol, and the boot id holds across sockets",
    async run(target) {
      const a = await target.connect();
      assert.equal(a.welcome.protocol, target.protocol, "welcome.protocol");
      assert.ok(typeof a.welcome.bootId === "string" && a.welcome.bootId, "welcome carries a bootId (the resume point's validity stamp)");
      // The phone draws its tabs from the list the host sends UNASKED after
      // welcome; a desktop that waited to be asked would show an empty app.
      await a.waitFor((m) => m.t === "session.list" && Array.isArray(m.sessions), { what: "the unasked session.list after welcome", ms: 5000 });
      const b = await target.connect();
      assert.equal(b.welcome.bootId, a.welcome.bootId, "a reconnect to the same desktop sees the same bootId — a new one would read as a restart and throw away every resume point");
      await a.close(); await b.close();
    },
  },
  {
    name: "/api/health has the shape the watchdog probes",
    async run(target) {
      const r = await target.http("GET", "/api/health");
      assert.equal(r.status, 200, `status (${r.text})`);
      const h = r.json;
      assert.ok(h && typeof h === "object", `JSON body (${r.text})`);
      assert.equal(h.ok, true, "ok");
      assert.equal(h.protocol, target.protocol, "protocol");
      assert.equal(typeof h.root, "string", "root");
      assert.ok(Number.isInteger(h.sessions) && h.sessions >= 0, `sessions is a count (${h.sessions})`);
      // `ptys` is the leak gauge: the master/slave fds this process holds, or
      // null when they cannot be read. A desktop with no fds says null, never
      // a number that means something else.
      assert.ok(h.ptys === null || (Number.isInteger(h.ptys?.masters) && Number.isInteger(h.ptys?.slaves)),
        `ptys is {masters, slaves} or null (${JSON.stringify(h.ptys)})`);
      const keys = Object.keys(h).sort().join(",");
      assert.equal(keys, "ok,protocol,ptys,root,sessions", "no field one desktop has and the other lacks");
    },
  },
  {
    name: "session.create is acked once per ackId: a racing and a late retry name the same session and spawn nothing",
    async run(target) {
      const c = await target.connect();
      const before = (await listSessions(c)).length;
      const id = ack("create-retry");
      const since = c.mark();
      const msg = { t: "session.create", cwd: target.repoDir, cols: 80, rows: 24, ackId: id };
      c.send(msg);
      c.send(msg); // the phone's reconnect re-flush races the first delivery
      await c.waitFor(() => c.all(opAckFor(id), since).length >= 2, { since, what: "two op.acks", ms: 20_000 });
      await sleep(300);
      c.send(msg); // and once more well after it settled: the ledger, not the in-flight guard
      await c.waitFor(() => c.all(opAckFor(id), since).length >= 3, { since, what: "a third op.ack", ms: 10_000 });
      const acks = c.all(opAckFor(id), since);
      assert.equal(acks.length, 3, `one receipt per send (${acks.length})`);
      assert.ok(acks.every((a) => a.ok === true && a.sessionId && a.sessionId === acks[0].sessionId),
        `every receipt names the SAME session (${acks.map(verdictOf).join(" | ")})`);
      await sleep(300);
      const after = await listSessions(c);
      assert.equal(after.length, before + 1, `exactly one session was spawned (${before} → ${after.length})`);
      assert.ok(after.some((s) => s.id === acks[0].sessionId && s.running), "and it is the one the receipt named, running");
      await c.close();
    },
  },
  {
    name: "backlog.add is acked once per ackId: a racing and a late retry name the same item and queue one",
    async run(target) {
      const c = await target.connect();
      const count = async () => {
        const since = c.mark();
        c.send({ t: "backlog.list" });
        const m = await c.waitFor((x) => x.t === "backlog.list", { since, what: "backlog.list" });
        return m.items.length;
      };
      const before = await count();
      const id = ack("backlog-retry");
      const since = c.mark();
      const msg = { t: "backlog.add", repoDir: target.repoDir, text: `contract item ${process.pid}`, ackId: id };
      c.send(msg);
      c.send(msg);
      await c.waitFor(() => c.all(backlogAckFor(id), since).length >= 2, { since, what: "two backlog.acks", ms: 20_000 });
      await sleep(300);
      c.send(msg);
      await c.waitFor(() => c.all(backlogAckFor(id), since).length >= 3, { since, what: "a third backlog.ack" });
      const acks = c.all(backlogAckFor(id), since);
      assert.ok(acks.every((a) => a.ok === true && a.itemId && a.itemId === acks[0].itemId),
        `every receipt names the SAME item (${acks.map(verdictOf).join(" | ")})`);
      assert.equal(await count(), before + 1, "exactly one item was queued");
      await c.close();
    },
  },
  {
    name: "a submitted prompt is acked ok and recorded once; a racing and a late retry with the same ackId do not run it again",
    async run(target) {
      const c = await target.connect();
      const sid = await openSession(c, target, "submit");
      const TEXT = `contract prompt ${process.pid} — summarise the failing test`;
      const id = ack("submit-retry");
      const since = c.mark();
      const msg = { t: "session.input", id: sid, data: TEXT, submit: true, ackId: id };
      c.send(msg);
      c.send(msg);
      await c.waitFor(() => c.all(inputAckFor(id), since).length >= 2, { since, what: "two input.acks", ms: 60_000 });
      c.send(msg);
      await c.waitFor(() => c.all(inputAckFor(id), since).length >= 3, { since, what: "a third input.ack", ms: 10_000 });
      const acks = c.all(inputAckFor(id), since);
      assert.ok(acks.every((a) => a.ok === true), `every receipt is ok (${acks.map(verdictOf).join(" | ")})`);
      assert.ok(acks.every((a) => a.state === undefined || a.state === "ok"), `state is ok or absent (${acks.map((a) => a.state).join(",")})`);
      assert.ok(acks.every((a) => verdictOf(a) === verdictOf(acks[0])), "the replayed receipts say what the first one said");
      await sleep(500);
      const prompts = (await historyOf(c, sid)).filter((e) => e.text === TEXT);
      assert.equal(prompts.length, 1, `the prompt is in the session's history exactly once (${prompts.length})`);
      await c.close();
    },
  },
  {
    name: "a fresh attach replays the PTY in full (full:true), at the seq the live stream reached",
    async run(target) {
      const a = await target.connect();
      const sid = await openSession(a, target, "attach");
      await submitPrompt(a, sid, "contract attach probe");
      await sleep(800);
      const live = a.all((m) => m.t === "pty" && m.id === sid);
      assert.ok(live.length > 0, "the creating socket is attached and streams the PTY");
      const lastSeq = live.at(-1).seq;
      assert.ok(Number.isInteger(lastSeq) && lastSeq > 0, `live frames carry seq (${lastSeq})`);
      const b = await target.connect();
      const since = b.mark();
      b.send({ t: "session.attach", id: sid });
      const rep = await b.waitFor((m) => m.t === "pty" && m.id === sid, { since, what: "the attach replay" });
      assert.equal(rep.full, true, `a fresh attach is a FULL replay, so the client resets its terminal (${JSON.stringify({ full: rep.full, seq: rep.seq })})`);
      assert.ok(rep.seq >= lastSeq, `the replay is at least as far as the live stream got (${rep.seq} vs ${lastSeq})`);
      assert.ok(b64(rep.dataB64).length > 0, "and it carries the screen");
      await b.waitFor((m) => m.t === "session.history" && m.id === sid, { since, what: "session.history after the replay" });
      await a.close(); await b.close();
    },
  },
  {
    name: "a reconnect resumes: resumeSeq from this boot replays exactly the bytes missed, a foreign boot gets a full replay",
    async run(target) {
      // `a` stays attached throughout: its frames are the truth the delta is held to.
      const a = await target.connect();
      const sid = await openSession(a, target, "resume");
      await submitPrompt(a, sid, "contract resume ALPHA");
      await sleep(800);

      const b = await target.connect();
      let since = b.mark();
      b.send({ t: "session.attach", id: sid });
      await b.waitFor((m) => m.t === "session.history" && m.id === sid, { since, what: "attach" });
      await sleep(300);
      const seen = b.all((m) => m.t === "pty" && m.id === sid);
      const S = seen.at(-1).seq;
      const bootId = b.welcome.bootId;
      await b.close(); // the tunnel drops

      const aMark = a.mark();
      await submitPrompt(a, sid, "contract resume BRAVO"); // output while nobody on `b` sees it
      await a.waitFor((m) => m.t === "pty" && m.id === sid, { since: aMark, what: "output while detached" });
      await sleep(800);

      const c = await target.connect();
      assert.equal(c.welcome.bootId, bootId, "same desktop, same boot");
      since = c.mark();
      c.send({ t: "session.attach", id: sid, resumeSeq: S, resumeBoot: bootId });
      await c.waitFor((m) => m.t === "session.history" && m.id === sid, { since, what: "resume attach" });
      const rep = c.all((m) => m.t === "pty" && m.id === sid, since)[0];
      assert.ok(rep, "output happened while away, so the resume replays something");
      assert.ok(!rep.full, `a resume from this boot is a DELTA, never a terminal reset (${JSON.stringify({ full: rep.full })})`);
      // The delta must be exactly what the always-attached socket received after S.
      await a.waitFor((m) => m.t === "pty" && m.id === sid && m.seq >= rep.seq, { what: "the live stream to reach the replay's seq" });
      const missed = a.all((m) => m.t === "pty" && m.id === sid && m.seq > S && m.seq <= rep.seq).map((m) => b64(m.dataB64)).join("");
      assert.equal(b64(rep.dataB64), missed, "the delta is byte-for-byte the frames missed since resumeSeq");
      await c.close();

      // The same seq stamped by another boot means nothing (a tmux session can
      // outlive the daemon and restart its seq): replay in full.
      const d = await target.connect();
      since = d.mark();
      d.send({ t: "session.attach", id: sid, resumeSeq: S, resumeBoot: "not-this-boot" });
      const full = await d.waitFor((m) => m.t === "pty" && m.id === sid, { since, what: "the foreign-boot replay" });
      assert.equal(full.full, true, "a resume point from another boot gets a FULL replay");
      await d.close(); await a.close();
    },
  },
  {
    name: "a detached socket gets no PTY; a killed session says so and refuses what is sent to it",
    async run(target) {
      const a = await target.connect();
      const sid = await openSession(a, target, "detach");
      const b = await target.connect();
      let since = b.mark();
      b.send({ t: "session.attach", id: sid });
      await b.waitFor((m) => m.t === "session.history" && m.id === sid, { since, what: "attach" });
      b.send({ t: "session.detach", id: sid });
      await sleep(300);
      since = b.mark();
      await submitPrompt(a, sid, "contract detach probe");
      await sleep(1000);
      assert.ok(a.all((m) => m.t === "pty" && m.id === sid).length > 0, "the attached socket still streams");
      assert.equal(b.all((m) => m.t === "pty" && m.id === sid, since).length, 0, "the detached one gets nothing");

      since = a.mark();
      a.send({ t: "session.kill", id: sid });
      await a.waitFor((m) => m.t === "session.exit" && m.id === sid, { since, what: "session.exit", ms: 10_000 });
      await sleep(300);
      const listed = (await listSessions(a)).find((s) => s.id === sid);
      assert.ok(!listed || listed.running === false, `the killed session is no longer running (${JSON.stringify(listed && { running: listed.running })})`);
      const id = ack("killed");
      since = a.mark();
      a.send({ t: "session.input", id: sid, data: "anyone there", submit: true, ackId: id });
      const r = await a.waitFor(inputAckFor(id), { since, what: "the receipt for a send to a killed session", ms: 20_000 });
      assertRefusal(r, "a send to a killed session");
      await a.close(); await b.close();
    },
  },
  {
    name: "refused sends and ops end their sender's wait: ok:false with a sentence, never retryable, and a retry gets the same verdict",
    async run(target) {
      const c = await target.connect();
      const cases = [
        { what: "session.input (raw keys) to a session that does not exist", recv: inputAckFor,
          msg: (id) => ({ t: "session.input", id: "no-such-session", data: "hello\r", ackId: id }) },
        { what: "session.input (submit) to a session that does not exist", recv: inputAckFor,
          msg: (id) => ({ t: "session.input", id: "no-such-session", data: "hello", submit: true, ackId: id }) },
        { what: "an answer (expectPrompt) to a question that is not open", recv: inputAckFor, state: "stale",
          msg: (id, sid) => ({ t: "session.input", id: sid, data: "1", expectPrompt: "p:no-such-question", ackId: id }) },
        { what: "session.create outside every repo", recv: opAckFor,
          msg: (id) => ({ t: "session.create", cwd: "/definitely/not/a/repo", cols: 80, rows: 24, ackId: id }) },
        { what: "backlog.add outside every repo", recv: backlogAckFor,
          msg: (id) => ({ t: "backlog.add", repoDir: "/definitely/not/a/repo", text: "later", ackId: id }) },
        { what: "fanout.followup of a run that does not exist", recv: opAckFor,
          msg: (id) => ({ t: "fanout.followup", runId: "no-such-run", text: "and commit it", ackId: id }) },
      ];
      const sid = await openSession(c, target, "refuse");
      const before = (await listSessions(c)).length;
      for (const k of cases) {
        const id = ack("refuse");
        const since = c.mark();
        c.send(k.msg(id, sid));
        const first = await c.waitFor(k.recv(id), { since, what: `the receipt for ${k.what}`, ms: 20_000 });
        assertRefusal(first, k.what);
        if (k.state) assert.equal(first.state, k.state, `${k.what}: state`);
        c.send(k.msg(id, sid));
        await c.waitFor(() => c.all(k.recv(id), since).length >= 2, { since, what: `the replayed receipt for ${k.what}`, ms: 10_000 });
        const again = c.all(k.recv(id), since)[1];
        assert.equal(verdictOf(again), verdictOf(first), `${k.what}: a retry with the same ackId is answered with the same verdict`);
      }
      await sleep(300);
      assert.equal((await listSessions(c)).length, before, "no refused op spawned a session");
      await c.close();
    },
  },
  {
    name: "notInDemo: every durable op the demo cannot do is refused through its op.ack and terminates the queue",
    async run(target, t) {
      if (target.kind === "real") {
        // Stated, not skipped quietly: the real desktop RUNS the plan's tier B
        // (builds, captures, assessments, fan-outs, …). Its at-most-once for
        // those is e2e-opqueue's subject; the shape every REFUSAL shares is
        // the previous check's, and that one runs here too.
        t.note("real host runs tier B — nothing to refuse; its refusal shape is pinned by the check above");
        return;
      }
      const { HANDLERS } = await import("../../packages/web/src/demo/host/handlers.ts");
      const { DURABLE_OPS, NOT_IN_DEMO } = await import("../../packages/web/src/demo/host/index.ts");
      const tierB = DURABLE_OPS.filter((op) => HANDLERS[op]?.tier === "B");
      assert.ok(tierB.length > 0, "the demo refuses some durable op (else this check is vacuous)");
      const c = await target.connect();
      for (const op of tierB) {
        const id = ack(`nid-${op}`);
        const since = c.mark();
        // Fields every op of this kind might address; the refusal must not
        // depend on them being valid.
        const msg = { t: op, ackId: id, id: "x", runId: "x", buildId: "x", repoDir: target.repoDir, dirs: [target.repoDir], text: "x", cols: 80, rows: 24 };
        c.send(msg);
        const r = await c.waitFor(opAckFor(id), { since, what: `op.ack for ${op}`, ms: 5000 });
        assertRefusal(r, op);
        assert.ok(r.reason === (HANDLERS[op].reason ?? NOT_IN_DEMO), `${op}: says why in the demo's words (${r.reason})`);
        c.send(msg);
        await c.waitFor(() => c.all(opAckFor(id), since).length >= 2, { since, what: `replay for ${op}` });
        assert.equal(verdictOf(c.all(opAckFor(id), since)[1]), verdictOf(r), `${op}: a retry gets the stored verdict`);
      }
      t.note(`${tierB.length} refused durable ops: ${tierB.join(", ")}`);
      await c.close();
    },
  },
  {
    // What the phone's queue holds a lane on (`sessionBudgetHeld`) is the
    // verdict this message comes back with, so both desktops must answer it
    // alike: no receipt (it is not durable), the cap on `session.updated`, an
    // unmeasured spend is `unknown` (which never holds), garbage refused in words.
    name: "session.budget.set comes back on session.updated; an unmeasured spend never holds; garbage is refused in words",
    async run(target) {
      const c = await target.connect();
      const sid = await openSession(c, target, "budget");
      const updated = (pred) => (m) => m.t === "session.updated" && m.session?.id === sid && pred(m.session);
      let since = c.mark();
      c.send({ t: "session.budget.set", id: sid, budget: { unit: "tok", max: 1000 } });
      const set = await c.waitFor(updated((s) => !!s.budget), { since, what: "session.updated with the cap" });
      assert.deepEqual(set.session.budget.cfg, { unit: "tok", max: 1000, interrupt: true }, "the cap as cleaned, interrupt written out");
      assert.equal(set.session.budget.verdict.state, "unknown", `no logged turn: unknown (${JSON.stringify(set.session.budget.verdict)})`);
      assert.equal(set.session.budget.verdict.why, "noSpark");
      since = c.mark();
      c.send({ t: "session.budget.set", id: sid, budget: { unit: "tok", max: -5 } });
      const no = await c.waitFor((m) => m.t === "toast" && /^budget not set/.test(m.text), { since, what: "the refusal of a garbage cap" });
      assert.equal(no.text, "budget not set: it needs a unit and an amount above zero (a percent at most 100)");
      since = c.mark();
      c.send({ t: "session.budget.set", id: sid, budget: null });
      await c.waitFor(updated((s) => !s.budget), { since, what: "session.updated without a cap" });
      await sleep(200);
      assert.equal(c.all((m) => m.t === "op.ack" || m.t === "input.ack", since).length, 0, "no receipt: the message is not durable");
      await c.close();
    },
  },
];
