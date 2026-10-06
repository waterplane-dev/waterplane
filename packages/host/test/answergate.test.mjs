/**
 * The answer gate (`answergate.ts`): every condition in docs/notes/plugins.md
 * "The answer gate" refuses in words and types nothing, and an accepted answer
 * goes through the SAME dispatcher a phone's tap does (`sessions.answerBox`,
 * which picks the CLI's own channel, the walk or `"<n>\r"`) — the gate holds no
 * typing verb of its own — with a decision row and an `autofire` notification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { gateAnswer, gateRefusal, isBlocked, isBlockedText } = await import("../dist/answergate.js");
const { promptFingerprint } = await import("@waterplane/shared");

const box = (over = {}) => ({ kind: "select", question: "Which layout?", options: [{ index: 1, label: "Grid" }, { index: 2, label: "List" }], ...over });
const base = (over = {}) => {
  const prompt = over.prompt === undefined ? box() : over.prompt;
  return { pluginName: "Echo", answers: true, sessionLive: true, switchOn: true, prompt, told: prompt ? promptFingerprint(prompt) : null, choice: 2, ...over };
};

test("gateRefusal: each condition refuses in words", () => {
  assert.equal(gateRefusal(base()), null);
  assert.match(gateRefusal(base({ answers: false })), /did not declare "answers"/);
  assert.match(gateRefusal(base({ sessionLive: false })), /not running/);
  assert.match(gateRefusal(base({ switchOn: false })), /"let Echo answer" is off/);
  assert.match(gateRefusal(base({ prompt: null })), /no question is open/);
  assert.match(gateRefusal(base({ told: promptFingerprint(box({ question: "Other?" })) })), /not the one the plugin was told about/);
  assert.match(gateRefusal(base({ told: null })), /not the one the plugin was told about/);
  for (const kind of ["trust", "tool", "plan"]) {
    const p = box({ kind });
    assert.match(gateRefusal(base({ prompt: p, told: promptFingerprint(p) })), new RegExp(`a ${kind} box is always a person's call`));
  }
  const destructive = box({ question: "Force push to main?" });
  assert.match(gateRefusal(base({ prompt: destructive, told: promptFingerprint(destructive) })), /destructive, permission-granting or secret/);
  const multi = box({ multi: true });
  assert.match(gateRefusal(base({ prompt: multi, told: promptFingerprint(multi) })), /checkbox box/);
  assert.match(gateRefusal(base({ choice: 3 })), /3 is not one of the box's options/);
});

test("isBlocked / isBlockedText: the blocklist moved to core unchanged", () => {
  assert.equal(isBlocked(box()), false);
  assert.equal(isBlocked(box({ options: [{ index: 1, label: "Delete the branch" }] })), true);
  assert.equal(isBlocked(box({ question: "Enter API key" })), true, "squashed: 'api key' → 'apikey'");
  assert.equal(isBlockedText("I published the notes.\nShould I continue?"), false);
  assert.equal(isBlockedText("Shall I force-push this?"), true);
});

function deps(sessionInfo, answer = async () => ({ ok: true })) {
  const answered = []; const rows = []; const notes = [];
  return {
    answered, rows, notes,
    d: {
      sessions: {
        get: () => sessionInfo,
        answerBox: async (id, choice) => { answered.push([id, choice]); return answer(id, choice); },
      },
      decision: (r) => rows.push(r),
      notify: (k, p) => notes.push([k, p]),
    },
  };
}

const plugin = { id: "echo", name: "Echo", answers: true };

test("gateAnswer: refused ⇒ nothing answered; accepted ⇒ the tap's dispatcher, a decision row, an autofire note", async () => {
  const p = box();
  const info = { title: "demo", running: true, prompt: p, pluginAnswer: {} };
  const off = deps(info);
  const r0 = await gateAnswer(off.d, plugin, "s1", 2, "why", promptFingerprint(p));
  assert.equal(r0.ok, false);
  assert.match(r0.reason, /"let Echo answer" is off/);
  assert.deepEqual([off.answered, off.rows, off.notes], [[], [], []]);

  info.pluginAnswer = { echo: true };
  const on = deps(info);
  const r1 = await gateAnswer(on.d, plugin, "s1", 2, "list reads better", promptFingerprint(p));
  assert.deepEqual(r1, { ok: true });
  assert.deepEqual(on.answered, [["s1", 2]], "through answerBox, never a keystroke of the gate's own");
  assert.equal(on.rows.length, 1);
  assert.equal(on.rows[0].source, "plugin");
  assert.equal(on.rows[0].plugin, "echo");
  assert.equal(on.rows[0].outcome, "answered");
  assert.equal(on.rows[0].answer, "List");
  assert.equal(on.notes[0][0], "autofire");

  // An unnumbered box goes through the same dispatcher — answerBox decides
  // walk vs digit vs the CLI's own channel, not the gate.
  const nav = box({ nav: true });
  const navInfo = { title: "demo", running: true, prompt: nav, pluginAnswer: { echo: true } };
  const w = deps(navInfo);
  assert.deepEqual(await gateAnswer(w.d, plugin, "s1", 1, "", promptFingerprint(nav)), { ok: true });
  assert.deepEqual(w.answered, [["s1", 1]]);
});

test("gateAnswer: the dispatcher's refusal is the gate's answer, recorded as an error", async () => {
  const p = box();
  const info = { title: "demo", running: true, prompt: p, pluginAnswer: { echo: true } };
  const gone = deps(info, async () => ({ ok: false, reason: "that question is no longer open — it was answered or withdrawn" }));
  const r = await gateAnswer(gone.d, plugin, "s1", 1, "", promptFingerprint(p));
  assert.deepEqual(r, { ok: false, reason: "that question is no longer open — it was answered or withdrawn" });
  assert.equal(gone.rows[0].outcome, "error");
  assert.match(gone.rows[0].error, /no longer open/);
  assert.deepEqual(gone.notes, [], "no autofire note for an answer that did not land");
});

test("gateAnswer: the gate's refusals hold before the dispatcher is ever asked", async () => {
  const tool = box({ kind: "tool", nav: true, askId: "per_1" });
  const info = { title: "demo", running: true, prompt: tool, pluginAnswer: { echo: true } };
  const x = deps(info);
  const r = await gateAnswer(x.d, plugin, "s1", 1, "", promptFingerprint(tool));
  assert.match(r.reason, /a tool box is always a person's call/);
  assert.deepEqual(x.answered, [], "a permission the CLI posed on its own channel is still a person's call");
});

// ── standing rules ──────────────────────────────────────────────────────────
test("gateRule: no rule, another session, plugin backend or key ⇒ refused in words; the tapped rule ⇒ allowed and audited; cleared on exit/switch-off", async () => {
  const { gateRule, rememberRule, rulesFor, forgetRules, ruleRefusal, sessionRules } = await import("../dist/answergate.js");
  forgetRules({});
  const decisions = [], notes = [];
  const sess = { s1: { title: "one", running: true, backend: "copilot" }, s2: { title: "two", running: true, backend: "copilot" }, s3: { title: "gone", running: false, backend: "copilot" } };
  const deps = { sessions: { get: (id) => sess[id] ?? null }, decision: (r) => decisions.push(r), notify: (k, p) => notes.push([k, p]) };
  const copilot = { id: "copilot", name: "Copilot", answers: true, backends: ["copilot"] };
  const other = { id: "other", name: "Other", answers: true, backends: ["othercli"] };

  assert.match(gateRule(deps, copilot, "s1", "touch a.txt", "").reason, /no rule a person made on this session for Copilot covers that/);
  assert.deepEqual(decisions, [], "a refusal writes nothing");
  assert.ok(rememberRule({ sessionId: "s1", plugin: "copilot", backend: "copilot", key: "touch a.txt", label: "touch a.txt" }));
  assert.equal(rememberRule({ sessionId: "s1", plugin: "copilot", backend: "copilot", key: "", label: "x" }), null, "no key, no rule");
  assert.equal(rememberRule({ sessionId: "s1", plugin: "copilot", backend: "copilot", key: "x".repeat(3000), label: "x" }), null, "a rule names one request");
  assert.equal(rememberRule({ sessionId: "s1", plugin: undefined, backend: "copilot", key: "k", label: "k" }), null, "no owning plugin, no rule");

  assert.match(gateRule(deps, copilot, "s2", "touch a.txt", "").reason, /no rule a person made/, "another session");
  assert.match(gateRule(deps, copilot, "s1", "touch b.txt", "").reason, /no rule a person made/, "another key");
  assert.match(gateRule(deps, copilot, "s1", "touch a.txt ", "").reason, /no rule a person made/, "exact key only");
  assert.match(gateRule(deps, other, "s1", "touch a.txt", "").reason, /not a backend Other declares/, "another plugin");
  assert.match(gateRule(deps, copilot, "s3", "touch a.txt", "").reason, /not running/);
  assert.match(gateRule(deps, copilot, "nope", "touch a.txt", "").reason, /not running/);
  assert.deepEqual(decisions, []);

  assert.deepEqual(gateRule(deps, copilot, "s1", "touch a.txt", "the same command again"), { ok: true });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].plugin, "copilot");
  assert.equal(decisions[0].outcome, "answered");
  assert.match(decisions[0].question, /Allowed by a standing rule: touch a\.txt/);
  assert.equal(notes[0][0], "autofire");
  assert.equal(rulesFor("s1", "copilot")[0].uses, 1);
  assert.deepEqual(rulesFor("s1", "other"), [], "another plugin sees none");
  assert.deepEqual(Object.keys(sessionRules("s1")), ["copilot"], "the wire's copy, by plugin");
  assert.equal(sessionRules("s1").copilot[0].uses, 1);
  assert.equal(sessionRules("s9"), undefined, "absent, never an empty object");

  // cleared: the session's exit, the plugin's switch-off (by its id)
  rememberRule({ sessionId: "s2", plugin: "copilot", backend: "copilot", key: "k", label: "k" });
  assert.equal(forgetRules({ sessionId: "s1" }), 1);
  assert.match(ruleRefusal({ pluginId: "copilot", pluginName: "Copilot", answers: true, backends: ["copilot"], session: sess.s1, sessionId: "s1", key: "touch a.txt" }), /no rule/);
  assert.equal(forgetRules({ plugin: "copilot" }), 1);
  assert.deepEqual(rulesFor("s2", "copilot"), []);
});

test("gateRule: a plugin that never declared `answers` cannot answer through a rule either", async () => {
  const { gateRule, rememberRule, forgetRules } = await import("../dist/answergate.js");
  forgetRules({});
  const decisions = [];
  const deps = { sessions: { get: () => ({ title: "one", running: true, backend: "copilot" }) }, decision: (r) => decisions.push(r), notify: () => {} };
  rememberRule({ sessionId: "s1", plugin: "copilot", backend: "copilot", key: "touch a.txt", label: "touch a.txt" });
  const r = gateRule(deps, { id: "copilot", name: "Copilot", answers: false, backends: ["copilot"] }, "s1", "touch a.txt", "");
  assert.equal(r.ok, false);
  assert.match(r.reason, /Copilot did not declare "answers" in its manifest, so it may only suggest/);
  assert.deepEqual(decisions, [], "nothing audited, nothing answered");
  forgetRules({});
});

test("gateRule: plugin B declaring the same backend cannot use the rule a person made on plugin A's dialog", async () => {
  const { gateRule, rememberRule, rulesFor, forgetRules, ruleRefusal } = await import("../dist/answergate.js");
  forgetRules({});
  const decisions = [];
  const deps = { sessions: { get: () => ({ title: "one", running: true, backend: "copilot" }) }, decision: (r) => decisions.push(r), notify: () => {} };
  rememberRule({ sessionId: "s1", plugin: "a", backend: "copilot", key: "touch a.txt", label: "touch a.txt" });
  const b = { id: "b", name: "B", answers: true, backends: ["copilot"] };
  assert.match(gateRule(deps, b, "s1", "touch a.txt", "").reason, /no rule a person made on this session for B covers that/);
  assert.equal(ruleRefusal({ pluginId: "a", pluginName: "A", answers: true, backends: ["copilot"], session: { running: true, backend: "copilot" }, sessionId: "s1", key: "touch a.txt" }), null, "A still may");
  assert.deepEqual(rulesFor("s1", "b"), [], "B lists none");
  assert.equal(forgetRules({ sessionId: "s1", plugin: "b" }), 0, "B's forget leaves A's rule alone");
  assert.equal(rulesFor("s1", "a").length, 1);
  assert.deepEqual(decisions, []);
  forgetRules({});
});
