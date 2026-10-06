import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowToggle, appInstallVerb, appLabel, appRows, appsSummary, appStateText,
  autoInstallText, installIntroText, installOffer, installStatusText, installVerbText, isApkRow,
  buildsOf, isAllowed, NO_INSTALL, readyApps, snoozeText, toggleAllow, waitingAppNote,
  installerName, quietOwnerText, quietVerdict,
  isPlayBuild, isPlaySelf, PLAY_INTRO_TEXT, PLAY_SELF_TEXT, PLAY_UNREAD_TEXT, playAutoText, shellDistribution,
} from "./installPolicy.ts";

const PHONE = { supported: true, canInstall: true, silent: true };
const row = (over = {}) => ({
  name: "app-debug.apk",
  state: "done",
  pkg: "de.hoh.tiptoi",
  pkgLabel: "Tiptoi",
  pkgVersion: "1.4",
  ...over,
});

test("an apk is recognised by name or by declared type", () => {
  assert.equal(isApkRow({ name: "app-debug.apk" }), true);
  assert.equal(isApkRow({ name: "APP-RELEASE.APK" }), true);
  assert.equal(isApkRow({ name: "build", mime: "application/vnd.android.package-archive" }), true);
  assert.equal(isApkRow({ name: "report.md" }), false);
  assert.equal(isApkRow({}), false);
});

test("a browser is told nothing at all about installing", () => {
  const offer = installOffer(row(), NO_INSTALL);
  assert.equal(offer.verb, null);
  assert.equal(offer.reason, null);
  assert.equal(autoInstallText(row(), NO_INSTALL, ["de.hoh.tiptoi"]), null);
  assert.equal(allowToggle(row(), NO_INSTALL, []), null);
  assert.equal(installIntroText(NO_INSTALL, ["de.hoh.tiptoi"]), null);
});

test("a refusal is a sentence, never a drawn-and-dead verb", () => {
  const offer = installOffer(row(), { ...PHONE, canInstall: false });
  assert.equal(offer.verb, null);
  assert.match(offer.reason ?? "", /has not allowed/);
  assert.equal(offer.settings, true);
});

test("nothing is offered for a file that is not an app, or is not here yet", () => {
  assert.equal(installOffer(row({ name: "notes.md", pkg: "" }), PHONE).verb, null);
  assert.equal(installOffer(row({ state: "downloading" }), PHONE).verb, null);
  const gone = installOffer(row({ evicted: true }), PHONE);
  assert.equal(gone.verb, null);
  assert.match(gone.reason ?? "", /cleared to save space/);
});

test("a downloaded apk on a phone that allows installs offers the verb", () => {
  assert.equal(installOffer(row(), PHONE).verb, "install");
  // Mid-install there is nothing to tap and nothing to complain about.
  assert.equal(installOffer(row({ install: "installing" }), PHONE).verb, null);
});

test("waiting for a confirmation is never worded as a failure", () => {
  assert.match(installStatusText(row({ install: "asked" })) ?? "", /confirm/);
  assert.doesNotMatch(installStatusText(row({ install: "asked" })) ?? "", /fail|error/i);
  assert.equal(installStatusText(row({ install: "installing" })), "installing…");
  assert.match(installStatusText(row({ install: "installed" })) ?? "", /installed · Tiptoi 1\.4/);
  assert.equal(installStatusText(row()), null);
});

test("a failure keeps the phone's own words, and says so when there are none", () => {
  assert.match(
    installStatusText(row({ install: "failed", installError: "signatures do not match" })) ?? "",
    /could not install: signatures do not match/,
  );
  assert.match(installStatusText(row({ install: "failed" })) ?? "", /did not say why/);
});

test("out of space is said as out of space, in MB, with the retry that fixes it", () => {
  const s = installStatusText(row({ install: "failed",
    installError: "Failed to allocate 227349112 because only 0 allocatable" })) ?? "";
  assert.match(s, /out of space — it needs 228 MB beyond the room Android keeps in reserve/);
  assert.match(s, /none of it is usable yet/);
  assert.match(s, /Settings shows about 728 MB free, then retry/);
  assert.doesNotMatch(s, /has 0 MB/);
  assert.match(s, /retry/);
});

