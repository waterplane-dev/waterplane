/**
 * The repo half of "a build installs itself on the phone without asking" —
 * one row in the setup checklist, emitted only for a repo that builds an
 * Android app.
 *
 * Quiet installs have two halves. The PHONE half (install access, the app's
 * auto-install switch, and waterplane having done the app's FIRST install — update
 * ownership is granted then and only then) is read on the phone, on the Apps
 * screen (`web/installPolicy.ts`, `QUIET_INSTALL_RULES`). This is the half the
 * desktop can read off the repo: is there a build in the outbox for the phone
 * to download at all, which key signs it, and does it target a recent enough
 * Android. It learned its shape from a real case: an app first installed from
 * a file manager asked on every update however often waterplane asked for silence,
 * and nothing said why.
 *
 * Read-only. Every reading degrades to ABSENT — a `targetSdk` pulled from a
 * variable is "not read", never a number.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { readdir as readdirAsync, readFile as readFileAsync, stat as statAsync } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AppRepoFacts, AutoPullConfig, BuildConfig, ComplianceCheck } from "@waterplane/shared";
import { OUTBOX_SUBDIRS } from "./files.js";
import { BRAND } from "@waterplane/shared";
import { findKey, readLink } from "./signkey.js";

/** Below this targetSdk the row warns. A line chosen here, not the platform's
 *  exact rule (which rises with each Android release): an old target is where
 *  a silent update starts being refused. */
export const APK_TARGET_SDK_LINE = 33;

const SKIP = new Set(["node_modules", "build", "dist", ".git", ".gradle", ".idea"]);

/** Directories visited before the search stops — `buildscan.ts`' cap, for the same reason. */
const MAX_DIRS = 400;

/** Gradle files of Android APP modules, at most four directories deep
 *  (`packages/app/android/app` is four). Runs in the setup checklist, on the loop pumping every
 *  PTY: an entry's kind comes from its listing (a `statSync` per entry was a 9P round trip each on
 *  WSL, minutes in a vcpkg checkout), and the walk stops after `MAX_DIRS` — a module past that is
 *  not found, so the row is absent rather than wrong. */
