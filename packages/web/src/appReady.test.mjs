/**
 * `appReady.ts`: the per-app checklist that joins the desktop's facts with this
 * phone's half — the first `no` named as the blocker, unknown never a guess,
 * and another phone's outcome never counted as this one's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneChecks, readiness, readinessCut, readinessVerdict, repoChecks } from "./appReady.ts";
import { failureText } from "./installPolicy.ts";

const NOW = 1_800_000_000_000;
const ago = (ms) => `${Math.round(ms / 60000)} min ago`;
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
const entry = (over) => ({ key: Math.random().toString(), deviceId: "phone-a", pullId: "p", pkg: "de.hoh.tiptoi",
  outcome: "installed", reportedAt: NOW - 60000, at: NOW - 60000, auto: true, version: "0.1.1", ...over });

test("everything holds: no blocker, the card says it installs itself", () => {
  const [r] = readiness([facts()], [], ph({ log: [entry({})] }));
  assert.equal(r.blocker, undefined);
  assert.equal(readinessVerdict(r), "installs itself");
  assert.deepEqual(r.checks.map((c) => c.id), ["build", "outbox", "key", "sdk", "pull", "access", "switch", "owner", "last"]);
});

test("the first NO is the blocker, desktop half first", () => {
  const [r] = readiness([facts({ apks: 0, newestApk: undefined, autoPull: { enabled: false, builds: true, maxBytes: 0 } })], [], ph({ allow: [] }));
  assert.equal(r.blocker.id, "outbox");
  assert.match(readinessVerdict(r), /^not yet — APK in the outbox/);
});

test("an APK over the auto-download cap is named with both sizes", () => {
  const c = repoChecks(facts({ newestApk: { rel: "a.apk", mtime: NOW, size: 232e6 }, autoPull: { enabled: true, builds: true, maxBytes: 64e6, newestMatches: false } }), NOW, ago)
    .find((x) => x.id === "pull");
  assert.equal(c.state, "no");
  assert.match(c.text, /232 MB is over its 64 MB cap/);
});

test("an unread targetSdk is unknown and blocks nothing; a debug-default key is a caveat", () => {
  const cs = repoChecks(facts({ targetSdk: undefined, key: "debug-default" }), NOW, ago);
  assert.equal(cs.find((c) => c.id === "sdk").state, "unknown");
  assert.equal(cs.find((c) => c.id === "key").state, "warn");
});

test("the last attempt is THIS phone's — another phone's success does not count", () => {
  const log = [
    entry({ deviceId: "phone-b", at: NOW - 1000 }),
    entry({ outcome: "failed", error: "the install was cancelled — INSTALL_FAILED_VERIFICATION_FAILURE: Install not allowed", at: NOW - 120000 }),
  ];
  const last = phoneChecks("de.hoh.tiptoi", "Tiptoi", ph({ log })).find((c) => c.id === "last");
  assert.equal(last.state, "no");
  assert.match(last.text, /Play Protect/);
});

test("an app first installed by someone else blocks, and says who", () => {
  const owner = phoneChecks("de.hoh.tiptoi", "Tiptoi",
    ph({ sources: { self: "dev.waterplane.app.dev", byPkg: { "de.hoh.tiptoi": { installer: "com.android.shell" } } } }))
    .find((c) => c.id === "owner");
  assert.equal(owner.state, "no");
  assert.match(owner.text, /adb or Android Studio/);
});

test("a flavor's suffix joins the repo to the package the phone actually has", () => {
  const f = facts({ pkg: "dev.waterplane.app", variants: ["dev.waterplane.app.dev"] });
  const [r] = readiness([f], [], ph({ allow: ["dev.waterplane.app.dev"] }));
  assert.equal(r.pkg, "dev.waterplane.app.dev");
  assert.equal(r.checks.find((c) => c.id === "switch").state, "ok");
});

test("a phone app no repo builds keeps its phone half; the desktop not answering is not 'no repo'", () => {
  const row = { pkg: "com.x", label: "X", allowed: true, note: "" };
  const [r1] = readiness([], [row], ph({ allow: ["com.x"] }));
  assert.match(r1.checks[0].text, /No repo on this desktop builds com\.x/);
  const [r2] = readiness(null, [row], ph({ allow: ["com.x"] }));
  assert.match(r2.checks[0].text, /has not answered/);
});

test("the chips' count and cut are one function", () => {
  const rows = readiness([facts(), facts({ pkg: "a.b", repoName: "AB" })], [], ph({ log: [entry({})] }));
  assert.equal(readinessCut(rows, "blocked").length + readinessCut(rows, "ready").length, rows.length);
  assert.equal(readinessCut(rows, "blocked")[0].pkg, "a.b");
});

test("failure words: Play Protect and an abandoned session are explained, unknown text passes through", () => {
  assert.match(failureText("INSTALL_FAILED_VERIFICATION_FAILURE: Install not allowed"), /Play Protect/);
  assert.match(failureText("INSTALL_FAILED_ABORTED: Session was abandoned"), /retry starts a fresh one/i);
  assert.equal(failureText("something new"), "something new");
});
