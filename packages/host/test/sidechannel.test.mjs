/**
 * The side channel (`sessions/sidechannel.ts`) and the one answer dispatcher
 * (`sessions/boxes.ts`'s `answerBox`), driven by a FAKE `BackendSources` object
 * — no server, no PTY. The turn and box functions are the real ones (`turn.ts`,
 * `boxes.ts`) over a fake `SessionCore` whose unrelated members are no-ops.
 *
 * Pinned: a turn ends ONCE however often the source says so; a dialog publishes
 * with the CLI's id as `askId` and `nav`, and resolves; the channel going down
 * hands the box and the turn boundaries back to the screen and re-arms the
 * screen reader; `answerBox` prefers the CLI's own channel and refuses in words
 * — typing nothing — when the dialog is gone; a backend without `sources` is
 * answered exactly as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

const { ChannelSlice, dialogToPrompt } = await import("../dist/sessions/sidechannel.js");
const turn = await import("../dist/sessions/turn.js");
const boxes = await import("../dist/sessions/boxes.js");
const boxread = await import("../dist/sessions/boxread.js");

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const CAPS = { turns: true, slash: "none", remoteControl: false, permissionModes: [] };
function harness({ sources, promptBoxes = "fakeplug-highlight", plugin = "fakeplug" } = {}) {
  const events = []; const typed = []; const armed = [];
  const sessions = new Map();
  const base = {
    sessions,
    emit: (ev, ...args) => { events.push([ev, ...args]); return true; },
    sourceTurn: (s, e) => turn.sourceTurn(core, s, e),
    applyPrompt: (s, p) => boxread.applyPrompt(core, s, p),
    armPromptCheck: (s, ms) => { armed.push(ms); },
    input: (id, data) => { typed.push([id, data]); return true; },
  };
  // Every other hub member is a no-op returning undefined: those paths
  // (limits, context, agents, capture) are not what is under test here.
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const s = {
    info: { id: "s1", cwd: tmpdir(), running: true, title: "demo" },
    backend: { id: "fake", ...(plugin ? { plugin } : {}), caps: CAPS, facts: { turns: [{ source: true }], dialogs: [{ source: true }, ...(promptBoxes ? [{ screen: promptBoxes }] : [])] }, ...(sources ? { sources } : {}) },
    scrollback: "", seq: 0, spawnedAt: Date.now(),
    stopPending: false, stopVerifyTimer: null, turnActive: false, turnFromScreen: false,
    hooksActive: false, turnHookSeen: false, stopCount: 0, idleNotified: false, askDismissed: null,
    agentTimer: null, submits: [],
  };
  sessions.set("s1", s);
  return { core, s, events, typed, armed, slice: new ChannelSlice(core) };
}

function fakeSources({ pending = [], health = { state: "up", since: 1 } } = {}) {
  const st = { turnOn: null, dialogOn: null, onHealth: null, pending, closed: 0, answered: [], ss: null };
  const sources = {
    turns: { watch: (ss, on) => { st.turnOn = on; return () => { st.turnOn = null; }; } },
    dialogs: {
      watch: (ss, on) => { st.dialogOn = on; return () => { st.dialogOn = null; }; },
      pending: async () => st.pending,
    },
    attach: async (ss, onHealth) => {
      st.ss = ss; st.onHealth = onHealth;
      return { close: async () => { st.closed++; }, health: () => health };
    },
  };
  const dialog = (id, over = {}) => ({
    id, kind: "tool", question: `bash: ${id}`,
    options: [{ index: 1, label: "Allow once" }, { index: 2, label: "Allow always" }, { index: 3, label: "Reject" }],
    answer: async (n) => { st.answered.push([id, n]); return { ok: true }; },
    ...over,
  });
  return { st, sources, dialog };
}

test("attach: the channel comes up, says so, and owns the turn boundaries", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  assert.equal(h.s.info.sideChannel.state, "down", "not up until the channel says so");
  await flush();
  assert.equal(h.s.info.sideChannel.state, "up");
  assert.equal(h.s.info.hooked, true, "hooked = exact boundaries live");
  assert.equal(h.s.hooksActive, true);
  assert.equal(f.st.ss.id, "s1");
  assert.equal(h.s.channel.dialogsLive, true, "pending() answered with a list ⇒ the channel owns the dialogs");
});

test("a turn ends once, however often the source says so", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  f.st.turnOn.started(Date.now());
  assert.equal(h.s.info.turnActive, true);
  f.st.turnOn.ended(Date.now());
  f.st.turnOn.ended(Date.now());
  assert.equal(h.s.info.turnActive, false);
  assert.equal(h.s.stopCount, 1);
  assert.equal(h.events.filter((e) => e[0] === "turnEnded").length, 1);
  assert.equal(h.events.filter((e) => e[0] === "idle").length, 1, "one turn-finished ping");
  // `ready` with no turn believed ends nothing and counts nothing.
  f.st.turnOn.ready();
  f.st.turnOn.ended(Date.now());
  assert.equal(h.s.stopCount, 1);
});

test("a dialog publishes with the CLI's id and nav, oldest first, and resolves", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  f.st.dialogOn.asked(f.dialog("per_1"));
  f.st.dialogOn.asked(f.dialog("per_2"));
  const p = h.s.info.prompt;
  assert.equal(p.askId, "per_1", "the oldest open dialog is the one the TUI shows");
  assert.equal(p.nav, true);
  assert.equal(p.kind, "tool");
  assert.deepEqual(p.options.map((o) => o.label), ["Allow once", "Allow always", "Reject"], "options verbatim");
  assert.equal(h.events.filter((e) => e[0] === "prompt").length, 1);
  f.st.dialogOn.resolved("per_1");
  assert.equal(h.s.info.prompt.askId, "per_2");
  f.st.dialogOn.resolved("per_2");
  assert.equal(h.s.info.prompt, null);
  // A dialog that states no option is not a box anybody could answer.
  f.st.dialogOn.asked(f.dialog("per_3", { options: [] }));
  assert.equal(h.s.info.prompt, null);
  assert.equal(dialogToPrompt(f.dialog("x", { question: undefined })), null);
});

test("the up edge reconciles against pending(); null leaves the screen reader on", async () => {
  const f = fakeSources();
  f.st.pending = [f.dialog("per_9")];
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  assert.equal(h.s.info.prompt.askId, "per_9");
  assert.equal(boxread.screenReaderOff(h.s), true);

  const g = fakeSources({ pending: null });
  const k = harness({ sources: g.sources });
  k.slice.attach(k.s);
  await flush();
  assert.equal(k.s.channel.dialogsLive, false, "cannot say ⇒ the channel does not claim the dialogs");
  assert.equal(boxread.screenReaderOff(k.s), false);
});

test("channel down ⇒ hooked off, the box retired, the screen reader re-armed", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  f.st.dialogOn.asked(f.dialog("per_1"));
  assert.equal(boxread.screenReaderOff(h.s), true);
  f.st.onHealth({ state: "down", since: 2, note: "the backend's server exited" });
  assert.deepEqual(h.s.info.sideChannel, { state: "down", since: 2, note: "the backend's server exited" });
  assert.equal(h.s.info.hooked, false);
  assert.equal(h.s.hooksActive, false, "silence heuristics again");
  assert.equal(h.s.info.prompt, null, "the channel's box goes with the channel");
  assert.equal(boxread.screenReaderOff(h.s), false);
  assert.deepEqual(h.armed, [0], "a prompt check armed NOW, not at the next output");
  // …and back up: the turns and the dialogs are the channel's again.
  f.st.pending = [f.dialog("per_4")];
  f.st.onHealth({ state: "up", since: 3 });
  await flush();
  assert.equal(h.s.info.hooked, true);
  assert.equal(h.s.info.prompt.askId, "per_4");
});

test("answerBox prefers the CLI's own channel, and refuses in words when the dialog is gone", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  f.st.dialogOn.asked(f.dialog("per_1"));
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 2), { ok: true });
  assert.deepEqual(f.st.answered, [["per_1", 2]]);
  assert.deepEqual(h.typed, [], "nothing typed into the PTY");

  const r0 = await boxes.answerBox(h.core, "s1", 7);
  assert.equal(r0.ok, false);
  assert.match(r0.reason, /7 is not one of the box's options/);

  f.st.dialogOn.resolved("per_1");
  const r1 = await boxes.answerBox(h.core, "s1", 1);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /no longer open — it was answered or withdrawn/);
  const r2 = await boxes.answerBox(h.core, "s1", 1, { walk: true });
  assert.match(r2.reason, /no longer open/, "a promptChoice is refused the same way");
  assert.deepEqual(h.typed, [], "still nothing typed");
  assert.deepEqual(f.st.answered, [["per_1", 2]]);

  // The channel's own refusal travels as its sentence.
  f.st.dialogOn.asked(f.dialog("per_5", { answer: async () => ({ ok: false, reason: "that permission expired" }) }));
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 1), { ok: false, reason: "that permission expired" });
  f.st.dialogOn.asked(f.dialog("per_6", { answer: async () => { throw new Error("ECONNREFUSED"); } }));
  f.st.dialogOn.resolved("per_5");
  const r3 = await boxes.answerBox(h.core, "s1", 1);
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /ECONNREFUSED/);
});

test("a source answering { keys } gets exactly those keys typed once, into that session", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  const other = { ...h.s, info: { ...h.s.info, id: "s2" } };
  h.core.sessions.set("s2", other);
  h.slice.attach(h.s);
  await flush();
  let calls = 0;
  f.st.dialogOn.asked(f.dialog("tui_1", { answer: async (n) => { calls++; return { keys: String(n) }; } }));
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 1), { ok: true });
  assert.equal(calls, 1);
  assert.deepEqual(h.typed, [["s1", "1"]], "the digit alone, no Return, into s1 only");

  // The control keys a walk already presses are allowed, counted as ONE key each.
  f.st.dialogOn.resolved("tui_1");
  f.st.dialogOn.asked(f.dialog("tui_2", { answer: async () => ({ keys: "\x1b[B\x1b[B\r" }) }));
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 2), { ok: true });
  assert.deepEqual(h.typed.at(-1), ["s1", "\x1b[B\x1b[B\r"]);
  assert.equal(h.typed.length, 2);
  assert.equal(boxes.sourceKeysProblem("12345678"), null, "eight printable keys");
  assert.equal(boxes.sourceKeysProblem("\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A\r"), null, "eight keys, an arrow counted as one");
});

test("oversize or odd keys are refused in words, nothing typed", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  const bad = [
    ["123456789", /9 keystrokes, and a box is answered with at most 8/],
    ["git push --force\r", /17 keystrokes/],
    ["1\x03", /control character \(0x03\)/],
    ["\x1b[200~1\x1b[201~", /keystrokes|control/],
    ["\n", /control character \(0x0a\)/],
    ["\x7f", /control character \(0x7f\)/],
    ["", /no keystrokes/],
    [7, /no keystrokes/],
  ];
  let i = 0;
  for (const [keys, re] of bad) {
    const id = `odd_${i++}`;
    f.st.dialogOn.asked(f.dialog(id, { answer: async () => ({ keys }) }));
    const r = await boxes.answerBox(h.core, "s1", 1);
    assert.equal(r.ok, false, JSON.stringify(keys));
    assert.match(r.reason, /keystrokes this host will not type/);
    assert.match(r.reason, re, JSON.stringify(keys));
    f.st.dialogOn.resolved(id);
  }
  assert.deepEqual(h.typed, [], "not one byte typed");
});

test("keys go only to a dialog the source posed and still has open", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  // The source withdraws its dialog while answering, then hands back keys: nothing typed.
  f.st.dialogOn.asked(f.dialog("tui_9", { answer: async () => { f.st.dialogOn.resolved("tui_9"); return { keys: "1" }; } }));
  const r = await boxes.answerBox(h.core, "s1", 1);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer open/);
  assert.deepEqual(h.typed, []);

  // A screen box (no channel) is answered the old way: no source is asked, so no keys exist.
  const k = harness({ promptBoxes: "claude-numbered" });
  k.s.info.prompt = { kind: "select", question: "Which?", askId: "tui_1", options: [{ index: 1, label: "A" }] };
  assert.deepEqual(await boxes.answerBox(k.core, "s1", 1), { ok: true });
  assert.deepEqual(k.typed, [["s1", "1\r"]], "the tap's digit+Return, never a source's keys");
});

test("no sources ⇒ today's session: no channel, the digit a tap always sent", async () => {
  const h = harness({ promptBoxes: "claude-numbered" });
  h.s.info.sideChannel = { state: "up", since: 1 }; // stale, off a live/ record
  h.slice.attach(h.s);
  assert.equal(h.s.channel, undefined);
  assert.equal(h.s.info.sideChannel, undefined);
  h.s.info.prompt = { kind: "select", question: "Which?", options: [{ index: 1, label: "A" }, { index: 2, label: "B" }] };
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 2), { ok: true });
  assert.deepEqual(h.typed, [["s1", "2\r"]]);
  h.s.info.running = false;
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 2), { ok: false, reason: "session not available" });
});

test("detach closes the channel and a late event changes nothing", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  const { turnOn, dialogOn, onHealth } = f.st;
  h.slice.detach(h.s);
  await flush();
  assert.equal(f.st.closed, 1);
  assert.equal(f.st.turnOn, null, "watches unsubscribed");
  turnOn.started(Date.now());
  dialogOn.asked(f.dialog("late"));
  onHealth({ state: "down", since: 9 });
  assert.equal(h.s.info.turnActive, undefined);
  assert.equal(h.s.info.prompt, undefined);
  h.slice.detach(h.s); // idempotent
  assert.equal(f.st.closed, 1);
});

test("an attach that fails is a channel down with the reason in words", async () => {
  const h = harness({ sources: { attach: async () => { throw new Error("no such binary"); } } });
  h.slice.attach(h.s);
  await flush();
  assert.equal(h.s.info.sideChannel.state, "down");
  assert.match(h.s.info.sideChannel.note, /did not start: no such binary/);
  assert.equal(h.s.info.hooked, undefined);
});

/** A `requiresChannel` backend, as a hybrid backend declares itself. */
const holding = (h) => { h.s.backend.delivery = { requiresChannel: true }; h.s.backend.label = "othercli"; return h; };

