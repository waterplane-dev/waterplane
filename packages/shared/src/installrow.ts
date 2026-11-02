/**
 * **The row-level half of "may a downloaded APK install itself"** — what the
 * phone allows (`InstallCaps`), the Play build's refusals, and every sentence
 * about ONE downloaded row. Pure, shared by the Downloads rows (`PullSheet`) and
 * the Android apps surface, so the two never word the same row twice.
 * The app-level half (`InstallBuild`, `appRows`, ...) stays in
 * `web/installPolicy.ts` and imports from here.
 */
import { BRAND } from "./brand.js";

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
  /** When the shell's clean-up deleted this build's APK after an install
   *  (`ShellPullService.cleanAfterInstall`). Absent = never cleaned. */
  cleanedAt?: number;
  /** Bytes that clean-up gave back, app copy and Downloads copy together. */
  cleanedBytes?: number;
  /** Why a Downloads copy stayed, in the shell's words. */
  cleanNote?: string;
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
  if (row.evicted && row.cleanedAt) return { verb: null, reason: cleanedText(row) };
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
export function stateText(install: InstallState | undefined, error: string | undefined,
                   label: string, version: string | undefined): string | null {
  switch (install) {
    case "installing": return "installing…";
    case "asked": return "waiting for you to confirm it on this phone";
    case "installed": return `installed${version ? ` · ${label} ${version}` : ""}`;
    case "failed": return `could not install: ${failureText(error)}`;
    default: return null;
  }
}

/** A failure in words a person can act on. PackageInstaller's out-of-space refusal reads "Failed to allocate N because
 *  only M allocatable" — true, but in bytes and without the one fact that
 *  matters: freeing space and retrying fixes it. Anything else keeps the
 *  phone's own words.
 *
 *  M is NOT the free space Settings shows: "allocatable" is what is left after
 *  Android's low-storage reserve (5% of the disk, capped at 500 MB by default).
 *  Saying "has 0 MB free" sent a person who had freed space to free a little
 *  more, retry, and read the same 0 again — so the sentence names the reserve
 *  and the figure Settings has to reach. */
export function failureText(error: string | undefined): string {
  if (!error) return "the phone did not say why";
  // Play Protect's package verifier said no. The shell already re-asks OUT LOUD after a
  // refused silent attempt (`installLoudAfterRefusal`), so reaching this means that ask
  // was refused or dismissed too — the platform's words name neither Play Protect nor a remedy.
  if (/VERIFICATION_FAILURE/.test(error)) {
    return "Google Play Protect stopped it — it checks every app from outside the Play Store, and refused this build " +
      "with nobody there to answer it. Retry with the phone in hand: if Play Protect asks, install anyway. If it " +
      "refuses without asking, Play Store › Play Protect says why";
  }
  if (/Session was abandoned/i.test(error)) {
    return "the install was dropped before it finished — Android abandons one when the app is closed mid-install or " +
      "the confirm dialog goes unanswered. A retry starts a fresh one";
  }
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

/** A build that DECLARES THE SAME VERSION as an older build of the same app
 *  still on this phone. Android installs it anyway (an equal versionCode is
 *  not a downgrade), so nothing fails — but the installed app, the history and
 *  this row can no longer say which build is on the phone. The cure is in the
 *  repo, not here: its build must raise the version every time, uncommitted
 *  rebuilds included (a commit-count version stays put between commits —
 *  Talking-sandwatch, 2026-11-01). Said on the NEWER build only, and only where
 *  both creation stamps are known and differ: one file fetched twice is not two
 *  builds. Null otherwise — never a guess. */
export function repeatedVersionText(
  row: { name: string; pkg?: string; pkgVersion?: string; mtime?: number },
  all: readonly { name: string; pkg?: string; pkgVersion?: string; mtime?: number }[],
): string | null {
  const at = row.mtime;
  if (!row.pkg || !row.pkgVersion || !at) return null;
  const older = all.some((b) => b.pkg === row.pkg && b.pkgVersion === row.pkgVersion && !!b.mtime && b.mtime < at);
  if (!older) return null;
  return `same version (${row.pkgVersion}) as an older build on this phone — its repo does not raise the version `
    + "on every build, so once installed the two cannot be told apart. Ask the repo's agent to raise it on every build";
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
    label: on ? `stop installing ${appLabel(row)} by itself` : `install ${appLabel(row)} by itself`,
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
  if (!allow.length) return "No app installs by itself yet — you can turn it on for an app, one at a time.";
  const n = allow.length;
  return n === 1
    ? "1 app installs itself when a new build arrives."
    : `${n} apps install themselves when a new build arrives.`;
}

// ── Clean-up after an install ────────────────────────────────────────

function mb(bytes: number): string {
  return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** What a cleaned row says: the APK went because the build installed, how much
 *  came back, and — never swallowed — a Downloads copy that stayed. */
export function cleanedText(row: Pick<InstallRow, "cleanedAt" | "cleanedBytes" | "cleanNote">): string {
  const freed = row.cleanedBytes ? ` (${mb(row.cleanedBytes)} freed)` : "";
  const base = `APK deleted after it installed${freed} — fetch it again to reinstall`;
  return row.cleanNote ? `${base} · ${row.cleanNote}` : base;
}
