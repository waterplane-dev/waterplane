/**
 * The core's calls INTO features, over a fake registry: `featureRun.ts` takes
 * the registry and the core as parameters so this runs under `node --test`
 * without the real one's React tree.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createFeatureRunner, createRepoActionTable, createRepoChipList, createSettingsRowTable, createSheetTable, createToolbarItemTable, setupRowDefs,
  availabilityText, countedN, createLauncherItemTable, createMenuItemTable, createSecretFillerTable, createSessionViewTable, menuBadgeTotal, menuItemCatalog,
} from "./featureRun.ts";

function fakeCore() {
  const toasts = [];
  const tracks = [];
  return { toasts, tracks, core: { say: { toast: (m) => toasts.push(m), track: (id) => tracks.push(id), confirm: () => {} } } };
}

/** Silences the console.error the runner is meant to print, and counts it. */
function quietly(fn) {
  const orig = console.error;
  let n = 0;
  console.error = () => { n++; };
  try { fn(); } finally { console.error = orig; }
  return n;
}

test("handlers run in registry order and a throw is contained to its feature", () => {
  const seen = [];
  const { core, toasts, tracks } = fakeCore();
  const r = createFeatureRunner([
    { id: "a", messages: { "session.list": () => { seen.push("a"); } } },
    { id: "b", messages: { "session.list": () => { seen.push("b"); throw new Error("boom"); } } },
    { id: "c", messages: { "session.list": (_m, c) => { seen.push(c === core ? "c" : "c?"); } } },
  ], () => core);
  const errors = quietly(() => r.dispatch({ t: "session.list", sessions: [] }));
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(errors, 1, "the failure is still logged");
  assert.deepEqual(toasts, ["b stopped handling session.list"]);
  assert.deepEqual(tracks, ["feature-fail:b"]);
});

test("a frame no feature handles touches nothing, not even the core", () => {
  const r = createFeatureRunner([{ id: "a", messages: { pong: () => {} } }], () => { throw new Error("core read"); });
  r.dispatch({ t: "session.list", sessions: [] });
});

test("the toast is said once per (feature, t); the console hears every time", () => {
  const { core, toasts, tracks } = fakeCore();
  const r = createFeatureRunner([
    { id: "b", messages: { "session.list": () => { throw new Error("x"); }, welcome: () => { throw new Error("y"); } } },
  ], () => core);
  const errors = quietly(() => {
    r.dispatch({ t: "session.list", sessions: [] });
    r.dispatch({ t: "session.list", sessions: [] });
    r.dispatch({ t: "welcome" });
  });
  assert.equal(errors, 3);
  assert.deepEqual(toasts, ["b stopped handling session.list", "b stopped handling welcome"]);
  assert.deepEqual(tracks, ["feature-fail:b", "feature-fail:b"]);
});

test("runCommand: false for an id no feature owns, true (and contained) for one that throws", () => {
  const { core, toasts } = fakeCore();
  const ran = [];
  const r = createFeatureRunner([
    { id: "a", commands: [{ id: "go", run: (c) => ran.push(c === core) }, { id: "bad", run: () => { throw new Error("z"); } }] },
  ], () => core);
  assert.equal(r.runCommand("nope"), false);
  assert.equal(r.runCommand("go"), true);
  assert.deepEqual(ran, [true]);
  let ok;
  quietly(() => { ok = r.runCommand("bad"); });
  assert.equal(ok, true);
  assert.deepEqual(toasts, ["a stopped handling bad"]);
});

test("boot runs every feature in order, survives a throw, and undoes in reverse", () => {
  const { core, toasts } = fakeCore();
  const log = [];
  const r = createFeatureRunner([
    { id: "a", boot: () => { log.push("boot a"); return () => log.push("undo a"); } },
    { id: "b", boot: () => { throw new Error("no"); } },
    { id: "c", boot: () => { log.push("boot c"); return () => log.push("undo c"); } },
  ], () => core);
  let undo;
  quietly(() => { undo = r.boot(); });
  assert.deepEqual(log, ["boot a", "boot c"]);
  assert.deepEqual(toasts, ["b stopped handling boot"]);
  undo();
  assert.deepEqual(log, ["boot a", "boot c", "undo c", "undo a"]);
});

