/**
 * What a delivery is entitled to SAY about the submit proof — the health
 * record's half of `deliver.ts`, not its verdict.
 *
 * The verdict side is pinned by e2e through a booted host and a stub binary.
 * What could not be asked there is the thing that went wrong on the live
 * machine: `deliver.submit` read 5 misses of the last 20 — degraded, amber,
 * permanent — while the sent log said every one of those five deliveries came
 * back `ok`. The branch is one code path and three different events, and the
 * record was told only the code path:
 *
 *   • hooks live, a turn ALREADY running (a person interjecting) — no
 *     turn-start exists to observe, so the rule is not applicable;
 *   • hooks not yet HEARD FROM, and our own Return is what made the pipe speak
 *     — the proof turns up, late, and the delivery used to file a fallback for
 *     it anyway;
 *   • no pipe at all — `ok` returned on no proof, which is the fallback and the
 *     one worth a word.
 *
 * A fake session manager rather than a PTY, because the states above are ones a
 * real host cannot be asked to produce on demand — which is the same reason
 * `clihealth.ts` says its own rules must be pinnable with nothing booted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverPrompt } from "../dist/deliver.js";
import { CliHealthStore, setCliHealth } from "../dist/clihealth.js";
import { setLiveSourceLookup } from "../dist/livesources.js";

/**
 * The smallest session manager `deliverPrompt` will accept.
 *
 * `screenText` answers with whatever has been typed, so the echo probe finds
 * its text on the first look and the delivery reaches the submit branch — which
 * is the only part under test here. Every Return is recorded, and `onReturn`
 * lets a case say what the CLI does about it (a hook arriving, a turn starting,
 * nothing at all).
 */
function fakeSessions({ hooked = false, turnActive = false, onReturn = () => {}, submitted = [], backend } = {}) {
  const state = {
    hooked,
    turnActive,
    stopCount: 0,
    screen: "",
    scrollback: "",
    returns: 0,
    hookFallbacks: [],
    submitted,
  };
  const info = { id: "s1", running: true, ...(backend ? { backend } : {}), get turnActive() { return state.turnActive; } };
  const sessions = {
    state,
    get: () => info,
    idleMs: () => 300,
    waitReady: async () => true,
    screenText: async () => state.screen,
    scrollback: () => state.scrollback,
    recordPrompt: () => {},
    isHooked: () => state.hooked,
    stopCount: () => state.stopCount,
    /** The grid the composer is drawn in — the audit row's, never a branch's. */
    geometry: () => ({ cols: 80, rows: 30 }),
    /**
     * The CLI's own `UserPromptSubmit`, as this double can produce it: the
     * prompts `submitted` says went in, claimed at most once each — the whole
     * point of the ledger being that two deliveries of one text cannot both
     * read one hook event as their own.
     */
    claimSubmittedPrompt: (_id, text, since) => {
      // `since` is not decoration: an event from BEFORE this delivery started
      // is somebody else's, and a double that ignored the window let a second
      // send of identical words claim the first send's hook — which is the
      // exact failure the real ledger is spending a claim to prevent.
      const i = state.submitted.findIndex((e) => !e.claimed && e.prompt === text && (e.at ?? 0) >= since);
      if (i < 0) return false;
      state.submitted[i].claimed = true;
      return true;
    },
    lastSubmittedPrompt: (_id, since) => state.submitted.filter((e) => (e.at ?? 0) >= since).at(-1)?.prompt ?? null,

    // This double has no screen-inferred turn state to tell apart from a
    // hook-announced one — `turnActive` IS the hook's fact here.
    turnFromHook: () => state.turnActive,
    // Settling asks this BEFORE it reads a transcript: a backend whose record is
    // not claude's jsonl can never produce the evidence those verdicts are
    // about, and reading one to find that out costs a full store read per
    // settle. This double is a claude session, like everything else here.
    keepsClaudeLog: () => true,
    getTranscript: () => null,
    noteHookFallback: (_id, via) => state.hookFallbacks.push(via),
    // This double stands in for a CLAUDE session, which is what every assertion
    // in this file is about: `deliver.ts` asks the manager whether the session's
    // backend is inside the health record's scope before filing anything, and
    // for claude the answer has always been yes.
    healthScope: () => true,
    write: (_id, data) => {
      if (data === "\r") { state.returns++; onReturn(state); return; }
      state.screen = data;
    },
  };
  return sessions;
}

