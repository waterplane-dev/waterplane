import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowToggle, appLabel, autoInstallText, installIntroText, installOffer, installStatusText, installVerbText, isApkRow, isAllowed, NO_INSTALL, toggleAllow, cleanedText, repeatedVersionText, isPlayBuild, shellDistribution,
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

test("over a plain route a finished APK offers no install, and the row says why and what to do", () => {
  const offer = installOffer(row(), { ...PHONE, plainRoute: true });
  assert.equal(offer.verb, null);
  assert.match(offer.reason, /do not download or install on this route/);
  assert.match(offer.reason, /tailnet/);
  assert.equal(installOffer(row(), PHONE).verb, "install");
  assert.equal(installOffer(row(), { ...NO_INSTALL, plainRoute: true }).reason, null, "a browser is told nothing");
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
    installStatusText(row({ install: "failed", installError: "Package is invalid" })) ?? "",
    /could not install: Package is invalid/,
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
  assert.equal(installVerbText("failed", "Session was abandoned"), "retry install");
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
  assert.match(allowToggle(row(), PHONE, []).label, /install Tiptoi by itself/);
  assert.match(allowToggle(row(), PHONE, ["de.hoh.tiptoi"]).label, /stop installing Tiptoi/);
  assert.equal(allowToggle(row(), PHONE, ["de.hoh.tiptoi"]).on, true);
});

test("the sheet's one line counts what is actually on the list", () => {
  assert.match(installIntroText(PHONE, []) ?? "", /No app installs by itself yet/);
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

test("a cleaned build says the clean-up took it, not the eviction, and a Downloads copy that stayed is said", () => {
  const cleaned = installOffer(row({ evicted: true, install: "installed", cleanedAt: 1, cleanedBytes: 42e6 }), PHONE);
  assert.equal(cleaned.verb, null);
  assert.match(cleaned.reason, /deleted after it installed \(42 MB freed\)/);
  assert.doesNotMatch(cleaned.reason, /cleared to save space/);
  const stayed = cleanedText({ cleanedAt: 1, cleanedBytes: 0, cleanNote: "the copy in Downloads/a.apk is no longer this app's to delete — remove it by hand" });
  assert.match(stayed, /remove it by hand/);
  assert.doesNotMatch(stayed, /freed/);
  // Bytes still here: the clean-up mark alone never hides the install verb.
  assert.equal(installOffer(row({ cleanedAt: 1 }), PHONE).verb, "install");
});

test("repeatedVersionText: a newer build declaring an older build's version says so, on the newer one only", () => {
  const old = row({ name: "a-dirty.apk", pkgVersion: "0.1.5", mtime: 1000 });
  const neu = row({ name: "a-dirty_2.apk", pkgVersion: "0.1.5", mtime: 2000 });
  const all = [old, neu];
  assert.match(repeatedVersionText(neu, all), /same version \(0\.1\.5\) as an older build/);
  assert.equal(repeatedVersionText(old, all), null);
  // A raised version, one file fetched twice, an unread package or stamp: nothing to say.
  assert.equal(repeatedVersionText({ ...neu, pkgVersion: "0.1.6" }, all), null);
  assert.equal(repeatedVersionText(neu, [neu, { ...neu, name: "copy.apk" }]), null);
  assert.equal(repeatedVersionText({ ...neu, mtime: undefined }, all), null);
  assert.equal(repeatedVersionText(neu, [{ ...old, pkg: "other.app" }, neu]), null);
});


test("a signing-key conflict is never offered as a retry: it names the uninstall, its data cost, and the other way", () => {
  const err = "it conflicts with the app already installed — INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package "
    + "dev.waterplane.app signatures do not match newer version; ignoring!";
  const text = installStatusText(row({ install: "failed", installError: err })) ?? "";
  assert.match(text, /signed with a different key/);
  assert.match(text, /a retry fails the same way/);
  assert.match(text, /uninstall that copy first \(which deletes its data/);
  assert.match(text, /build it with the key the installed copy has/);
  assert.doesNotMatch(text, /ignoring!/);
  assert.equal(installVerbText("failed", err), "install after uninstalling the old copy");
  assert.equal(installVerbText("failed", "signatures do not match"), "install after uninstalling the old copy");
});
