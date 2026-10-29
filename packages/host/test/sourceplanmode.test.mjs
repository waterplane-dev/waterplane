/**
 * The 2.2 consumers of two source slots (P4b1, `docs/plans/backend-parity-v3.md` §7, gaps C5/C6),
 * driven by FAKE sources — no server, no PTY. The slice, box and mode functions are the real ones
 * (`sidechannel.ts`, `boxes.ts`, `livemode.ts`) over a fake `SessionCore`.
 *
 * Plan (`sources.plan`): a posed plan is published as claude's plan box (kind `plan`, the plan
 * text riding on `DetectedPrompt.plan`, `path` EMPTY — no file, never a made-up one); a person's
 * tap calls ONE verb at most once; `SourceKeys` are typed by the core; words are refused; the
 * answer gate and an untapped answer are refused; `closed` retires; the channel going down hands
 * it back.
 *
 * Mode (`sources.mode`): `current()` (validated) is `liveMode`, a `watch` is a re-read cue; `set()`
 * by a server switch or by ONE press per step on livemode's ladder; refused with a box open;
 * claude's footer path is unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { ChannelSlice, planToPrompt } = await import("../dist/sessions/sidechannel.js");
const turn = await import("../dist/sessions/turn.js");
const boxes = await import("../dist/sessions/boxes.js");
const boxread = await import("../dist/sessions/boxread.js");
const livemode = await import("../dist/sessions/livemode.js");
const { isPlanBox, PLAN_CAP } = await import("../dist/planbox.js");
const { gateRefusal, isBlocked } = await import("../dist/answergate.js");
const { promptFingerprint } = await import("@waterplane/shared");

const here = dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const MODES = ["default", "plan", "acceptEdits", "auto"];
function harness({ sources, facts, caps = {} } = {}) {
  const events = []; const typed = []; const wrote = [];
  const sessions = new Map();
  const base = {
    sessions,
    emit: (ev, ...args) => { events.push([ev, ...args]); return true; },
    sourceTurn: (s, e) => turn.sourceTurn(core, s, e),
    applyPrompt: (s, p) => boxread.applyPrompt(core, s, p),
    armPromptCheck: () => {},
    input: (id, data) => { typed.push([id, data]); return true; },
    write: (id, data) => { wrote.push([id, data]); h.onWrite?.(data); return true; },
    checkMode: (s) => livemode.checkMode(core, s),
  };
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const s = {
    info: { id: "s1", cwd: tmpdir(), running: true, title: "demo", remoteControl: true },
    backend: {
      id: "fake", label: "Fakecli", plugin: "fakeplug",
      caps: { turns: true, slash: "none", remoteControl: false, permissionModes: MODES, ...caps },
      facts: facts ?? { plan: [{ source: true }], mode: [{ source: true }] },
      ...(sources ? { sources } : {}),
    },
    scrollback: "", seq: 0, spawnedAt: Date.now(),
    stopPending: false, stopVerifyTimer: null, turnActive: false, turnFromScreen: false,
    hooksActive: false, turnHookSeen: false, stopCount: 0, idleNotified: false, askDismissed: null,
    agentTimer: null, submits: [],
  };
  sessions.set("s1", s);
  const h = { core, s, events, typed, wrote, slice: new ChannelSlice(core), onWrite: null };
  return h;
}

function planSources({ health = { state: "up", since: 1 } } = {}) {
  const st = { planOn: null, onHealth: null, calls: [] };
  const sources = {
    plan: { watch: (ss, on) => { st.planOn = on; return () => { st.planOn = null; }; } },
    attach: async (ss, onHealth) => { st.onHealth = onHealth; return { close: async () => {}, health: () => health }; },
  };
  const plan = (id, over = {}) => ({
    id, text: "# Plan\n\n1. read\n2. write",
    approve: async () => { st.calls.push([id, "approve"]); return { ok: true }; },
    keepPlanning: async () => { st.calls.push([id, "keep"]); return { ok: true }; },
    ...over,
  });
  return { st, sources, plan };
}

async function posedPlan(over) {
  const f = planSources();
  const h = harness({ sources: f.sources });
  h.slice.attach(h.s); await flush();
  const p = f.plan("plan-1", over);
  f.st.planOn.posed(p);
  return { f, h, p };
}

// ── plan ──────────────────────────────────────────────────────────────────────

test("plan: posed ⇒ claude's plan box, from the source — kind plan, the text, an EMPTY path, nav, the CLI's id", async () => {
  const { h } = await posedPlan();
  const box = h.s.info.prompt;
  assert.equal(box.kind, "plan");
  assert.ok(isPlanBox(box.question), "worded as claude's box is, so the plan reader knows it");
  assert.match(box.question, /^Fakecli has written up a plan/);
  assert.deepEqual(box.options.map((o) => [o.index, o.label]), [[1, "Yes, proceed with the plan"], [2, "No, keep planning"]]);
  assert.equal(box.nav, true, "named, never typed as a digit");
  assert.equal(box.askId, "plan-1");
  assert.deepEqual(box.plan, { text: "# Plan\n\n1. read\n2. write", path: "" }, "no file ⇒ path empty, never made up");
  assert.ok(isBlocked(box), "a plan box is a person's call");
});

test("plan: a plan longer than PLAN_CAP is cut exactly as the plan file is; no text ⇒ the box without a plan", () => {
  const long = planToPrompt({ id: "p", text: "x".repeat(PLAN_CAP + 10), approve: async () => ({ ok: true }), keepPlanning: async () => ({ ok: true }) }, "Fakecli");
  assert.equal(long.plan.text.length, PLAN_CAP);
  assert.equal(long.plan.cut, true);
  const bare = planToPrompt({ id: "p", text: "  ", approve: async () => ({ ok: true }), keepPlanning: async () => ({ ok: true }) }, "Fakecli");
  assert.equal(bare.kind, "plan");
  assert.equal("plan" in bare, false);
  assert.equal(planToPrompt({ id: "", text: "x", approve: async () => ({ ok: true }), keepPlanning: async () => ({ ok: true }) }, "F"), null, "no id");
  assert.equal(planToPrompt({ id: "p", text: "x", approve: async () => ({ ok: true }) }, "F"), null, "a verb missing");
});

test("plan: a tap on approve calls approve() ONCE — a second tap, even concurrent, calls nothing", async () => {
  const { f, h } = await posedPlan();
  const [a, b] = await Promise.all([
    boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true }),
    boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true }),
  ]);
  assert.deepEqual(f.st.calls, [["plan-1", "approve"]]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.match(b.reason, /already answered/);
  const c = await boxes.answerBox(h.core, "s1", 2, { walk: true, byPerson: true });
  assert.equal(c.ok, false, "the latch holds until the CLI closes the plan");
  assert.deepEqual(f.st.calls, [["plan-1", "approve"]]);
  assert.deepEqual(h.typed, [], "nothing typed for a server answer");
});

test("plan: a re-pose mid-answer whose verb then fails releases the LIVE latch — the second tap reaches the verb", async () => {
  let n = 0, release;
  const { f, h } = await posedPlan({ approve: () => { f.st.calls.push(["plan-1", "approve"]); return ++n === 1 ? new Promise((r) => { release = r; }) : Promise.resolve({ ok: true }); } });
  const first = boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true });
  await flush();
  f.st.planOn.posed(f.plan("plan-1", { text: "revised" }));
  release({ ok: false, reason: "changed" });
  assert.equal((await first).ok, false);
  assert.equal(h.s.channel.plans.get("plan-1").answering, false, "the entry in the map was released");
  const second = await boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true });
  assert.equal(second.ok, true);
  assert.equal(f.st.calls.length, 2);
});

test("plan: row 2 is keepPlanning(); a refusal by the source releases the latch for a retry", async () => {
  let n = 0;
  const { f, h } = await posedPlan({ keepPlanning: async () => { f.st.calls.push(["plan-1", "keep"]); return ++n === 1 ? { ok: false, reason: "busy" } : { ok: true }; } });
  const r1 = await boxes.answerBox(h.core, "s1", 2, { walk: true, byPerson: true });
  assert.deepEqual(r1, { ok: false, reason: "busy" });
  const r2 = await boxes.answerBox(h.core, "s1", 2, { walk: true, byPerson: true });
  assert.equal(r2.ok, true);
  assert.deepEqual(f.st.calls, [["plan-1", "keep"], ["plan-1", "keep"]]);
});

test("plan: SourceKeys are typed by the core, once; bad keys and words are refused, nothing typed", async () => {
  {
    const { h } = await posedPlan({ approve: async () => ({ keys: "1" }) });
    const r = await boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true });
    assert.equal(r.ok, true);
    assert.deepEqual(h.typed, [["s1", "1"]]);
  }
  {
    const { h } = await posedPlan({ approve: async () => ({ keys: "\x03" }) });
    const r = await boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /keystrokes this host will not type/);
    assert.deepEqual(h.typed, []);
  }
  {
    const { h } = await posedPlan({ approve: async () => ({ typed: "yes", then: "\r" }) });
    const r = await boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /words into a plan/);
    assert.deepEqual(h.typed, []);
  }
});

test("plan: the answer gate refuses it, and an answer that is not a person's tap calls no verb", async () => {
  const { f, h } = await posedPlan();
  const box = h.s.info.prompt;
  const why = gateRefusal({ pluginName: "P", answers: true, sessionLive: true, switchOn: true, prompt: box, told: promptFingerprint(box), choice: 1 });
  assert.match(why, /plan box is always a person's call/);
  const r = await boxes.answerBox(h.core, "s1", 1); // the gate's own call shape: no byPerson
  assert.equal(r.ok, false);
  assert.match(r.reason, /person's call/);
  const t = await boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true, text: "go" });
  assert.equal(t.ok, false, "no typed words on a plan");
  const x = await boxes.answerBox(h.core, "s1", 3, { walk: true, byPerson: true });
  assert.equal(x.ok, false);
  assert.deepEqual(f.st.calls, []);
});

test("plan: closed retires the box; a tap after it is refused in words", async () => {
  const { f, h } = await posedPlan();
  f.st.planOn.closed("plan-1");
  assert.equal(h.s.info.prompt, null);
  const r = await boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true });
  assert.equal(r.ok, false);
  assert.deepEqual(f.st.calls, []);
});

test("plan: the channel going down hands it back — box retired, nothing held", async () => {
  const { f, h } = await posedPlan();
  assert.equal(h.s.info.prompt.askId, "plan-1");
  f.st.onHealth({ state: "down", since: 2, note: "gone" });
  assert.equal(h.s.info.prompt, null);
  assert.equal(h.s.channel.plans.size, 0);
});

test("plan: oldest first across dialogs and plans; a re-pose keeps the answer latch", async () => {
  const f = planSources();
  let dialogOn = null;
  f.sources.dialogs = { watch: (ss, on) => { dialogOn = on; return () => {}; }, pending: async () => [] };
  const h = harness({ sources: f.sources, facts: { plan: [{ source: true }], dialogs: [{ source: true }] } });
  h.slice.attach(h.s); await flush();
  f.st.planOn.posed(f.plan("plan-1"));
  dialogOn.asked({ id: "d1", kind: "tool", question: "bash: ls", options: [{ index: 1, label: "Allow" }], answer: async () => ({ ok: true }) });
  assert.equal(h.s.info.prompt.askId, "plan-1", "the plan was posed first");
  await boxes.answerBox(h.core, "s1", 1, { walk: true, byPerson: true });
  f.st.planOn.posed(f.plan("plan-1", { text: "revised" }));
  assert.equal(h.s.channel.plans.get("plan-1").answering, true);
  f.st.planOn.closed("plan-1");
  assert.equal(h.s.info.prompt.askId, "d1", "then the dialog");
});

test("plan: without the plan FACT the slot is not watched (the wire cap is read off the same table)", async () => {
  const f = planSources();
  const h = harness({ sources: f.sources, facts: {} });
  h.slice.attach(h.s); await flush();
  assert.equal(f.st.planOn, null);
});

// ── mode ──────────────────────────────────────────────────────────────────────

function modeSources({ start = "default", cycle = MODES, set } = {}) {
  const st = { mode: start, sets: [], cue: null, cur: null };
  const sources = {
    mode: {
      current: () => st.cur ?? st.mode,
      watch: (ss, on) => { st.cue = on; return () => { st.cue = null; }; },
      set: async (ss, target) => { st.sets.push(target); return set ? set(st, target) : { keys: "\x1b[Z" }; },
    },
    attach: async () => ({ close: async () => {}, health: () => ({ state: "up", since: 1 }) }),
  };
  const press = () => { const i = cycle.indexOf(st.mode); st.mode = cycle[(i + 1) % cycle.length]; };
  return { st, sources, press };
}

async function modeHarness(opts) {
  const f = modeSources(opts);
  const h = harness({ sources: f.sources });
  h.onWrite = (data) => { if (data === "\x1b[Z") f.press(); };
  h.slice.attach(h.s); await flush();
  return { f, h };
}

test("mode: current() is liveMode — read on the up edge, re-read on a watch cue; null or a stranger deletes it", async () => {
  const { f, h } = await modeHarness();
  assert.equal(h.s.info.liveMode, "default", "read on the up edge");
  f.st.mode = "plan"; f.st.cue("plan");
  assert.equal(h.s.info.liveMode, "plan");
  assert.ok(h.events.some(([e]) => e === "updated"));
  f.st.cur = "bypassPermissions"; livemode.checkMode(h.core, h.s);
  assert.equal("liveMode" in h.s.info, false, "a mode the descriptor does not declare is unknown");
  f.st.cur = null; f.st.mode = null; h.s.info.liveMode = "plan"; livemode.checkMode(h.core, h.s);
  assert.equal("liveMode" in h.s.info, false, "null deletes, never last-known");
  f.sources.mode.current = () => { throw new Error("x"); }; h.s.info.liveMode = "plan"; livemode.checkMode(h.core, h.s);
  assert.equal("liveMode" in h.s.info, false, "a throw is unknown");
});

test("mode: set() by a server switch — the reading is still the source's, nothing typed", async () => {
  const { f, h } = await modeHarness({ set: (st, target) => { st.mode = target; return { ok: true }; } });
  const r = await livemode.setMode(h.core, "s1", "acceptEdits");
  assert.deepEqual(r, { mode: "acceptEdits" });
  assert.equal(h.s.info.liveMode, "acceptEdits");
  assert.deepEqual(f.st.sets, ["acceptEdits"]);
  assert.deepEqual(h.wrote, []);
});

test("mode: a server refusal is said in words; a switch the reading does not show is said too", async () => {
  {
    const { h } = await modeHarness({ set: () => ({ ok: false, reason: "not now" }) });
    const r = await livemode.setMode(h.core, "s1", "plan");
    assert.deepEqual(r, { mode: "default", reason: "not now" });
  }
  {
    const { h } = await modeHarness({ set: () => ({ ok: true }) });
    const r = await livemode.setMode(h.core, "s1", "plan");
    assert.equal(r.mode, "default");
    assert.match(r.reason, /said it switched .* still reads/);
  }
});

test("mode: keys — ONE press per set(), re-read until it changes, stop on the target", async () => {
  const { f, h } = await modeHarness();
  const r = await livemode.setMode(h.core, "s1", "acceptEdits"); // default → plan → acceptEdits
  assert.deepEqual(r, { mode: "acceptEdits" });
  assert.deepEqual(h.wrote, [["s1", "\x1b[Z"], ["s1", "\x1b[Z"]]);
  assert.deepEqual(f.st.sets, ["acceptEdits", "acceptEdits"]);
  assert.equal(h.s.info.liveMode, "acceptEdits");
});

test("mode: keys — a cycle that comes back round stops, naming the target as not in it", async () => {
  const { h } = await modeHarness({ cycle: ["default", "plan"] });
  const r = await livemode.setMode(h.core, "s1", "auto");
  assert.equal(r.mode, "default");
  assert.match(r.reason, /isn't in this session's mode cycle/);
  assert.equal(h.wrote.length, 2);
});

test("mode: keys the host will not type, or no reading to start from, press nothing", async () => {
  {
    const { h } = await modeHarness({ set: () => ({ keys: "\x03" }) });
    const r = await livemode.setMode(h.core, "s1", "plan");
    assert.match(r.reason, /will not type/);
    assert.deepEqual(h.wrote, []);
  }
  {
    const { f, h } = await modeHarness();
    f.st.mode = null; livemode.checkMode(h.core, h.s);
    const r = await livemode.setMode(h.core, "s1", "plan");
    assert.match(r.reason, /can't be read right now, so nothing was pressed/);
    assert.deepEqual(h.wrote, []);
  }
});

test("mode: refused in words with a box open — set() never asked", async () => {
  const { f, h } = await modeHarness();
  h.s.info.prompt = { kind: "tool", question: "q", options: [{ index: 1, label: "a" }] };
  const r = await livemode.setMode(h.core, "s1", "plan");
  assert.match(r.reason, /question is open/);
  assert.deepEqual(f.st.sets, []);
  assert.deepEqual(h.wrote, []);
});

test("mode: serialised per session — a double tap is one walk and an immediate 'already there'", async () => {
  const { f, h } = await modeHarness();
  const [a, b] = await Promise.all([livemode.setMode(h.core, "s1", "plan"), livemode.setMode(h.core, "s1", "plan")]);
  assert.deepEqual(a, { mode: "plan" });
  assert.deepEqual(b, { mode: "plan" });
  assert.equal(h.wrote.length, 1);
  assert.deepEqual(f.st.sets, ["plan"]);
});

test("mode: claude's footer path is unchanged — no mode source, the footer is read", () => {
  const grid = readFileSync(join(here, "fixtures/permmode/accept-edits.txt"), "utf8");
  const h = harness({ facts: { dialogs: [{ screen: "claude-numbered" }] }, caps: { permissionModes: ["default", "plan", "acceptEdits", "auto"] } });
  h.s.screenLog = { gridText: () => grid };
  livemode.checkMode(h.core, h.s);
  assert.equal(h.s.info.liveMode, "acceptEdits");
  const other = harness({ facts: {} });
  other.s.info.liveMode = "plan";
  livemode.checkMode(other.core, other.s);
  assert.equal(other.s.info.liveMode, "plan", "a backend with neither reader is not touched");
});