test("the hold tells the truth: connecting waits, an outage promises the server back, a channel that never started promises nothing", async () => {
  const f = fakeSources();
  const h = holding(harness({ sources: f.sources }));
  h.slice.attach(h.s);
  assert.equal(h.slice.sendHold(h.s).connecting, true, "seconds old ⇒ worth a short wait");
  await flush();
  assert.equal(h.slice.sendHold(h.s), null, "up ⇒ no hold");
  f.st.onHealth({ state: "down", since: 5, note: "othercli's server for this session exited" });
  const out = h.slice.sendHold(h.s);
  assert.equal(out.connecting, false);
  assert.match(out.sentence, /not answering \(othercli's server for this session exited\).*nothing was typed\. It is sent once the server is back\./);

  const never = holding(harness({ sources: { attach: async () => { throw new Error("port taken"); } } }));
  never.slice.attach(never.s);
  await flush();
  const n = never.slice.sendHold(never.s);
  assert.equal(n.connecting, false);
  assert.match(n.sentence, /did not start .*port taken.*nothing was typed\.$/);
  assert.doesNotMatch(n.sentence, /sent once the server is back/, "no server is coming back for a channel that never was");
});

test("a session the source says has NO channel is screen-only: said in words, nothing watched, sends never held", async () => {
  let watched = 0;
  const sources = {
    turns: { watch: () => { watched++; return () => {}; } },
    dialogs: { watch: () => { watched++; return () => {}; }, pending: async () => [] },
    attach: async () => ({ screenOnly: "screen-only (started before the side channel): read off the screen", close: async () => {}, health: () => ({ state: "down", since: 1 }) }),
  };
  const h = holding(harness({ sources }));
  h.slice.attach(h.s);
  await flush();
  assert.deepEqual([h.s.info.sideChannel.state, h.s.info.sideChannel.note], ["down", "screen-only (started before the side channel): read off the screen"]);
  assert.equal(h.slice.sendHold(h.s), null, "a pane started before the channel stays sendable — today's screen-only path");
  assert.equal(watched, 0);
  assert.equal(boxread.screenReaderOff(h.s), false, "the screen reader keeps every box");
  assert.equal(h.s.info.hooked, undefined, "turn ends stay silence's");
  assert.ok(h.events.some((e) => e[0] === "updated"), "the header line is published");
});

test("a tmux DETACH while the channel is still connecting SUSPENDS the handle (the pane's server survives); an ending closes", async () => {
  let release;
  const calls = [];
  const sources = {
    attach: () => new Promise((r) => { release = () => r({ close: async () => { calls.push("close"); }, suspend: async () => { calls.push("suspend"); }, health: () => ({ state: "up", since: 1 }) }); }),
  };
  const h = harness({ sources });
  h.slice.attach(h.s);
  h.s.detaching = true;
  h.slice.detach(h.s);
  release();
  await flush();
  assert.deepEqual(calls, ["suspend"], "never close(): that kills the server the detached pane still dials");

  const k = harness({ sources });
  k.slice.attach(k.s);
  k.s.detaching = false;
  k.slice.detach(k.s);
  release();
  await flush();
  assert.deepEqual(calls, ["suspend", "close"], "the session ending closes");
});

test("a dialog the channel can SEE but not pose keeps the screen reader on duty, and its box answerable by the screen", async () => {
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  assert.equal(boxread.screenReaderOff(h.s), true, "reconciled: the channel owns the dialogs");
  f.st.dialogOn.unposed(1);
  assert.equal(boxread.screenReaderOff(h.s), false, "a question tool dialog reaches the phone through the screen");
  assert.deepEqual(h.armed, [0], "…which looks now");
  // The screen reads it (no askId); a channel resolve elsewhere does not retire it.
  boxread.applyPrompt(h.core, h.s, { kind: "select", question: "Which color?", options: [{ index: 1, label: "Red" }, { index: 2, label: "Blue" }], nav: true });
  f.st.dialogOn.asked(f.dialog("per_1"));
  assert.equal(h.s.info.prompt.askId, "per_1", "a permission the channel CAN pose still wins");
  f.st.dialogOn.resolved("per_1");
  assert.equal(h.s.info.prompt, null);
  assert.deepEqual(h.armed, [0, 0], "…and the screen is asked again for the question still open");
  boxread.applyPrompt(h.core, h.s, { kind: "select", question: "Which color?", options: [{ index: 1, label: "Red" }, { index: 2, label: "Blue" }], nav: true });
  f.st.dialogOn.resolved("nothing-open");
  assert.equal(h.s.info.prompt?.question, "Which color?", "the screen's box is the screen's to retire while one is unposed");
  f.st.dialogOn.unposed(0);
  assert.equal(h.s.info.prompt, null, "none open ⇒ the reader stands down and its box goes");
  assert.equal(boxread.screenReaderOff(h.s), true);
});

test("with no screen reader, a dialog the channel sees but cannot pose marks the session waiting on you", async () => {
  const f = fakeSources();
  const awaiting = [];
  const h = harness({ sources: f.sources, promptBoxes: false });
  h.core.setAwaiting = (s, on) => { awaiting.push(on); };
  h.slice.attach(h.s);
  await flush();
  f.st.dialogOn.unposed(1);
  f.st.dialogOn.unposed(1);
  f.st.dialogOn.unposed(0);
  assert.deepEqual(awaiting, [true, false], "on while one is open, off once answered; a repeat count changes nothing");
  assert.deepEqual(h.armed, [], "no screen reader to arm");
});

test("sweep: every backend with sources.sweep is asked, with alive = a held session (or a live pane)", async () => {
  const { registerBackend, unregisterBackend } = await import("../dist/backends/index.js");
  const { pluginDescriptor } = await import("../dist/plugins/pluginapi.js");
  const asked = [];
  registerBackend(pluginDescriptor({
    id: "sweepy", label: "S", bin: () => "/bin/true", prepare: async () => ({ args: [], instructionsVia: "none", askRulesVia: "none" }), models: async () => ({ aliases: [], ids: [] }),
    caps: {}, facts: {}, measured: { versions: [], version: async () => null },
    sources: { attach: async () => ({ close: async () => {}, health: () => ({ state: "up", since: 1 }) }), sweep: (alive) => asked.push([alive("s1"), alive("gone")]) },
  }, "P"));
  try {
    const h = harness();
    h.slice.sweep();
    assert.deepEqual(asked, [[true, false]]);
  } finally { unregisterBackend("sweepy"); }
});

// ── standing rules: only a PERSON's tap on a `remember` option makes one (answergate.ts) ──
test("a person's tap on a `remember` option makes the host's rule; a gated answer, another option or a failed answer does not", async () => {
  const gate = await import("../dist/answergate.js");
  gate.forgetRules({});
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  const remembering = (id, over = {}) => f.dialog(id, {
    options: [{ index: 1, label: "Yes" }, { index: 2, label: "Yes, and don't ask again", remember: { key: "touch a.txt", label: "touch a.txt" } }, { index: 3, label: "No" }],
    ...over,
  });
  f.st.dialogOn.asked(remembering("per_r1"));
  assert.equal(h.s.info.prompt.options[1].remember, undefined, "`remember` never reaches the wire…");
  assert.deepEqual(h.s.info.prompt.options[1].remembers, { label: "touch a.txt" }, "…but the rule a tap makes does, in the host's label");
  assert.equal(h.s.info.prompt.options[0].remembers, undefined, "only on the option that makes one");
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 2), { ok: true }, "the gate's own path (no byPerson)…");
  assert.deepEqual(gate.rulesFor("s1", "fakeplug"), [], "…keeps no rule");
  f.st.dialogOn.resolved("per_r1");

  f.st.dialogOn.asked(remembering("per_r2"));
  await boxes.answerBox(h.core, "s1", 1, { byPerson: true });
  assert.deepEqual(gate.rulesFor("s1", "fakeplug"), [], "a person's tap on another option keeps none");
  f.st.dialogOn.resolved("per_r2");

  f.st.dialogOn.asked(remembering("per_r3", { answer: async () => ({ ok: false, reason: "expired" }) }));
  await boxes.answerBox(h.core, "s1", 2, { byPerson: true });
  assert.deepEqual(gate.rulesFor("s1", "fakeplug"), [], "an answer the CLI did not take keeps none");
  f.st.dialogOn.resolved("per_r3");

  // A source whose options change once answered (Copilot's do): the option as TAPPED counts.
  let answered = false;
  const opts = [{ index: 1, label: "Yes" }, { index: 2, label: "Yes, and don't ask again", remember: { key: "touch a.txt", label: "touch a.txt" } }, { index: 3, label: "No" }];
  f.st.dialogOn.asked({
    id: "per_r4", kind: "tool", question: "bash: per_r4",
    get options() { return answered ? opts.map(({ index, label }) => ({ index, label })) : opts; },
    answer: async () => { answered = true; return { ok: true }; },
  });
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 2, { byPerson: true }), { ok: true });
  const rs = gate.rulesFor("s1", "fakeplug");
  assert.deepEqual(rs.map((r) => [r.sessionId, r.plugin, r.backend, r.key, r.label, r.uses]), [["s1", "fakeplug", "fake", "touch a.txt", "touch a.txt", 0]]);
  gate.forgetRules({});
});

