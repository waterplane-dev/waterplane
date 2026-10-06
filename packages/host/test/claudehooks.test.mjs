/**
 * The claude hook pipe, end to end at the turn level: a RECORDED hook stream
 * handed to `turn.ts`'s `onHookEvent` (the `/api/hook` sink), over the real
 * `claudeBackend` descriptor, the real side channel slice, and the real turn and
 * box functions — a fake `SessionCore` whose unrelated members are no-ops.
 *
 * Written BEFORE claude moved onto the `sources` seam
 * (docs/analysis/backends-design.md §10) and unchanged by that move: it pins
 * what the hooks DO, not which file does it.
 *
 * Pinned: the first hook makes the pipe live (once, one `hook.pipe` good);
 * `SessionStart` adopts the id and sits at the prompt; `UserPromptSubmit`
 * starts a turn and records its words for `claimSubmittedPrompt` (claimed
 * once); a `Stop` is HELD against the working line and a duplicate ends the
 * turn ONCE; a `Stop` refused by a hook (working line keeps painting) keeps the
 * turn; `/compact` (no hook at all) is published off the screen and retired
 * quietly; a `Stop` arriving after such a screen-detected idle still ends a
 * turn; a hook for a session nobody has is a no-op.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

// Module consts read at load: a short Stop hold so the test runs in ms.
process.env.WATERPLANE_STOP_VERIFY_MS = "30";

const turn = await import("../dist/sessions/turn.js");
const boxes = await import("../dist/sessions/boxes.js");
const { ChannelSlice } = await import("../dist/sessions/sidechannel.js");
const { claudeBackend } = await import("../dist/backends/claude.js");

const WINDOW = 30;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Past one hold window, with room for a timer that fires late. */
const pastWindow = () => wait(WINDOW * 3);
const WORKING = "✻ Crafting… (9m 35s · esc to interrupt)";
const COMPACT = "✻ Compacting conversation… (35s)";

function harness({ backend = claudeBackend, cwd = tmpdir(), claudeSessionId } = {}) {
  const events = []; const notes = []; const adopted = []; const rereads = []; const applied = []; const watchStops = [];
  const sessions = new Map();
  const base = {
    sessions,
    emit: (ev, ...args) => { events.push([ev, ...args]); return true; },
    noteFor: (s, sig, outcome) => { notes.push([sig, outcome]); },
    adoptClaudeId: (s, id) => { if (id) { adopted.push(id); s.info.claudeSessionId = id; } },
    stopClaudeIdWatch: () => { watchStops.push(1); },
    refreshModel: (s, path) => { rereads.push(path); },
    applyPrompt: (s, p) => { applied.push(p); s.info.prompt = p; },
    armTurnWatch: (s, seqAt) => turn.armTurnWatch(core, s, seqAt),
    armPromptCheck: () => {},
    // Both shapes: the switch (before the move) calls none of these; the seam calls them.
    sourceTurn: (s, e, f) => turn.sourceTurn(core, s, e, f),
    sourceIdentified: (s, id) => turn.sourceIdentified?.(core, s, id),
  };
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  let grid = "";
  const s = {
    info: { id: "w1", cwd, running: true, title: "demo", ...(claudeSessionId ? { claudeSessionId } : {}) },
    backend,
    scrollback: "", seq: 0, spawnedAt: Date.now() - 60_000,
    screenLog: { gridText: () => grid },
    stopPending: false, stopVerifyTimer: null, turnActive: false, turnFromScreen: false,
    hooksActive: false, turnHookSeen: false, stopCount: 0, idleNotified: false, askDismissed: null,
    agentTimer: null, submits: [],
    // A prompt check already pending, so `scheduleChecks` never runs the real reader here.
    promptTimer: setTimeout(() => {}, 0), promptDueAt: 0, lastPromptCheckAt: Date.now(),
    idleTimer: null,
  };
  sessions.set(s.info.id, s);
  const slice = new ChannelSlice(core);
  slice.attach(s); // a no-op for a backend without `sources`; the hook pipe's channel with them
  const hook = (ev, extra = {}) => turn.onHookEvent(core, { hook_event_name: ev, cwd, ...extra });
  /** The CLI printed something: `n` fresh bytes, and the grid now reads `text`. */
  const paint = (text, n = 200) => { grid = text; s.seq += n; s.scrollback += text; };
  /** A CLI that keeps repainting `text`, as a working one does; returns the stop. */
  const keepPainting = (text) => { paint(text); const t = setInterval(() => paint(text, 50), 8); return () => clearInterval(t); };
  const ended = () => events.filter((e) => e[0] === "turnEnded").length;
  const stop = () => { s.info.running = false; slice.detach(s); turn.clearStopVerify(s); if (s.idleTimer) clearTimeout(s.idleTimer); };
  return { core, s, events, notes, adopted, rereads, applied, watchStops, hook, paint, keepPainting, ended, stop, slice };
}

