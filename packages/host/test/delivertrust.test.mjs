/**
 * A folder-trust question on screen at delivery time — CLAUDE's is answered by delivery itself,
 * every other CLI's is the person's (final review B1, `docs/analysis/backend-parity-v3/review-final.md`).
 *
 * The incident this pins: delivery tested the squashed screen against claude's trust words, scoped
 * only on "not a shell", so a Gemini session showing "Do you trust the files in this folder?" got
 * `1⏎` typed into it on any delivery — and on Gemini a digit selects AND submits, trusting the
 * repo's own hooks and servers for good. Nobody tapped anything.
 *
 * Now (`backends/derive.ts`'s `trustRule`): `delivery.autoAcceptsTrust` (claude's alone) answers;
 * any other backend whose screen shows claude's words or its own `delivery.trustPromptRe` gets
 * `retry` with a sentence naming it, and NOTHING is written. Auto-fire (`sessions/drive.ts`'s
 * `autoFireBlocker`) never walks into another CLI's trust box either.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

const { deliverPrompt } = await import("../dist/deliver.js");
const { trustRule } = await import("../dist/backends/derive.js");
const { resolveBackend } = await import("../dist/backends/index.js");
const { registerBackend, unregisterBackend } = await import("../dist/backends/registry.js");
const { pluginDescriptor } = await import("../dist/plugins/pluginapi.js");
const { autoFireBlocker } = await import("../dist/sessions/drive.js");
const { claudeBackend } = await import("../dist/backends/claude.js");

/** Gemini's own trust box, as measured (`screenq.mjs` in the plugin), and its include-dirs twin. */
const GEMINI_TRUST = [
  "Do you trust the files in this folder?",
  "",
  "● 1. Trust folder (/Users/me/repo)",
  "  2. Trust parent folder (/Users/me)",
  "  3. Don't trust",
].join("\n");
const ACME_TRUST = "Allow Acme to work in this workspace?\n  1. Allow\n  2. Leave";

const def = (id, delivery = {}) => ({
  id, label: id === "gem" ? "Gemini CLI" : "Acme CLI", bin: () => id,
  prepare: async () => ({ args: [], instructionsVia: "none", askRulesVia: "none" }),
  caps: { turns: true, slash: "none", remoteControl: false, permissionModes: [] },
  facts: {}, measured: { versions: [], version: async () => null }, models: async () => ({ aliases: [], ids: [] }),
  delivery,
});
// A plugin cannot claim the auto-accept: `normDelivery` builds a fresh object without it.
registerBackend(pluginDescriptor(def("gem", { autoAcceptsTrust: true }), "Gem"));
registerBackend(pluginDescriptor(def("acme", { trustPromptRe: /allowacmetoworkinthisworkspace/g }), "Acme"));
after(() => { unregisterBackend("gem"); unregisterBackend("acme"); });

/** The smallest session manager `deliverPrompt` accepts (`deliversubmit.test.mjs`'s shape). */
function fakeSessions({ backend, screen, onWrite = () => {} }) {
  const state = { screen, writes: [] };
  const info = { id: "s1", running: true, ...(backend ? { backend } : {}), turnActive: false };
  return {
    state,
    get: () => info,
    idleMs: () => 300,
    waitReady: async () => true,
    screenText: async () => state.screen,
    scrollback: () => "",
    recordPrompt: () => {},
    isHooked: () => false,
    stopCount: () => 0,
    geometry: () => ({ cols: 80, rows: 30 }),
    claimSubmittedPrompt: () => false,
    lastSubmittedPrompt: () => null,
    turnFromHook: () => false,
    keepsClaudeLog: () => false,
    getTranscript: () => null,
    noteHookFallback: () => {},
    healthScope: () => false,
    write: (_id, data) => { state.writes.push(data); onWrite(state, data); },
  };
}

