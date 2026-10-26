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
