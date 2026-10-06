/**
 * What this desktop already has for building an Android app: a JDK and the Android SDK.
 *
 * READ-ONLY, and the first half of the first-app journey's "find first, install user-local"
 * (`docs/analysis/first-app-plan.md`). Whatever is found here is never reinstalled; whatever is
 * missing is what the install (WP3's `toolchain.ts`) would fetch, with a size so the consent
 * screen can say it out loud.
 *
 * Never writes, never installs, never accepts a licence, never sudo. Everything it touches goes
 * through `AndroidEnvDeps`, so a test hands it a fixture directory and a fake `exec`.
 * Synchronous on purpose: `inspectRepo` (the setup checklist) is.
 *
 * Every reading degrades to ABSENT — a JDK whose `release` file cannot be read has an unknown
 * version, and an unknown version is "found, version not read", never a number.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

/** Oldest JDK the Android Gradle plugin of this decade accepts. */
export const MIN_JDK_MAJOR = 17;
/**
 * What the install asks sdkmanager for: exactly what `templates/android-hello` builds against
 * (`compileSdk`/`targetSdk` 36, `buildToolsVersion = "35.0.0"`). Change one, change the other.
 */
export const WANT_PLATFORM = "android-36";
export const WANT_BUILD_TOOLS = "35.0.0";

/** Rough download sizes, bytes — an ESTIMATE shown as "about", never a promise. */
const MB = 1024 * 1024;
export const SIZE_ESTIMATE = {
  jdk: 200 * MB,
  cmdlineTools: 160 * MB, // the pinned zips are 156-182 MB (toolchain.ts `CMDLINE_TOOLS_ZIPS`)
  platformTools: 15 * MB,
  platform: 65 * MB,
  buildTools: 60 * MB,
} as const;

export interface AndroidEnvDeps {
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  /** Entry names of a directory; `[]` when it cannot be read. */
  readdir(path: string): string[];
  /** File text, or null. */
  readText(path: string): string | null;
  /** Run a program and return stdout, or null on any failure. */
  exec(cmd: string, args: string[]): string | null;
}

function runQuiet(cmd: string, args: string[]): string | null {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}

/**
 * The probe's one spawn (`/usr/libexec/java_home`, up to 4 s, SYNCHRONOUS) is answered once per
 * host boot: the probe runs on request paths (`GET /api/onboard/plan`, each onboard step, the
 * checklist's `inspectRepo` sweep), on the thread pumping every PTY. The filesystem half of the
 * probe stays fresh on every call — it is cheap and is what an install changes. A toolchain step
 * that finishes calls `invalidateAndroidProbe()`, and so does each toolchain re-probe.
 */
const execMemo = new Map<string, string | null>();

export function cachedExec(cmd: string, args: string[], run: (cmd: string, args: string[]) => string | null = runQuiet): string | null {
  const key = [cmd, ...args].join("\0");
  if (execMemo.has(key)) return execMemo.get(key) ?? null;
  const out = run(cmd, args);
  execMemo.set(key, out);
  return out;
}

/** Forget the cached spawn answers (after a toolchain step, which may have installed a JDK). */
export function invalidateAndroidProbe(): void { execMemo.clear(); }

export function realDeps(): AndroidEnvDeps {
  return {
    env: process.env,
    home: homedir(),
    platform: process.platform,
    exists: (p) => existsSync(p),
    readdir: (p) => { try { return readdirSync(p); } catch { return []; } },
    readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    exec: (cmd, args) => cachedExec(cmd, args),
  };
}

export type JdkSource = "JAVA_HOME" | "java_home" | "brew" | "own";

export interface JdkFound {
  home: string;
  source: JdkSource;
  /** Major version off the JDK's `release` file; absent when unreadable. */
  major?: number;
}

export interface SdkFound {
  root: string;
  source: "ANDROID_HOME" | "ANDROID_SDK_ROOT" | "default";
  /** `platforms/android-*` directory names, sorted. */
  platforms: string[];
  /** `build-tools/*` directory names, sorted. */
  buildTools: string[];
  cmdlineTools: boolean;
  platformTools: boolean;
  /** `licenses/android-sdk-license` exists — the licence was accepted by someone, sometime. */
  licensesAccepted: boolean;
}

export type MissingPart = "jdk" | "sdk" | "platform" | "build-tools" | "cmdline-tools" | "licences";

