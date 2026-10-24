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

// ── Ask rules held by the gate (`askRulesVia: "gate"`, backend contract v2) ──
//
// A CLI with allow/deny but no ASK (Copilot 1.0.91) cannot hold "always ask before `git push`"
// itself, so the host's gate does: a plugin's automatic answer on a dialog that names a rule's
// command is refused, and the sentence names the rule. A person's tap is untouched.
const { askRuleMatches, askRuleHit } = await import("../dist/askrules.js");
const gate = await import("../dist/answergate.js");

test("askRuleMatches: the rule's pattern ANYWHERE in the dialog's words; a bare tool or a lone * matches nothing", () => {
  assert.equal(askRuleMatches("Bash(git push*)", "Run git push origin main?"), true);
  assert.equal(askRuleMatches("Bash(git push * main)", "Run `git push origin main` in /repo?"), true);
  assert.equal(askRuleMatches("Bash(git push * main)", "Run git push origin dev?"), false);
  assert.equal(askRuleMatches("Bash(npm publish*)", "Run NPM  Publish --tag next"), true, "case and whitespace runs are ignored");
  assert.equal(askRuleMatches("Bash(git push*)", "Run gitpush origin"), true, "a squashed render still matches");
  assert.equal(askRuleMatches("Bash(git push*)", "Run git status"), false);
  assert.equal(askRuleMatches("Bash", "Run git push"), false, "a bare tool rule names no command to look for");
  assert.equal(askRuleMatches("Bash(*)", "anything"), false, "a pattern of only * would refuse every dialog");
  assert.equal(askRuleMatches("Bash(a.b(c)*)", "run a.b(c) now"), true, "regex characters in a rule are literal");
  assert.equal(askRuleMatches("Bash(a.b*)", "run axb"), false);
  assert.equal(askRuleHit(["Bash(npm publish*)", "Bash(git push*)"], "git push origin"), "Bash(git push*)");
  assert.equal(askRuleHit([], "git push origin"), null);
});

