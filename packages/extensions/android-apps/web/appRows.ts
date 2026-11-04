/**
 * **The apps list's rows and words** — the app-level half of core's `installPolicy.ts`, copied here
 * so the Android apps extension stands on its own (docs/notes/android-apps-architecture.md §3). The
 * per-download row functions live in `@waterplane/shared` (`installrow.ts`) and are re-exported
 * from here so every importer in this folder reads one module. Pure: no React, no storage.
 *
 * One download is not one app: several builds of Tiptoi are ONE row here, and a package on the
 * allow-list with nothing downloaded is a row too — that is the whole reason the Apps screen exists.
 */
import { BRAND } from "@waterplane/shared";
import { stateText, isPlayBuild, isPlaySelf, PLAY_INTRO_TEXT, isApkRow, repeatedVersionText, autoInstallText } from "@waterplane/shared";
import type { InstallCaps, InstallRow, InstallState } from "@waterplane/shared";
import type { InstallSources } from "@waterplane/sdk";

export { NO_INSTALL, isPlayBuild, isPlaySelf, failureText, installVerbText, toggleAllow } from "@waterplane/shared";
export type { InstallCaps, InstallRow, InstallState, InstallSources };

// ── The apps screen ──────────────────────────────────────────────────

/** One downloaded build, as the apps list reads it. */
export interface InstallBuild extends InstallRow {
  id: string;
  /** When this row last changed — how the newest build of a package is picked. */
  updatedAt?: number;
  /** The repo that produced it, where the download knows. */
  repo?: string;
  /** "Later" on the phone's ready-to-install notification: when it comes back. */
  installSnoozedUntil?: number;
  /** When the desktop wrote the file — tells two builds apart from one file fetched twice. */
  mtime?: number;
}

/** A download record, as far as the apps list reads one — structural, so this
 *  pure module needs no import of `pull.ts`. */
export interface BuildSource {
  item: { id: string; name: string; repoName?: string; mtime?: number };
  state: string;
  evicted?: boolean;
  pkg?: string;
  pkgLabel?: string;
  pkgVersion?: string;
  install?: InstallState;
  installError?: string;
  installSnoozedUntil?: number;
  cleanedAt?: number;
  cleanedBytes?: number;
  cleanNote?: string;
  updatedAt?: number;
}

/** Download records → the builds `appRows` reads. One mapping, because the
 *  launcher's "ready" count and the apps screen must count the same rows. */
export function buildsOf(records: readonly BuildSource[]): InstallBuild[] {
  return records.map((r) => ({
    id: r.item.id,
    name: r.item.name,
    state: r.state,
    evicted: r.evicted,
    pkg: r.pkg,
    pkgLabel: r.pkgLabel,
    pkgVersion: r.pkgVersion,
    install: r.install,
    installError: r.installError,
    installSnoozedUntil: r.installSnoozedUntil,
    cleanedAt: r.cleanedAt,
    cleanedBytes: r.cleanedBytes,
    cleanNote: r.cleanNote,
    updatedAt: r.updatedAt,
    repo: r.item.repoName || undefined,
    mtime: r.item.mtime,
  }));
}

/** What the desktop's install log knows about a package — enough to NAME it
 *  after every build of it has been cleared off this phone. */
export interface KnownApp {
  pkg: string;
  label?: string;
  repo?: string;
}

/** One APP, which is not the same thing as one download: several builds of
 *  Tiptoi are one row here, and a package on the list with nothing downloaded
 *  is a row too — that is the whole reason this screen exists. */
export interface AppRow {
  pkg: string;
  label: string;
  /** The repo that builds it. A package name is what the switch is about, but
   *  the repo is what a person recognises — absent only where nothing on this
   *  phone or in the log ever said, never guessed. */
  repo?: string;
  allowed: boolean;
  /** The newest build of it still on this phone, where there is one. */
  buildId?: string;
  version?: string;
  install?: InstallState;
  installError?: string;
  /** When its newest build last changed — the "ready" list is newest first. */
  builtAt?: number;
  /** Its newest build's notification was put off until then. */
  snoozedUntil?: number;
  /** What happens to the NEXT build of it, in words. */
  note: string;
  /** Its newest build declares the same version as an older one — `repeatedVersionText`. */
  repeat?: string;
}

