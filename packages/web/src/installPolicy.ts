/**
 * **Whether a downloaded APK may install itself, and what the row says about
 * it** — the pure half, so every sentence on this subject is decided in one
 * file and pinned by a test.
 *
 * The transport already ends with a fresh build sitting on the phone minutes
 * after the desktop finished writing it. What was left was a person finding the
 * file and tapping through a file manager, on every build, for every app. The
 * allow-list is the answer: a package on it installs itself at the end of the
 * download, with nobody watching.
 *
 * **Three refusals that are the platform's and not this app's**, all of them
 * worded rather than drawn as a dead button (`Unavailable.tsx`):
 *
 *  - **A browser cannot install anything.** No sentence either — a phone
 *    reading the app over the tunnel is not being told about a capability the
 *    APK has.
 *  - **"Install unknown apps" is a special access** only the person can grant.
 *    It is offered with the Settings screen beside it, never demanded.
 *  - **The FIRST install of a package always shows the system dialog.** No flag
 *    removes it, so the row says so in advance rather than promising silence it
 *    cannot deliver. Every build after that is quiet — that is the whole shape
 *    of the feature: one dialog per app, ever.
 *
 * **The list is packages, never file names.** Three repos on this desktop all
 * build `app-debug.apk`; the package name is read out of the archive itself
 * (`Installs.read`), and a row that could not be read offers the tap and
 * promises nothing.
 */
import { BRAND } from "@waterplane/shared";

/** What the phone will allow, as `ShellInstall.status()` answers it. */
export interface InstallCaps {
  /** The APK has the install plugin. False in a browser, and in a shell older
   *  than this feature — the UI updates over the air while the binary does not,
   *  so that is a real, ordinary state. */
  supported: boolean;
  /** "Install unknown apps" is granted for this app. */
  canInstall: boolean;
  /** This Android can skip the dialog for an UPDATE (API 31+). */
  silent: boolean;
  /** Which distribution the shell is: `dev` (the owner's sideloaded build, every
   *  feature) or `play` (from Google Play — never installs itself, never
   *  installs quietly). ABSENT on a shell older than the field, and absent
   *  means INHERIT: today's full behaviour, exactly as `dev`. */
  distribution?: "dev" | "play";
  /** The shell's own package, where it said. */
  self?: string;
}

export const NO_INSTALL: InstallCaps = { supported: false, canInstall: false, silent: false };

// ── The Google Play build ────────────────────────────────────────────

/** The distribution half of `ShellInstall.status()`'s answer. Anything but the
 *  two known words is ABSENT — an older shell, or a value this bundle has never
 *  heard of, inherits the full behaviour rather than being guessed into one. */
export function shellDistribution(r: unknown): Pick<InstallCaps, "distribution" | "self"> {
  if (!r || typeof r !== "object") return {};
  const o = r as Record<string, unknown>;
  const out: Pick<InstallCaps, "distribution" | "self"> = {};
  if (o.distribution === "dev" || o.distribution === "play") out.distribution = o.distribution;
  if (typeof o.self === "string" && o.self) out.self = o.self;
  return out;
}

/** Is this the Google Play build? Only a shell that SAYS so — absent is the
 *  full-feature behaviour every shell before the split had. */
export function isPlayBuild(caps: InstallCaps): boolean {
  return caps.distribution === "play";
}

/** Is this package the shell itself, in the Play build — the one install that
 *  build refuses outright (`Installs.refusal` on the native side). */
export function isPlaySelf(pkg: string | undefined, caps: InstallCaps): boolean {
  return isPlayBuild(caps) && !!pkg && !!caps.self && pkg === caps.self;
}

/** Why the Play build will not install a build of itself. Worded as the native
 *  refusal is (`Installs.SELF_UPDATE_REFUSED`), so the row and a failed tap read
 *  the same. */
export const PLAY_SELF_TEXT = "this build updates through Google Play — install the new version from the Play Store";

/** Why the Play build will not install an archive it could not read
 *  (`Installs.UNREADABLE_REFUSED`). */
export const PLAY_UNREAD_TEXT =
  "could not read which app this file is, and this build installs only an app it can name";

/** Why auto-install is not offered in the Play build — said where the switch
 *  would be, never as a dimmed switch (`Unavailable.tsx`). */
export function playAutoText(name: string): string {
  return `new builds of ${name} wait for a tap: this ${BRAND.displayName} comes from Google Play, ` +
    "which does not let it install apps by themselves — every install asks";
}

/** The Play build's whole install story, in one sentence. */
export const PLAY_INTRO_TEXT =
  `A build downloaded here installs with the phone's own confirm dialog, one tap each. This ${BRAND.displayName} ` +
  "comes from Google Play, which does not let it install apps by themselves, and it updates itself only through Play.";

export type InstallState = "" | "queued" | "installing" | "asked" | "installed" | "failed";