test("gateRefusal with the gate's ask rules: a dialog naming `git push` is a person's, and the sentence names the rule", () => {
  // The rule is asked BEFORE the blocklist ("push" is on it), so the sentence says which rule.
  const p = box({ question: "Allow the shell command git push origin main?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }] });
  const g = base({ prompt: p, told: promptFingerprint(p), askRules: ["Bash(git push*)"] });
  assert.match(gateRefusal(g), /that question matches the ask rule Bash\(git push\*\) — a person's call/);
  // No rules held ⇒ the gate is exactly what it was (here: the blocklist's own sentence).
  assert.match(gateRefusal({ ...g, askRules: undefined }), /destructive, permission-granting or secret/);
  // A rule that does not match lets an ordinary answer through.
  assert.equal(gateRefusal(base({ askRules: ["Bash(git push*)"] })), null);
  // An option's label counts too: the command can be on the row, not the question.
  const onRow = box({ question: "Run this?", options: [{ index: 1, label: "Yes: npm publish" }, { index: 2, label: "No" }] });
  assert.match(gateRefusal(base({ prompt: onRow, told: promptFingerprint(onRow), askRules: ["Bash(npm publish*)"] })), /ask rule Bash\(npm publish\*\)/);
});

test("gateAnswer: only a session launched askRulesVia:\"gate\" is held to its launch's rules; they go with the session", async () => {
  const p = box({ question: "Run git push origin feature?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }] });
  const info = { title: "demo", running: true, prompt: p, pluginAnswer: { echo: true }, askRulesVia: "gate", cwd: "/nowhere" };
  gate.holdAskRules("g1", ["Bash(git push*)"]);
  assert.deepEqual([...gate.gateAskRules("g1", "/nowhere")], ["Bash(git push*)"]);
  const held = deps(info);
  const r = await gateAnswer(held.d, plugin, "g1", 1, "", promptFingerprint(p));
  assert.equal(r.ok, false);
  assert.match(r.reason, /ask rule Bash\(git push\*\)/);
  assert.deepEqual(held.answered, [], "nothing typed");
  // A native-rules session (claude: the CLI's own `permissions.ask`) is not the gate's business.
  const native = deps({ ...info, askRulesVia: "native" });
  gate.holdAskRules("g2", ["Bash(git push*)"]);
  const r2 = await gateAnswer(native.d, plugin, "g2", 1, "", promptFingerprint(p));
  assert.match(r2.reason ?? "", /destructive, permission-granting or secret/, "the ordinary blocklist, not a rule");
  // The session's end (no plugin named) drops what the gate held for it.
  gate.forgetRules({ sessionId: "g1" });
  assert.equal(gate.heldAskRules("g1"), undefined);
  assert.deepEqual([...gate.gateAskRules("g1", undefined)], [], "with no store and no launch record: none");
  gate.forgetRules({ sessionId: "g2" });
});

// ── a standing "don't ask again" never outranks an ask rule the gate holds ──
// Copilot (`askRulesVia:"gate"`): the repo's ask rules hold `git push*`. A person taps "Yes, and
// don't ask again" on `git push origin main` — that tap answers the dialog, but it must not leave a
// rule the plugin's `api.ruleAllows` can use to push next time with nobody asked; and a rule made
// before the ask rule existed is refused all the same.
test("gateRule: a standing rule whose request matches the gate's ask rules is refused, nothing audited", () => {
  gate.forgetRules({});
  const decisions = [], notes = [];
  const sess = {
    c1: { title: "copilot", running: true, backend: "copilot", askRulesVia: "gate", cwd: "/nowhere" },
    n1: { title: "native", running: true, backend: "copilot", askRulesVia: "native", cwd: "/nowhere" },
  };
  const deps = { sessions: { get: (id) => sess[id] ?? null }, decision: (r) => decisions.push(r), notify: (k, p) => notes.push([k, p]) };
  const copilot = { id: "copilot", name: "Copilot", answers: true, backends: ["copilot"] };
  gate.holdAskRules("c1", ["Bash(git push*)"]);
  gate.holdAskRules("n1", ["Bash(git push*)"]);
  // A rule a person made (say, before the repo's ask rules said otherwise): held, but not usable.
  gate.rememberRule({ sessionId: "c1", plugin: "copilot", backend: "copilot", key: "git push origin main", label: "git push origin main" });
  const r = gate.gateRule(deps, copilot, "c1", "git push origin main", "the same command again");
  assert.equal(r.ok, false);
  assert.match(r.reason, /matches the ask rule Bash\(git push\*\) — a person's call/);
  assert.deepEqual(decisions, [], "nothing audited");
  assert.deepEqual(notes, []);
  assert.equal(gate.rulesFor("c1", "copilot")[0].uses, 0, "never counted as used");
  // The key alone can carry the command when the label is the plugin's prose.
  gate.rememberRule({ sessionId: "c1", plugin: "copilot", backend: "copilot", key: "git push --force", label: "that shell command" });
  assert.match(gate.gateRule(deps, copilot, "c1", "git push --force", "").reason, /ask rule Bash\(git push\*\)/);
  // A rule that names no ask-rule command still answers.
  gate.rememberRule({ sessionId: "c1", plugin: "copilot", backend: "copilot", key: "touch a.txt", label: "touch a.txt" });
  assert.deepEqual(gate.gateRule(deps, copilot, "c1", "touch a.txt", ""), { ok: true });
  // A native-rules session is not the gate's business (the CLI's own ask outranks allow there).
  gate.rememberRule({ sessionId: "n1", plugin: "copilot", backend: "copilot", key: "git push origin main", label: "git push origin main" });
  assert.deepEqual(gate.gateRule(deps, copilot, "n1", "git push origin main", ""), { ok: true });
  // ruleRefusal itself takes the rules.
  assert.match(gate.ruleRefusal({ pluginId: "copilot", pluginName: "Copilot", answers: true, backends: ["copilot"], session: sess.c1, sessionId: "c1", key: "git push origin main", askRules: ["Bash(git push*)"] }), /ask rule/);
  assert.equal(gate.ruleRefusal({ pluginId: "copilot", pluginName: "Copilot", answers: true, backends: ["copilot"], session: sess.c1, sessionId: "c1", key: "git push origin main" }), null, "no rules passed ⇒ none consulted");
  gate.forgetRules({ sessionId: "c1" }); gate.forgetRules({ sessionId: "n1" });
});

test("rememberRule: a tap on a dialog that matches an ask rule keeps no rule", () => {
  gate.forgetRules({});
  const rules = ["Bash(git push*)"];
  assert.equal(gate.rememberRule({ sessionId: "c1", plugin: "copilot", backend: "copilot", key: "git push origin main", label: "git push origin main", askRules: rules }), null, "the key names it");
  assert.equal(gate.rememberRule({ sessionId: "c1", plugin: "copilot", backend: "copilot", key: "k1", label: "this command", askRules: rules, text: "Allow the shell command git push origin main?" }), null, "the dialog's words name it");
  assert.ok(gate.rememberRule({ sessionId: "c1", plugin: "copilot", backend: "copilot", key: "touch a.txt", label: "touch a.txt", askRules: rules, text: "Allow touch a.txt?" }));
  assert.deepEqual(gate.rulesFor("c1", "copilot").map((r) => r.key), ["touch a.txt"]);
  assert.equal(gate.dialogAskRuleHit(rules, { question: "Run it?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "Always", remember: { key: "git push", label: "x" } }] }), "Bash(git push*)", "a remember key counts");
  assert.equal(gate.dialogAskRuleHit([], { question: "git push", options: [] }), null);
  gate.forgetRules({});
});

test("holdAskRulesFor: a spawn that throws releases what the gate held; a native launch holds nothing", () => {
  assert.throws(() => gate.holdAskRulesFor("t1", "gate", ["Bash(git push*)"], () => { throw new Error("no tmux"); }), /no tmux/);
  assert.equal(gate.heldAskRules("t1"), undefined, "nothing left for a session that never registered");
  assert.equal(gate.holdAskRulesFor("t2", "gate", ["Bash(git push*)"], () => 7), 7);
  assert.deepEqual(gate.heldAskRules("t2"), ["Bash(git push*)"]);
  assert.equal(gate.holdAskRulesFor("t3", "native", ["Bash(git push*)"], () => 8), 8);
  assert.equal(gate.heldAskRules("t3"), undefined);
  gate.forgetRules({ sessionId: "t2" });
});