test("a recorded hook stream: start, prompt, held Stop, duplicate Stop — one turn, ended once", async () => {
  const h = harness();
  try {
    assert.equal(h.s.info.sideChannel, undefined, "claude publishes no side channel, before or after its hooks");
    assert.equal(h.s.info.hooked, undefined, "no pipe until a hook arrives");

    h.hook("SessionStart", { session_id: "c1", transcript_path: "/p/c1.jsonl", source: "startup" });
    assert.equal(h.s.hooksActive, true);
    assert.equal(h.s.info.hooked, true, "the first hook makes the pipe live");
    assert.equal(h.s.turnHookSeen, true);
    assert.deepEqual(h.notes, [["hook.pipe", "good"]], "one health observation, from the pipe GOING LIVE");
    assert.deepEqual(h.adopted, ["c1"], "SessionStart hands the session its conversation id");
    assert.equal(h.watchStops.length, 1, "…and retires the project-dir polling");
    assert.deepEqual(h.rereads, ["/p/c1.jsonl"], "the model is re-read off the log the CLI named");
    assert.equal(h.s.turnActive, false, "a booted session sits at its prompt");
    assert.equal(h.s.info.sideChannel, undefined);
    assert.ok(h.events.some((e) => e[0] === "updated"), "the pipe going live is broadcast");

    h.s.info.prompt = { kind: "tool", question: "q", options: [{ index: 1, label: "Yes" }] };
    const since = Date.now() - 1;
    h.hook("UserPromptSubmit", { session_id: "c1", prompt: "fix the bug" });
    assert.equal(h.s.turnActive, true, "a submitted prompt starts a turn");
    assert.equal(h.s.info.turnActive, true);
    assert.deepEqual(h.applied.at(-1), null, "a submitted prompt is proof no dialog is up");
    assert.equal(turn.claimSubmittedPrompt(h.core, "w1", "fix the bug", since), true, "the delivery proof: the CLI named the words");
    assert.equal(turn.claimSubmittedPrompt(h.core, "w1", "fix the bug", since), false, "…claimed ONCE");
    assert.deepEqual(h.notes, [["hook.pipe", "good"]], "one pipe, one observation — not one per hook");

    h.hook("Stop", { session_id: "c1", transcript_path: "/p/c1.jsonl" });
    h.hook("Stop", { session_id: "c1", transcript_path: "/p/c1.jsonl" }); // the duplicate
    assert.equal(h.s.turnActive, true, "a Stop is HELD until the screen agrees");
    assert.equal(h.ended(), 0);
    assert.deepEqual(h.rereads, ["/p/c1.jsonl", "/p/c1.jsonl", "/p/c1.jsonl"], "each Stop re-reads the model");
    await pastWindow();
    assert.equal(h.s.turnActive, false, "nothing painted since: the turn is over");
    assert.equal(h.s.stopCount, 1, "two Stops, one turn");
    assert.equal(h.ended(), 1, "one turnEnded");

    h.hook("SessionEnd", { session_id: "c1" });
    assert.equal(h.s.turnActive, false);
    assert.equal(h.s.stopCount, 1, "SessionEnd ends nothing that was not running");
  } finally { h.stop(); }
});

