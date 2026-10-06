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
  CommandDef, ConnInfo, CoreApi, DurableOp, FeatureManifest, LedgerSummary, LedgerViewDef, LedgerViewParts, LedgerViewProps, MessageHandlers, QueueBacklogOpts, RepoActionDef, RepoChipCount,
  RepoChipDef, SettingsGroupId, SettingsRowsDef, SetupRowDef, SheetDef, SheetId, ToolbarItemDef, UploadApi, UploadBuf, UploadProgress,
} from "./types.ts";
export { core } from "../core/api.ts";
export { createStore, useStore, type Store } from "./store.ts";
export { mapWith, mapWithout, useCore, useLatest, useQueueEntries } from "./hooks.ts";
export { useBackStep } from "../backStep.ts";
/** This device's preferences (`core/prefs.ts`) — read-only from a feature; the
 *  Settings sheet is their writer. */
export { useConnStatus } from "./connStatus.ts";
export { usePref, type DevicePrefs, type PrefKey } from "../core/prefs.ts";
export type { CachedListStore, CachedLists } from "./cached.ts";
export { repoRunStore, type RepoRunStore, type RunLike } from "./repoRun.ts";
export { featureSheetId, type FeatureSheetId } from "../routing.ts";
export { pluginClient, type PluginClient } from "./pluginClient.ts";
export type { PluginCallResult, PluginMethods } from "@waterplane/shared";
export { ledgers, type CachedRead } from "./ledgers.ts";
export { explainCostPrompt, type CostSubject } from "../explainCost.ts";
export { nativeKeystore, isKeystoreError, KEYSTORE_CODES, type KeystoreCode, type KeystoreError, type KeystoreStatus, type NativeKeystore, type PromptText } from "../nativeKeystore.ts";