test("a sheet's onLeave runs when it stops being on top, and never on no change or from nothing", () => {
  const left = [];
  const t = createSheetTable([{ id: "f", sheets: [{ id: "tokens", persisted: false, render: () => null, onLeave: () => left.push("tokens") }] }]);
  t.leave("tokens", "tokens");
  t.leave(null, "tokens");
  t.leave(null, null);
  assert.deepEqual(left, []);
  t.leave("tokens", null);
  t.leave("tokens", "pull");
  t.leave("pull", null); // a sheet with no feature entry is a no-op
  assert.deepEqual(left, ["tokens", "tokens"]);
});

/** The deferred toast lands on the next microtask. */
const tick = () => new Promise((r) => queueMicrotask(r));

test("settings rows: one group only, by order then registry order, keyed per feature", () => {
  const { core } = fakeCore();
  const t = createSettingsRowTable([
    { id: "a", settings: [{ group: "sessions", order: 20, render: () => "a20" }, { group: "tools", order: 0, render: () => "aT" }] },
    { id: "b", settings: [{ group: "sessions", order: 10, render: (c) => (c === core ? "b10" : "b?") }] },
    { id: "c", settings: [{ group: "sessions", order: 20, render: () => "c20" }] },
  ], () => core);
  assert.deepEqual(t.rows("sessions"), [
    { key: "b:0", node: "b10" }, { key: "a:0", node: "a20" }, { key: "c:0", node: "c20" },
  ]);
  assert.deepEqual(t.rows("tools"), [{ key: "a:1", node: "aT" }]);
  // A band: from <= order < to, so a group's rows can be drawn in two places.
  assert.deepEqual(t.rows("sessions", { to: 20 }), [{ key: "b:0", node: "b10" }]);
  assert.deepEqual(t.rows("sessions", { from: 20 }), [{ key: "a:0", node: "a20" }, { key: "c:0", node: "c20" }]);
  assert.deepEqual(t.rows("sessions", { from: 11, to: 20 }), []);
});

test("settings rows: a group no feature adds to reads nothing, not even the core", () => {
  const t = createSettingsRowTable([{ id: "a", settings: [{ group: "tools", order: 0, render: () => "x" }] }],
    () => { throw new Error("core read"); });
  assert.deepEqual(t.rows("appearance"), []);
});

test("settings rows: a throw drops that feature's row only, said once and after the render", async () => {
  const { core, toasts, tracks } = fakeCore();
  const t = createSettingsRowTable([
    { id: "a", settings: [{ group: "sessions", order: 0, render: () => { throw new Error("x"); } }] },
    { id: "b", settings: [{ group: "sessions", order: 1, render: () => "b" }] },
  ], () => core);
  let rows;
  const errors = quietly(() => { rows = t.rows("sessions"); t.rows("sessions"); });
  assert.deepEqual(rows, [{ key: "b:0", node: "b" }]);
  assert.equal(errors, 2);
  assert.deepEqual(toasts, [], "no state is set while the settings sheet is rendering");
  await tick();
  assert.deepEqual(toasts, ["a stopped handling settings:sessions"]);
  assert.deepEqual(tracks, ["feature-fail:a"]);
});

test("toolbar items: undefined for an id no feature owns, null passes through, a throw hides the item", async () => {
  const { core, toasts } = fakeCore();
  const seen = [];
  const t = createToolbarItemTable([
    { id: "a", toolbarItems: [
      { id: "mine", render: (c, ctx) => { seen.push([c === core, ctx.label]); return "drawn"; } },
      { id: "hidden", render: () => null },
      { id: "bad", render: () => { throw new Error("z"); } },
    ] },
  ], () => core);
  const ctx = { label: true, dismiss: () => {}, active: null };
  assert.equal(t.item("nope", ctx), undefined);
  assert.equal(t.item("mine", ctx), "drawn");
  assert.deepEqual(seen, [[true, true]]);
  assert.equal(t.item("hidden", ctx), null);
  let out;
  quietly(() => { out = t.item("bad", ctx); });
  assert.equal(out, null);
  await tick();
  assert.deepEqual(toasts, ["a stopped handling toolbar:bad"]);
});