test("the button after a failure is a retry", () => {
  assert.equal(installVerbText("failed"), "retry install");
  assert.equal(installVerbText("installed"), "install again");
  assert.equal(installVerbText(undefined), "install");
});

test("the promise about the NEXT build distinguishes the first one", () => {
  const allow = ["de.hoh.tiptoi"];
  assert.match(autoInstallText(row(), PHONE, []) ?? "", /wait for a tap/);
  assert.match(autoInstallText(row(), PHONE, allow) ?? "", /the first one asks once/);
  // Once it HAS been installed from here, the qualifier goes.
  const after = autoInstallText(row({ install: "installed" }), PHONE, allow) ?? "";
  assert.match(after, /install by themselves/);
  assert.doesNotMatch(after, /first one asks/);
  // An Android too old to skip the dialog must not promise silence.
  assert.match(autoInstallText(row(), { ...PHONE, silent: false }, allow) ?? "", /asks every time/);
  // Allowed, but the phone has not granted the access: a promise with a caveat.
  assert.match(autoInstallText(row(), { ...PHONE, canInstall: false }, allow) ?? "", /once this phone allows it/);
});

test("a package that could not be read promises nothing about itself", () => {
  const unread = row({ pkg: "", pkgLabel: "", pkgVersion: "" });
  assert.equal(autoInstallText(unread, PHONE, []), null);
  assert.equal(allowToggle(unread, PHONE, []), null);
  // …but the tap is still offered: the installer is what judges the file.
  assert.equal(installOffer(unread, PHONE).verb, "install");
});

test("the label is the app's own, never the file name where a name exists", () => {
  assert.equal(appLabel(row()), "Tiptoi");
  assert.equal(appLabel(row({ pkgLabel: "" })), "de.hoh.tiptoi");
  assert.equal(appLabel(row({ pkgLabel: "", pkg: "" })), "app-debug.apk");
});

test("the allow-list is packages, and toggling keeps the order", () => {
  assert.equal(isAllowed(row(), ["de.hoh.tiptoi"]), true);
  assert.equal(isAllowed(row({ pkg: "" }), [""]), false);
  const one = toggleAllow([], "de.hoh.tiptoi");
  assert.deepEqual(one, ["de.hoh.tiptoi"]);
  const two = toggleAllow(one, "de.hoh.talkingpictures");
  assert.deepEqual(two, ["de.hoh.tiptoi", "de.hoh.talkingpictures"]);
  assert.deepEqual(toggleAllow(two, "de.hoh.tiptoi"), ["de.hoh.talkingpictures"]);
  // A row with no package can never put "" on the list.
  assert.deepEqual(toggleAllow(two, ""), two);
});

test("the switch says which direction it goes in", () => {
  assert.match(allowToggle(row(), PHONE, []).label, /always install Tiptoi/);
  assert.match(allowToggle(row(), PHONE, ["de.hoh.tiptoi"]).label, /stop installing Tiptoi/);
  assert.equal(allowToggle(row(), PHONE, ["de.hoh.tiptoi"]).on, true);
});

test("the sheet's one line counts what is actually on the list", () => {
  assert.match(installIntroText(PHONE, []) ?? "", /No app installs itself yet/);
  assert.match(installIntroText(PHONE, ["a"]) ?? "", /^1 app installs itself/);
  assert.match(installIntroText(PHONE, ["a", "b"]) ?? "", /^2 apps install themselves/);
  assert.match(installIntroText({ ...PHONE, canInstall: false }, ["a"]) ?? "", /Allow waterplane to install apps/);
});

// ── the apps screen ──────────────────────────────────────────────────

const build = (over = {}) => ({
  id: "l_1",
  name: "app-debug.apk",
  state: "done",
  pkg: "de.hoh.tiptoi",
  pkgLabel: "Tiptoi",
  pkgVersion: "0.1.98",
  updatedAt: 100,
  ...over,
});

test("an app on the list with no build on the phone still has a row", () => {
  // The whole reason this screen exists: the build was deleted, and that is
  // exactly when somebody wants to switch the app OFF.
  const rows = appRows([], ["de.hoh.tiptoi"], PHONE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pkg, "de.hoh.tiptoi");
  assert.equal(rows[0].allowed, true);
  assert.equal(rows[0].buildId, undefined);
  assert.match(rows[0].note, /installs itself when a build arrives/);
});