test("a backend no plugin registered: no `remembers` on the wire, and a tap keeps no rule nobody could use", async () => {
  const gate = await import("../dist/answergate.js");
  gate.forgetRules({});
  const f = fakeSources();
  const h = harness({ sources: f.sources, plugin: null });
  h.slice.attach(h.s);
  await flush();
  f.st.dialogOn.asked(f.dialog("per_n1", {
    options: [{ index: 1, label: "Yes" }, { index: 2, label: "Yes, and don't ask again", remember: { key: "k", label: "k" } }],
  }));
  assert.equal(h.s.info.prompt.options[1].remembers, undefined);
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 2, { byPerson: true }), { ok: true });
  assert.equal(gate.sessionRules("s1"), undefined);
});

test("dialogToPrompt: `remembers` carries the host's label (trimmed, the key when blank), never an unkeepable one", async () => {
  const { dialogToPrompt } = await import("../dist/sessions/sidechannel.js");
  const d = (remember) => ({ id: "x", kind: "tool", question: "q?", options: [{ index: 1, label: "Yes, always", remember }], answer: async () => ({ ok: true }) });
  assert.deepEqual(dialogToPrompt(d({ key: "ls -la", label: "  ls -la in /tmp " }), { keepsRules: true }).options[0].remembers, { label: "ls -la in /tmp" });
  assert.deepEqual(dialogToPrompt(d({ key: "ls -la", label: "" }), { keepsRules: true }).options[0].remembers, { label: "ls -la" });
  assert.equal(dialogToPrompt(d({ key: "", label: "x" }), { keepsRules: true }).options[0].remembers, undefined);
  assert.equal(dialogToPrompt(d({ key: "k", label: "k" })).options[0].remembers, undefined, "no owner ⇒ nothing promised");
  // A dialog that matches an ask rule the gate holds promises no rule: the gate would refuse it.
  const push = { id: "y", kind: "tool", question: "Run git push origin main?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "Yes, and don't ask again", remember: { key: "git push origin main", label: "git push origin main" } }], answer: async () => ({ ok: true }) };
  assert.equal(dialogToPrompt(push, { keepsRules: true, askRules: ["Bash(git push*)"] }).options[1].remembers, undefined);
  assert.deepEqual(dialogToPrompt(push, { keepsRules: true, askRules: ["Bash(npm publish*)"] }).options[1].remembers, { label: "git push origin main" });
});

test("Copilot `git push` under askRulesVia:\"gate\": no `remembers` on the wire, and a person's tap answers but keeps no rule", async () => {
  const gate = await import("../dist/answergate.js");
  gate.forgetRules({});
  const f = fakeSources();
  const h = harness({ sources: f.sources });
  h.s.info.askRulesVia = "gate";
  gate.holdAskRules("s1", ["Bash(git push*)"]);
  h.slice.attach(h.s);
  await flush();
  f.st.dialogOn.asked(f.dialog("per_p1", {
    question: "Allow the shell command git push origin main?",
    options: [{ index: 1, label: "Yes" }, { index: 2, label: "Yes, and don't ask again", remember: { key: "git push origin main", label: "git push origin main" } }, { index: 3, label: "No" }],
  }));
  assert.equal(h.s.info.prompt.options[1].remembers, undefined, "the option promises no rule the gate would refuse");
  assert.deepEqual(await boxes.answerBox(h.core, "s1", 2, { byPerson: true }), { ok: true }, "the tap still answers");
  assert.deepEqual(gate.rulesFor("s1", "fakeplug"), [], "…and keeps no standing rule");
  gate.forgetRules({});
});

// ── context freshness at a turn's end ────────────────────────────────
// A source's `ended(at)` is settled once its `context` sample is stamped at or after `at`
// (bounded by `CONTEXT_FRESH_MS`), so the turn-end context read sees THIS turn's fill and a
// plugin needs no end-gate hold of its own. claude (in-band, no context source) never waits.
const { CONTEXT_FRESH_MS } = await import("../dist/sessions/knobs.js");

function withContext(f, sample, { inBand = false } = {}) {
  f.sources.context = { sample: () => sample.v };
  if (inBand) f.sources.inBand = true;
  return f;
}

test("context freshness: the bound is 1500 ms", () => {
  assert.equal(CONTEXT_FRESH_MS, 1500);
});

test("context freshness: an ended edge waits for a sample at or after its `at`, then settles once", async () => {
  const sample = { v: { at: 900, usedTok: 10 } };
  const f = withContext(fakeSources(), sample);
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  f.st.turnOn.started(800);
  f.st.turnOn.ended(1000);
  assert.equal(h.s.stopCount, 0, "a stale sample (900 < 1000) holds the end");
  assert.equal(h.s.info.turnActive, true);
  sample.v = { at: 1000, usedTok: 42 };
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.s.stopCount, 1);
  assert.equal(h.s.info.turnActive, false);
});

