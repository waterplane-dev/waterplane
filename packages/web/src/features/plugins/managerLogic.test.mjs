/**
 * The plugin manager's rows and filters (pure). Extension web halves cannot be imported under plain
 * node (react, lucide), so each in-repo extension is stood in for by the SHAPE of its contributions —
 * what its `web/index.ts` declares, nothing else. `places` below is what the logic derives from them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  MANAGER_FILTERS, cutRows, derivePlaces, filterCounts, filterMatches, filterNote, firstSentence, managerRow, managerRows, cardPlaces, shortenPaths,
} from "./managerLogic.ts";
import { scopeRowIds } from "../../settingsIndex.ts";

const I = () => null;
const view = (id, over = {}) => ({
  manifest: { id, name: id[0].toUpperCase() + id.slice(1), version: "1.0.0", description: "Does a thing. And more.", ...(over.manifest ?? {}) },
  source: `/x/${id}`, enabled: true, state: "active", values: {}, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "manifest")),
});

const FEATURES = {
  "android-apps": { id: "android-apps", launcherItems: [{ id: "a", label: "android apps", icon: I, open() {} }], appsDoor: { open() {} } },
  desktop: { id: "desktop", sessionViews: [{ id: "desktop", label: "Desktop", icon: I, open() {} }], launcherItems: [{ id: "desktop", label: "Desktop", icon: I, available: () => "No desktop session", open() {} }] },
  diskusage: { id: "diskusage", settings: [{ group: "tools", order: 0, render: I, rows: [{ id: "disk-space", label: "disk space" }] }] },
  links: { id: "links", menuItems: [{ id: "links", label: "links", icon: I, open() {} }], launcherItems: [{ id: "links", label: "Links", icon: I, open() {} }], repoChips: [{ id: "links", icon: I, useCount: I, open() {} }] },
  ocr: { id: "ocr", settings: [{ group: "tools", order: 0, render: I, rows: [{ id: "ocr", label: "text from images" }] }], imageText: { read: async () => null } },
  codeshell: { id: "codeshell", ledgerViews: [{ id: "oc", label: "OpenCode" }] },
  permissions: { id: "permissions", menuItems: [{ id: "permissions", label: "permission rules", icon: I, open() {} }], repoActions: [{ id: "perms", icon: I, label: () => "x", run() {} }] },
  requirements: { id: "requirements", setupRows: [{ check: "requirements" }], repoActions: [{ id: "list", icon: I, label: () => "x", run() {} }] },
  scorecard: { id: "scorecard", setupRows: [{ check: "scorecard" }], repoChips: [{ id: "scorecard", icon: I, useCount: I, open() {} }] },
  "token-stats": { id: "token-stats" },
  vault: { id: "vault", settings: [{ group: "tools", order: 20, render: I, rows: [{ id: "vault", label: "Vault" }] }], launcherItems: [{ id: "vault", label: "Vault", icon: I, open() {} }], secretFillers: [{ id: "login", label: "Fill from vault", icon: I, open() {} }], menuItems: [{ id: "vault", label: "Vault", icon: I, open() {} }], tabMarks: [{ id: "asks", icon: I, useMark: I }], repoActions: [{ id: "repo", icon: I, label: () => "Vault page", run() {} }], repoChips: [{ id: "asks", icon: I, useCount: I, open() {} }, { id: "repo", icon: I, useCount: I, open() {} }] },
};
// Private extensions (vault, permissions) are absent from the public snapshot.
const HAS = (id) => existsSync(new URL(`../../../../extensions/${id}/waterplane-plugin.json`, import.meta.url));
const REAL = (id) => JSON.parse(readFileSync(new URL(`../../../../extensions/${id}/waterplane-plugin.json`, import.meta.url), "utf8"));
const asList = Object.values(FEATURES);

test("places are derived with their own labels", () => {
  const text = (id) => derivePlaces(FEATURES[id]).map((p) => p.text);
  assert.deepEqual(text("android-apps"), ["Home menu: android apps", "Apps"]);
  assert.deepEqual(text("desktop"), ["Home menu: Desktop", "Session header: Desktop"]);
  assert.deepEqual(text("diskusage"), ["Settings: disk space"]);
  assert.deepEqual(text("links"), ["Home menu: Links", "Session menu: links", "Repo row: links count"]);
  assert.deepEqual(text("ocr"), ["Settings: text from images", "Annotator: reads text"]);
  assert.deepEqual(text("codeshell"), ["Token statistics: OpenCode"]);
  assert.deepEqual(text("permissions"), ["Session menu: permission rules", "Repo menu: perms"]);
  assert.deepEqual(text("requirements"), ["Repo menu: list", "Repo readings"]);
  assert.deepEqual(text("scorecard"), ["Repo row: scorecard count", "Repo readings"]);
  assert.deepEqual(text("token-stats"), []);
  assert.deepEqual(derivePlaces(undefined), []);
});

test("only a place that needs no session carries an open (launcher item, Apps door)", () => {
  const withOpen = (id) => derivePlaces(FEATURES[id]).filter((p) => p.open).map((p) => p.text);
  assert.deepEqual(withOpen("android-apps"), ["Home menu: android apps", "Apps"]);
  assert.deepEqual(withOpen("links"), ["Home menu: Links"]);
  assert.deepEqual(withOpen("permissions"), []);
  const d = derivePlaces(FEATURES.desktop).find((p) => p.open);
  assert.equal(d.unavailable({}), "No desktop session", "the contribution's own reason is kept");
  assert.equal(derivePlaces(FEATURES.links).find((p) => p.open).unavailable({}), null);
});

test("an open calls the contribution", () => {
  let got;
  const f = { id: "x", appsDoor: { open: (c, cut) => { got = [c, cut]; } } };
  derivePlaces(f)[0].open("core");
  assert.deepEqual(got, ["core", { kind: "all" }]);
});

test("manifest places join the derived ones, once", () => {
  const r = managerRow(view("copilot-usage", { manifest: { places: ["Token statistics: Copilot", "  ", "Apps"] } }), { id: "copilot-usage", appsDoor: { open() {} } });
  assert.deepEqual(r.places.map((p) => p.text), ["Apps", "Token statistics: Copilot"]);
});

test("a manifest place wins over a derived one for the same where; a derived button stays", () => {
  const r = managerRow(view("permissions", { manifest: { places: ["Repo menu: permission rules", "Session menu: permission rules"] } }), FEATURES.permissions);
  assert.deepEqual(r.places.map((p) => p.text), ["Repo menu: permission rules", "Session menu: permission rules"], "no 'Repo menu: perms'");
  const k = managerRow(view("links", { manifest: { places: ["Home menu: Links shortcut", "Repo row: link counts"] } }), FEATURES.links);
  assert.deepEqual(k.places.map((p) => p.text), ["Home menu: Links", "Session menu: links", "Repo row: link counts"], "the Home-menu button is kept, its manifest twin dropped");
  assert.ok(k.places[0].open);
});

test("row: summary falls back to the first sentence; tags in print order", () => {
  assert.equal(firstSentence("Reads Copilot usage. Needs a token."), "Reads Copilot usage.");
  assert.equal(firstSentence("no full stop"), "no full stop");
  assert.equal(firstSentence(undefined), "");
  const r = managerRow(view("vault", { builtin: true, privacy: "private", fixed: true, manifest: { summary: "Keeps secrets.", maturity: "preview" } }), undefined);
  assert.equal(r.summary, "Keeps secrets.");
  assert.deepEqual(r.tags, ["Beta", "Private"]);
  assert.equal(r.canSwitch, false);
  assert.match(r.fixedWhy, /built in and always on/);
  const o = managerRow(view("echo"), undefined);
  assert.equal(o.summary, "Does a thing.");
  assert.deepEqual(o.tags, ["Installed"], "unrated prints no maturity tag; no On tag, Installed only for outside plugins");
  assert.equal(o.canSwitch, true);
  assert.equal(o.hasSettings, true);
});

test("states, error and needs", () => {
  const f = managerRow(view("bad", { state: "error", error: "boom" }), undefined);
  assert.equal(f.stateLabel, "Failed to load");
  assert.equal(f.error, "boom");
  assert.equal(managerRow(view("o", { state: "off", enabled: false }), undefined).state, "off");
  assert.deepEqual(managerRow(view("bad2", { state: "error", error: "x" }), undefined).tags, ["Failed to load", "Installed"]);
  assert.deepEqual(managerRow(view("n", { env: { A: true, B: false } }), undefined).needs, [], "on and working: an unset env is not a need");
  assert.deepEqual(managerRow(view("n", { env: { A: true, B: false }, status: { tone: "ok", text: "fine" } }), undefined).needs, []);
  assert.deepEqual(managerRow(view("n", { env: { A: true, B: false }, status: { tone: "bad", text: "no token" } }), undefined).needs, ["B"]);
  assert.deepEqual(managerRow(view("n", { env: { B: false }, state: "off", enabled: false }), undefined).needs, ["B"]);
  const ex = managerRow(view("x", { manifest: { experimental: true } }), undefined);
  assert.equal(ex.maturity.label, "Experimental");
  assert.equal(filterMatches(ex, "beta"), true);
});

test("a fixed builtin has Settings only when its extension adds rows", () => {
  assert.equal(managerRow(view("token-stats", { fixed: true, builtin: true }), FEATURES["token-stats"]).hasSettings, false);
  assert.equal(managerRow(view("ocr", { fixed: true, builtin: true }), FEATURES.ocr).hasSettings, true);
});

test("a fixed builtin whose real manifest names a Settings place has a Settings button that lands on a row of its own", () => {
  const r = managerRow(view("token-stats", { fixed: true, builtin: true, manifest: REAL("token-stats") }), FEATURES["token-stats"]);
  assert.equal(r.hasSettings, true);
  assert.deepEqual(scopeRowIds("token-stats"), ["token-stats"], "the scope holds the row the place names, and no empty plugins card");
});

test("no card prints a humanized internal id as a place (vault, links, scorecard speak for themselves)", () => {
  for (const id of ["vault", "links", "scorecard", "permissions"].filter(HAS)) {
    const texts = managerRow(view(id, { manifest: REAL(id) }), FEATURES[id]).places.map((p) => p.text);
    for (const bad of ["Repo menu: repo", "Session tab: asks", "Repo row: asks count", "Repo row: links count", "Repo row: scorecard count", "Repo menu: perms", "Repo row: repo count"]) {
      assert.ok(!texts.includes(bad), `${id} prints "${bad}": ${texts.join(" | ")}`);
    }
  }
  if (HAS("vault")) assert.ok(managerRow(view("vault", { manifest: REAL("vault") }), FEATURES.vault).places.some((p) => p.where === "Session tab"));
});

test("an external copy of a builtin's id gets its own key and none of the builtin's web half", () => {
  const list = [
    view("ocr", { fixed: true, builtin: true, source: "/b/ocr" }),
    view("ocr", { state: "error", error: "duplicate id", source: "/ext/ocr" }),
  ];
  const rows = managerRows(list, asList);
  assert.equal(new Set(rows.map((r) => r.key)).size, 2, "keys are unique");
  const imp = rows.find((r) => r.state === "failed");
  const real = rows.find((r) => r.state !== "failed");
  assert.deepEqual(imp.places, [], "the impostor shows no derived places");
  assert.ok(real.places.length > 0 || real.hasSettings, "the builtin keeps its web half");
});

test("one bucketing function feeds the count and the cut", () => {
  const list = [
    view("a"), view("b", { state: "off", enabled: false }), view("c", { manifest: { maturity: "preview" } }),
    view("d", { manifest: { maturity: "experimental" }, state: "off", enabled: false }), view("e", { builtin: true, privacy: "private", fixed: true }),
    view("f", { state: "error", error: "x" }),
  ];
  const rows = managerRows(list, asList);
  assert.equal(rows[0].id, "f", "failed first");
  const counts = filterCounts(rows);
  assert.deepEqual(counts, { all: 6, on: 4 - 1, off: 2, beta: 2, private: 1 });
  for (const f of MANAGER_FILTERS) assert.equal(cutRows(rows, f).length, counts[f], `${f}: the number is the cut`);
  assert.equal(filterNote(2, 6, "beta"), "2 of 6 plugins: Beta");
  assert.equal(filterNote(6, 6, "all"), "");
  assert.deepEqual(managerRows(null, []), []);
});

test("a fixed builtin's reason reads after Unavailable's 'no <label> — '", () => {
  const r = managerRow(view("copilot", { builtin: true, fixed: true }), undefined);
  assert.equal(`no switch — ${r.fixedWhy}.`, "no switch — Copilot is built in and always on.");
});

test("status paths shrink to their last segment, display only", () => {
  assert.equal(shortenPaths("gemini at /opt/homebrew/bin/gemini; its home is /var/folders/ab/cd/T/x."), "gemini at gemini; its home is x.");
  assert.equal(shortenPaths("no path here, a/b stays, 1/2"), "no path here, a/b stays, 1/2");
});

test("a Settings place line goes when the card has the Settings button", () => {
  const places = [{ key: "a", where: "Settings", label: "x", text: "Settings: x" }, { key: "b", where: "Apps", label: "", text: "Apps" }];
  assert.deepEqual(cardPlaces({ places, hasSettings: true }).map((p) => p.where), ["Apps"]);
  assert.equal(cardPlaces({ places, hasSettings: false }).length, 2);
});
