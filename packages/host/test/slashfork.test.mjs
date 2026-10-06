/**
 * A bare `/fork [title]` sent to a claude session is answered by the HOST and
 * never typed (`routes/session.ts`'s `forkFromInput`).
 *
 * From CLI 2.1.291 the CLI's own `/fork` hands the branch to its background
 * daemon — a session in no tmux this host owns, whose `SessionStart` hook is
 * dropped as unknown — so a fork asked for from the phone was one the phone
 * could never see. What is pinned here is the contract on the wire: the fork
 * goes through `sessions.fork()` (the one path the toolbar's button already
 * uses), the receipt says what happened in words, a retried ackId never forks
 * twice, every refusal is a sentence with nothing typed, and anything that is
 * not exactly this command — or not a claude session — is delivered as before.
 *
 * The route runs over a fake ctx: the ledger is a Map with the real one's two
 * verbs, and `deliverInput` records that it was asked (it is the typing path).
 * The real spawn (`--resume <id> --fork-session`) is `scripts/e2e-slashfork.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { sessionRoutes } = await import("../dist/routes/session.js");
const route = sessionRoutes["session.input"];

function harness(info, opts = {}) {
  const ledger = new Map();
  const sent = [], forks = [], typed = [], attached = [], raw = [];
  let n = 0;
  const c = {
    acks: {
      get: (id) => ledger.get(id) ?? null,
      remember: (id, rec) => ledger.set(id, rec),
      preLossRefusal: () => null,
    },
    netstats: { noteAckReplay: () => {} },
    inputsInFlight: new Map(),
    sessions: {
      get: (id) => (info && id === info.id ? info : null),
      fork: opts.fork ?? ((id, o) => { forks.push({ id, ...o }); return { id: `f${++n}`, title: o.title }; }),
      input: (id, data) => { raw.push([id, data]); return true; },
    },
    deliverInput: (...args) => { typed.push(args); return Promise.resolve({ ok: true, state: "ok" }); },
    recomputeWatched: () => {},
    send: (_ws, m) => sent.push(m),
  };
  const input = (data, ackId = "a1") => route({ c, ws: {}, att: { add: (id) => attached.push(id) },
    msg: opts.raw ? { t: "session.input", id: info?.id ?? "gone", data }
      : { t: "session.input", id: info?.id ?? "gone", data, ackId, submit: true } });
  return { input, sent, forks, typed, attached, ledger, raw };
}

const live = (over = {}) => ({ id: "s1", cwd: "/r", title: "myapp", running: true, remoteControl: true, claudeSessionId: "conv-1", ...over });
const acks = (sent) => sent.filter((m) => m.t === "input.ack");

test("/fork opens a new tab through sessions.fork, focuses it, and the receipt says so", () => {
  const h = harness(live());
  h.input("/fork");
  assert.equal(h.typed.length, 0, "/fork was never typed into the CLI");
  assert.deepEqual(h.forks, [{ id: "s1", title: "myapp (fork)" }]);
  assert.deepEqual(h.attached, ["f1"], "the asking socket streams the new tab");
  assert.deepEqual(h.sent.find((m) => m.t === "session.focus"), { t: "session.focus", id: "f1" });
  const [ack] = acks(h.sent);
  assert.equal(ack.ok, true);
  assert.equal(ack.state, "forked");
  assert.match(ack.reason, /forked into a new session/);
});

test("a title after /fork names the new tab", () => {
  const h = harness(live());
  h.input("/fork try the other schema");
  assert.equal(h.forks[0].title, "try the other schema");
  assert.match(acks(h.sent)[0].reason, /try the other schema/);
});

test("a person's fork of a work item's tab does not wear the machine's mark", () => {
  // `backlog · ` is what the automatic-session cap counts and the reaper may
  // close: a fork the person asked for must not inherit it.
  const h = harness(live({ title: "backlog · myapp · fix the flaky test" }));
  h.input("/fork");
  assert.equal(h.forks[0].title, "myapp · fix the flaky test (fork)");
});

test("a retried ackId is re-acked with the same words and never forks a second time", () => {
  const h = harness(live());
  h.input("/fork", "k1");
  h.input("/fork", "k1");
  assert.equal(h.forks.length, 1, "one ackId, one fork");
  const [first, replay] = acks(h.sent);
  assert.equal(replay.ok, true);
  assert.equal(replay.state, "forked");
  assert.equal(replay.reason, first.reason, "the replayed receipt says what the first one said");
  h.input("/fork", "k2");
  assert.equal(h.forks.length, 2, "a NEW ackId is a new request");
});

test("no known conversation id ⇒ refused in words, nothing typed, nothing spawned", () => {
  const h = harness(live({ claudeSessionId: undefined }));
  h.input("/fork");
  assert.equal(h.forks.length, 0);
  assert.equal(h.typed.length, 0, "never falls back to typing /fork");
  const [ack] = acks(h.sent);
  assert.equal(ack.ok, false);
  assert.equal(ack.retryable, undefined);
  assert.match(ack.reason, /conversation is not known yet/);
  assert.match(ack.reason, /was not typed/);
  assert.equal(h.ledger.get("a1").ok, false, "the refusal is remembered");
});

test("a gone session and a session with remote control off are refused in words", () => {
  const gone = harness(null);
  gone.input("/fork");
  assert.equal(gone.typed.length + gone.forks.length, 0);
  assert.match(acks(gone.sent)[0].reason, /session is gone/);

  const off = harness(live({ remoteControl: false }));
  off.input("/fork");
  assert.equal(off.typed.length + off.forks.length, 0);
  assert.match(acks(off.sent)[0].reason, /remote control is off/);
});

test("a fork the manager cannot make is a sentence, not a silence", () => {
  // `fork()` answers null for a session that stopped between the check and the
  // call, and the spawn can throw (an unknown backend, a missing tmux).
  for (const fork of [() => null, () => { throw new Error("tmux is not installed"); }]) {
    const h = harness(live(), { fork });
    h.input("/fork");
    assert.equal(h.typed.length, 0);
    const [ack] = acks(h.sent);
    assert.equal(ack.ok, false);
    assert.match(ack.reason, /could not fork this session/);
    assert.equal(h.sent.some((m) => m.t === "session.focus"), false, "nothing to focus");
  }
  const thrown = harness(live(), { fork: () => { throw new Error("tmux is not installed"); } });
  thrown.input("/fork");
  assert.match(acks(thrown.sent)[0].reason, /tmux is not installed/, "the cause is carried into the sentence");
});

test("other backends, and anything that is not exactly /fork, are delivered as before", () => {
  const oc = harness(live({ backend: "another-cli", claudeSessionId: undefined, backendSessionId: "b-1" }));
  oc.input("/fork");
  assert.equal(oc.forks.length, 0);
  assert.equal(oc.typed.length, 1, "another backend gets the words typed, unchanged");

  for (const t of ["/forked", "/fork-it", "please /fork this", "fork"]) {
    const h = harness(live());
    h.input(t);
    assert.equal(h.forks.length, 0, t);
    assert.equal(h.typed.length, 1, `${t} is typed`);
  }

  // An explicit `backend: "claude"` is the same as absent.
  const cl = harness(live({ backend: "claude" }));
  cl.input("/fork");
  assert.equal(cl.forks.length, 1);
});

test("a raw (non-submit) write is never intercepted", () => {
  // Without `submit` the client owns the Return and these are bare keystrokes —
  // the host cannot know they will become a whole `/fork` line.
  const h = harness(live(), { raw: true });
  h.input("/fork");
  assert.equal(h.forks.length, 0);
  assert.deepEqual(h.raw, [["s1", "/fork"]], "written as the keystrokes they are");
});
