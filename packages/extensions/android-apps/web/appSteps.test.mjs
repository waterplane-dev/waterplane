/**
 * `appSteps.ts`: the Apps card's three steps (build, download, install), its headline, the one fix
 * for the first step that stops, and the list cut whose number and rows are one function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readiness } from "./appReady.ts";
import { appHeadline, appsCut, appSteps, fixFor, fixLabel, switchAlsoEnablesPull } from "./appSteps.ts";

const NOW = 1_800_000_000_000;
const ago = (ts) => `${Math.round((NOW - ts) / 60000)} min ago`;
const PHONE = { supported: true, canInstall: true, silent: true };
const facts = (over = {}) => ({
  repoId: "r", repoName: "Tiptoi", repoDir: "/dev/Tiptoi", pkg: "de.hoh.tiptoi", module: "app/build.gradle.kts",
  targetSdk: 35, key: "desktop", apks: 3, newestApk: { rel: ".claude/outbox/tiptoi-1.apk", mtime: NOW - 600000, size: 24e6 },
  builds: [{ id: "debug-apk", name: "Debug APK", apk: true }],
  autoPull: { enabled: true, builds: true, maxBytes: 64e6, newestMatches: true }, ...over,
});
const ph = (over = {}) => ({
  caps: PHONE, allow: ["de.hoh.tiptoi"], log: [], me: "phone-a", now: NOW, ago,
  sources: { self: "dev.waterplane.app.dev", byPkg: { "de.hoh.tiptoi": { installer: "dev.waterplane.app.dev" } } }, ...over,
});
const card = (f = {}, p = {}, rows = []) => readiness([facts(f)], rows, ph(p))[0];

test("all three steps hold: it updates by itself, and there is nothing to fix", () => {
  const r = card();
  // No install reported yet is UNKNOWN on its own line — it blocks nothing, so the step still holds.
  assert.deepEqual(appSteps(r).map((s) => [s.id, s.state]), [["build", "ok"], ["download", "ok"], ["install", "ok"]]);
  assert.equal(appSteps(r)[1].text, "Each new build downloads to this phone by itself.");
  assert.match(appHeadline(r), /^updates by itself/);
  assert.equal(fixFor(r), null);
});

test("the download rule off: step 2 stops, the fix turns it on, and the switch would turn it on too", () => {
  const r = card({ autoPull: { enabled: false, builds: true, maxBytes: 0 } });
  const [build, download] = appSteps(r);
  assert.equal(build.state, "ok");
  assert.equal(download.state, "no");
  assert.match(download.text, /stays on the desktop until you download it/);
  assert.equal(appHeadline(r), "not by itself yet — stops at step 2, download");
  assert.equal(fixFor(r), "enable-pull");
  assert.equal(fixLabel("enable-pull"), "turn on download by itself");
  assert.equal(switchAlsoEnablesPull(r), true);
  assert.equal(switchAlsoEnablesPull(card()), false, "a rule already on is left alone");
});

test("no APK yet: step 1 stops and says to run the build button; the fix opens the Build sheet", () => {
  const r = card({ apks: 0, newestApk: undefined });
  assert.equal(appSteps(r)[0].state, "no");
  assert.match(appSteps(r)[0].text, /run its build button/);
  assert.equal(fixFor(r), "open-build");
});

test("the phone's switch off: step 3 stops, and the fix IS the switch", () => {
  const r = card({}, { allow: [] });
  assert.equal(appSteps(r)[2].state, "no");
  assert.equal(fixFor(r), "allow-app");
  assert.equal(fixLabel("allow-app"), "turn on install by itself");
  assert.doesNotMatch(fixLabel("allow-app"), /: on$/, "a fix is a verb, never a switch's state label");
});

test("an app another installer owns stops at install with words only — no button can fix it", () => {
  const r = card({}, { sources: { self: "x", byPkg: { "de.hoh.tiptoi": { installer: "com.android.vending" } } } });
  assert.equal(r.blocker.id, "owner");
  assert.equal(fixFor(r), null);
  assert.match(appSteps(r)[2].text, /Uninstall it once/);
});

test("not installed yet: install holds with the one-dialog caveat, said in the step", () => {
  const r = card({}, { sources: { self: "x", byPkg: {} } });
  assert.equal(r.blocker, undefined);
  assert.equal(appSteps(r)[2].state, "warn");
  assert.match(appHeadline(r), /with a caveat/);
});

test("a phone-only app (no desktop facts) offers no desktop fix", () => {
  const rows = [{ pkg: "x.y", label: "X", allowed: false, repo: "Elsewhere" }];
  const [r] = readiness([], rows, ph({ allow: [] }));
  assert.equal(r.facts, undefined);
  assert.equal(fixFor(r), "allow-app");
  assert.equal(switchAlsoEnablesPull(r), false);
});

test("a browser cannot check install: the headline never claims the app updates itself", () => {
  const r = card({}, { caps: { supported: false, canInstall: false, silent: false } });
  assert.equal(r.blocker, undefined);
  assert.equal(appSteps(r)[2].state, "unknown");
  assert.equal(appHeadline(r), "nothing stops it that this device can see — install cannot be checked here");
});

test("the cut: one function for the waiting chip's number and its rows, and for one repo", () => {
  const a = { repo: "A", row: { pkg: "a" } };
  const b = { repo: "B", row: { pkg: "b" } };
  const c = { repo: "B" };
  const all = [a, b, c];
  assert.deepEqual(appsCut(all, { kind: "all" }, new Set()), all);
  assert.deepEqual(appsCut(all, { kind: "waiting" }, new Set(["b"])), [b]);
  assert.deepEqual(appsCut(all, { kind: "repo", repo: "B" }, new Set()), [b, c]);
});