test("a Stop a hook refused: the working line keeps the turn, and it ends when the line stops", async () => {
  const h = harness();
  try {
    h.hook("UserPromptSubmit", { prompt: "loop until done" });
    h.hook("Stop", {});
    const quiet = h.keepPainting(WORKING); // printed AFTER the Stop: the CLI carried on
    await pastWindow();
    assert.equal(h.s.turnActive, true, "the CLI is still working: the Stop was refused");
    assert.equal(h.s.stopCount, 0);
    quiet();
    h.paint("");
    await pastWindow();
    await pastWindow();
    assert.equal(h.s.turnActive, false, "the working line stopped: the held Stop is believed");
    assert.equal(h.s.stopCount, 1);
    assert.equal(h.ended(), 1);
  } finally { h.stop(); }
});

test("/compact announces nothing: published off the screen, retired quietly; a later Stop still ends a turn", async () => {
  const h = harness();
  try {
    h.hook("SessionStart", { session_id: "c2" });
    assert.equal(h.s.info.hooked, true);
    // Output on a hooked session with no turn believed arms the screen turn watch.
    boxes.scheduleChecks(h.core, h.s);
    assert.ok(h.s.stopVerifyTimer, "the screen turn watch is armed for a hooked claude session");
    const quiet = h.keepPainting(COMPACT);
    await pastWindow();
    assert.equal(h.s.turnActive, true, "a compaction nobody announced is published");
    assert.equal(h.s.turnFromScreen, true, "…as read off the screen");
    quiet();
    h.paint("");
    await pastWindow();
    await pastWindow();
    assert.equal(h.s.turnActive, false, "the line stopped: retired");
    assert.equal(h.s.stopCount, 0, "quietly — no stopCount");
    assert.equal(h.ended(), 0, "…and no turnEnded");

    // A Stop arriving AFTER that screen-detected idle is still owed an end.
    h.hook("Stop", { session_id: "c2" });
    await pastWindow();
    assert.equal(h.s.stopCount, 1, "a Stop is counted even with no turn believed");
    assert.equal(h.ended(), 1);
  } finally { h.stop(); }
});

test("the first hook may be a Notification: the pipe is live, no turn-shaped hook seen", () => {
  const h = harness();
  try {
    h.hook("Notification", { session_id: "x", notification_type: "idle_prompt" });
    assert.equal(h.s.info.hooked, true);
    assert.equal(h.s.turnHookSeen, false, "a Notification is not a turn-shaped hook");
    assert.equal(h.s.turnActive, false);
    h.hook("SomethingNew", {});
    assert.equal(h.s.turnActive, false, "an unknown event changes nothing beyond the pipe");
    assert.deepEqual(h.notes, [["hook.pipe", "good"]]);
  } finally { h.stop(); }
});

test("a hook for a session nobody has is a no-op", () => {
  const h = harness({ claudeSessionId: "mine" });
  try {
    turn.onHookEvent(h.core, { hook_event_name: "UserPromptSubmit", session_id: "theirs", cwd: "/nowhere/else", prompt: "x" });
    turn.onHookEvent(h.core, { hook_event_name: "", session_id: "mine" });
    turn.onHookEvent(h.core, {});
    assert.equal(h.events.length, 0, "nothing emitted");
    assert.equal(h.s.hooksActive, false);
    assert.equal(h.s.info.hooked, undefined);
    assert.equal(h.s.turnActive, false);
    assert.deepEqual(h.notes, []);
  } finally { h.stop(); }
});

test("a hookless backend is never handed a claude hook, even by exact id", () => {
  const hookless = { ...claudeBackend, id: "hookless", caps: { ...claudeBackend.caps, hooks: "none" }, sources: undefined };
  const h = harness({ backend: hookless, claudeSessionId: "c9" });
  try {
    h.hook("UserPromptSubmit", { session_id: "c9", prompt: "x" });
    assert.equal(h.s.hooksActive, false);
    assert.equal(h.s.turnActive, false);
    assert.equal(h.events.length, 0);
  } finally { h.stop(); }
});
