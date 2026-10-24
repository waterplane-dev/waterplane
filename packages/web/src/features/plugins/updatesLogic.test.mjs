// node --test packages/web/src/features/plugins/updatesLogic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { updatesDue } from "@waterplane/shared";
import {
  applyRunning, availableRows, bannerView, checkedWords, nextCheckWords, cutRows, cutWords, dueCount, installConfirm, installedRows, parseUrlInput,
  receiptDue, receiptWords, resultView, selfSwapped, untaggedWords, rollbackConfirm, selfConfirm, selfView, sourceWords, updatePluginConfirm, urlConfirm,
} from "./logic.ts";

const inst = (id, ref, over = {}) => ({ id, version: "1.0.0", source: "manager", ref, commit: "a", dir: "/d/" + id, ...over });
const entry = (name, over = {}) => ({
  repo: `waterplane-dev/${name}`, url: `https://github.com/waterplane-dev/${name}`, name, description: `${name} does things`,
  maturity: "preview", latest: { kind: "tag", ref: "v1.1.0" }, installed: null, fromOrg: true, problems: [], ...over,
});
const self = (over = {}) => ({ mode: "tarball", current: "0.1.4", latest: "0.1.5", canApply: true, rollbackTo: "0.1.3", ...over });
const status = (over = {}) => ({
  self: self(),
  catalog: [
    entry("gemini", { installed: inst("gemini", "v1.0.0") }),            // due
    entry("fresh", { installed: inst("fresh", "v1.1.0") }),              // current
    entry("hand", { installed: inst("hand", "v0.1.0", { source: "local" }) }), // never updated by the manager
    entry("new"),                                                         // available
    entry("broken", { latest: null, problems: ["no manifest"] }),         // available, refused
  ],
  checkedAt: 1000, autoCheck: true, ...over,
});
const view = (id) => ({ manifest: { id, name: id, version: "1.0.0", maturity: id === "fresh" ? "stable" : undefined } });

test("source words: waterplane-dev, a URL, or managed by you", () => {
  const st = status();
  assert.equal(sourceWords(st.catalog[0].installed, st.catalog[0]), "from waterplane-dev");
  assert.equal(sourceWords(st.catalog[2].installed, st.catalog[2]), "managed by you");
  assert.equal(sourceWords(null, null), "managed by you");
  const other = entry("x", { repo: "someone/x", url: "https://github.com/someone/x", fromOrg: false, installed: inst("x", "v1.0.0") });
  assert.equal(sourceWords(other.installed, other), "from https://github.com/someone/x");
});

test("installed rows: maturity, source, and an update button only for what updatesDue lists", () => {
  const rows = installedRows([view("gemini"), view("fresh"), view("hand"), view("loose")], status());
  assert.deepEqual(rows.map((r) => [r.id, !!r.due, r.source]), [
    ["gemini", true, "from waterplane-dev"], ["fresh", false, "from waterplane-dev"],
    ["hand", false, "managed by you"], ["loose", false, "managed by you"],
  ]);
  assert.equal(rows[1].maturity.label, "Stable");
  assert.equal(rows[0].maturity.level, "unrated");
  assert.equal(rows[0].due.to, "v1.1.0");
});

test("available rows: an install button, or the problems in words", () => {
  const rows = availableRows(status());
  assert.deepEqual(rows.map((r) => [r.name, r.action.kind]), [["new", "install"], ["broken", "problems"]]);
  assert.deepEqual(rows[1].action.words, ["no manifest"]);
  assert.match(rows[0].maturity.meaning, /break/);
  const none = availableRows(status({ catalog: [entry("e", { latest: null })] }));
  assert.match(none[0].action.words[0], /Nothing installable/);
});

test("the count IS the filter: shown rows equal dueCount, and the cut says n of N", () => {
  const st = status();
  const cut = cutRows(st, true);
  assert.equal(cut.shown.length, dueCount(st));
  assert.equal(dueCount(st), updatesDue(st).length);
  assert.deepEqual(cut.shown.map((r) => r.key), ["self", "waterplane-dev/gemini"]);
  assert.equal(cut.total, 6);
  assert.equal(cutRows(st, false).shown.length, 6);
  assert.equal(cutWords(2, 6), "Showing the 2 with an update: 2 of 6");
  const quiet = status({ self: self({ latest: "0.1.4" }), catalog: [] });
  assert.equal(cutRows(quiet, true).shown.length, 0);
  assert.equal(dueCount(null), 0);
});