// ── extension points: plugin.push, feature: sheet ids, repo actions and chips, setup rows ──

test("plugin.push reaches only the manifest it names, only for the event it names; a throw is contained and said once", () => {
  const { core, toasts } = fakeCore();
  const got = [];
  const r = createFeatureRunner([
    { id: "req", pushes: { changed: (d, c) => got.push(["req", d, c === core]), boom: () => { throw new Error("x"); } } },
    { id: "other", pushes: { changed: (d) => got.push(["other", d]) } },
  ], () => core);
  r.dispatch({ t: "plugin.push", plugin: "req", event: "changed", data: { n: 1 } });
  assert.deepEqual(got, [["req", { n: 1 }, true]]);
  r.dispatch({ t: "plugin.push", plugin: "req", event: "nope", data: 1 });
  r.dispatch({ t: "plugin.push", plugin: "ghost", event: "changed", data: 1 });
  assert.equal(got.length, 1, "an unknown event or plugin touches nothing");
  const errors = quietly(() => { r.dispatch({ t: "plugin.push", plugin: "req", event: "boom", data: 1 }); r.dispatch({ t: "plugin.push", plugin: "req", event: "boom", data: 1 }); });
  assert.equal(errors, 2);
  assert.deepEqual(toasts, ["req stopped handling push boom"]);
});

test("a sheet whose feature: prefix is not its own manifest id is dropped", () => {
  const render = () => null;
  let t;
  const errors = quietly(() => {
    t = createSheetTable([
      { id: "a", sheets: [{ id: "feature:a/list", persisted: false, render }, { id: "feature:other/x", persisted: false, render }] },
      { id: "b", sheets: [{ id: "backlog", persisted: true, render }] },
    ]);
  });
  assert.deepEqual([...t.sheets.keys()], ["feature:a/list", "backlog"]);
  assert.equal(errors, 1);
});

const REPO = { id: "r1", repoName: "myapp" };

test("repo actions: registry order, a null label is omitted, a throw drops the entry and is said once", async () => {
  const { core, toasts } = fakeCore();
  const ran = [];
  const icon = () => null;
  const t = createRepoActionTable([
    { id: "a", repoActions: [
      { id: "one", icon, label: (r) => `one in ${r.repoName}`, title: () => "t1", run: (r, c) => ran.push(["one", r.id, c === core]) },
      { id: "hidden", icon, label: () => null, run: () => ran.push("hidden") },
    ] },
    { id: "b", repoActions: [
      { id: "bad", icon, label: () => { throw new Error("x"); }, run: () => {} },
      { id: "two", icon, label: () => "two", run: () => { throw new Error("run"); } },
    ] },
  ], () => core);
  let acts;
  const errors = quietly(() => { acts = t.actions(REPO); t.actions(REPO); });
  await tick();
  assert.deepEqual(acts.map((a) => [a.key, a.label, a.title]), [["a:one", "one in myapp", "t1"], ["b:two", "two", undefined]]);
  assert.equal(errors, 2, "the label that threw is logged each time");
  assert.deepEqual(toasts, ["b stopped handling repo action bad"], "…and said once");
  acts[0].run();
  assert.deepEqual(ran, [["one", "r1", true]]);
  quietly(() => acts[1].run());
  await tick();
  assert.deepEqual(toasts, ["b stopped handling repo action bad", "b stopped handling repo action two"]);
});

test("repo chips keep registry order; setup rows concatenate", () => {
  const useCount = () => null;
  const icon = () => null;
  const feats = [
    { id: "a", repoChips: [{ id: "x", icon, useCount, open: () => {} }], setupRows: [{ check: "c1" }] },
    { id: "b", setupRows: [{ check: "c2", fix: "f2" }, { check: "c3" }] },
    { id: "c" },
  ];
  assert.deepEqual(createRepoChipList(feats).map((c) => c.key), ["a:x"]);
  assert.deepEqual(setupRowDefs(feats).map((d) => d.check), ["c1", "c2", "c3"]);
});