test("a downloaded build that is not on the list is a row too", () => {
  const rows = appRows([build()], [], PHONE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].allowed, false);
  assert.equal(rows[0].label, "Tiptoi");
  assert.equal(rows[0].buildId, "l_1");
  assert.match(rows[0].note, /wait for a tap/);
});

test("several builds of one app are ONE row, and it is the newest", () => {
  const rows = appRows([
    build({ id: "old", pkgVersion: "0.1.97", updatedAt: 10 }),
    build({ id: "new", pkgVersion: "0.1.98", updatedAt: 20 }),
  ], ["de.hoh.tiptoi"], PHONE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].buildId, "new");
  assert.equal(rows[0].version, "0.1.98");
});

test("rows that cannot be acted on are not rows", () => {
  // Not an app, not finished, bytes cleared, package unreadable.
  const rows = appRows([
    build({ id: "a", name: "report.md", pkg: "" }),
    build({ id: "b", state: "downloading" }),
    build({ id: "c", evicted: true }),
  ], [], PHONE);
  assert.deepEqual(rows, []);
});

test("an allowed app whose builds were cleared keeps its name and repo", () => {
  // The bytes are gone, so nothing can be installed from here — but the row
  // must still say WHICH app, not fall back to the bare package name.
  const rows = appRows([build({ id: "c", evicted: true, repo: "tiptoi" })], ["de.hoh.tiptoi"], PHONE);
  assert.equal(rows[0].label, "Tiptoi");
  assert.equal(rows[0].repo, "tiptoi");
  assert.equal(rows[0].buildId, undefined);
  assert.equal(rows[0].version, undefined);
});

test("with no build at all, the install log names the app", () => {
  const rows = appRows([], ["de.hoh.tiptoi"], PHONE, [{ pkg: "de.hoh.tiptoi", label: "Tiptoi", repo: "tiptoi" }]);
  assert.equal(rows[0].label, "Tiptoi");
  assert.equal(rows[0].repo, "tiptoi");
  assert.equal(appRows([], ["x.y"], PHONE)[0].repo, undefined);
});

test("the allowed apps come first, then by name", () => {
  const rows = appRows([
    build({ id: "z", pkg: "z.app", pkgLabel: "Zebra" }),
    build({ id: "a", pkg: "a.app", pkgLabel: "Alpha" }),
  ], ["z.app"], PHONE);
  assert.deepEqual(rows.map((r) => r.pkg), ["z.app", "a.app"]);
});

test("the note on a waiting app says what the phone is waiting FOR", () => {
  assert.match(waitingAppNote(true, PHONE), /installs itself when a build arrives/);
  assert.match(waitingAppNote(true, { ...PHONE, canInstall: false }), /once this phone allows it/);
  assert.match(waitingAppNote(false, PHONE), /no build of it on this phone/);
});

test("the summary counts the list against what the phone knows", () => {
  const rows = appRows([build(), build({ id: "b", pkg: "b.app", pkgLabel: "B" })], ["de.hoh.tiptoi"], PHONE);
  assert.match(appsSummary(rows, PHONE), /^1 of 2 installs itself/);
  assert.match(appsSummary([], PHONE), /No app has been downloaded/);
  assert.match(appsSummary(rows, { ...PHONE, canInstall: false }), /Allow waterplane to install apps/);
  assert.match(appsSummary(rows, NO_INSTALL), /cannot install apps/);
  const none = appRows([build()], [], PHONE);
  assert.match(appsSummary(none, PHONE), /none of them installing by itself/);
});