/** A store with nothing else installed, plus the record for one signal. */
function store() {
  const s = new CliHealthStore(mkdtempSync(join(tmpdir(), "waterplane-submit-")), () => {}, () => {});
  setCliHealth(s);
  return {
    store: s,
    submit: () => s.get().signals["deliver.submit"] ?? null,
  };
}

const TEXT = "have another look at the retry test and say what you find";

test("interjecting into a working session records nothing at all", async () => {
  // The live case, and the majority of that 5-of-20: hooks are perfectly alive,
  // a turn is already running, and `turnActive` was true before the Return
  // existed. There is no turn-start to observe. `DeliverOpts.interactive`
  // already documents that this costs the proof; what it must not do is report
  // the CLI as degraded for it — the rate would then be a measurement of how
  // often the user interjects.
  const h = store();
  const sessions = fakeSessions({
    hooked: true,
    turnActive: true,
    onReturn: (s) => { s.scrollback += "x".repeat(200); },
  });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { interactive: true, watch: false });
  assert.equal(result, "ok", "the delivery itself is unchanged — press-and-look, report ok");
  assert.equal(h.submit(), null, "and it is not a statement about the CLI, so nothing is written");
  assert.deepEqual(sessions.state.hookFallbacks, [], "the pipe is live; nothing fell back to silence either");
});

test("a hook that lands during the press-and-look loop is the proof arriving, not a fallback", async () => {
  // `isHooked` answers "has a hook reached THIS host process", so a tmux
  // session re-attached after a restart reads unhooked until its next turn
  // boundary — and our own Return is what produces that boundary. On the live
  // host the first hook landed 677 ms into this loop and the delivery filed a
  // fallback anyway. The proof turning up late is the primary rule answering.
  const h = store();
  const sessions = fakeSessions({
    hooked: false,
    onReturn: (s) => { s.hooked = true; s.turnActive = true; s.scrollback += "x".repeat(200); },
  });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "ok");
  const sig = h.submit();
  assert.ok(sig, "this one IS an observation about the CLI");
  assert.equal(sig.window.at(-1).ok, true, "and the answer was yes");
  assert.equal(sig.totalMiss, 0);
  assert.deepEqual(sessions.state.hookFallbacks, [], "the pipe answered, so no hook fallback either");
});

test("a session with no pipe at all still records the fallback it took", async () => {
  // The signal this exists for, and the one the two cases above must not
  // dilute: nothing reported the turn, the delivery returned `ok` on no proof,
  // and the record says so.
  const h = store();
  const sessions = fakeSessions({
    hooked: false,
    onReturn: (s) => { s.scrollback += "x".repeat(200); },
  });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "ok");
  const sig = h.submit();
  assert.equal(sig.window.at(-1).ok, false);
  assert.equal(sig.window.at(-1).fallback, true);
  assert.equal(sig.via, "press-and-look");
  assert.deepEqual(sessions.state.hookFallbacks, ["silence heuristics"], "and the missing pipe is named once");
});

test("a hooked, quiet session whose Return starts a turn is still a plain good", async () => {
  // The path the change must leave exactly as it was.
  const h = store();
  const sessions = fakeSessions({
    hooked: true,
    onReturn: (s) => { s.turnActive = true; },
  });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "ok");
  assert.equal(h.submit().window.at(-1).ok, true);
  assert.equal(sessions.state.returns, 1, "one press, because the hook answered it");
});

// ── The echo rescue a slash command could never reach ──────────────────────
//
// Reported from a phone: `/cost` came back "not delivered · typed, but never
// appeared on screen", with the command plainly sitting in the composer.
//
// The echo check has a rescue for a screen that was simply slow to repaint —
// ask the conversation log whether it ran anyway. For a SLASH command that
// rescue can never fire: the CLI writes those as an envelope the transcript
// reader drops, so the log is silent whether the command ran or not. On a link
// where the echo misses its window (measured on this host at ~23% of
// deliveries), an ordinary prompt gets rescued and a local command goes straight
// to `unconfirmed` — the verdict that is never retried.
//
// The proof that fits is the one the submit branch already rests on for this
// same class of command: the screen moved. It is allowed to be weaker evidence
// because the hazard `unconfirmed` guards is absent — a local command sends
// nothing to the model, so doing it twice opens a view twice.

