/**
 * The boot-time check on `main.ts`'s `ctx` draft.
 *
 * `main.ts` builds `ctx` as `{} as ServerCtxDraft` and assigns each member in
 * boot order, so a member is TYPED present while still undefined until its line
 * runs. `assertCtxComplete` runs once, just before the server listens, and
 * throws naming every key that never got assigned — a forgotten assignment
 * fails the boot, not some request later with `undefined is not a function`.
 *
 * `serverCtxKeys()` must list EVERY key of `ServerCtx`: the type check below
 * fails `tsc` when a field is added to `ServerCtx`/`HostCtx` and not listed
 * here. (`ctx.ts` itself stays types-only — `hostshape`.)
 */
import type { ServerCtx } from "./ctx.js";

export function serverCtxKeys() {
  return [
  "acks", "announceBuild", "attention", "assess", "assessExecutor", "assessSnapshot", "attached", "auth", "authStateFor",
  "autopull", "backlog", "backlogSnapshot", "billing", "BOOT_ID", "broadcast", "broadcastAuthState", "budget", "builds",
  "capture", "clearNotifications", "clients", "cliHealthStore", "closeDevice", "containRepoDir", "decisionLog", "deliverChain",
  "deliverInput", "deliverySnapshot", "DOCTOR", "durableOp", "enforceAuth", "fanout", "fmtSize",
  "handleClientMessage", "handleNotification", "healthWatch", "imgSeen", "inputsInFlight", "installLog", "intents", "intentSnapshot",
  "isAttachedToSomeone", "launchSnapshot", "meter", "naming", "netstats", "notificationFeed", "notifications", "notify",
  "notifyPrefs", "onboard", "openDeliveries", "outSeen", "padNotesFor", "peers", "pluginUpdates", "plugins", "PORT",
  "publishBudget", "pullCatchUp", "pullNewFiles", "pullSeen", "push", "recomputeWatched", "resolveAttention", "resolveAttentionPrefix", "review", "ROOT",
  "scanImages", "scanOutboxDocs", "scanPullCandidates", "scheduleSnapshot", "send", "sentLogStore",
  "sessions", "settings", "setupWatch", "socketAuthorized", "startPrompt", "syncUsagePolling", "tokenStats",
  "uiStats", "updateApplier", "updates", "usage", "usageLog", "usageSources", "weekBurn", "wsDevice", "wsKind", "wsRole", "wsToken",
  ] as const satisfies readonly (keyof ServerCtx)[];
}

// Exhaustiveness: a ServerCtx key missing from the list makes `Unlisted` non-never,
// which `MustBeNever` refuses at compile time. Type-only: nothing runs at import.
type Unlisted = Exclude<keyof ServerCtx, ReturnType<typeof serverCtxKeys>[number]>;
export type MustBeNever<T extends never> = T;
export type CtxKeysExhaustive = MustBeNever<Unlisted>;

/** Throws (naming the keys) unless every required `ServerCtx` key is assigned. */
export function assertCtxComplete(draft: object, keys: readonly string[] = serverCtxKeys()): void {
  const rec = draft as Record<string, unknown>;
  const missing = keys.filter((k) => rec[k] === undefined);
  if (missing.length) {
    throw new Error(`boot: ctx incomplete — never assigned: ${missing.join(", ")} (main.ts assigns each ctx member in boot order)`);
  }
}
