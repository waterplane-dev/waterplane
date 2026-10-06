import test from "node:test";
import assert from "node:assert/strict";

import {
  actionKey, changedValues, cutDecisions, decisionSources, envRows, fieldValue, globalActions, nextToggleValue,
  parseFieldInput, pluginName, pluginStateLine, sessionBadges, sessionControls, sourceLabel,
} from "./logic.ts";

const manifest = {
  id: "oracle", name: "Decision oracle", version: "1.0.0", apiVersion: 1,
  settings: [
    { kind: "switch", key: "autofire", label: "auto-fire", default: false },
    { kind: "choice", key: "model", label: "model", default: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { kind: "number", key: "cap", label: "break after", default: 5, min: 0, max: 50 },
    { kind: "text", key: "policy", label: "guardrails", default: "be careful", multiline: true },
  ],
  actions: [
    { id: "test", label: "test the key", scope: "global" },
    { id: "propose", label: "draft a reply", scope: "session" },
  ],
  toggles: [{ id: "on", label: "oracle here", default: true }],
  env: ["GEMINI_API_KEY", "OTHER"],
  answers: true,
};
const view = (over = {}) => ({
  manifest, source: "/Users/x/dev/myapp-plugin-oracle", enabled: true, state: "active",
  values: { autofire: false, model: "a", cap: 5, policy: "be careful" }, env: { GEMINI_API_KEY: true }, ...over,
});

test("the state line says the load error verbatim, and says what off means", () => {
  assert.deepEqual(pluginStateLine(view()), { tone: "ok", text: "active" });
  const err = pluginStateLine(view({ state: "error", error: "apiVersion is 2; this waterplane speaks 1" }));
  assert.equal(err.tone, "bad");
  assert.match(err.text, /apiVersion is 2; this waterplane speaks 1$/);
  assert.match(pluginStateLine(view({ state: "error" })).text, /gave no reason/);
  assert.equal(pluginStateLine(view({ state: "off", enabled: false })).tone, "dim");
});

test("env rows are the declared names with set/unset — an absent answer is unset, never a value", () => {
  assert.deepEqual(envRows(view()), [{ name: "GEMINI_API_KEY", set: true }, { name: "OTHER", set: false }]);
});

test("a typed number outside its range or not a number is refused in words, never clamped", () => {
  const num = manifest.settings[2];
  assert.deepEqual(parseFieldInput(num, " 12 "), { ok: true, value: 12 });
  const hi = parseFieldInput(num, "99");
  assert.equal(hi.ok, false);
  assert.match(hi.why, /99 is outside 0–50/);
  assert.equal(parseFieldInput(num, "").ok, false);
  assert.match(parseFieldInput(num, "lots").why, /"lots" is not a number/);
  assert.deepEqual(parseFieldInput(manifest.settings[3], "line 1\nline 2"), { ok: true, value: "line 1\nline 2" });
  assert.equal(parseFieldInput(manifest.settings[1], "zzz").ok, false, "a choice not in the options is refused");
});

test("plugin.set carries only the changed key, and nothing when it did not change", () => {
  assert.deepEqual(changedValues(view(), "cap", 8), { cap: 8 });
  assert.equal(changedValues(view(), "model", "a"), null);
  assert.equal(fieldValue(view({ values: {} }), manifest.settings[2]), 5, "the manifest default fills a missing value");
});

test("global actions are the Settings buttons; session ones are not", () => {
  assert.deepEqual(globalActions(view()).map((a) => a.id), ["test"]);
});

test("a session shows an active plugin's toggles, its answer switch and its session actions", () => {
  const [g] = sessionControls([view()], {});
  assert.equal(g.name, "Decision oracle");
  assert.deepEqual(g.toggles.map((t) => [t.def.id, t.on, t.overridden]), [["on", true, false]]);
  assert.equal(g.mayAnswer, false, "the answer switch defaults OFF");
  assert.deepEqual(g.actions.map((a) => a.id), ["propose"]);

  const [h] = sessionControls([view()], { pluginToggles: { oracle: { on: false } }, pluginAnswer: { oracle: true } });
  assert.deepEqual(h.toggles.map((t) => [t.on, t.overridden]), [[false, true]]);
  assert.equal(h.mayAnswer, true);
});

test("an off or failed plugin draws nothing on a session, and one without answers has no answer switch", () => {
  assert.deepEqual(sessionControls([view({ state: "off" }), view({ state: "error" })], {}), []);
  assert.deepEqual(sessionControls(null, {}), []);
  const quiet = view({ manifest: { ...manifest, answers: false, toggles: [], actions: [] } });
  assert.deepEqual(sessionControls([quiet], {}), [], "nothing to draw is no group at all");
  const suggestOnly = view({ manifest: { ...manifest, answers: undefined } });
  assert.equal(sessionControls([suggestOnly], {})[0].mayAnswer, null);
});

test("a plugin that adds backends draws only on a session running one of them", () => {
  const copilot = view({ manifest: { ...manifest, backends: ["copilot"] } });
  assert.deepEqual(sessionControls([copilot], {}), [], "absent backend is claude");
  assert.deepEqual(sessionControls([copilot], { backend: "claude" }), []);
  assert.equal(sessionControls([copilot], { backend: "copilot" }).length, 1);
  assert.equal(sessionControls([view()], { backend: "copilot" }).length, 1, "no backends = every session");
});

test("a flip back to the manifest default is sent as null, so the session follows the default", () => {
  const def = { id: "on", label: "x", default: true };
  assert.equal(nextToggleValue({ def, on: true, overridden: false }), false);
  assert.equal(nextToggleValue({ def, on: false, overridden: true }), null);
});

test("badges carry the plugin's name when known, else its id, in a stable order; blank ones are dropped", () => {
  const s = { pluginBadges: { zeta: { text: "paused", tone: "warn" }, oracle: { text: "on · 3/10", tone: "ok" }, blank: { text: " ", tone: "dim" } } };
  assert.deepEqual(sessionBadges(s, [view()]).map((b) => [b.id, b.name, b.badge.text]),
    [["oracle", "Decision oracle", "on · 3/10"], ["zeta", "zeta", "paused"]]);
  assert.deepEqual(sessionBadges({}, null), []);
  assert.equal(pluginName(null, "gone"), "gone");
});

test("an action's result is filed per button and per session", () => {
  assert.notEqual(actionKey("p", "a"), actionKey("p", "a", "s1"));
  assert.notEqual(actionKey("p", "a", "s1"), actionKey("p", "a", "s2"));
});

const row = (o) => ({ id: o.id, ts: o.ts, sessionId: o.s ?? "s1", sessionTitle: "t", source: o.source ?? "plugin", plugin: o.plugin,
  question: "q", options: [], outcome: o.outcome ?? "suggested", choice: null, rationale: "", archived: o.archived });

test("the decision log cut: session, source, archived — newest first, and the counts come from the same cut", () => {
  const entries = [
    row({ id: "1", ts: 1, source: "limit", outcome: "limit" }),
    row({ id: "2", ts: 3, plugin: "oracle" }),
    row({ id: "3", ts: 2, plugin: "oracle", archived: true }),
    row({ id: "4", ts: 4, plugin: "other", s: "s2" }),
  ];
  const all = cutDecisions(entries, { sessionId: null, source: null, showArchived: false });
  assert.deepEqual(all.shown.map((e) => e.id), ["4", "2", "1"]);
  assert.equal(all.archived, 1);

  const s1 = cutDecisions(entries, { sessionId: "s1", source: "plugin:oracle", showArchived: true });
  assert.deepEqual(s1.shown.map((e) => e.id), ["2", "3"]);
  assert.equal(s1.inScope.length, 3);

  assert.deepEqual(decisionSources(all.inScope), [{ key: "limit", n: 1 }, { key: "plugin:oracle", n: 2 }, { key: "plugin:other", n: 1 }]);
  assert.equal(sourceLabel("plugin:oracle", [view()]), "Decision oracle");
  assert.equal(sourceLabel("plugin:other", [view()]), "other");
  assert.equal(sourceLabel("limit", null), "usage limit");
});

test("standing rules on a session: from host state, by plugin, each a line saying what it allows and how often it answered", async () => {
  const { sessionRuleGroups, ruleLine } = await import("./logic.ts");
  assert.deepEqual(sessionRuleGroups({}, null), [], "none ⇒ nothing drawn");
  const s = { pluginRules: { zed: [{ label: "ls", at: 1, uses: 0 }], oracle: [{ label: "touch a.txt", at: 1, uses: 2 }, { label: " ", at: 2, uses: 1 }], empty: [] } };
  const g = sessionRuleGroups(s, [view()]);
  assert.deepEqual(g.map((x) => [x.id, x.name]), [["oracle", "Decision oracle"], ["zed", "zed"]]);
  assert.deepEqual(g[0].lines, ["touch a.txt — answered 2 times without asking", "a request — answered 1 time without asking"]);
  assert.deepEqual(g[1].lines, ["ls — not used yet"]);
  assert.equal(ruleLine({ label: "x", uses: -3 }), "x — not used yet");
});