test("context freshness: a fresh sample already there settles at once; a source with watch() wakes the wait", async () => {
  const sample = { v: { at: 2000, usedTok: 10 } };
  const f = withContext(fakeSources(), sample);
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  f.st.turnOn.started(1500);
  f.st.turnOn.ended(2000);
  assert.equal(h.s.stopCount, 1, "fresh ⇒ no wait");

  const s2 = { v: null }; let push = null;
  const g = withContext(fakeSources(), s2);
  g.sources.context.watch = (ss, on) => { push = on; return () => { push = null; }; };
  const h2 = harness({ sources: g.sources });
  h2.slice.contextPollMs = 10_000; // only the watch can wake it inside the test
  h2.slice.attach(h2.s);
  await flush();
  g.st.turnOn.started(1);
  g.st.turnOn.ended(5);
  assert.equal(h2.s.stopCount, 0);
  s2.v = { at: 6, usedTok: 1 };
  push(s2.v);
  assert.equal(h2.s.stopCount, 1, "the watch callback settles the end in its own tick");
  assert.equal(push, null, "the wait unsubscribes once settled");
});

test("context freshness: absent or stale past the bound ⇒ the end settles as today", async () => {
  const sample = { v: null };
  const f = withContext(fakeSources(), sample);
  const h = harness({ sources: f.sources });
  h.slice.contextWaitMs = 40;
  h.slice.attach(h.s);
  await flush();
  f.st.turnOn.started(1);
  f.st.turnOn.ended(5);
  assert.equal(h.s.stopCount, 0);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(h.s.stopCount, 1, "no sample ever ⇒ proceed after the bound");
});