/** The slice of a download row this module reads. */
export interface InstallRow {
  name: string;
  mime?: string;
  state: string;
  evicted?: boolean;
  /** What the APK says it is. Absent = unread or unreadable, never a guess. */
  pkg?: string;
  pkgLabel?: string;
  pkgVersion?: string;
  install?: InstallState;
  installError?: string;
}

/** Is this row an app at all? Name or declared type — the host's mime table and
 *  a phone's own guess have disagreed, and either saying so is enough. */
export function isApkRow(row: { name?: string; mime?: string }): boolean {
  const n = (row.name ?? "").toLowerCase();
  const m = (row.mime ?? "").toLowerCase();
  return n.endsWith(".apk") || m === "application/vnd.android.package-archive";
}

/** What to call the app on screen: its own label, then its package, then the
 *  file name — which is the one that says nothing, so it is last. */
export function appLabel(row: InstallRow): string {
  return row.pkgLabel || row.pkg || row.name;
}

/** Is this package one the person said may install itself? */
export function isAllowed(row: InstallRow, allow: readonly string[]): boolean {
  return !!row.pkg && allow.includes(row.pkg);
}

/** Add or remove a package, keeping the order stable so the sheet does not
 *  reshuffle under a tap. */
export function toggleAllow(allow: readonly string[], pkg: string): string[] {
  if (!pkg) return [...allow];
  return allow.includes(pkg) ? allow.filter((p) => p !== pkg) : [...allow, pkg];
}

/**
 * May this row be tapped to install — and if not, why not, in words.
 *
 * `verb` null with a `reason` is the `Unavailable.tsx` shape: the control is not
 * drawn at all and the row carries the sentence. `verb` null with no reason is
 * a row this subject has nothing to say about (not an app, not downloaded yet,
 * a browser).
 */
export function installOffer(row: InstallRow, caps: InstallCaps): {
  verb: "install" | null;
  reason: string | null;
  /** The Settings screen would fix it — the row draws that button. */
  settings?: boolean;
} {
  if (!caps.supported) return { verb: null, reason: null };
  if (!isApkRow(row)) return { verb: null, reason: null };
  if (row.state !== "done") return { verb: null, reason: null };
  if (isPlaySelf(row.pkg, caps)) return { verb: null, reason: PLAY_SELF_TEXT };
  if (isPlayBuild(caps) && !row.pkg) return { verb: null, reason: PLAY_UNREAD_TEXT };
  if (row.evicted) {
    return { verb: null, reason: "the bytes were cleared to save space — fetch it again to install it" };
  }
  if (!caps.canInstall) {
    return {
      verb: null,
      reason: `this phone has not allowed ${BRAND.displayName} to install apps`,
      settings: true,
    };
  }
  if (row.install === "installing") return { verb: null, reason: null };
  return { verb: "install", reason: null };
}

/** The install sentence, from the four facts that decide it. One implementation,
 *  because a download row and an app row must not word the same outcome two
 *  ways — `asked` is the system installer waiting for a tap and is never a
 *  failure, which is the distinction worth having in one place. */
function stateText(install: InstallState | undefined, error: string | undefined,
                   label: string, version: string | undefined): string | null {
  switch (install) {
    case "installing": return "installing…";
    case "asked": return "waiting for you to confirm it on this phone";
    case "installed": return `installed${version ? ` · ${label} ${version}` : ""}`;
    case "failed": return `could not install: ${failureText(error)}`;
    default: return null;
  }
}

/** PackageInstaller's out-of-space refusal reads "Failed to allocate N because
 *  only M allocatable" — true, but in bytes and without the one fact that
 *  matters: freeing space and retrying fixes it. Anything else keeps the
 *  phone's own words.
 *
 *  M is NOT the free space Settings shows: "allocatable" is what is left after
 *  Android's low-storage reserve (5% of the disk, capped at 500 MB by default).
 *  Saying "has 0 MB free" sent a person who had freed space to free a little
 *  more, retry, and read the same 0 again — so the sentence names the reserve
 *  and the figure Settings has to reach. */
function failureText(error: string | undefined): string {
  if (!error) return "the phone did not say why";
  const m = /allocate (\d+) because only (\d+) allocatable/i.exec(error);
  if (!m) return error;
  const mb = (n: number) => `${Math.ceil(n / 1e6)} MB`;
  const need = Number(m[1]);
  const usable = Number(m[2]);
  const have = usable > 0 ? `only ${mb(usable)} of it is usable` : "none of it is usable yet";
  return `this phone is out of space — it needs ${mb(need)} beyond the room Android keeps in reserve (up to 500 MB), and ${have}. `
    + `Free space until Settings shows about ${mb(need + 500e6 - usable)} free, then retry`;
}

/** The word on the install button. After a failure it is a RETRY — the same
 *  tap, but "install" beside "could not install" read as the thing that had
 *  just not worked rather than the way to try again. */
