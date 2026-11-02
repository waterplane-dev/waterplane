/**
 * **The desktop's half of "will the next build of this app install itself"**,
 * one per Android app module across every repo — core's `api.repoApps()`
 * (`host/appready.ts`), which the android-apps extension's `readiness` answers from.
 *
 * The install log's own DTOs live in that extension (`packages/extensions/android-apps/shared/wire.mts`);
 * only these facts stay in core, because the host reads them off the repos.
 *
 * The repo half used to exist only as one PROSE row in each repo's setup
 * checklist (`host/apkcheck.ts`), so the question *which of my apps are fully
 * set up* meant opening every repo's setup sheet and reading a paragraph. The
 * phone joins these facts with its own half (install access, the app's switch,
 * who owns its updates, the last attempts on this phone) on the Apps screen.
 *
 * Facts, never a verdict: the phone words the checks, and every field degrades
 * to ABSENT — a `targetSdk` behind a variable is not read, never a number.
 */
export interface AppRepoFacts {
  repoId: string;
  repoName: string;
  repoDir: string;
  /** `applicationId`, where the gradle file holds it as a literal. */
  pkg?: string;
  /** `pkg` plus each literal `applicationIdSuffix` — the package a flavor or
   *  build type actually installs as (`dev.waterplane.app.dev`). */
  variants?: string[];
  /** The app module's gradle file, worktree-relative. */
  module: string;
  targetSdk?: number;
  /**
   * Which key signs its builds. `desktop` / `debug` / `other`: named in
   * `keystore.properties` (this desktop's sideload key, this desktop's debug
   * key, anything else). `repo`: the module's own `signingConfig`.
   * `debug-default`: nothing configured, so the debug key of whichever machine
   * builds it. `missing`: the module reads `keystore.properties` and there is
   * none — the build has no key.
   */
  key: "desktop" | "debug" | "other" | "repo" | "debug-default" | "missing";
  /** APKs in the repo's outbox dirs. */
  apks: number;
  newestApk?: { rel: string; mtime: number; size: number };
  /** The repo's configured build commands; `apk` where the command reads like
   *  one that makes an APK (gradle `assemble…`, `flutter build apk`, a name
   *  saying APK). A heuristic label, never a filter. */
  builds: { id: string; name: string; apk: boolean }[];
  /** The repo's auto-download rule. `newestMatches`: would the rule queue the
   *  newest outbox APK (pattern and size cap) — absent with no APK. */
  autoPull: { enabled: boolean; builds: boolean; maxBytes: number; newestMatches?: boolean };
}

export interface AppReadinessReport {
  /** When the desktop read it. */
  at: number;
  apps: AppRepoFacts[];
}
