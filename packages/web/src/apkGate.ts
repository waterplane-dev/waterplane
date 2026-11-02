/**
 * Which Android shell (APK) a phone-side feature needs, and whether this
 * phone's has it — ONE function, read by the Downloads sheet's switch note and
 * by What's new (`features/whatsnew`), so the two can never disagree about the
 * same version. Pure: the version comes from `nativeInfo().versionName`.
 */

/** The APK that first holds "keep only the Downloads copy" and the shade taps that land somewhere. */
export const APK_0_1_8 = "0.1.8";

/** `x.y.z` → numbers; a leading `v` and a `-suffix` are ignored. Empty when nothing numeric. */
export function versionParts(v: string): number[] {
  const core = v.trim().replace(/^v/i, "").split(/[-+ ]/)[0] ?? "";
  if (!/^\d+(\.\d+)*$/.test(core)) return [];
  return core.split(".").map((p) => Number(p));
}

/** Negative when a < b, 0 when equal, positive when a > b. An unreadable version sorts lowest. */
export function cmpVersion(a: string, b: string): number {
  const x = versionParts(a), y = versionParts(b);
  if (!x.length || !y.length) return (x.length ? 1 : 0) - (y.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Does this shell hold what `needsApk` names? No requirement ⇒ true; an empty/unreadable version ⇒ false (an old shell said nothing). */
export function apkOk(needsApk: string | undefined, versionName: string): boolean {
  if (!needsApk) return true;
  return versionParts(versionName).length > 0 && cmpVersion(versionName, needsApk) >= 0;
}

/** The refusal, in words: "needs the 0.1.8 APK · yours is 0.1.6". */
export function apkNeedWords(needsApk: string, versionName: string): string {
  return `needs the ${needsApk} APK · yours is ${versionName.trim() || "an older one"}`;
}

/**
 * Where THIS phone gets a newer shell APK, so the gate's sentence names a place that has one:
 * `play` — the Play build updates only from Google Play; `files` — a download of the shell's own
 * package is already on the files tab (a phone driving a desktop that builds the shell); else
 * `release` — the release page, where every non-Play APK is published. Never claims the files tab
 * on the strength of "a build might land there".
 *
 * `files` only for a download whose version passes the SAME gate (`apkOk(needsApk, …)`): a copy of
 * the shell this phone already runs, or an older one, would send the person to a file that cannot
 * lift the gate under a sentence saying it is newer. An unread version is not new enough.
 */
export type ShellApkWhere = "play" | "files" | "release";
/** A finished download as the gate reads it: whose package (`PullRecord.pkg`) and which version (`pkgVersion`). */
export interface ApkOnPhone { pkg?: string; version?: string }
export function shellApkWhere(distribution: string | undefined, self: string | undefined, apks: readonly ApkOnPhone[], needsApk: string): ShellApkWhere {
  if (distribution === "play") return "play";
  if (self && apks.some((a) => a.pkg === self && apkOk(needsApk, a.version ?? ""))) return "files";
  return "release";
}

/** Where the button goes off the phone: Play's page or the release page; null = the files tab. */
export function shellApkUrl(where: ShellApkWhere, self: string, org: string, slug: string): string | null {
  if (where === "files") return null;
  return where === "play" ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(self)}` : `https://github.com/${org}/${slug}/releases/latest`;
}

/** The sentence beside the gate, and the button that leads there. One per place, never a dead button. */
export function shellApkWords(where: ShellApkWhere): { note: string; verb: string; title: string } {
  if (where === "play") return { note: "This app updates from Google Play.", verb: "open Play", title: "this app's page on Google Play" };
  if (where === "files") return { note: "A newer APK is already on the files tab.", verb: "get the APK", title: "the files this phone fetched, where the APK is" };
  return { note: "The newest APK is on the release page.", verb: "open releases", title: "the release page, where every APK is published" };
}