/** A session whose screen never echoes what was typed, but DOES redraw. */
function blindSessions({ redraw = true } = {}) {
  const sessions = fakeSessions();
  let frame = 0;
  sessions.screenText = async () => (redraw ? `frame ${frame++}` : "static");
  sessions.write = (_id, data) => { if (data === "\r") sessions.state.returns++; };
  return sessions;
}

test("a local command whose echo never lands is rescued by the screen moving", async () => {
  const s = store();
  const sessions = blindSessions({ redraw: true });
  const result = await deliverPrompt(sessions, "s1", "/usage", "command", { watch: false });
  // Not `unconfirmed`: the screen changed after the write, so the keystrokes
  // landed, and the submit branch's own proof then carries it.
  assert.notEqual(result, "unconfirmed", "a redrawing screen is proof the keys landed");
  const rec = s.store.get().signals["deliver.echo"];
  assert.equal(rec.via, "the screen moving", "and it is recorded as the fallback it is");
});

test("an ORDINARY prompt gets no such rescue — it could be sent twice", async () => {
  store();
  const sessions = blindSessions({ redraw: true });
  const result = await deliverPrompt(sessions, "s1", "do the thing", "prompt", { watch: false });
  assert.equal(result, "unconfirmed", "a prompt with no echo and no log is still ambiguous");
});

test("a local command on a screen that never moves is still unconfirmed", async () => {
  store();
  const sessions = blindSessions({ redraw: false });
  const result = await deliverPrompt(sessions, "s1", "/usage", "command", { watch: false });
  assert.equal(result, "unconfirmed", "nothing changed, so nothing is proven");
});

test("an interjection the CLI names back IS provable, and is recorded as a good", async () => {
  // The other side of the first test in this file, and the reason it is not a
  // contradiction of it: what could not be proved there was a turn START, which
  // an interjection has already spent before its Return exists. The prompt hook
  // is a different fact — the CLI naming the words it took — and it is true of
  // exactly one delivery. So the same interjection that records NOTHING without
  // it records a `good` with it, and the health rate stops being a measurement
  // of how the person likes to work.
  const h = store();
  const sessions = fakeSessions({
    hooked: true,
    turnActive: true,
    onReturn: (s) => {
      s.scrollback += "x".repeat(200);
      s.submitted.push({ prompt: TEXT, claimed: false, at: Date.now() });
    },
  });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { interactive: true, watch: false });
  assert.equal(result, "ok");
  const sig = h.submit();
  assert.ok(sig, "a proof that exists is a proof worth recording");
  assert.equal(sig.window.at(-1).ok, true);
  assert.equal(sig.window.at(-1).fallback ?? false, false, "the prompt hook is the primary rule, not a rescue");
});

test("one hook event cannot prove two deliveries of the same words", async () => {
  // `claimSubmittedPrompt` spends its match. Two sends of an identical text —
  // `continue`, or the sweep re-sending a prompt it proved never ran — would
  // otherwise both read one `UserPromptSubmit` as their own, and the second
  // would be reported `ok` having never run. Same rule, same reason, as
  // `settle.ts`'s spent-turn ledger.
  const h = store();
  const submitted = [];
  const first = fakeSessions({ hooked: true, turnActive: true, submitted, onReturn: () => submitted.push({ prompt: TEXT, claimed: false, at: Date.now() }) });
  await deliverPrompt(first, "s1", TEXT, "prompt", { interactive: true, watch: false });
  assert.equal(h.submit().window.at(-1).ok, true, "the first delivery claims the event");
  // The second one presses its own Return into a session whose CLI files
  // nothing this time: the only event on the ledger is already spent.
  const second = fakeSessions({ hooked: true, turnActive: true, submitted });
  await deliverPrompt(second, "s1", TEXT, "prompt", { interactive: true, watch: false });
  assert.equal(h.submit().window.length, 1, "and the second proves nothing, so it records nothing");
});

// ── A side channel's landing (`sources.delivery`, WP1c) ────────────────────
//
// The source rung is the prompt hook's twin: the backend's own record of a user
// message whose text EQUALS ours. Two things are pinned here and both are about
// WHEN it may count. It proves a submit — so a hooked session whose turn-start
// never arrives is `ok` instead of `unsubmitted` — and it is asked only once a
// Return has gone in, floored at that press, so words merely typed (or an
// identical message from before) can never stand in for the keystroke.