export interface AndroidEnvReport {
  jdk: JdkFound | null;
  /** A JDK that was found but is older than `MIN_JDK_MAJOR` (and so not used). */
  jdkTooOld: JdkFound | null;
  sdk: SdkFound | null;
  /** What a build cannot do without, in install order. Empty ⇒ ready to build. */
  missing: MissingPart[];
  /** About how much an install of `missing` would download. 0 when nothing but a licence is missing. */
  installBytes: number;
  /** One plain sentence on what is missing, or null when nothing is. */
  summary: string | null;
}

function majorOf(release: string | null): number | undefined {
  const v = /JAVA_VERSION="?([\d.]+)/.exec(release ?? "")?.[1];
  if (!v) return undefined;
  const parts = v.split(".");
  const n = Number(parts[0] === "1" ? parts[1] : parts[0]);
  return Number.isFinite(n) ? n : undefined;
}

/** `dir` itself, or the JDK home inside a macOS bundle / a tarball's one top directory. */
function jdkHomeIn(d: AndroidEnvDeps, dir: string): string | null {
  const direct = [dir, join(dir, "libexec", "openjdk.jdk", "Contents", "Home"), join(dir, "Contents", "Home")];
  for (const c of direct) if (d.exists(join(c, "bin", "java"))) return c;
  // Adoptium tarball: one `jdk-21.0.x+y` directory, on mac with `Contents/Home` inside.
  for (const sub of d.readdir(dir)) {
    for (const c of [join(dir, sub), join(dir, sub, "Contents", "Home")]) {
      if (d.exists(join(c, "bin", "java"))) return c;
    }
  }
  return null;
}

function* jdkCandidates(d: AndroidEnvDeps): Generator<{ home: string; source: JdkSource }> {
  const jh = d.env.JAVA_HOME;
  if (jh) yield { home: jh, source: "JAVA_HOME" };
  if (d.platform === "darwin") {
    // Lazy: only runs when JAVA_HOME gave nothing usable.
    const out = d.exec("/usr/libexec/java_home", ["-v", `${MIN_JDK_MAJOR}+`])?.trim();
    if (out) yield { home: out.split("\n")[0], source: "java_home" };
  }
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt", "/home/linuxbrew/.linuxbrew/opt"]) {
    for (const f of ["openjdk@21", "openjdk@17", "openjdk"]) {
      const h = jdkHomeIn(d, join(prefix, f));
      if (h) yield { home: h, source: "brew" };
    }
  }
  const own = jdkHomeIn(d, join(d.home, ".config", BRAND.configDirName, "jdk"));
  if (own) yield { home: own, source: "own" };
}

export function findJdk(d: AndroidEnvDeps): { jdk: JdkFound | null; tooOld: JdkFound | null } {
  let tooOld: JdkFound | null = null;
  for (const c of jdkCandidates(d)) {
    if (!d.exists(join(c.home, "bin", "java"))) continue;
    const major = majorOf(d.readText(join(c.home, "release")));
    const found: JdkFound = { home: c.home, source: c.source, ...(major !== undefined ? { major } : {}) };
    // An unreadable version is accepted ("found, version not read"), a known-old one is not.
    if (major !== undefined && major < MIN_JDK_MAJOR) { tooOld ??= found; continue; }
    return { jdk: found, tooOld };
  }
  return { jdk: null, tooOld };
}

function readSdk(d: AndroidEnvDeps, root: string, source: SdkFound["source"]): SdkFound {
  const cl = join(root, "cmdline-tools");
  return {
    root,
    source,
    platforms: d.readdir(join(root, "platforms")).filter((n) => /^android-/.test(n)).sort(),
    buildTools: d.readdir(join(root, "build-tools")).filter((n) => /^\d/.test(n)).sort(),
    cmdlineTools: d.readdir(cl).some((v) => d.exists(join(cl, v, "bin", "sdkmanager"))),
    platformTools: d.exists(join(root, "platform-tools")),
    licensesAccepted: d.exists(join(root, "licenses", "android-sdk-license")),
  };
}