const TEXT = "look at the failing test";
/** `deliverPrompt` answers the verdict; the sentence rides `opts.onDetail`. */
async function deliver(sessions) {
  let detail;
  const result = await deliverPrompt(sessions, "s1", TEXT, "backlog", { onDetail: (d) => { detail = d; } });
  return { result, detail };
}

test("trustRule: claude's family answers its own box; a shell and a plugin never do", () => {
  for (const id of ["claude", "claude-local", "claude-endpoint"]) {
    let b; try { b = resolveBackend(id); } catch { continue; }
    assert.equal(trustRule(b).autoAccept, true, id);
  }
  assert.equal(trustRule(resolveBackend("shell")).autoAccept, false);
  assert.equal(trustRule(resolveBackend("gem")).autoAccept, false, "a plugin's delivery cannot carry the flag");
  assert.equal(trustRule(null).autoAccept, false, "an unknown backend is never answered");
});

test("trustRule: claude's words are claude's own literal, asked of every backend", () => {
  assert.equal(claudeBackend.delivery.trustPromptRe.source, "trustthisfolder|createdoroneyoutrust|doyoutrust");
  const gem = trustRule(resolveBackend("gem"));
  assert.equal(gem.asks("doyoutrustthefilesinthisfolder?"), true);
  assert.match(gem.refusal, /^Gemini CLI is asking whether to trust this folder/);
});

test("trustRule: a plugin's own regex is asked too, and a /g flag keeps no state between screens", () => {
  const acme = trustRule(resolveBackend("acme"));
  for (let i = 0; i < 3; i++) assert.equal(acme.asks("allowacmetoworkinthisworkspace?1.allow"), true, `look ${i}`);
  assert.equal(acme.asks("nothinghere"), false);
});

test("a Gemini trust box at delivery: retry naming Gemini, NOTHING typed", async () => {
  const sessions = fakeSessions({ backend: "gem", screen: GEMINI_TRUST });
  const r = await deliver(sessions);
  assert.equal(r.result, "retry");
  assert.match(r.detail ?? "", /^Gemini CLI is asking whether to trust this folder — answer it on the phone or in the terminal/);
  assert.deepEqual(sessions.state.writes, [], "not a digit, not a Return, not the words");
});

test("a backend's OWN trustPromptRe at delivery: retry, nothing typed", async () => {
  const sessions = fakeSessions({ backend: "acme", screen: ACME_TRUST });
  const r = await deliver(sessions);
  assert.equal(r.result, "retry");
  assert.match(r.detail ?? "", /^Acme CLI is asking whether to trust this folder/);
  assert.deepEqual(sessions.state.writes, []);
});

test("claude: its own numbered trust box is still answered by delivery (keys first, then the words)", async () => {
  const sessions = fakeSessions({
    screen: "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit",
    // Answered ⇒ claude boots to its composer; the words then echo where they are typed.
    onWrite: (st, d) => { st.screen = d === "1\r" ? "? for shortcuts" : d === "\r" ? st.screen : d; },
  });
  const r = await deliver(sessions);
  assert.equal(sessions.state.writes[0], "1\r", "today's keys, unchanged");
  assert.ok(sessions.state.writes.includes(TEXT), "the delivery went on to type the words");
  assert.notEqual(r.detail ?? "", trustRule(claudeBackend).refusal);
});

test("auto-fire: another CLI's trust box blocks in words; claude's does not", () => {
  const mk = (backend) => {
    const s = { info: { id: "s1", running: true, prompt: { kind: "trust", options: [] } }, hooksActive: true, turnActive: false, backend };
    return { sessions: new Map([["s1", s]]) };
  };
  assert.equal(autoFireBlocker(mk(resolveBackend("gem")), "s1", 1000), trustRule(resolveBackend("gem")).refusal);
  assert.equal(autoFireBlocker(mk(claudeBackend), "s1", 1000), null, "claude's trust box: delivery accepts it, as ever");
});
