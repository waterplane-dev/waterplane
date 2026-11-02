import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import {
  actionKey, changedValues, cutDecisions, decisionSources, envRows, fieldValue, globalActions, nextToggleValue,
  parseFieldInput, pluginName, pluginStateLine, pluginSearchWords, pluginWords, sessionBadges, sessionControls, sourceLabel,
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

test("a plugin's search words are everything its section says: name, id, description, fields, choices, buttons", () => {
  const w = pluginWords(view({ manifest: { ...manifest, description: "asks a second model" } }));
  for (const word of ["Decision oracle", "oracle", "asks a second model", "use Decision oracle", "auto-fire", "model", "A", "B", "break after", "guardrails", "test the key"]) {
    assert.ok(w.includes(word), `missing "${word}"`);
  }
  assert.equal(pluginSearchWords(null), "");
  const both = pluginSearchWords([view(), view({ manifest: { ...manifest, id: "notary", name: "Notary" } })]);
  assert.ok(both.includes("Notary") && both.includes("Decision oracle"), "the row's words are every section's");
});

// ── PluginView.auto words, and the per-host plugin list cache ─────────────────────────────────
import { autoLine, cacheLiveList, readCachedList, slimList } from "./logic.ts";
import { LS, isDeviceKey } from "../../storage.ts";
import { planHostSwitch } from "@waterplane/shared";
import { createStore } from "../../sdk/store.ts";
import { bindPluginList, enabledIn, isExtensionEnabled } from "../../sdk/extensions.ts";
import { createLauncherItemTable } from "../../core/featureRun.ts";

test("an autoOn extension's line is the desktop's sentence plus that a flip is final; no auto, no line", () => {
  assert.equal(autoLine({}), null);
  assert.equal(autoLine({ auto: { state: "on", why: "  " } }), null);
  assert.equal(autoLine({ auto: { state: "on", why: "on automatically — a repo on this desktop is an Android app" } }),
    "On automatically — a repo on this desktop is an Android app. Flipping the switch makes it your choice, and it stays that way.");
  assert.match(autoLine({ auto: { state: "off", why: "off automatically — no repo here is an Android app; checked every 15 minutes" } }), /^Off automatically .* checked every 15 minutes\. Flipping/);
});

function fakeLocalStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
  return m;
}
function switchHost(m, from, to) {
  for (const op of planHostSwitch([...m.keys()], isDeviceKey, from, to)) {
    if (op.op === "copy") m.set(op.to, m.get(op.from)); else m.delete(op.key);
  }
}
const live = (id, enabled, state = enabled ? "active" : "off") => ({ manifest: { id, name: id, version: "1", apiVersion: 1 }, source: "/x", enabled, state, values: { secret: "never cached" } });

test("plugin list cache: a cold start with no connection reads this host's last list, and draws its line", (t) => {
  const m = fakeLocalStorage();
  t.after(() => { delete globalThis.localStorage; });
  assert.equal(readCachedList(), null, "a host that never listed ⇒ unknown ⇒ off, as before");
  cacheLiveList([live("phoneapps", true), live("other", false)]);
  assert.doesNotMatch(m.get(LS.pluginList), /never cached|source|values/, "only id, switch and state are kept");

  // Cold start: the store `isExtensionEnabled` reads starts from the cache — no socket anywhere.
  const on = createStore(readCachedList());
  bindPluginList(on);
  assert.equal(isExtensionEnabled("phoneapps"), true);
  assert.equal(isExtensionEnabled("other"), false);
  const icon = () => null;
  const items = createLauncherItemTable([
    { id: "phoneapps", hideWhen: () => !isExtensionEnabled("phoneapps"), launcherItems: [{ id: "main", label: "Apps", icon, open: () => {} }] },
  ], () => ({ say: { toast: () => {}, track: () => {} } })).items();
  assert.deepEqual(items.map((i) => i.key), ["phoneapps:main"], "the launcher line is drawn offline");

  // The live list replaces the cache.
  on.set(cacheLiveList([live("phoneapps", false)]));
  assert.equal(isExtensionEnabled("phoneapps"), false);
  assert.deepEqual(readCachedList(), slimList([live("phoneapps", false)]));
});