/**
 * A fake backend channel: `messages` is its record of user turns, `landed` the
 * real contract (resolve true when a message equal to `text` lands at or after
 * `sinceMs`, false at the timeout), and every call is logged with the number of
 * Returns the double had seen at that moment.
 */
function fakeChannel(sessions, { state = "up" } = {}) {
  const ch = { messages: [], calls: [] };
  const session = { id: "s1", cwd: "/tmp/x", spawnedAt: 0 };
  const health = () => ({ state, since: 0 });
  const delivery = {
    landed: async (_s, text, sinceMs, timeoutMs) => {
      ch.calls.push({ sinceMs, returnsAtCall: sessions.state.returns });
      const deadline = Date.now() + Math.min(timeoutMs, 3000);
      for (;;) {
        if (ch.messages.some((m) => m.text === text && m.at >= sinceMs)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    userTurns: async () => ch.messages.map((m, i) => ({ id: `m${i}`, ...m })),
  };
  setLiveSourceLookup((id) => (id === "s1"
    ? { session, sources: { delivery, attach: async () => ({ close: async () => {}, health }) }, health }
    : null));
  return ch;
}

test("a source landing proves the submit, and only after the Return", async (t) => {
  t.after(() => setLiveSourceLookup(null));
  const h = store();
  // A hooked session whose CLI never reports the turn: without a source this is
  // five Returns, no proof, and `unsubmitted`.
  let ch;
  const sessions = fakeSessions({
    hooked: true,
    onReturn: () => { ch.messages.push({ text: TEXT, at: Date.now() }); },
  });
  ch = fakeChannel(sessions);
  const startedAt = Date.now();
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "ok", "the channel named our words, after our Return");
  assert.equal(sessions.state.returns, 1, "one press: the landing answered it");
  assert.equal(ch.calls.length, 1, "subscribed once for the whole delivery");
  assert.equal(ch.calls[0].returnsAtCall, 0, "armed AT the first press…");
  assert.ok(ch.calls[0].sinceMs >= startedAt, "…and floored at it, never earlier");
  assert.equal(h.submit(), null, "a side channel answering is not an observation about the claude TUI");
});

test("a source landing from BEFORE the Return proves nothing", async (t) => {
  t.after(() => setLiveSourceLookup(null));
  store();
  // The channel reports our words the moment they are TYPED — inside this
  // delivery's own window, so a floor at the delivery's start would accept it —
  // and the TUI is mid-draw for a moment, so the Return comes ≥150 ms later.
  // Every Return is then swallowed. Only a floor at the PRESS refuses it.
  const sessions = fakeSessions({ hooked: true });
  const ch = fakeChannel(sessions);
  const realWrite = sessions.write;
  let busyOnce = false;
  sessions.idleMs = () => (busyOnce ? ((busyOnce = false), 0) : 300);
  sessions.write = (id, data) => {
    if (data !== "\r") { ch.messages.push({ text: TEXT, at: Date.now() }); busyOnce = true; }
    realWrite(id, data);
  };
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "unsubmitted", "typed words are not a user turn; the Return is still unproven");
  assert.equal(sessions.state.returns, 5, "the ladder pressed exactly as it always has");
});

test("a source on an UNHOOKED session replaces the press-and-look fallback, recording nothing", async (t) => {
  t.after(() => setLiveSourceLookup(null));
  const h = store();
  let ch;
  const sessions = fakeSessions({
    hooked: false,
    onReturn: (s) => { s.scrollback += "x".repeat(200); ch.messages.push({ text: TEXT, at: Date.now() }); },
  });
  ch = fakeChannel(sessions);
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "ok");
  assert.equal(h.submit(), null, "proved by the channel, so no `press-and-look` fallback is filed");
});

test("a DOWN channel is never asked, and the delivery is today's", async (t) => {
  t.after(() => setLiveSourceLookup(null));
  const h = store();
  const sessions = fakeSessions({ hooked: false, onReturn: (s) => { s.scrollback += "x".repeat(200); } });
  const ch = fakeChannel(sessions, { state: "down" });
  const result = await deliverPrompt(sessions, "s1", TEXT, "prompt", { watch: false });
  assert.equal(result, "ok");
  assert.equal(ch.calls.length, 0, "no subscription against a channel that cannot answer");
  assert.equal(h.submit().via, "press-and-look", "the fallback is recorded exactly as without a source");
});

