// first-app WP1: scaffold the android-hello template into a temp root and run the repo's own
// first build command (`.waterplane/builds.json`'s "release"), IF a JDK and an Android SDK are
// already on this machine. It never downloads an SDK or JDK: without them it prints that it
// skipped and exits 0. (The unit/host test `scaffoldtemplates.test.mjs` pins the files.)
//
//   WATERPLANE_E2E_COLD=1  use an empty GRADLE_USER_HOME (downloads Gradle + dependencies, ~0.5 GB
//                          into the temp dir) — the number the plan's 6-minute budget is about.
//                          Default: the machine's own Gradle cache, reported as WARM.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { E, SLUG, STATE } from "./lib-brand.mjs";

const skip = (why) => { console.log(`SKIP: e2e-templates did not build android-hello — ${why}`); process.exit(0); };
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

// An SDK that has what the template compiles against (compileSdk 36, build-tools 35.0.0).
const sdkCandidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library/Android/sdk"), join(homedir(), "Android/Sdk")].filter(Boolean);
const sdk = sdkCandidates.find((d) => existsSync(join(d, "platforms/android-36")) && existsSync(join(d, "build-tools/35.0.0")));
if (!sdk) skip(`no Android SDK with platforms/android-36 + build-tools/35.0.0 in ${sdkCandidates.join(", ") || "(no candidates)"}`);

// A JDK 17..21 (AGP 8.13 / Gradle 8.14 do not run on 25).
let javaHome = process.env.JAVA_HOME;
const jdkMajor = (h) => { try { return Number(/version "(\d+)/.exec(spawnSync(join(h, "bin/java"), ["-version"], { encoding: "utf8" }).stderr)?.[1]); } catch { return 0; } };
if (!javaHome || ![17, 21].includes(jdkMajor(javaHome))) {
  javaHome = undefined;
  for (const v of ["21", "17"]) {
    try { const h = execFileSync("/usr/libexec/java_home", ["-v", v], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); if (h && jdkMajor(h) === Number(v)) { javaHome = h; break; } } catch { /* none of that version */ }
  }
}
if (!javaHome) skip("no JDK 17 or 21 (JAVA_HOME or /usr/libexec/java_home)");

const { newRepo } = await import("../packages/host/dist/scaffold.js");
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-templates-`));
const res = await newRepo(ROOT, ROOT, "hello-e2e", { template: "android-hello" });
if ("error" in res) { console.error("FAIL: scaffold:", res.error); process.exit(1); }
const dir = res.path;
const builds = JSON.parse(readFileSync(join(dir, STATE, "builds.json"), "utf8"));
const release = builds.find((b) => b.id === "release");
check(!!release, "builds.json offers a release build");

const cold = process.env[E.E2E_COLD] === "1";
const gradleHome = cold ? join(ROOT, "gradle-home") : (process.env.GRADLE_USER_HOME || join(homedir(), ".gradle"));
console.log(`building with JDK ${jdkMajor(javaHome)} (${javaHome}), SDK ${sdk}, ${cold ? "COLD (empty GRADLE_USER_HOME)" : "WARM (existing Gradle cache — not the plan's cold number)"}`);
const started = Date.now();
const run = spawnSync("sh", ["-lc", release.cmd], {
  cwd: dir, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, GRADLE_USER_HOME: gradleHome, CI: "1" },
});
const secs = Math.round((Date.now() - started) / 1000);
if (run.status !== 0) { console.error((run.stdout || "").split("\n").slice(-40).join("\n"), run.stderr); }
check(run.status === 0, `"${release.cmd}" exits 0 (${secs}s, ${cold ? "cold" : "warm"})`);

const apk = join(dir, "app/build/outputs/apk/release/app-release.apk");
check(existsSync(apk) && statSync(apk).size > 100_000, "app-release.apk exists where artifacts collection looks (build/outputs)");
console.log(`BUILD-TIME ${cold ? "cold" : "warm"}: ${secs}s`);

if (!process.env[E.E2E_KEEP]) rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