test("session views: none contributed is an empty list, so the header is unchanged", () => {
  const t = createSessionViewTable([{ id: "a" }, { id: "b", repoActions: [] }], () => { throw new Error("core read"); });
  assert.deepEqual(t.views("s1"), []);
  assert.deepEqual(createLauncherItemTable([{ id: "a" }], () => { throw new Error("core read"); }).items(), []);
});

test("session views: order then registry order; unavailable keeps the entry and carries the sentence", async () => {
  const { core, toasts } = fakeCore();
  const icon = () => null;
  const opened = [];
  const t = createSessionViewTable([
    { id: "a", sessionViews: [
      { id: "late", label: "Late", icon, order: 5, open: () => opened.push("late") },
      { id: "desk", label: "Desktop", icon, available: () => "Live desktop needs macOS for now", open: () => opened.push("desk") },
    ] },
    { id: "b", sessionViews: [
      { id: "bad", label: "Bad", icon, available: () => { throw new Error("x"); }, open: () => {} },
      { id: "first", label: "First", icon, order: -1, available: () => true, open: (c, ctx) => opened.push(["first", ctx.sessionId, c === core]) },
      { id: "boom", label: "Boom", icon, open: () => { throw new Error("open"); } },
    ] },
  ], () => core);
  let views;
  const errors = quietly(() => { views = t.views("s9"); });
  await tick();
  assert.deepEqual(views.map((v) => [v.key, v.label, v.unavailable]), [
    ["b:first", "First", null],
    ["a:desk", "Desktop", "Live desktop needs macOS for now"],
    ["b:boom", "Boom", null],
    ["a:late", "Late", null],
  ]);
  assert.equal(errors, 1);
  assert.deepEqual(toasts, ["b stopped handling session view bad"]);
  views[0].open();
  assert.deepEqual(opened, [["first", "s9", true]], "open gets the session it was drawn for");
  quietly(() => views[2].open());
  await tick();
  assert.deepEqual(toasts.at(-1), "b stopped handling session view boom");
});

test("launcher items resolve the same way; a non-sentence refusal still reads as words", () => {
  const { core } = fakeCore();
  const icon = () => null;
  const ran = [];
  const t = createLauncherItemTable([
    { id: "d", launcherItems: [
      { id: "desk", label: "Desktop", icon, open: (c) => ran.push(c === core) },
      { id: "odd", label: "Odd", icon, available: () => false, open: () => {} },
    ] },
  ], () => core);
  const items = t.items();
  assert.deepEqual(items.map((i) => [i.key, i.unavailable]), [["d:desk", null], ["d:odd", "Odd is not available here"]]);
  items[0].open();
  assert.deepEqual(ran, [true]);
  assert.equal(availabilityText(true, "X"), null);
  assert.equal(availabilityText("  needs macOS  ", "X"), "needs macOS");
  assert.equal(availabilityText("", "X"), "X is not available here");
});

test("launcher items pass their count hook through untouched, and only theirs", () => {
  const { core } = fakeCore();
  const icon = () => null;
  const useCount = () => ({ n: 2, title: "2 asks" });
  const items = createLauncherItemTable([
    { id: "v", launcherItems: [{ id: "vault", label: "Vault", icon, open: () => {}, useCount }] },
    { id: "d", launcherItems: [{ id: "desk", label: "Desktop", icon, open: () => {} }] },
  ], () => core).items();
  assert.equal(items.find((i) => i.key === "v:vault").useCount, useCount);
  assert.equal(items.find((i) => i.key === "d:desk").useCount, undefined);
});

