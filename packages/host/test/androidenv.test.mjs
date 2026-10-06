/**
 * The Android toolchain probe (`androidenv.ts`) over fixture directories, the doctor lines it
 * feeds, and the `android-toolchain` compliance row on an Android vs a non-Android repo.
 * Read-only: nothing here installs or accepts anything; `exec` is a fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { probeAndroidEnv, isAndroidRepo, realDeps } = await import("../dist/androidenv.js");
const { androidToolchainRow } = await import("../dist/compliance.js");
const { androidChecks } = await import("../dist/doctor.js");

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "androidenv-")));
const touch = (p, text = "") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };

function jdk(home, version = "21.0.4") {
  touch(join(home, "bin", "java"));
  touch(join(home, "release"), `JAVA_VERSION="${version}"\n`);
  return home;
}
function sdk(root, { platform = true, tools = true, licences = true, cmdline = true } = {}) {
  mkdirSync(root, { recursive: true });
  if (platform) mkdirSync(join(root, "platforms", "android-35"), { recursive: true });
  if (tools) mkdirSync(join(root, "build-tools", "35.0.0"), { recursive: true });
  if (cmdline) touch(join(root, "cmdline-tools", "latest", "bin", "sdkmanager"));
  if (licences) touch(join(root, "licenses", "android-sdk-license"), "hash");
}
// Sandboxed to the fixture home: this machine's own brew JDK must not leak into a "missing" case.
const deps = (home, env = {}, extra = {}) => {
  const real = realDeps();
  const inside = (p) => p.startsWith(home);
  return {
    ...real, home, env, platform: "darwin", exec: () => null,
    exists: (p) => inside(p) && real.exists(p),
    readdir: (p) => (inside(p) ? real.readdir(p) : []),
    readText: (p) => (inside(p) ? real.readText(p) : null),
    ...extra,
  };
};

test("found via env: JAVA_HOME and ANDROID_HOME, nothing missing", () => {
  const home = tmp();
  const j = jdk(join(home, "somejdk"));
  sdk(join(home, "mysdk"));
  const r = probeAndroidEnv(deps(home, { JAVA_HOME: j, ANDROID_HOME: join(home, "mysdk") }));
  assert.equal(r.jdk?.source, "JAVA_HOME");
  assert.equal(r.jdk?.major, 21);
  assert.equal(r.sdk?.source, "ANDROID_HOME");
  assert.deepEqual(r.missing, []);
  assert.equal(r.installBytes, 0);
  assert.equal(r.summary, null);
});

test("found via Android Studio's default path, and java_home", () => {
  const home = tmp();
  sdk(join(home, "Library", "Android", "sdk"));
  const j = jdk(join(home, "jh"), "17.0.9");
  const r = probeAndroidEnv(deps(home, {}, { exec: (cmd, args) => (cmd === "/usr/libexec/java_home" && args[1] === "17+" ? `${j}\n` : null) }));
  assert.equal(r.sdk?.source, "default");
  assert.equal(r.jdk?.source, "java_home");
  assert.deepEqual(r.missing, []);
});

test("Linux default SDK path", () => {
  const home = tmp();
  sdk(join(home, "Android", "Sdk"));
  const r = probeAndroidEnv({ ...deps(home), platform: "linux" });
  assert.equal(r.sdk?.root, join(home, "Android", "Sdk"));
});

test("waterplane's own JDK dir is found, one tarball directory down", () => {
  const home = tmp();
  jdk(join(home, ".config", "waterplane", "jdk", "jdk-21.0.4+7"));
  const r = probeAndroidEnv(deps(home));
  assert.equal(r.jdk?.source, "own");
});

test("a JDK older than 17 is reported, not used", () => {
  const home = tmp();
  const j = jdk(join(home, "old"), "1.8.0_392");
  const r = probeAndroidEnv(deps(home, { JAVA_HOME: j }));
  assert.equal(r.jdk, null);
  assert.equal(r.jdkTooOld?.major, 8);
  assert.ok(r.missing.includes("jdk"));
  assert.match(r.summary, /too old/);
});

test("everything missing: names each part and sizes the install", () => {
  const r = probeAndroidEnv(deps(tmp()));
  assert.deepEqual(r.missing, ["jdk", "sdk", "platform", "build-tools"]);
  assert.ok(r.installBytes > 400 * 1024 * 1024);
  assert.match(r.summary, /Missing: a JDK 17 or newer, the Android SDK/);
  assert.match(r.summary, /about \d+ MB/);
});

test("licences missing: the only gap, costs no download", () => {
  const home = tmp();
  const j = jdk(join(home, "j"));
  sdk(join(home, "Library", "Android", "sdk"), { licences: false });
  const r = probeAndroidEnv(deps(home, { JAVA_HOME: j }));
  assert.deepEqual(r.missing, ["licences"]);
  assert.equal(r.installBytes, 0);
  assert.doesNotMatch(r.summary, /download/);
});

test("an SDK with no platform or build-tools names those and sdkmanager", () => {
  const home = tmp();
  const j = jdk(join(home, "j"));
  sdk(join(home, "Library", "Android", "sdk"), { platform: false, tools: false, cmdline: false, licences: false });
  const r = probeAndroidEnv(deps(home, { JAVA_HOME: j }));
  assert.deepEqual(r.missing, ["platform", "build-tools", "cmdline-tools", "licences"]);
});

test("the probe writes nothing", () => {
  const home = tmp();
  probeAndroidEnv(deps(home));
  assert.deepEqual(readdirSync(home), []);
});

test("doctor lines: absent is ok with a reason, unaccepted licences are the one warn", () => {
  const none = androidChecks(probeAndroidEnv(deps(tmp())));
  assert.deepEqual(none.map((c) => [c.id, c.status]), [["java", "ok"], ["android-sdk", "ok"], ["sdk-licences", "ok"]]);
  const home = tmp();
  sdk(join(home, "Library", "Android", "sdk"), { licences: false });
  const lic = androidChecks(probeAndroidEnv(deps(home))).find((c) => c.id === "sdk-licences");
  assert.equal(lic.status, "warn");
  assert.ok(lic.fix);
});

function repo(files) {
  const dir = tmp();
  for (const [p, text] of Object.entries(files)) touch(join(dir, p), text);
  return dir;
}

test("Android detection: gradle plugin, manifest, deep module; not a Node repo", () => {
  assert.ok(isAndroidRepo(repo({ "app/build.gradle.kts": 'plugins { id("com.android.application") }' })));
  assert.ok(isAndroidRepo(repo({ "packages/app/android/app/src/main/AndroidManifest.xml": "<manifest/>" })));
  assert.ok(!isAndroidRepo(repo({ "package.json": "{}", "src/index.ts": "", "build.gradle": "plugins { id 'java' }" })));
  assert.ok(!isAndroidRepo(repo({ "node_modules/x/AndroidManifest.xml": "" })));
});

test("android-toolchain row: Android repo warns in words, non-Android repo has no row", () => {
  const android = repo({ "app/build.gradle.kts": 'plugins { id("com.android.application") }' });
  const missing = probeAndroidEnv(deps(tmp()));
  const row = androidToolchainRow(android, () => missing);
  assert.equal(row.id, "android-toolchain");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /Missing: a JDK 17 or newer/);
  assert.match(row.detail, /Android Studio/);

  const node = repo({ "package.json": "{}" });
  assert.equal(androidToolchainRow(node, () => missing), null);

  const home = tmp();
  const j = jdk(join(home, "j"));
  sdk(join(home, "sdk"));
  const ready = probeAndroidEnv(deps(home, { JAVA_HOME: j, ANDROID_HOME: join(home, "sdk") }));
  assert.equal(androidToolchainRow(android, () => ready).status, "pass");
  assert.ok(!existsSync(join(android, ".waterplane")));
});

test("the probe's java_home spawn is asked once per boot, again only after an invalidation", async () => {
  const { cachedExec, invalidateAndroidProbe } = await import("../dist/androidenv.js");
  invalidateAndroidProbe();
  let n = 0;
  const run = (cmd) => { n++; return cmd === "/fake/java_home" ? "/jdk/home\n" : null; };
  assert.equal(cachedExec("/fake/java_home", ["-v", "17+"], run), "/jdk/home\n");
  assert.equal(cachedExec("/fake/java_home", ["-v", "17+"], run), "/jdk/home\n");
  assert.equal(n, 1, "a second probe on a request path spawns nothing");
  // A miss is remembered too: the 4 s timeout is the case worth not paying twice.
  assert.equal(cachedExec("/fake/none", [], run), null);
  assert.equal(cachedExec("/fake/none", [], run), null);
  assert.equal(n, 2);
  // Different args are a different question.
  cachedExec("/fake/java_home", ["-v", "21+"], run);
  assert.equal(n, 3);
  invalidateAndroidProbe();
  cachedExec("/fake/java_home", ["-v", "17+"], run);
  assert.equal(n, 4, "after a toolchain step the machine is asked again");
  invalidateAndroidProbe();
});