test("self view: buttons only when canApply, otherwise the command and why", () => {
  const st = status();
  const v = selfView(st.self, st);
  assert.deepEqual([v.headline, v.showUpdate, v.showRollback, v.command, v.why], ["0.1.4 → 0.1.5", true, true, null, null]);
  const npm = status({ self: self({ canApply: false, mode: "npm", command: "npm i -g waterplane", why: "installed with npm", rollbackTo: undefined }) });
  const n = selfView(npm.self, npm);
  assert.deepEqual([n.showUpdate, n.showRollback, n.command, n.why], [false, false, "npm i -g waterplane", "installed with npm"]);
  const cur = status({ self: self({ latest: "0.1.4" }) });
  assert.equal(selfView(cur.self, cur).headline, "0.1.4 · up to date");
  assert.equal(selfView(cur.self, cur).showUpdate, false);
  assert.equal(selfView(cur.self, cur).showRollback, true);
});

test("confirm texts", () => {
  assert.equal(installConfirm({ name: "Gemini", ref: "v1.2.0", desktop: "studio", fromOrg: true }),
    "Install Gemini v1.2.0 from waterplane-dev on studio? It runs with full access to this desktop.");
  assert.equal(urlConfirm({ url: "https://github.com/a/b", desktop: "studio" }),
    "Install the plugin at https://github.com/a/b on studio? Not from waterplane-dev. It runs with full access to this desktop.");
  assert.equal(selfConfirm({ desktop: "studio", current: "0.1.4", to: "0.1.5" }),
    "Update studio from 0.1.4 to 0.1.5? The desktop restarts; sessions keep running.");
  assert.match(rollbackConfirm({ desktop: "studio", current: "0.1.5", to: "0.1.4" }), /^Roll studio back from 0.1.5 to 0.1.4\?/);
  assert.match(updatePluginConfirm({ name: "g", from: "v1", to: "v2", desktop: "d", fromOrg: true }), /^Update g from v1 to v2 from waterplane-dev on d\?/);
});

test("url input: https only, with a sentence for each refusal", () => {
  assert.deepEqual(parseUrlInput(" https://github.com/a/b "), { ok: true, url: "https://github.com/a/b" });
  assert.equal(parseUrlInput("").ok, false);
  assert.match(parseUrlInput("git@github.com:a/b").why, /https/);
  assert.equal(parseUrlInput("http://x/y").ok, false);
});

test("results: restart words by the host's value, a button only for offer", () => {
  const self1 = { kind: "self" };
  const plug = { kind: "plugin-update", id: "g" };
  assert.deepEqual(resultView({ ok: true, restart: "restarting" }, self1, true), { note: "restarting the desktop… · the phone picks up the new UI next", restartButton: false });
  assert.deepEqual(resultView({ ok: true, restart: "offer" }, plug), { note: "restart the desktop to load it", restartButton: true });
  assert.deepEqual(resultView({ ok: true, restart: "manual" }, plug), { note: "restart the desktop to load it", restartButton: false });
  assert.deepEqual(resultView({ ok: true, restart: "restarting" }, { kind: "restart" }), { note: "restarting the desktop…", restartButton: false });
  assert.deepEqual(resultView({ ok: false, restart: "none" }, self1), { note: null, restartButton: false });
});

test("the new-UI line only on a version change, never on already-newest or a failure", () => {
  const self1 = { kind: "self" };
  assert.equal(resultView({ ok: true, restart: "none" }, self1, selfSwapped({ ok: true, restart: "none" })).note, null);
  assert.equal(resultView({ ok: true, restart: "manual" }, self1, false).note, "restart the desktop to load it");
  assert.equal(resultView({ ok: false, restart: "restarting" }, self1, selfSwapped({ ok: false, restart: "restarting" })).note, "restarting the desktop…");
  assert.equal(selfSwapped({ ok: true, restart: "restarting" }), true);
  assert.equal(receiptWords({ ok: true, message: "Already the newest", at: 1 }), "Already the newest");
  assert.equal(receiptWords({ ok: true, message: "Updated", at: 1 }, true), "Updated — the phone picks up the new UI next");
  const warn = "Updated. Warning: signature skipped (no .sig)  ";
  assert.equal(receiptWords({ ok: true, message: warn, at: 1 }), warn);
});