export function installVerbText(install: InstallState | undefined): string {
  if (install === "failed") return "retry install";
  if (install === "installed") return "install again";
  return "install";
}

/** The install sentence for a DOWNLOAD row, or null where there is nothing to
 *  say. */
export function installStatusText(row: InstallRow): string | null {
  return stateText(row.install, row.installError, appLabel(row), row.pkgVersion);
}

/**
 * What happens to the NEXT build of this app, as a promise the row can keep.
 *
 * Null where nothing has been decided — an unread package, a row that is not an
 * app, a browser. The allowed-but-first-time sentence is the important one: it
 * is the difference between "this will be quiet" and "this will be quiet from
 * the build after next".
 */
export function autoInstallText(row: InstallRow, caps: InstallCaps, allow: readonly string[]): string | null {
  if (!caps.supported || !isApkRow(row) || !row.pkg) return null;
  const name = appLabel(row);
  if (isPlaySelf(row.pkg, caps)) return PLAY_SELF_TEXT;
  if (isPlayBuild(caps)) return playAutoText(name);
  if (!isAllowed(row, allow)) return `new builds of ${name} wait for a tap`;
  if (!caps.canInstall) return `${name} would install itself once this phone allows it`;
  if (!caps.silent) return `new builds of ${name} install by themselves, and this Android asks every time`;
  if (row.install === "installed") return `new builds of ${name} install by themselves`;
  return `new builds of ${name} install by themselves — the first one asks once`;
}

/** The label on the per-app switch. Not drawn at all where the package could
 *  not be read: a promise about "this app" needs to know which app. Not drawn
 *  in the Play build either — `autoInstallText` says why in its place. */
export function allowToggle(row: InstallRow, caps: InstallCaps, allow: readonly string[]): {
  pkg: string;
  on: boolean;
  label: string;
} | null {
  if (!caps.supported || !isApkRow(row) || !row.pkg) return null;
  if (isPlayBuild(caps)) return null;
  const on = isAllowed(row, allow);
  return {
    pkg: row.pkg,
    on,
    label: on ? `stop installing ${appLabel(row)} by itself` : `always install ${appLabel(row)}`,
  };
}

/** What the sheet says about the whole feature, once, above the rows. Null in a
 *  browser — there is nothing here to explain. */
export function installIntroText(caps: InstallCaps, allow: readonly string[]): string | null {
  if (!caps.supported) return null;
  if (!caps.canInstall) {
    return `Allow ${BRAND.displayName} to install apps and a build downloaded here can go straight onto this phone.`;
  }
  if (isPlayBuild(caps)) return PLAY_INTRO_TEXT;
  if (!allow.length) return "No app installs itself yet — turn it on per app under apps.";
  const n = allow.length;
  return n === 1
    ? "1 app installs itself when a new build arrives."
    : `${n} apps install themselves when a new build arrives.`;
}

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
}

/** A download record, as far as the apps list reads one — structural, so this
 *  pure module needs no import of `pull.ts`. */
export interface BuildSource {
  item: { id: string; name: string; repoName?: string };
  state: string;
  evicted?: boolean;
  pkg?: string;
  pkgLabel?: string;
  pkgVersion?: string;
  install?: InstallState;
  installError?: string;
  installSnoozedUntil?: number;
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
    updatedAt: r.updatedAt,
    repo: r.item.repoName || undefined,
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
  if (!caps.supported || !caps.canInstall || !row.buildId) return null;
  if (row.install === "installing") return null;
  if (isPlaySelf(row.pkg, caps)) return null;
  return { id: row.buildId, label: `install ${row.label}${row.version ? ` ${row.version}` : ""} now` };
}

// ── Who may update it quietly ────────────────────────────────────────

/** What the phone records about who installed each package (`Installs.source`
 *  on the shell). `byPkg` leaves out a package it could not read. */
export interface InstallSources {
  /** waterplane's own package — the name an owner is compared against. */
  self: string;
  sdk?: number;
  byPkg: Record<string, { installer?: string; updateOwner?: string }>;
}

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

/**
 * **When a build installs itself without asking** — the whole list, said once
 * on the Apps screen so nobody learns it from a dialog that will not go away.
 * The repo half (same signing key, a recent targetSdk, a build in the outbox)
 * is also a row in that repo's setup checklist (`host/apkcheck.ts`).
 */
export const QUIET_INSTALL_RULES: readonly string[] = [
  `This phone lets ${BRAND.displayName} install apps (Settings → install unknown apps).`,
  "The app's auto-install is on here.",
  `Its FIRST install came from ${BRAND.displayName}. That one always asks, once; after it Android lets ${BRAND.displayName} update the app ` +
    "quietly. An app first installed from a file manager, a browser, the Play Store or Android Studio stays " +
    "that installer's and every update asks — uninstall it once and install from here.",
  "Every build is signed with the same key. A build signed differently cannot update the installed app at all.",
  "The app targets a recent Android version, and the phone runs Android 12 or newer.",
];
