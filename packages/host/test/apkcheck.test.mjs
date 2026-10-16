/**
 * `apkcheck.ts`: the setup row for a repo that builds an Android app — absent
 * for every other repo, a warn with no APK in the outbox or an old targetSdk,
 * and never a number where the gradle file had a variable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { apkInstallCheck, apkRepoFacts, looksLikeApkBuild, readGradle } = await import("../dist/apkcheck.js");

const repo = (gradle, apks = []) => {
  const d = mkdtempSync(join(tmpdir(), "apkcheck-"));
  if (gradle != null) {
    mkdirSync(join(d, "app"), { recursive: true });
    writeFileSync(join(d, "app", "build.gradle.kts"), gradle);
  }
  if (apks.length) {
    mkdirSync(join(d, ".claude", "outbox"), { recursive: true });
    for (const a of apks) writeFileSync(join(d, ".claude", "outbox", a), "x");
  }
  return d;
};

const KTS = `plugins { id("com.android.application") }
android { defaultConfig { applicationId = "de.hoh.tiptoi"; targetSdk = 35 } }`;

test("no Android app module: no row at all", () => {
  const d = repo(null);
  try { assert.equal(apkInstallCheck(d), null); } finally { rmSync(d, { recursive: true }); }
});

test("an APK in the outbox and a recent target: pass, naming the package and the phone half", () => {
  const d = repo(KTS, ["tiptoi-0820.apk"]);
  try {
    const c = apkInstallCheck(d);
    assert.equal(c.id, "apk-install");
    assert.equal(c.status, "pass");
    assert.match(c.detail, /^de\.hoh\.tiptoi: 1 APK in the outbox/);
    assert.match(c.detail, /FIRST install of the app must come from waterplane/);
    assert.match(c.detail, /debug key/);
  } finally { rmSync(d, { recursive: true }); }
});

test("no APK in the outbox: warn, and says where it has to go", () => {
  const d = repo(KTS);
  try {
    const c = apkInstallCheck(d);
    assert.equal(c.status, "warn");
    assert.match(c.detail, /No APK in \.claude\/outbox\//);
  } finally { rmSync(d, { recursive: true }); }
});

test("an old targetSdk warns; a variable is not read as a number", () => {
  const d = repo(KTS.replace("35", "29"), ["a.apk"]);
  try { assert.match(apkInstallCheck(d).detail, /targetSdk 29 is below 33/); } finally { rmSync(d, { recursive: true }); }
  assert.equal(readGradle("targetSdkVersion rootProject.ext.targetSdkVersion").targetSdk, undefined);
  assert.equal(readGradle("targetSdkVersion 34").targetSdk, 34);
  assert.equal(readGradle(`signingConfig = signingConfigs.getByName("release")`).repoKey, true);
});

const PULL = { enabled: true, scope: "outbox", match: [], maxBytes: 256 * 1024 * 1024, builds: true, supersede: true };
const anyMatch = (cfg, f) => !(cfg.maxBytes > 0 && f.size > cfg.maxBytes);

test("facts: the repo half as data — package, key, outbox, builds, the auto-download rule", async () => {
  const d = repo(KTS, ["tiptoi-debug-1.apk"]);
  try {
    const builds = [{ id: "debug-apk", name: "Debug APK", cmd: "./gradlew assembleDebug" }, { id: "lint", name: "Lint", cmd: "npm run lint" }];
    const [f] = await apkRepoFacts({ id: "r1", repoName: "Tiptoi", worktreePath: d }, builds, PULL, anyMatch);
    assert.equal(f.pkg, "de.hoh.tiptoi");
    assert.equal(f.targetSdk, 35);
    assert.equal(f.key, "debug-default");
    assert.equal(f.apks, 1);
    assert.equal(f.newestApk.rel, ".claude/outbox/tiptoi-debug-1.apk");
    assert.deepEqual(f.builds.map((b) => b.apk), [true, false]);
    assert.deepEqual(f.autoPull, { enabled: true, builds: true, maxBytes: PULL.maxBytes, newestMatches: true });
  } finally { rmSync(d, { recursive: true }); }
});

test("facts: no APK ⇒ newestMatches ABSENT, never false; a module reading keystore.properties without one ⇒ missing", async () => {
  const d = repo(KTS + `\nval p = rootProject.file("keystore.properties")`);
  try {
    const [f] = await apkRepoFacts({ id: "r1", repoName: "x", worktreePath: d }, [], { ...PULL, enabled: false }, anyMatch);
    assert.equal(f.apks, 0);
    assert.equal(f.autoPull.newestMatches, undefined);
    assert.equal(f.key, "missing");
  } finally { rmSync(d, { recursive: true }); }
});

test("facts: a repo with no app module answers no rows", async () => {
  const d = repo(null);
  try { assert.deepEqual(await apkRepoFacts({ id: "r", repoName: "x", worktreePath: d }, [], PULL, anyMatch), []); }
  finally { rmSync(d, { recursive: true }); }
});

test("an APK build is read off the name or the command, and is only a label", () => {
  assert.equal(looksLikeApkBuild({ name: "Debug APK", cmd: "bash phone-build-debug.sh" }), true);
  assert.equal(looksLikeApkBuild({ name: "Release", cmd: "flutter build apk --release" }), true);
  assert.equal(looksLikeApkBuild({ name: "x", cmd: "./gradlew assembleRelease" }), true);
  assert.equal(looksLikeApkBuild({ name: "Tests", cmd: "npm test" }), false);
});

test("facts: a package-less module beside a named one is dropped; suffixes become variants", async () => {
  const d = repo(KTS.replace("targetSdk = 35", `targetSdk = 35 }; buildTypes { debug { applicationIdSuffix = ".dev" }`));
  writeFileSync(join(d, "build.gradle.kts"), `plugins { id("com.android.application") version "8" apply false }`);
  try {
    const fs = await apkRepoFacts({ id: "r", repoName: "x", worktreePath: d }, [], PULL, anyMatch);
    assert.equal(fs.length, 1);
    assert.deepEqual(fs[0].variants, ["de.hoh.tiptoi.dev"]);
  } finally { rmSync(d, { recursive: true }); }
});
