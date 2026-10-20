/**
 * The extension's data layer — everything it reads off Claude Code's own logs
 * on this machine, and the one entry `extension.ts` (WP2) imports. Also the
 * entry of the test bundle (`dist/data.mjs`).
 *
 * The API, as WP2 calls it:
 *
 *   claudeConfigDir(override?: string): string
 *   projectDirFor(configDir: string, folderFsPath: string): Promise<{ dir: string | null; why?: string }>
 *   listSessions(projectDir: string): Promise<SessionRow[]>               // newest first
 *   newestSession(projectDir: string): Promise<SessionRow | null>
 *   readSession(path: string, prevCursor: SessionCursor | null, folder: string)
 *     : Promise<{ cursor: SessionCursor | null; doc: SessionDoc | null; why?: string }>
 *   turnCosts(path: string): Promise<TurnCost[]>                          // also on SessionDoc.turnCosts
 *   class TokenStore {
 *     constructor(cacheFile: string)
 *     load(): Promise<void>
 *     refresh(configDir: string, onProgress?: (done: number, total: number) => void): Promise<ScanStats>
 *     save(): Promise<void>
 *     readonly files: Files
 *     stats: ScanStats                                                    // { scannedAt, logs, reread }
 *   }
 *   foldCorpus(files: Files, now: number, scan?: ScanStats): CorpusDoc   // pass store.stats as `scan`
 *   weighFolder(folderFsPath: string): Promise<WeightDoc>
 *
 * Typical use: `const {dir, why} = await projectDirFor(claudeConfigDir(), folder)`;
 * no dir ⇒ post `{t:"session", doc:null, why}`. Else `newestSession(dir)` →
 * `readSession(row.path, cursorFor(row.path) ?? null, folder)` on every watcher
 * event, keeping the returned cursor per path. The corpus: `store.load()` once,
 * `store.refresh(configDir, progress)` → `foldCorpus(store.files, Date.now(), store.stats)`
 * → `store.save()`.
 */
export { claudeConfigDir, projectDirFor, listSessions, newestSession } from "./logs.js";
export { readSession } from "./session.js";
export type { SessionCursor } from "./session.js";
export { turnCosts, advanceTurns, projectTurns } from "./turns.js";
export type { TurnCursor } from "./turns.js";
export { TokenStore } from "./store.js";
export type { Files, ScanStats } from "./store.js";
export { foldCorpus } from "./corpus.js";
export { weighFolder } from "./weight.js";
export { claudeImports, classifyInstructions, classifyRule, fmGlobs, instructionTotals as totalsFor, sharedChars } from "@waterplane/shared";
export { inventory } from "./instructions.js";

// ── The host primitives these are built on, re-exported for the tests ONLY:
// `test/*.test.mjs` pins the extension's figures equal to the host's own
// readers over the same fixture. The extension itself never calls these.
export { summarizeLog } from "../../../host/src/tokenscan.js";
export { updateContextLog } from "../../../host/src/ctxlog/ctxupdate.js";
export { foldCostWindow } from "../../../host/src/costwindow.js";
export { claudeProjectDir } from "../../../host/src/claudeconfig.js";

// ── Pure pieces the extension and the webview share, exported for the tests.
export { PROMPTS, render, scrub } from "./promptText.js";
export { sessionTotal } from "./sessiontotal.js";
export { isLive, isRunning, fmtAge, fmtElapsed, runningTurn, runningWords, LIVE_MS, RUNNING_FRESH_MS } from "./running.js";
export { MAX_ROWS, WINDOW_MS, SessionLedger, recentRows, summarize, isAutomated, peekEntrypoint } from "./sessionlist.js";

// ── Repo health: the pure fold, the PATH check, the storage slug, the prompt builders, and the
// worker lifecycle (`HealthRun` is vscode-free; extension.ts imports it from here).
export { foldHealth, gitOnPath, isShallow, headAndBehind, outcomeOf, NO_GIT_WHY, NOT_READ_WHY } from "../health/healthdoc.js";
export type { HealthFoldInput, HealthStepResult, HealthUpdateResult } from "../health/healthdoc.js";
export { healthSlug } from "../health/healthslug.js";
export { healthIndexOf, healthIndexOfFile, parseHealthRows } from "../health/healthindexdoc.js";
export { splitLongest, explainRising, risingSeries, definitionOf } from "../health/healthprompts.js";
export { DEFAULT_HEALTH_SECONDS, HealthRun, workerEnv } from "../health/healthrun.js";
export { mendSeriesTail, TORN_TAIL_NOTE } from "../health/seriestail.js";
export type { HealthRunDeps, HealthStep } from "../health/healthrun.js";
export { chooseSource, lastRowTs, readScopes, repoSeriesDir, seriesName } from "../health/healthsource.js";
export type { HealthSource } from "../health/healthsource.js";
export { measureWords, notRunHere, notRunWords, ownAddNoteWords, ownMixedWords, repoMixedWords, sourceWords } from "../health/sourcewords.js";
export { NO_RUN } from "../shims/healthnorun.js";