function appModules(root: string): string[] {
  const out: string[] = [];
  let dirs = 0;
  const walk = (dir: string, depth: number) => {
    if (dirs++ >= MAX_DIRS) return;
    let ents: Dirent[];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const n = e.name;
      if (n === "build.gradle" || n === "build.gradle.kts") {
        const p = join(dir, n);
        const text = readOrEmpty(p);
        if (/com\.android\.application|applicationId/.test(text)) out.push(p);
        continue;
      }
      if (depth >= 4 || n.startsWith(".") || SKIP.has(n)) continue;
      const p = join(dir, n);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = statSync(p).isDirectory(); } catch { /* dangling */ } }
      if (isDir) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** `appModules` without holding the event loop — the same walk and cap, every call awaited. For
 *  the unattended setup sweep (`compliance.ts`' `inspectRepoAsync`). */
export async function appModulesAsync(root: string): Promise<string[]> {
  const out: string[] = [];
  let dirs = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (dirs++ >= MAX_DIRS) return;
    let ents: Dirent[];
    try { ents = await readdirAsync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const n = e.name;
      if (n === "build.gradle" || n === "build.gradle.kts") {
        const p = join(dir, n);
        let text = "";
        try { text = await readFileAsync(p, "utf8"); } catch { /* unreadable: not a module */ }
        if (/com\.android\.application|applicationId/.test(text)) out.push(p);
        continue;
      }
      if (depth >= 4 || n.startsWith(".") || SKIP.has(n)) continue;
      const p = join(dir, n);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = (await statAsync(p)).isDirectory(); } catch { /* dangling */ } }
      if (isDir) await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

function readOrEmpty(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

/** What one app module's gradle file says, each field absent where it is not
 *  a literal. */
export function readGradle(text: string): { pkg?: string; targetSdk?: number; repoKey: boolean } {
  const pkg = /applicationId\s*=?\s*["']([\w.]+)["']/.exec(text)?.[1];
  const sdk = /targetSdk(?:Version)?\s*=?\s*(\d+)\b/.exec(text)?.[1];
  return {
    pkg,
    targetSdk: sdk ? Number(sdk) : undefined,
    repoKey: /signingConfig\s*=?\s*signingConfigs/.test(text),
  };
}

/** APKs in the repo's outbox dirs (and one level under them), newest first. */
function outboxApks(root: string): { rel: string; mtime: number; size: number }[] {
  const out: { rel: string; mtime: number; size: number }[] = [];
  const scan = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 1) scan(p, depth + 1); continue; }
      if (n.toLowerCase().endsWith(".apk")) out.push({ rel: relative(root, p), mtime: st.mtimeMs, size: st.size });
    }
  };
  for (const sub of OUTBOX_SUBDIRS) {
    const d = join(root, sub);
    if (existsSync(d)) scan(d, 0);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The row, or null for a repo that builds no Android app. */
export function apkInstallCheck(worktree: string, modules?: string[]): ComplianceCheck | null {
  // `modules`: already found by `appModulesAsync` (the sweep), else walked here.
  const mods = modules ?? appModules(worktree);
  if (!mods.length) return null;
  const g = readGradle(readOrEmpty(mods[0]));
  const apks = outboxApks(worktree);
  const name = g.pkg ?? relative(worktree, mods[0]);
  const problems: string[] = [];
  const facts: string[] = [];

  if (apks.length) {
    facts.push(`${apks.length} APK${apks.length === 1 ? "" : "s"} in the outbox, newest ${apks[0].rel}.`);
  } else {
    problems.push(`No APK in ${OUTBOX_SUBDIRS[0]}/ — a build left in the module's build/ directory never ` +
      `reaches the phone. Have the build copy its APK into ${OUTBOX_SUBDIRS[0]}/ (a dated name keeps them apart).`);
  }
  if (g.targetSdk === undefined) {
    facts.push("targetSdk is not a literal in the gradle file, so it was not checked.");
  } else if (g.targetSdk < APK_TARGET_SDK_LINE) {
    problems.push(`targetSdk ${g.targetSdk} is below ${APK_TARGET_SDK_LINE}: newer Androids refuse a quiet ` +
      `update to an app targeting an old version and ask every time.`);
  } else {
    facts.push(`targetSdk ${g.targetSdk}.`);
  }
  // A module that reads keystore.properties (the templates do) but has no pointer yet: the
  // `signing-key` fix creates-or-links the desktop key (`signkey.ts`, a confirm-gated fix).
  const gradleText = readOrEmpty(mods[0]);
  const wantsLink = /keystore\.properties/.test(gradleText);
  const linked = wantsLink ? readLink(worktree) : null;
  let fix: string | null = null;
  if (wantsLink && !linked) {
    fix = "signing-key";
    problems.push(findKey().desktop.broken
      ? "keystore.properties is missing and this desktop's signing key has lost its properties file."
      : "No keystore.properties — the build has no signing key to use. The fix creates this desktop's key (once) and links it.");
  }
  if (!(wantsLink && !linked)) facts.push(linked
    ? `Signed with ${linked === "desktop" ? "this desktop's signing key (kept outside the repo)" : linked === "debug" ? "this desktop's debug key" : "the key named in keystore.properties"} — ` +
      "a build signed with another key cannot update the app the phone has."
    : g.repoKey && !wantsLink
    ? "Signed with the repo's own signing config — keep that key; a build signed differently cannot update the " +
      "app, and that includes a debug build over a release one (the debug build uses the desktop's debug key)."
    : "Signed with this desktop's debug key (~/.android/debug.keystore) — a build from another machine cannot " +
      "update the app the phone has.");

  const phone = `On the phone: the FIRST install of the app must come from ${BRAND.name} (Apps screen; one dialog), and its ` +
    "auto-install on — an app first installed from a file manager, a browser or Android Studio asks on every " +
    `update until it is uninstalled once and installed from ${BRAND.name}.`;

  return {
    id: "apk-install",
    label: "APK builds install quietly on the phone",
    status: problems.length ? "warn" : "pass",
    detail: `${name}: ${[...problems, ...facts].join(" ")} ${phone}`,
    fix,
  };
}

/** Which key signs a module's builds — `AppRepoFacts.key`, the same reading the row above words. */
export function keyKind(worktree: string, gradleText: string): AppRepoFacts["key"] {
  if (/keystore\.properties/.test(gradleText)) return readLink(worktree) ?? "missing";
  return readGradle(gradleText).repoKey ? "repo" : "debug-default";
}

/** A build command that reads like one producing an APK. A LABEL on the phone's checklist,
 *  never a filter: a script called `phone-build.sh` may well make one. */
export function looksLikeApkBuild(b: Pick<BuildConfig, "name" | "cmd">): boolean {
  return /\bapk\b/i.test(b.name) || /\bassemble\w*|\bbundle(Debug|Release)\b|build\s+apk|\.apk\b|\bapk\b/i.test(b.cmd);
}

/**
 * The structured half of `apkInstallCheck`, one per app module, for the phone's Apps screen
 * (`GET /api/apps/readiness`). Facts only — the phone words them beside its own half. The
 * build list and the auto-download rule are passed in: they belong to their managers.
 */
export async function apkRepoFacts(
  repo: { id: string; repoName: string; worktreePath: string },
  builds: BuildConfig[],
  pull: AutoPullConfig,
  matches: (cfg: AutoPullConfig, f: { name: string; relPath: string; size: number }) => boolean,
): Promise<AppRepoFacts[]> {
  const root = repo.worktreePath;
  const mods = await appModulesAsync(root);
  if (!mods.length) return [];
  const apks = outboxApks(root);
  const newest = apks[0];
  const buildRows = builds.map((b) => ({ id: b.id, name: b.name, apk: looksLikeApkBuild(b) }));
  const read = mods.map((m) => ({ m, text: readOrEmpty(m) })).map((r) => ({ ...r, g: readGradle(r.text) }));
  // A module with no package BESIDE one with a package is the root build file's
  // `apply false` plugin line or a template, not a second app: dropped. Alone it stays —
  // a package behind a variable is still an app, just one the phone cannot join.
  const named = read.filter((r) => r.g.pkg);
  return (named.length ? named : read).map(({ m, text, g }) => {
    const suffixes = [...text.matchAll(/applicationIdSuffix\s*=?\s*["']([\w.]+)["']/g)].map((x) => x[1]);
    return {
      repoId: repo.id,
      repoName: repo.repoName,
      repoDir: root,
      pkg: g.pkg,
      ...(g.pkg && suffixes.length ? { variants: [...new Set(suffixes.map((x) => g.pkg + (x.startsWith(".") ? x : "." + x)))] } : {}),
      module: relative(root, m),
      targetSdk: g.targetSdk,
      key: keyKind(root, text),
      apks: apks.length,
      newestApk: newest,
      builds: buildRows,
      autoPull: {
        enabled: pull.enabled,
        builds: pull.builds,
        maxBytes: pull.maxBytes,
        newestMatches: newest
          ? matches(pull, { name: newest.rel.split("/").pop() ?? newest.rel, relPath: newest.rel, size: newest.size })
          : undefined,
      },
    };
  });
}