test("a counted launcher item's tap opens what it counted (openCount), contained; uncounted items have none", async () => {
  const { core, toasts } = fakeCore();
  const icon = () => null;
  const ran = [];
  const items = createLauncherItemTable([
    { id: "v", launcherItems: [{ id: "vault", label: "Vault", icon, open: () => ran.push("home"), useCount: () => ({ n: 1, title: "1" }), openCount: (c) => ran.push(c === core ? "waiting" : "?") }] },
    { id: "b", launcherItems: [{ id: "bad", label: "Bad", icon, open: () => {}, useCount: () => null, openCount: () => { throw new Error("boom"); } }] },
    { id: "d", launcherItems: [{ id: "desk", label: "Desktop", icon, open: () => {}, openCount: () => ran.push("never") }] },
  ], () => core).items();
  const v = items.find((i) => i.key === "v:vault");
  v.openCount(); v.open();
  assert.deepEqual(ran, ["waiting", "home"]);
  assert.equal(items.find((i) => i.key === "d:desk").openCount, undefined, "openCount without useCount is ignored");
  assert.equal(quietly(() => items.find((i) => i.key === "b:bad").openCount()), 1);
  await tick();
  assert.equal(toasts.length, 1);
});

test("one reading of a count: the item's badge and the ☰ sum agree, and nothing waiting is 0", () => {
  assert.equal(countedN(null), 0);
  assert.equal(countedN(undefined), 0);
  assert.equal(countedN({ n: 0, title: "" }), 0);
  assert.equal(countedN({ n: -3, title: "" }), 0);
  assert.equal(countedN({ n: NaN, title: "" }), 0);
  assert.equal(countedN({ n: 2, title: "" }), 2);
  // The ☰: the core's own counts (activity, apps ready) plus every counted line inside it.
  assert.equal(menuBadgeTotal(0, []), 0);
  assert.equal(menuBadgeTotal(0, [null, { n: 0, title: "" }]), 0);
  assert.equal(menuBadgeTotal(1, [{ n: 2, title: "" }, null, { n: 3, title: "" }]), 6);
  assert.equal(menuBadgeTotal(0, [{ n: 1, title: "re-arm" }]), 1, "one waiting vault card lights the closed menu");
});

test("menu items: catalog ids are namespaced, ordered, and open with the active session", () => {
  const { core } = fakeCore();
  const icon = () => null;
  const opened = [];
  const features = [
    { id: "a" },
    { id: "links", menuItems: [
      { id: "late", label: "late", icon, order: 5, open: () => {} },
      { id: "links", label: "links", icon, open: (c, ctx) => opened.push([ctx.active.id, c === core]) },
    ] },
  ];
  assert.deepEqual(menuItemCatalog(features).map((t) => [t.id, t.name]), [["links:links", "links"], ["links:late", "late"]]);
  const items = createMenuItemTable(features, () => core).items({ id: "s1" });
  assert.deepEqual(items.map((e) => e.key), ["links:links", "links:late"]);
  items[0].open();
  assert.deepEqual(opened, [["s1", true]]);
  assert.deepEqual(menuItemCatalog([{ id: "a" }]), []);
});

test("secret fillers: order, then registry order; open gets the ask's context; a throw is contained", () => {
  const { core } = fakeCore();
  const got = [];
  const ctx = { sessionId: "s1", askLine: "Password:", fill: () => true };
  const features = [
    { id: "a", secretFillers: [{ id: "late", label: "late", icon: () => null, order: 5, open: () => { throw new Error("boom"); } }] },
    { id: "logins", secretFillers: [{ id: "login", label: "from store", icon: () => null, open: (c, x) => got.push([c === core, x]) }] },
    { id: "off", secretFillers: [{ id: "x", label: "x", icon: () => null, available: () => "needs the app", open: () => {} }] },
  ];
  const items = createSecretFillerTable(features, () => core).items(ctx);
  assert.deepEqual(items.map((e) => [e.key, e.unavailable]), [["logins:login", null], ["off:x", "needs the app"], ["a:late", null]]);
  items[0].open();
  assert.deepEqual(got, [[true, ctx]]);
  assert.doesNotThrow(() => quietly(() => items[2].open()));
  assert.deepEqual(createSecretFillerTable([{ id: "a" }], () => core).items(ctx), []);
});
