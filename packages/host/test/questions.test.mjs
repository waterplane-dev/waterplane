/**
 * The `questions` slot (`BackendSources.questions`, contract 2.0) and the typed answer
 * (`SourceTyped`), driven by a FAKE source — no server, no PTY. The slice and the answer
 * dispatcher are the real ones (`sessions/sidechannel.ts`, `sessions/boxes.ts`,
 * `sourceanswer.ts`) over a fake `SessionCore`.
 *
 * Pinned: a question the CLI posed publishes as `kind:"question"` with its own id as `askId`,
 * `nav`, `freeText` and no options when it has none; `closed` retires it; the channel going
 * down retires it; `answerBox(id, NaN, {text})` reaches `answer({text})`; a typed answer the
 * source hands back is typed — words, then Return as a second write — only while the question
 * is still open, and refused in words past `SOURCE_TYPED_MAX` or with a control character,
 * nothing written; a `takesText` dialog row hands the reason to `answer(choice, {text})`; a
 * plain box refuses typed words; a typed answer the CLI never closes says so on the box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

const { ChannelSlice } = await import("../dist/sessions/sidechannel.js");
const turn = await import("../dist/sessions/turn.js");
const boxes = await import("../dist/sessions/boxes.js");
const boxread = await import("../dist/sessions/boxread.js");
const { sourceTypedProblem, applySourceReply, TYPED_AFTER_KEYS_MS } = await import("../dist/sourceanswer.js");
const { SOURCE_TYPED_MAX, promptFingerprint } = await import("@waterplane/shared");

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const CAPS = { turns: true, slash: "none", remoteControl: false, permissionModes: [] };
function harness(sources) {
  const events = []; const typed = [];
  const sessions = new Map();
  const base = {
    sessions,
    emit: (ev, ...args) => { events.push([ev, ...args]); return true; },
    sourceTurn: (s, e) => turn.sourceTurn(core, s, e),
    applyPrompt: (s, p) => boxread.applyPrompt(core, s, p),
    armPromptCheck: () => {},
    input: (id, data) => { typed.push([id, data]); return true; },
  };
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const s = {
    info: { id: "s1", cwd: tmpdir(), running: true, title: "demo" },
    backend: { id: "fake", label: "Fake CLI", plugin: "fakeplug", caps: CAPS, facts: { turns: [{ source: true }], dialogs: [{ source: true }], questions: [{ source: true }] }, sources },
    scrollback: "", seq: 0, spawnedAt: Date.now(),
    stopPending: false, stopVerifyTimer: null, turnActive: false, turnFromScreen: false,
    hooksActive: false, turnHookSeen: false, stopCount: 0, idleNotified: false, askDismissed: null,
    agentTimer: null, submits: [],
  };
  sessions.set("s1", s);
  return { core, s, events, typed, slice: new ChannelSlice(core) };
}

function fakeSources({ pendingQ, withDialogs = true } = {}) {
  const st = { qOn: null, dialogOn: null, onHealth: null, answered: [], dialogAnswered: [] };
  const sources = {
    ...(withDialogs ? { dialogs: { watch: (ss, on) => { st.dialogOn = on; return () => { st.dialogOn = null; }; }, pending: async () => [] } } : {}),
    questions: {
      watch: (ss, on) => { st.qOn = on; return () => { st.qOn = null; }; },
      ...(pendingQ ? { pending: async () => pendingQ } : {}),
    },
    attach: async (ss, onHealth) => { st.onHealth = onHealth; return { close: async () => {}, health: () => ({ state: "up", since: 1 }) }; },
  };
  const question = (id, over = {}) => ({
    id, question: `which colour? (${id})`, freeText: true,
    answer: async (a) => { st.answered.push([id, a]); return { ok: true }; },
    ...over,
  });
  const dialog = (id, over = {}) => ({
    id, kind: "tool", question: `bash: ${id}`,
    options: [{ index: 1, label: "Yes" }, { index: 2, label: "Yes, always" }, { index: 3, label: "No, and tell the agent why", takesText: true }],
    answer: async (n, extra) => { st.dialogAnswered.push(extra === undefined ? [id, n] : [id, n, extra]); return { ok: true }; },
    ...over,
  });
  return { st, sources, question, dialog };
}

test("a free-text question publishes as kind question, its id as askId, freeText, no options", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.qOn.asked(f.question("q_1"));
  assert.deepEqual(h.s.info.prompt, { kind: "question", question: "which colour? (q_1)", options: [], nav: true, askId: "q_1", freeText: true });
  assert.equal(boxread.screenReaderOff(h.s), true, "the channel's own box: the screen has nothing to add");
  assert.equal(h.events.filter((e) => e[0] === "prompt").length, 1);
  f.st.qOn.closed("q_1");
  assert.equal(h.s.info.prompt, null, "closed retires it");
});

test("questions and dialogs publish oldest first, across both", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.qOn.asked(f.question("q_1", { options: [{ index: 1, label: "red" }, { index: 2, label: "blue" }], freeText: false }));
  f.st.dialogOn.asked(f.dialog("per_1"));
  assert.equal(h.s.info.prompt.askId, "q_1");
  assert.deepEqual(h.s.info.prompt.options.map((o) => o.label), ["red", "blue"]);
  assert.equal(h.s.info.prompt.freeText, undefined, "absent when false — the fingerprint term only when set");
  f.st.qOn.closed("q_1");
  assert.equal(h.s.info.prompt.askId, "per_1");
  assert.equal(h.s.info.prompt.options[2].takesText, true, "the typed-reason row says so on the wire");
});

test("a question that states nothing to answer with is not published", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.qOn.asked(f.question("q_0", { freeText: false }));
  assert.equal(h.s.info.prompt ?? null, null, "no options and no typed answer: nobody could answer it from a phone");
  f.st.qOn.asked(f.question("q_x", { question: undefined }));
  assert.equal(h.s.info.prompt ?? null, null);
});

test("pending() reconciles questions on the up edge", async () => {
  const f = fakeSources({ pendingQ: [] });
  f.sources.questions.pending = async () => [f.question("q_9")];
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  assert.equal(h.s.info.prompt.askId, "q_9");
});

test("channel down retires the question box", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.qOn.asked(f.question("q_1"));
  assert.equal(h.s.info.prompt.askId, "q_1");
  f.st.onHealth({ state: "down", since: 2, note: "gone" });
  assert.equal(h.s.info.prompt, null);
  assert.equal(h.s.channel.questions.size, 0);
});

test("answerBox with text reaches answer({text}); a choice reaches answer({choice})", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.qOn.asked(f.question("q_1", { options: [{ index: 1, label: "red" }, { index: 2, label: "blue" }] }));
  assert.deepEqual(await boxes.answerBox(h.core, "s1", NaN, { text: "green", byPerson: true }), { ok: true });
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 2, {}), { ok: true });
  assert.deepEqual(f.st.answered, [["q_1", { text: "green" }], ["q_1", { choice: 2 }]]);
  assert.deepEqual(h.typed, [], "answered on the CLI's own channel: nothing typed");
  const r = await boxes.answerBox(h.core, "s1", 7, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /7 is not one of the question's options/);
  const none = await boxes.answerBox(h.core, "s1", NaN, {});
  assert.match(none.reason, /needs an option or typed words/);
});

test("a question with no free text refuses typed words, in words", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.qOn.asked(f.question("q_1", { freeText: false, options: [{ index: 1, label: "red" }] }));
  const r = await boxes.answerBox(h.core, "s1", NaN, { text: "green" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /takes one of its options, not typed words/);
  assert.deepEqual(f.st.answered, []);
});

test("a typed answer the source hands back is typed: words, then Return, as two writes", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.qOn.asked(f.question("q_1", { answer: async (a) => ({ typed: a.text, then: "\r" }) }));
  assert.deepEqual(await boxes.answerBox(h.core, "s1", NaN, { text: "blue", byPerson: true }), { ok: true });
  assert.deepEqual(h.typed, [["s1", "blue"], ["s1", "\r"]]);
});

test("a typed answer over SOURCE_TYPED_MAX, or with a control character, is refused — nothing written", async () => {
  assert.equal(SOURCE_TYPED_MAX, 1000);
  assert.equal(sourceTypedProblem({ typed: "blue", then: "\r" }), null);
  assert.equal(sourceTypedProblem({ typed: "x".repeat(1000) }), null);
  assert.match(sourceTypedProblem({ typed: "x".repeat(1001), then: "\r" }), /1001 characters, and an answer is typed with at most 1000/);
  assert.match(sourceTypedProblem({ typed: "a\rb" }), /control character \(0x0d\)/);
  assert.match(sourceTypedProblem({ typed: "\x1b[200~paste" }), /control character \(0x1b\)/);
  assert.match(sourceTypedProblem({ typed: "ok", then: "\n" }), /only Return/);
  assert.match(sourceTypedProblem({ typed: "" }), /nothing to type/);

  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.qOn.asked(f.question("q_1", { answer: async () => ({ typed: "x".repeat(1001), then: "\r" }) }));
  const r = await boxes.answerBox(h.core, "s1", NaN, { text: "blue", byPerson: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /will not type/);
  assert.deepEqual(h.typed, []);
});

test("a typed answer is not typed into a question that closed while the source was answering", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.qOn.asked(f.question("q_1", { answer: async () => { f.st.qOn.closed("q_1"); return { typed: "blue", then: "\r" }; } }));
  const r = await boxes.answerBox(h.core, "s1", NaN, { text: "blue" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer open/);
  assert.deepEqual(h.typed, []);
});

test("a typed answer the CLI never closes is said on the box; one it closes is not", async () => {
  let open = true; const notes = [];
  const deps = (o) => ({ input: () => true, stillOpen: () => open, onUnclosed: (n) => notes.push(n), closeWaitMs: 30, pauseMs: 0, label: "Fake CLI", ...o });
  assert.deepEqual(await applySourceReply({ typed: "blue", then: "\r" }, deps()), { ok: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /typed into Fake CLI's own question, but it has not closed/);
  open = true; notes.length = 0;
  assert.deepEqual(await applySourceReply({ typed: "blue", then: "\r" }, deps()), { ok: true });
  open = false;
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(notes, []);
});

test("a dialog's typed-reason row hands the reason over; a row without takesText refuses one", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.dialogOn.asked(f.dialog("per_1"));
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 3, { walk: true, byPerson: true, text: "use the other file" }), { ok: true });
  const r = await boxes.answerBox(h.core, "s1", 1, { walk: true, text: "why not" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /takes no typed reason/);
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 1, { walk: true }), { ok: true });
  assert.deepEqual(f.st.dialogAnswered, [["per_1", 3, { text: "use the other file" }], ["per_1", 1]], "no extra argument when nobody typed");
});

test("a box the screen read takes no typed words", async () => {
  const h = harness(undefined);
  delete h.s.backend.sources;
  h.s.info.prompt = { kind: "select", question: "pick", options: [{ index: 1, label: "a" }] };
  const r = await boxes.answerBox(h.core, "s1", 1, { text: "hello" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /takes no typed answer/);
  assert.deepEqual(h.typed, []);
});

test("the fingerprint differs between freeText true and false", () => {
  const p = { kind: "question", question: "which colour?", options: [], nav: true };
  assert.notEqual(promptFingerprint(p), promptFingerprint({ ...p, freeText: true }));
});

test("a takesText dialog row answered keys-then-words types keys, pauses, words, Return as three writes", async () => {
  const w = [];
  const r = await applySourceReply({ keys: "3", typed: "do nothing", then: "\r" }, { input: (d) => (w.push(d), true), stillOpen: () => true, pauseMs: 1, closeWaitMs: 5 });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(w, ["3", "do nothing", "\r"]);
});

test("keys-then-words pauses TYPED_AFTER_KEYS_MS after the keys, and types no words into a dialog that closed", async () => {
  assert.equal(TYPED_AFTER_KEYS_MS, 500);
  const w = []; let open = true;
  const r = await applySourceReply({ keys: "3", typed: "do nothing", then: "\r" }, {
    input: (d) => { w.push(d); if (d === "3") open = false; return true; }, stillOpen: () => open, pauseMs: 1, keysPauseMs: 1, closeWaitMs: 5,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /keys were typed, the words were not/);
  assert.deepEqual(w, ["3"]);
});

test("keys-then-words is bounded like each half: bad keys or bad words are refused, nothing written", async () => {
  const w = [];
  const deps = { input: (d) => (w.push(d), true), stillOpen: () => true, pauseMs: 1, keysPauseMs: 1, closeWaitMs: 5 };
  const a = await applySourceReply({ keys: "123456789", typed: "x", then: "\r" }, deps);
  assert.equal(a.ok, false); assert.match(a.reason, /at most 8/);
  const b = await applySourceReply({ keys: "3", typed: "x".repeat(1001), then: "\r" }, deps);
  assert.equal(b.ok, false); assert.match(b.reason, /at most 1000/);
  const c = await applySourceReply({ keys: "3", typed: "a\rb" }, deps);
  assert.equal(c.ok, false); assert.match(c.reason, /control character/);
  assert.deepEqual(w, []);
});

test("answerBox: keys-then-words types only the person's own words on a takesText row", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.dialogOn.asked(f.dialog("per_1", { answer: async (n, extra) => ({ keys: String(n), typed: extra?.text ?? "made up", then: "\r" }) }));
  // The person typed a reason on the takesText row: keys, words, Return — three writes.
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 3, { walk: true, byPerson: true, text: "do nothing" }), { ok: true });
  assert.deepEqual(h.typed, [["s1", "3"], ["s1", "do nothing"], ["s1", "\r"]]);
});

test("answerBox: keys-then-words with no person-typed text, on a row without takesText, or with other words is refused, nothing written", async () => {
  const f = fakeSources();
  const h = harness(f.sources);
  h.slice.attach(h.s);
  await flush();
  f.st.dialogOn.asked(f.dialog("per_1", { answer: async (n, extra) => ({ keys: String(n), typed: extra?.text ?? "made up", then: "\r" }) }));
  const r1 = await boxes.answerBox(h.core, "s1", 3, { walk: true, byPerson: true });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /asked to type words into a dialog/);
  const r2 = await boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true, text: "do nothing" });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /takes no typed reason/);
  f.st.dialogOn.resolved("per_1");
  f.st.dialogOn.asked(f.dialog("per_2", { answer: async (n) => ({ keys: String(n), typed: "something else", then: "\r" }) }));
  const r3 = await boxes.answerBox(h.core, "s1", 3, { walk: true, byPerson: true, text: "do nothing" });
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /not the words you typed/);
  assert.deepEqual(h.typed, []);
});

// ── a retried answer ackId joins the running answer (routes/session.ts's `answerReply`) ──
// A typed answer takes seconds (keys, a pause, words, Return; a plugin's round trip), and the
// phone re-sends a pending entry with the SAME ackId the moment its socket comes back. The second
// frame must join the answer in flight — one dispatch, one write — and get the same receipt.
test("a duplicate ackId while an answer is still running joins it: answered once, acked twice", async () => {
  const { sessionRoutes } = await import("../dist/routes/session.js");
  const route = sessionRoutes["session.input"];
  const p = { kind: "question", question: "why?", options: [], nav: true, askId: "q1", freeText: true };
  const ledger = new Map(); const sent = []; const calls = [];
  let release;
  const c = {
    acks: { get: (id) => ledger.get(id) ?? null, remember: (id, rec) => ledger.set(id, rec), preLossRefusal: () => null },
    netstats: { noteAckReplay: () => {} },
    inputsInFlight: new Map(),
    sessions: {
      get: () => ({ id: "s1", running: true, prompt: p }),
      answerBox: (...args) => { calls.push(args); return new Promise((r) => { release = r; }); },
      input: () => { throw new Error("an answer is never a raw write"); },
    },
    send: (_ws, m) => sent.push(m),
  };
  const frame = () => route({ c, ws: {}, att: new Set(), msg: { t: "session.input", id: "s1", data: "", ackId: "ans1", expectPrompt: promptFingerprint(p), promptText: "do nothing" } });
  frame();
  await flush();
  frame(); // the socket blipped mid-answer: the phone re-sends the same entry
  await flush();
  assert.equal(calls.length, 1, "the second frame joined the first — the words are typed once");
  assert.ok(c.inputsInFlight.has("ans1"), "in flight until it settles");
  release({ ok: true });
  await flush();
  const acks = sent.filter((m) => m.t === "input.ack");
  assert.equal(acks.length, 2, "both frames get a receipt");
  assert.ok(acks.every((a) => a.ok === true && a.ackId === "ans1"));
  assert.deepEqual(ledger.get("ans1"), { ok: true, reason: undefined }, "remembered once settled");
  assert.equal(c.inputsInFlight.has("ans1"), false, "and no longer in flight");
  frame(); // a third, after it settled: the ledger re-acks
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(sent.filter((m) => m.t === "input.ack").length, 3);
});