test("a receipt (self or lastApply) shows once, keyed on its timestamp", () => {
  const last = { ok: true, message: "Updated to 0.1.5", at: 50 };
  assert.equal(receiptDue(last, null, 60), true);
  assert.equal(receiptDue(last, 50, 60), false);
  assert.equal(receiptDue(last, 40, 60), true);
  assert.equal(receiptDue(undefined, null, 60), false);
  assert.equal(receiptWords({ ok: false, message: "checksum", at: 1 }), "Update failed: checksum");
});

test("a fresh phone does not toast an old receipt, but does a recent one", () => {
  const old = { ok: true, message: "x", at: 1000 };
  assert.equal(receiptDue(old, null, 1000 + 11 * 60_000), false);
  assert.equal(receiptDue(old, null, 1000 + 9 * 60_000), true);
  assert.equal(receiptDue(old, 999, 1000 + 11 * 60_000), true);
});

test("fromOrg decides the wording, not the repo label", () => {
  const spoof = entry("x", { repo: "waterplane-dev/x", url: "https://evil.example/x", fromOrg: false, installed: inst("x", "v1") });
  assert.equal(sourceWords(spoof.installed, spoof), "from https://evil.example/x");
  const row = availableRows({ catalog: [{ ...spoof, installed: null }] })[0];
  assert.equal(row.fromOrg, false);
  assert.equal(row.url, "https://evil.example/x");
  const c = installConfirm({ name: "x", ref: "v1", desktop: "d", fromOrg: false, url: "https://evil.example/x" });
  assert.match(c, /from https:\/\/evil\.example\/x on d\? Not from waterplane-dev\./);
  assert.doesNotMatch(c, /Install x v1 from waterplane-dev/);
  assert.match(updatePluginConfirm({ name: "x", from: "v1", to: "v2", desktop: "d", fromOrg: false, url: "https://u/x" }), /Not from waterplane-dev/);
  assert.match(installConfirm({ name: "x", ref: null, desktop: "d", fromOrg: true }), /from waterplane-dev on d\? It runs/);
});

test("untagged plugins say so and name the branch", () => {
  assert.equal(untaggedWords({ kind: "branch", ref: "main" }), "untagged, tracks main");
  assert.equal(untaggedWords({ kind: "tag", ref: "v1" }), null);
  assert.equal(untaggedWords(null), null);
  const rows = availableRows({ catalog: [entry("b", { latest: { kind: "branch", ref: "main" } })] });
  assert.equal(rows[0].untagged, "untagged, tracks main");
});

test("banner: only for a due waterplane update, and a dismissal is per version", () => {
  const st = status();
  assert.deepEqual(bannerView(st, ""), { show: true, text: "waterplane 0.1.4 → 0.1.5 available", sig: "0.1.5" });
  assert.equal(bannerView(st, "0.1.5").show, false);
  assert.equal(bannerView(status({ self: self({ latest: "0.1.6" }) }), "0.1.5").show, true);
  assert.equal(bannerView(status({ self: self({ latest: undefined }) }), "").show, false);
  assert.equal(bannerView(null, "").show, false);
});

test("checked words", () => {
  assert.equal(checkedWords(undefined, 5), "not checked yet");
  assert.equal(checkedWords(0, 5 * 60_000), "checked 5 min ago");
});

test("next check words: only while the floor holds", () => {
  assert.equal(nextCheckWords(undefined, 5), null);
  assert.equal(nextCheckWords(1000, 1000), null);
  assert.equal(nextCheckWords(30_000, 1000), "next check possible in under a minute");
  assert.equal(nextCheckWords(4 * 60_000 + 1, 0), "next check possible in 5 min");
});

test("a pending apply stops claiming to run after a while (a restart eats the answer)", () => {
  assert.equal(applyRunning({ pending: true, at: 1000 }, 2000), true);
  assert.equal(applyRunning({ pending: true, at: 1000 }, 1000 + 4 * 60_000), false);
  assert.equal(applyRunning({ pending: false }, 2000), false);
  assert.equal(applyRunning(undefined, 2000), false);
});