test("context freshness: a turn starting while an end waits settles that end FIRST, in order", async () => {
  const sample = { v: { at: 1, usedTok: 1 } };
  const f = withContext(fakeSources(), sample);
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  f.st.turnOn.started(1);
  f.st.turnOn.ended(10);
  assert.equal(h.s.stopCount, 0);
  f.st.turnOn.started(11);
  assert.equal(h.s.stopCount, 1, "the old turn ended");
  assert.equal(h.s.info.turnActive, true, "the new turn runs");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(h.s.stopCount, 1, "the flushed end does not fire again");
});

test("context freshness: a channel closed while an end waits settles nothing late", async () => {
  const sample = { v: null };
  const f = withContext(fakeSources(), sample);
  const h = harness({ sources: f.sources });
  h.slice.contextWaitMs = 30;
  h.slice.attach(h.s);
  await flush();
  f.st.turnOn.started(1);
  f.st.turnOn.ended(5);
  h.slice.detach(h.s);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.s.stopCount, 0);
});

test("context freshness: claude's path (in-band) takes no wait, even beside a stale context source", async () => {
  const sample = { v: { at: 0, usedTok: 1 } };
  const f = withContext(fakeSources(), sample, { inBand: true });
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s);
  await flush();
  f.st.turnOn.started(1);
  f.st.turnOn.ended(10);
  assert.equal(h.s.stopCount, 1, "settled in the same tick");
  // …and the real claude source is exactly that shape: in-band, no context source to wait on.
  const { claudeSources } = await import("../dist/backends/claude-sources.js");
  assert.equal(claudeSources.inBand, true);
  assert.equal(claudeSources.context, undefined);
});