test("a SHELL (caps.turns false) gets exactly one Return, never the press-and-look re-press", async () => {
  // In a shell a second Return is a second (empty) command, and a quiet screen
  // after `cd x` is the normal answer, not a swallowed key. So: the echo was
  // seen, one Return, `ok` — even though the screen never grows.
  store();
  const sessions = fakeSessions({ backend: "shell" });
  sessions.healthScope = () => false; // the shell descriptor's `healthScope: false`
  const result = await deliverPrompt(sessions, "s1", "echo hello", "prompt", { watch: false });
  assert.equal(result, "ok");
  assert.equal(sessions.state.returns, 1, "one Return, however quiet the screen stays");
  // …and the same double as a claude session presses again on a quiet screen.
  const claude = fakeSessions({});
  await deliverPrompt(claude, "s1", "echo hello", "prompt", { watch: false });
  assert.ok(claude.state.returns > 1, "the contrast: an agent's quiet screen is re-pressed");
});

test("a SHELL never runs a line before the confirmed Return: multi-line goes in as ONE bracketed paste, or not at all", async () => {
  store();
  // Bracketed paste on (zsh, bash 5.1+): the whole text in one paste, then ONE Return.
  const zsh = fakeSessions({ backend: "shell" });
  zsh.healthScope = () => false;
  zsh.shellLineFacts = async () => ({ front: null, bracketed: true });
  const writes = [];
  const w = zsh.write;
  zsh.write = (id, data) => { writes.push(data); w(id, data.replace(/\x1b\[20[01]~/g, "")); }; // the shell draws the text, not the markers
  assert.equal(await deliverPrompt(zsh, "s1", "echo one\necho two", "prompt", { watch: false }), "ok");
  assert.deepEqual(writes, ["\x1b[200~echo one\necho two\x1b[201~", "\r"], "one paste, one Return — no raw newline ever typed");
  // No bracketed paste (/bin/sh, bash 3.2): refused in words, nothing typed.
  const sh = fakeSessions({ backend: "shell" });
  sh.healthScope = () => false;
  sh.shellLineFacts = async () => ({ front: null, bracketed: false });
  let typed = 0;
  sh.write = () => { typed++; };
  let said = "";
  assert.equal(await deliverPrompt(sh, "s1", "echo one\necho two", "prompt", { watch: false, onDetail: (d) => { said = d; } }), "retry");
  assert.equal(typed, 0, "not a byte typed");
  assert.match(said, /one line at a time/);
  // A single line is untouched.
  const one = fakeSessions({ backend: "shell" });
  one.healthScope = () => false;
  one.shellLineFacts = async () => ({ front: null, bracketed: false });
  assert.equal(await deliverPrompt(one, "s1", "echo one", "prompt", { watch: false }), "ok");
  assert.equal(one.state.screen, "echo one");
});

test("a SHELL with a program in front is not typed into — unless that program is asking for a code", async () => {
  store();
  const busy = fakeSessions({ backend: "shell" });
  busy.healthScope = () => false;
  busy.shellLineFacts = async () => ({ front: "vim", bracketed: false });
  let typed = 0;
  busy.write = () => { typed++; };
  let said = "";
  assert.equal(await deliverPrompt(busy, "s1", ":wq", "prompt", { watch: false, onDetail: (d) => { said = d; } }), "retry");
  assert.equal(typed, 0);
  assert.match(said, /the shell is running `vim` — use the keys, or quit it first/);
  // gcloud (python) waiting on "Enter the authorization code:" — the links reader saw it ask.
  const asking = fakeSessions({ backend: "shell" });
  asking.healthScope = () => false;
  asking.shellLineFacts = async () => ({ front: "python3", bracketed: false });
  asking.get().awaitingCode = true;
  assert.equal(await deliverPrompt(asking, "s1", "4/0AbCd", "prompt", { watch: false }), "ok");
  // …and a claude session is never asked at all.
  const claude = fakeSessions({});
  claude.shellLineFacts = async () => { throw new Error("never asked"); };
  claude.state.scrollback = "";
  const r = await deliverPrompt(claude, "s1", "line one\nline two", "prompt", { watch: false });
  assert.notEqual(r, "retry");
});