/**
 * Every app this phone has an answer about — the allow-list and the downloaded
 * builds, merged.
 *
 * **Both halves are needed and neither is enough.** A list built only from
 * downloads cannot show an app whose builds have been deleted, which is exactly
 * when somebody wants to turn it off; a list built only from the allow-list
 * cannot offer the app you just downloaded and have not decided about. So the
 * union, allowed ones first (that is the list this screen is about), then by
 * name.
 */
export function appRows(
  builds: readonly InstallBuild[], allow: readonly string[], caps: InstallCaps,
  known: readonly KnownApp[] = [],
): AppRow[] {
  const newest = new Map<string, InstallBuild>();
  // Any build of the package at all, bytes cleared or not: it can no longer be
  // installed, but it still knows the app's NAME and its repo. Without it an
  // allowed app whose builds were swept reads as a bare package name.
  const seenBuild = new Map<string, InstallBuild>();
  for (const b of builds) {
    if (!b.pkg || !isApkRow(b)) continue;
    const any = seenBuild.get(b.pkg);
    if (!any || (b.updatedAt ?? 0) >= (any.updatedAt ?? 0)) seenBuild.set(b.pkg, b);
    if (b.state !== "done" || b.evicted) continue;
    const had = newest.get(b.pkg);
    if (!had || (b.updatedAt ?? 0) >= (had.updatedAt ?? 0)) newest.set(b.pkg, b);
  }
  const out: AppRow[] = [];
  const seen = new Set<string>();
  const push = (pkg: string, build?: InstallBuild) => {
    if (seen.has(pkg)) return;
    seen.add(pkg);
    const allowed = allow.includes(pkg);
    const any = build ?? seenBuild.get(pkg);
    const logged = known.filter((k) => k.pkg === pkg);
    out.push({
      pkg,
      label: any?.pkgLabel || logged.find((k) => k.label)?.label || pkg,
      repo: build?.repo || any?.repo || logged.find((k) => k.repo)?.repo || undefined,
      allowed,
      buildId: build?.id,
      version: build?.pkgVersion || undefined,
      install: build?.install,
      installError: build?.installError || undefined,
      builtAt: build?.updatedAt,
      snoozedUntil: build?.installSnoozedUntil || undefined,
      note: build
        ? autoInstallText(build, caps, allow) ?? ""
        : waitingAppNote(allowed, caps),
      repeat: build ? repeatedVersionText(build, builds) ?? undefined : undefined,
    });
  };
  for (const pkg of allow) push(pkg, newest.get(pkg));
  for (const [pkg, build] of newest) push(pkg, build);
  return out.sort((a, b) => (Number(b.allowed) - Number(a.allowed)) || a.label.localeCompare(b.label));
}

/**
 * **Ready to install**: an app whose newest build is on this phone and has not
 * gone on. The same rows the phone's ready-to-install notification is posted
 * for, so a notification swiped away or put off with Later is still here —
 * newest first. `asked` (the system installer waited and nobody tapped) and
 * `failed` are ready too: both still need exactly one tap. ONE function for
 * the launcher's count and the apps screen's pane, or the two disagree.
 */
export function readyApps(rows: readonly AppRow[]): AppRow[] {
  return rows
    .filter((r) => !!r.buildId && r.install !== "installed" && r.install !== "installing")
    .sort((a, b) => (b.builtAt ?? 0) - (a.builtAt ?? 0));
}

/** "Later" said out loud on the row, while it is still in force. */
export function snoozeText(row: AppRow, now: number, clock: (ms: number) => string): string | null {
  if (!row.snoozedUntil || row.snoozedUntil <= now) return null;
  return `notification put off until ${clock(row.snoozedUntil)}`;
}

/** The note for an app with no build on this phone. It is on the list and
 *  nothing is here to install — that is a promise about the future, so it is
 *  worded as one rather than as a missing file. */
export function waitingAppNote(allowed: boolean, caps: InstallCaps): string {
  if (!allowed) return "no build of it on this phone";
  if (isPlayBuild(caps)) return "no build of it on this phone — and this Google Play build installs nothing by itself";
  if (!caps.canInstall) return "would install itself once this phone allows it";
  return "installs itself when a build arrives";
}

/** The one line at the top of the apps list. Counts what is actually on the
 *  list, against what this phone knows about at all. */
