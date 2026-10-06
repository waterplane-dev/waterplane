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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ComplianceCheck } from "@waterplane/shared";
import { OUTBOX_SUBDIRS } from "./files.js";
import { BRAND } from "@waterplane/shared";
import { findKey, readLink } from "./signkey.js";

/** Below this targetSdk the row warns. A line chosen here, not the platform's
 *  exact rule (which rises with each Android release): an old target is where
 *  a silent update starts being refused. */
export const APK_TARGET_SDK_LINE = 33;

const SKIP = new Set(["node_modules", "build", "dist", ".git", ".gradle", ".idea"]);

/** Gradle files of Android APP modules, at most four directories deep
 *  (`packages/app/android/app` is four). */
function appModules(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n === "build.gradle" || n === "build.gradle.kts") {
        const p = join(dir, n);
        const text = readOrEmpty(p);
        if (/com\.android\.application|applicationId/.test(text)) out.push(p);
        continue;
      }
      if (depth >= 4 || n.startsWith(".") || SKIP.has(n)) continue;
      const p = join(dir, n);
      try { if (statSync(p).isDirectory()) walk(p, depth + 1); } catch { /* vanished */ }
    }
  };
  walk(root, 0);
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
function outboxApks(root: string): { rel: string; mtime: number }[] {
  const out: { rel: string; mtime: number }[] = [];
  const scan = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 1) scan(p, depth + 1); continue; }
      if (n.toLowerCase().endsWith(".apk")) out.push({ rel: relative(root, p), mtime: st.mtimeMs });
    }
  };
  for (const sub of OUTBOX_SUBDIRS) {
    const d = join(root, sub);
    if (existsSync(d)) scan(d, 0);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The row, or null for a repo that builds no Android app. */
export function apkInstallCheck(worktree: string): ComplianceCheck | null {
  const mods = appModules(worktree);
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
  const wantsLink = /keystore\.properties/.test(readOrEmpty(mods[0]));
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