export function findSdk(d: AndroidEnvDeps): SdkFound | null {
  const cands: { root: string; source: SdkFound["source"] }[] = [];
  if (d.env.ANDROID_HOME) cands.push({ root: d.env.ANDROID_HOME, source: "ANDROID_HOME" });
  if (d.env.ANDROID_SDK_ROOT) cands.push({ root: d.env.ANDROID_SDK_ROOT, source: "ANDROID_SDK_ROOT" });
  if (d.platform === "darwin") cands.push({ root: join(d.home, "Library", "Android", "sdk"), source: "default" });
  if (d.platform === "linux") cands.push({ root: join(d.home, "Android", "Sdk"), source: "default" });
  const present = cands.filter((c) => d.exists(c.root)).map((c) => readSdk(d, c.root, c.source));
  // The first that can actually build wins; else the first that exists (so "licences missing" names it).
  return present.find((s) => s.platforms.length && s.buildTools.length) ?? present[0] ?? null;
}

function mbWords(bytes: number): string {
  const mb = Math.round(bytes / MB / 10) * 10;
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

const PART_WORDS: Record<MissingPart, string> = {
  jdk: `a JDK ${MIN_JDK_MAJOR} or newer`,
  sdk: "the Android SDK",
  platform: `an SDK platform (${WANT_PLATFORM})`,
  "build-tools": `SDK build-tools (${WANT_BUILD_TOOLS})`,
  "cmdline-tools": "the SDK command-line tools",
  licences: "accepted SDK licences",
};

export function probeAndroidEnv(d: AndroidEnvDeps = realDeps()): AndroidEnvReport {
  const { jdk, tooOld } = findJdk(d);
  const sdk = findSdk(d);
  const missing: MissingPart[] = [];
  let bytes = 0;
  if (!jdk) { missing.push("jdk"); bytes += SIZE_ESTIMATE.jdk; }
  if (!sdk) {
    missing.push("sdk", "platform", "build-tools");
    bytes += SIZE_ESTIMATE.cmdlineTools + SIZE_ESTIMATE.platformTools + SIZE_ESTIMATE.platform + SIZE_ESTIMATE.buildTools;
  } else {
    if (!sdk.platforms.length) { missing.push("platform"); bytes += SIZE_ESTIMATE.platform; }
    if (!sdk.buildTools.length) { missing.push("build-tools"); bytes += SIZE_ESTIMATE.buildTools; }
    // sdkmanager is only needed to FETCH something; a complete SDK without it builds fine.
    if (!sdk.cmdlineTools && (!sdk.platforms.length || !sdk.buildTools.length)) {
      missing.push("cmdline-tools"); bytes += SIZE_ESTIMATE.cmdlineTools;
    }
    if (!sdk.licensesAccepted) missing.push("licences");
  }
  let summary: string | null = null;
  if (missing.length) {
    const what = missing.map((m) => PART_WORDS[m]).join(", ");
    const old = tooOld && !jdk ? ` (found JDK ${tooOld.major} at ${tooOld.home}, too old)` : "";
    const size = bytes > 0 ? ` An install would download about ${mbWords(bytes)}.` : "";
    summary = `Missing: ${what}${old}.${size}`;
  }
  return { jdk, jdkTooOld: tooOld, sdk, missing, installBytes: bytes, summary };
}

// ---------------------------------------------------------------------------------------------
// Is this repo an Android repo? (Gates the checklist row; a Node repo is never told about a JDK.)

const SKIP = new Set(["node_modules", "build", "dist", ".git", ".gradle", ".idea", ".claude", BRAND.stateDirName]);

/**
 * `AndroidManifest.xml`, or a `build.gradle(.kts)` applying a `com.android` plugin, within six
 * directories (`packages/app/android/app/src/main` is six). Bounded: this runs in the checklist, on the
 * process pumping every PTY.
 */
export function isAndroidRepo(root: string, d: Pick<AndroidEnvDeps, "readdir" | "readText"> & { isDir?(p: string): boolean } = {
  ...realDeps(),
}): boolean {
  const isDir = d.isDir ?? ((p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  let budget = 400;
  const walk = (dir: string, depth: number): boolean => {
    if (budget-- <= 0) return false;
    const names = d.readdir(dir);
    for (const n of names) {
      if (n === "AndroidManifest.xml") return true;
      if (n === "build.gradle" || n === "build.gradle.kts") {
        if (/com\.android\b|["']android(?:-library)?["']/.test((d.readText(join(dir, n)) ?? "").slice(0, 262144))) return true;
      }
    }
    if (depth >= 6) return false;
    for (const n of names) {
      if (n.startsWith(".") || SKIP.has(n)) continue;
      const p = join(dir, n);
      if (isDir(p) && walk(p, depth + 1)) return true;
    }
    return false;
  };
  return walk(root, 0);
}
