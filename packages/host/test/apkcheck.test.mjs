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
const { apkInstallCheck, readGradle } = await import("../dist/apkcheck.js");

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