test("plugin list cache is per host: another desktop's list never leaks, and each comes back with its host", (t) => {
  const m = fakeLocalStorage();
  t.after(() => { delete globalThis.localStorage; });
  cacheLiveList([live("phoneapps", true)]);
  assert.equal(isDeviceKey(LS.pluginList), false, "a HOST key: parked on a switch");
  switchHost(m, "hostA", "hostB");
  assert.equal(readCachedList(), null, "host B was never listed here ⇒ off, not A's answer");
  assert.equal(enabledIn(readCachedList(), "phoneapps"), false);
  cacheLiveList([live("phoneapps", false)]);
  switchHost(m, "hostB", "hostA");
  assert.equal(enabledIn(readCachedList(), "phoneapps"), true, "A's own state at once");
  switchHost(m, "hostA", "hostB");
  assert.equal(enabledIn(readCachedList(), "phoneapps"), false, "B's own state at once");
});

test("an unreadable cache reads as no cache (off), never as a guess", (t) => {
  const m = fakeLocalStorage();
  t.after(() => { delete globalThis.localStorage; });
  m.set(LS.pluginList, "{nope");
  assert.equal(readCachedList(), null);
  m.set(LS.pluginList, JSON.stringify([{ manifest: { id: "x" }, enabled: "yes", state: "active" }]));
  assert.equal(readCachedList(), null);
  m.set(LS.pluginList, JSON.stringify([{ manifest: { id: "x" }, enabled: true, state: "active" }]));
  assert.deepEqual(readCachedList(), [{ manifest: { id: "x" }, enabled: true, state: "active" }]);
});

test("cacheLiveList: an unchanged list writes nothing and hands back the store's own array", (t) => {
  const m = fakeLocalStorage();
  t.after(() => { delete globalThis.localStorage; });
  const first = cacheLiveList([live("phoneapps", true)]);
  m.set(LS.pluginList, "sentinel");
  assert.equal(cacheLiveList([live("phoneapps", true)], first), first, "same rows ⇒ same array");
  assert.equal(m.get(LS.pluginList), "sentinel", "…and no write");
  const next = cacheLiveList([live("phoneapps", false)], first);
  assert.notEqual(next, first);
  assert.notEqual(m.get(LS.pluginList), "sentinel", "a change writes");
});

test("the real wiring: the real store starts from this host's cache and applyLiveList feeds it; index.ts hands the handler to it", async (t) => {
  const m = fakeLocalStorage();
  t.after(() => { delete globalThis.localStorage; });
  cacheLiveList([live("phoneapps", true)]);
  // store.ts imports the SDK barrel (React, the whole core); only its createStore is needed here.
  const { registerHooks } = await import("node:module");
  const sdkStore = new URL("../../sdk/store.ts", import.meta.url).href;
  const hooks = registerHooks({ resolve: (spec, ctx, next) => (
    spec === "../../sdk" ? { url: sdkStore, shortCircuit: true } : spec === "./logic" ? next("./logic.ts", ctx) : next(spec, ctx)) });
  t.after(() => hooks.deregister());
  const store = await import(`./store.ts?wiring=${Date.now()}`);
  assert.equal(enabledIn(store.pluginsOn.get(), "phoneapps"), true, "seeded from localStorage at module load (not createStore(null))");
  assert.equal(store.pluginsLive.get(), false);
  store.applyLiveList([live("phoneapps", false)]);
  assert.equal(enabledIn(store.pluginsOn.get(), "phoneapps"), false, "the live list replaces it");
  assert.equal(store.pluginsLive.get(), true);
  assert.deepEqual(JSON.parse(m.get(LS.pluginList)).map((r) => r.enabled), [false], "and the cache");
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /"plugin\.list": \(msg\) => \{[^}]*applyLiveList\(msg\.plugins\)/, "the manifest's handler calls it");
});
