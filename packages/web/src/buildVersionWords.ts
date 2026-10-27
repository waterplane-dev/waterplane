/**
 * Which build a build entry last produced, as its row says it. Pure, so
 * `buildVersionWords.test.mjs` pins it without a DOM. The identifier is the one
 * the artifact itself shows (`@waterplane/shared` buildstamp.ts), so a person can
 * hold the row beside the app and compare by eye.
 */
import { buildStampText, cleanBuildStamp, type BuildConfig, type BuildRecord, type BuildStamp } from "@waterplane/shared";

/** The builds an entry's artifact has had, newest first (`build.list`'s `versions`).
 *  The entry names its artifact, else the records are keyed by the entry's own id. */
export function entryVersions(b: Pick<BuildConfig, "id" | "artifact">, versions: Record<string, BuildRecord[]> | undefined): BuildRecord[] {
  return versions?.[b.artifact ?? b.id] ?? [];
}

/** One build as a line: the identifier, then where it went. */
export function buildRecordWords(r: BuildRecord): string {
  return `${buildStampText(r)}${r.channel ? ` → ${r.channel}` : ""}`;
}

/** The row's line for the newest build. */
export function lastBuildWords(r: BuildRecord): string {
  return `last build: ${buildRecordWords(r)}`;
}

/** The toggle under it; null when there is no earlier build to show. */
export function earlierBuildsLabel(n: number, open: boolean): string | null {
  if (n <= 0) return null;
  return open ? "hide earlier builds" : `${n} earlier build${n === 1 ? "" : "s"}`;
}

/** The shell's stamp out of `ShellUpdate.info()`: versionName (versionCode) plus the commit and
 *  build time `build.gradle` bakes in. Null from an APK that predates `builtAt` — the screen then
 *  falls back to the bare version it always showed. */
export function shellStampOf(r: Record<string, unknown> | null | undefined): BuildStamp | null {
  if (!r) return null;
  const name = typeof r.versionName === "string" ? r.versionName : "";
  const code = typeof r.versionCode === "number" && r.versionCode > 0 ? r.versionCode : 0;
  return cleanBuildStamp({
    version: name ? `${name}${code ? ` (${code})` : ""}` : undefined,
    sha: r.gitSha,
    dirty: r.gitDirty,
    at: r.builtAt,
  });
}