test("install-now is offered only where a build is actually here", () => {
  const [withBuild] = appRows([build()], ["de.hoh.tiptoi"], PHONE);
  assert.equal(appInstallVerb(withBuild, PHONE)?.id, "l_1");
  assert.match(appInstallVerb(withBuild, PHONE)?.label ?? "", /install Tiptoi 0\.1\.98 now/);
  const [noBuild] = appRows([], ["de.hoh.tiptoi"], PHONE);
  assert.equal(appInstallVerb(noBuild, PHONE), null);
  // Mid-install, and on a phone that has not granted the access, there is
  // nothing to tap.
  const [busy] = appRows([build({ install: "installing" })], [], PHONE);
  assert.equal(appInstallVerb(busy, PHONE), null);
  assert.equal(appInstallVerb(withBuild, { ...PHONE, canInstall: false }), null);
});

test("an app row words its state exactly as the download row does", () => {
  const [row] = appRows([build({ install: "asked" })], [], PHONE);
  assert.equal(appStateText(row), installStatusText(build({ install: "asked" })));
  const [failed] = appRows([build({ install: "failed", installError: "signatures do not match" })], [], PHONE);
  assert.match(appStateText(failed) ?? "", /signatures do not match/);
});

// ── ready to install ─────────────────────────────────────────────────

const rec = (id, over = {}) => ({
  item: { id, name: "app-debug.apk", repoName: "Tiptoi" },
  state: "done", pkg: "de.hoh.tiptoi", pkgLabel: "Tiptoi", pkgVersion: "1.4", updatedAt: 1, ...over,
});

test("ready is an app whose newest build has not gone on — asked and failed still need the tap", () => {
  const rows = appRows(buildsOf([
    rec("a", { install: "" }),
    rec("b", { pkg: "x.asked", install: "asked", updatedAt: 3 }),
    rec("c", { pkg: "x.failed", install: "failed", updatedAt: 2 }),
    rec("d", { pkg: "x.done", install: "installed" }),
    rec("e", { pkg: "x.busy", install: "installing" }),
    rec("f", { pkg: "x.gone", evicted: true }),
  ]), [], PHONE);
  // Newest first: the list is where a swiped-away notification is found again.
  assert.deepEqual(readyApps(rows).map((r) => r.pkg), ["x.asked", "x.failed", "de.hoh.tiptoi"]);
});

test("an older build is not ready once a newer one of the same app is here", () => {
  const rows = appRows(buildsOf([
    rec("old", { updatedAt: 1, pkgVersion: "1.3", install: "installed" }),
    rec("new", { updatedAt: 5, pkgVersion: "1.4" }),
  ]), [], PHONE);
  const ready = readyApps(rows);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].buildId, "new");
});

test("a snooze is said only while it is in force", () => {
  const [r] = appRows(buildsOf([rec("a", { installSnoozedUntil: 5_000 })]), [], PHONE);
  assert.equal(snoozeText(r, 1_000, () => "17:40"), "notification put off until 17:40");
  assert.equal(snoozeText(r, 6_000, () => "17:40"), null);
});

test("quiet updates: owned by waterplane, by someone else, or unknown — never guessed", () => {
  const src = {
    self: "dev.unsuck.amc",
    byPkg: {
      "io.paint": { installer: "dev.unsuck.amc", updateOwner: "dev.unsuck.amc" },
      "de.hoh.tiptoi": { installer: "com.google.android.packageinstaller" },
      "x.adb": {},
      "x.old": { installer: "dev.unsuck.amc" },
    },
  };
  assert.deepEqual(quietVerdict("io.paint", src), { verdict: "ours" });
  assert.deepEqual(quietVerdict("x.old", src), { verdict: "ours" });
  assert.deepEqual(quietVerdict("de.hoh.tiptoi", src), { verdict: "other", by: "com.google.android.packageinstaller" });
  assert.deepEqual(quietVerdict("x.adb", src), { verdict: "other", by: undefined });
  assert.deepEqual(quietVerdict("not.there", src), { verdict: "unknown" });
  assert.deepEqual(quietVerdict("io.paint", null), { verdict: "unknown" });
  // An owner that is not waterplane wins over waterplane having been the installer.
  assert.equal(quietVerdict("y", { self: "dev.unsuck.amc", byPkg: { y: { installer: "dev.unsuck.amc", updateOwner: "com.android.vending" } } }).verdict, "other");

  assert.equal(quietOwnerText("Paint", quietVerdict("io.paint", src)), null);
  assert.equal(quietOwnerText("Tiptoi", { verdict: "unknown" }), null);
  const t = quietOwnerText("Tiptoi", quietVerdict("de.hoh.tiptoi", src));
  assert.match(t, /every update of Tiptoi will ask/);
  assert.match(t, /file manager or a browser/);
  assert.match(t, /deletes its data/);
  assert.match(installerName(undefined), /adb or Android Studio/);
  assert.equal(installerName("org.fdroid.fdroid"), "org.fdroid.fdroid");
});

