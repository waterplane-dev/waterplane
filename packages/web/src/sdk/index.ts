/**
 * The ONE import a feature needs. `local/feature-boundary` refuses `core/` and
 * `App` from inside `features/`, so everything a feature may reach of the core
 * is exported here — and anything not exported here is not part of the
 * contract. Reasoning: docs/notes/web-architecture.md.
 *
 * Only what something outside `sdk/` imports is listed. The pure helpers under
 * it (`mapWithout`, `useRepoMap`, `cachedList`, the run caps and upserts) stay
 * exported from their own modules for `sdk.test.mjs`; add one here the day a
 * feature needs it, not before.
 */
export type {
  Availability, CommandDef, ImageTextReader, ConnInfo, ContributionIcon, CoreApi, DurableOp, FeatureManifest, LauncherItemCount, LauncherItemDef, LedgerSummary, MenuItemDef, SecretFillContext, SecretFillerDef, SecretFillerEntry, LedgerViewDef, LedgerViewParts, LedgerViewProps,
  MessageHandlers, QueueBacklogOpts, RepoActionDef, RepoChipCount, RepoChipDef, ReturnTo, SessionViewDef, SettingsGroupId, SettingsRowsDef, SetupRowDef, SheetDef, SheetId,
  ToolbarItemDef, UploadApi, UploadBuf, UploadProgress,
} from "./types.ts";
export { core } from "../core/api.ts";
export { createStore, keepStores, useStore, type Store } from "./store.ts";
export { mapWith, mapWithout, useCore, useLatest, useQueueEntries } from "./hooks.ts";
export { useBackStep } from "../backStep.ts";
/** This device's preferences (`core/prefs.ts`) — read-only from a feature; the
 *  Settings sheet is their writer. */
export { useConnStatus } from "./connStatus.ts";
export { setPref, usePref, type DevicePrefs, type PrefKey } from "../core/prefs.ts";
export type { CachedListStore, CachedLists } from "./cached.ts";
export { repoRunStore, type RepoRunStore, type RunLike } from "./repoRun.ts";
export { featureSheetId, type FeatureSheetId } from "../routing.ts";
export { pluginClient, type PluginClient } from "./pluginClient.ts";
/** The demo seam: `isDemo()` and a plugin's registered fixture (`registerDemoPlugin`; see `demoPlugin.ts`). */
export { isDemo, registerDemoPlugin, demoPluginPushes, type DemoPlugin } from "./demoPlugin.ts";
export { extStorage, type ExtStorage } from "./extStorage.ts";
/** Is an extension switched on (`useExtensionEnabled`/`isExtensionEnabled`, by its manifest id),
 *  and where its downloaded assets are cached and served (`extAssetCacheName`, `extAssetUrl`). */
export { EXT_CACHE_PREFIX, extAssetCacheName, extAssetUrl, isExtensionEnabled, useExtensionEnabled, watchExtensionEnabled } from "./extensions.ts";
/** An extension's downloaded engine files, kept in IndexedDB for offline use (works in the APK and on plain http). */
export { extAssets, type ExtAssets } from "./extAssets.ts";
export type { PluginCallResult, PluginMethods } from "@waterplane/shared";
export { openStream, type StreamCallbacks, type StreamHandle, type StreamState, type StreamStats, type StreamStopCause } from "./stream.ts";
export type { StreamFrame } from "@waterplane/shared";
export { ledgers, type CachedRead } from "./ledgers.ts";
export { secretFillers } from "./secretFillers.ts";
/** Open a URL outside the app — the one call that works in both a browser tab and the Android shell. */
export { openExternal } from "../openExternal.ts";
/** A full-resolution screenshot of the desktop into a repo's `.claude/outbox/` — the one capture route. */
export { desktopScreenshot } from "../desktopShot.ts";
/** Hide (or bring back) the Android shell's system bars; false where the shell cannot. */
export { shellImmersive } from "../immersive.ts";
export {
  modelRows, pacing, pacingLine, periodCap, periodReadSpan, periodTitle, primaryUsdPeriod, usdWords,
  type ModelRow, type Pacing,
} from "../periodWords.ts";
export { explainCostPrompt, type CostSubject } from "../explainCost.ts";
export { pqKem, type PqKem, type PqKemPair } from "../pqKem.ts";
export { nativeKeystore, isKeystoreError, KEYSTORE_CODES, type KeystoreCode, type KeystoreError, type KeystoreStatus, type NativeKeystore, type PromptText } from "../nativeKeystore.ts";