export function appsSummary(rows: readonly AppRow[], caps: InstallCaps): string {
  if (!caps.supported) return `This device cannot install apps — open ${BRAND.displayName}'s own app to do that.`;
  if (!caps.canInstall) return `Allow ${BRAND.displayName} to install apps and a build downloaded here can go straight onto this phone.`;
  const on = rows.filter((r) => r.allowed).length;
  if (!rows.length) return "No app has been downloaded to this phone yet.";
  if (isPlayBuild(caps)) return `${rows.length} app${rows.length === 1 ? "" : "s"} downloaded here. ${PLAY_INTRO_TEXT}`;
  if (!on) return `${rows.length} app${rows.length === 1 ? "" : "s"} downloaded here, none of them installing by itself.`;
  return `${on} of ${rows.length} install${on === 1 ? "s" : ""} itself when a new build arrives.`;
}

/** The same sentence for an APP row, whose label and version are already
 *  resolved. */
export function appStateText(row: AppRow): string | null {
  return stateText(row.install, row.installError, row.label, row.version);
}

/** What the tap on an app row does about a build that is here. Null where
 *  there is nothing to install — the row still says what it says. */
export function appInstallVerb(row: AppRow, caps: InstallCaps): { id: string; label: string } | null {
  if (!caps.supported || !caps.canInstall || caps.plainRoute || !row.buildId) return null;
  if (row.install === "installing") return null;
  if (isPlaySelf(row.pkg, caps)) return null;
  return { id: row.buildId, label: `install ${row.label}${row.version ? ` ${row.version}` : ""} now` };
}

// ── Who may update it quietly ────────────────────────────────────────

/**
 * Can waterplane update this installed app without the dialog?
 *
 * **Update ownership is granted on a package's FIRST install only** — asking
 * for it on an update does nothing. So an app first put on by a file manager,
 * a browser, the Play Store or Android Studio stays that installer's, and every
 * build waterplane installs afterwards asks, auto-install on or not. `ours` where the
 * owner (or, with no owner recorded, the installer) is waterplane; `other` names who
 * it is instead; `unknown` where the phone had nothing to read — not installed,
 * an older shell, an Android without the record. Never a guess.
 */
export function quietVerdict(pkg: string, src: InstallSources | null):
  { verdict: "ours" } | { verdict: "other"; by: string | undefined } | { verdict: "unknown" } {
  const rec = src?.byPkg[pkg];
  if (!src || !rec) return { verdict: "unknown" };
  const who = rec.updateOwner ?? rec.installer;
  if (who === src.self) return { verdict: "ours" };
  return { verdict: "other", by: who };
}

/** An installer's package, as a person would name it. */
export function installerName(pkg: string | undefined): string {
  switch (pkg) {
    case undefined: return "an installer that left no record (usually adb or Android Studio)";
    case "com.android.vending": return "the Play Store";
    case "com.android.shell": return "adb or Android Studio";
    case "com.google.android.packageinstaller":
    case "com.android.packageinstaller": return "the system installer (a file manager or a browser download)";
    default: return pkg;
  }
}

/** The warning on an app row whose updates waterplane does not own. Null otherwise. */
export function quietOwnerText(label: string, v: ReturnType<typeof quietVerdict>): string | null {
  if (v.verdict !== "other") return null;
  return `every update of ${label} will ask: it was first installed by ${installerName(v.by)}, and Android ` +
    `lets only that installer update it quietly. Uninstall it once (that deletes its data) and install the ` +
    `next build from here — one dialog, then quiet.`;
}

// ── Clean-up after an install ────────────────────────────────────────

/**
 * The clean-up switch, in words. `on` null = a shell older than the switch:
 * the sentence says what would bring it, never a dimmed control.
 */
export function cleanupText(on: boolean | null): string {
  if (on === null) {
    return "Deleting a build's APK once it has installed needs a newer app build — the next APK you install brings it.";
  }
  return on
    ? "Once a build installs, its APK is deleted from this phone: the copy inside the app, the copy saved to " +
      "Downloads, and older builds of the same app. Reinstalling means fetching it again."
    : "Installed builds keep their APK on this phone (inside the app, and in Downloads where you saved one) until " +
      "you clear it. Turn this on to delete it once the build is on.";
}

/** The toggle's label. */
export function cleanupLabel(on: boolean): string {
  return `delete APK after install: ${on ? "on" : "off"}`;
}