// ── the dev / play split ─────────────────────────────────────────────

const PLAY = { ...PHONE, silent: false, distribution: "play", self: "dev.waterplane.app" };
const DEV = { ...PHONE, distribution: "dev", self: "dev.waterplane.app.dev" };

test("the shell's distribution: two known words, anything else is ABSENT (inherit)", () => {
  assert.deepEqual(shellDistribution({ distribution: "play", self: "dev.waterplane.app" }),
    { distribution: "play", self: "dev.waterplane.app" });
  assert.deepEqual(shellDistribution({ distribution: "dev" }), { distribution: "dev" });
  // An older shell says nothing; a word this bundle never heard is not guessed.
  assert.deepEqual(shellDistribution({ canInstall: true }), {});
  assert.deepEqual(shellDistribution({ distribution: "beta", self: "" }), {});
  assert.deepEqual(shellDistribution(null), {});
  assert.equal(isPlayBuild(PHONE), false, "absent is today's full behaviour");
  assert.equal(isPlayBuild(DEV), false);
  assert.equal(isPlayBuild(PLAY), true);
});

test("an older shell (no distribution) words everything exactly as the dev build", () => {
  const allow = ["de.hoh.tiptoi"];
  for (const r of [row(), row({ pkg: "dev.waterplane.app" })]) {
    assert.equal(autoInstallText(r, PHONE, allow), autoInstallText(r, DEV, allow));
    assert.deepEqual(allowToggle(r, PHONE, allow), allowToggle(r, DEV, allow));
    assert.deepEqual(installOffer(r, PHONE), installOffer(r, DEV));
  }
  assert.equal(installIntroText(PHONE, allow), installIntroText(DEV, allow));
});

test("play: the shell never installs ITSELF, and says why instead of drawing the button", () => {
  const self = row({ pkg: "dev.waterplane.app", pkgLabel: "waterplane" });
  const offer = installOffer(self, PLAY);
  assert.equal(offer.verb, null);
  assert.equal(offer.reason, PLAY_SELF_TEXT);
  assert.match(PLAY_SELF_TEXT, /updates through Google Play/);
  assert.equal(isPlaySelf("dev.waterplane.app", PLAY), true);
  // The dev build installing its own package is the dogfood self-update.
  assert.equal(installOffer(row({ pkg: "dev.waterplane.app.dev" }), DEV).verb, "install");
  // Another app is still a tap away in the Play build.
  assert.equal(installOffer(row(), PLAY).verb, "install");
  // An archive it could not read: the self check needs the package.
  assert.equal(installOffer(row({ pkg: "" }), PLAY).reason, PLAY_UNREAD_TEXT);
  const [app] = appRows([build({ pkg: "dev.waterplane.app" })], [], PLAY);
  assert.equal(appInstallVerb(app, PLAY), null);
  assert.equal(app.note, PLAY_SELF_TEXT);
});

test("play: no auto-install switch, and the row SAYS why (never a dimmed switch)", () => {
  const allow = ["de.hoh.tiptoi"];
  assert.equal(allowToggle(row(), PLAY, allow), null);
  const why = autoInstallText(row(), PLAY, allow) ?? "";
  assert.match(why, /Google Play/);
  assert.match(why, /every install asks/);
  assert.equal(why, playAutoText("Tiptoi"));
  assert.equal(installIntroText(PLAY, allow), PLAY_INTRO_TEXT);
  assert.match(appsSummary(appRows([build()], allow, PLAY), PLAY), /one tap each/);
  assert.match(waitingAppNote(true, PLAY), /installs nothing by itself/);
  // Without the special access the Settings sentence still comes first.
  assert.match(installIntroText({ ...PLAY, canInstall: false }, []) ?? "", /Allow waterplane to install apps/);
});
