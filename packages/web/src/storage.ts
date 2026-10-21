/**
 * Every `localStorage` key this app owns, in one place — plus the four readers
 * that every call site was otherwise re-writing.
 *
 * The keys were fine as string literals right up until there were sixty-seven
 * of them across thirty files, at which point three separate things stopped
 * being answerable by reading any one file:
 *
 *  - **Is this key synced?** `shared/settings.ts` holds the allow-list and
 *    `settings.ts` patches `setItem` to honour it, so a key written anywhere is
 *    synced correctly the day it is written — but nothing at the WRITE site
 *    says which way it went. `SYNCED` below is checked against the shared
 *    list at module load, so the two can no longer drift silently.
 *  - **Does this key still exist?** A renamed key leaves the old literal
 *    behind in the one file nobody grepped, and the symptom is a preference
 *    that silently reverts. A constant that no longer exists is a type error.
 *  - **What is the shape?** Nearly every read here is the same six tokens —
 *    `try { JSON.parse(getItem(k) ?? fb) } catch { fb }` — copied about forty
 *    times, each with its own idea of what an empty value is.
 *
 * The helpers are deliberately thin. They swallow their own errors and return
 * the fallback, because every failure mode available here — private browsing, a
 * quota, a hand-edited value, an older build's shape — is a reason to carry on
 * with a default and never a reason for the app not to start. That rule was
 * already followed at every call site; it is only stated once now.
 *
 * This is a registry, NOT a wrapper you must remember to use. The cross-cutting
 * rules that actually matter (sync, the timestamp) still live in the `setItem`
 * patch in `settings.ts`, for the reason that file states at length: a rule
 * that only holds where somebody remembered to call a helper is a rule that
 * breaks silently three edits later. `tools/eslint/rules.js` keeps new
 * prefixed literals from being written outside this file and the key slices it
 * spreads into `LS` (`storage/keys*.ts`).
 *
 * Every key is `lsKey(name)`: the PREFIX is the brand's (`shared/brand.ts`),
 * so a rename edits one value there and no line here. A phone carrying an older
 * prefix has its keys copied across before the first read
 * (`boot/brandMigrate.ts`, run first by `hostBoot.ts`).
 */
import { SYNCED_SETTING_KEYS, lsKey } from "@waterplane/shared";
import { LS_PREFS } from "./storage/keysPrefs.ts";
import { LS_VIEW } from "./storage/keysView.ts";
import { LS_WORK } from "./storage/keysWork.ts";

/**
 * The keys.
 *
 * Grouped by what they describe, because that grouping is what decides whether
 * a key may sync (see `SYNCED_SETTING_KEYS`' own note): things the user
 * AUTHORED follow the user; things describing this device, this link, or work
 * in flight stay here.
 */
export const LS = {
  healthAxis: lsKey("healthAxis"),
  ...LS_PREFS,
  ...LS_WORK,
  ...LS_VIEW,
} as const;

/**
 * The static web demo's own corner of localStorage: every key the page reads or
 * writes lives under this prefix while `?demo=` is on a non-host origin (the
 * facade is `demo/world.ts`), so a demo opened on a real host's origin neither
 * reads its drafts, queue and settings nor leaves any. In the APK the demo is a
 * SavedHost and gets the `waterplane.h.<id>.` namespace instead.
 */
export const DEMO_WORLD_PREFIX = lsKey("demoworld.");

/**
 * Reader-view watermarks are per SESSION, so the key is built rather than
 * listed. Kept here anyway: it is the one prefixed key a grep of this file
 * would otherwise miss, and `BootGuard` has to recognise it to sweep it.
 */
export const TR_SEEN_PREFIX = lsKey("trSeen.");
export const trSeenKey = (sessionId: string): string => `${TR_SEEN_PREFIX}${sessionId}`;

/**
 * An in-repo EXTENSION's own corner (`sdk/extStorage.ts`): `<prefix>ext.<pluginId>.<name>`. Built
 * rather than listed for `trSeenKey`'s reason — the names are the extension's — and HOST-scoped
 * (`HOST_KEY_PREFIXES`), so a remembered choice is per desktop and parks with it on a switch.
 */
export const EXT_PREFIX = lsKey("ext.");
export const extKey = (pluginId: string, name: string): string => `${EXT_PREFIX}${pluginId}.${name}`;

/**
 * The demo's persisted fake desktop, one key per scenario (`demo/transport.ts`).
 *
 * In **sessionStorage**, never localStorage — so it is not in `KEY_SCOPE` and a
 * host switch never sees it: a reload of this tab (the watchdog's, after a
 * dropped demo socket) must find the demo as it was, and a new tab is a fresh
 * demo. Built rather than listed for `trSeenKey`'s reason, and kept here so the
 * one file that names every key still does.
 */
export const DEMO_SNAP_PREFIX = lsKey("demo.snap.");
export const demoSnapKey = (scenarioId: string): string => `${DEMO_SNAP_PREFIX}${scenarioId}`;

/**
 * Which keys follow the PHONE and which follow the ACTIVE HOST.
 *
 * Several desktops share this phone (`hosts.ts`). The active host's keys live
 * bare; switching parks every host key under `<prefix>h.<id>.` and restores the
 * next host's (`shared/hosts.ts` `planHostSwitch`). A DEVICE key is never
 * moved: it is about this screen, this hand or this link, not about whichever
 * desktop was on the other end.
 *
 * A record typed over every `LS` name, so a new key that is not classified is
 * a TYPE ERROR, not a key that silently follows the wrong owner — and
 * `storage.test.mjs` checks the same thing at run time. When in doubt, `host`:
 * a host key that should have been a device key costs a setting chosen twice,
 * a device key that should have been a host key shows one desktop's queue to
 * another. Every SYNCED key is `host` (sync is per host, and so is its
 * bookkeeping `syncTs`).
 */
export type KeyScope = "device" | "host";
export const KEY_SCOPE = {
  // synced — the settings document is per host
  snippets: "host", headerCmds: "host", fanoutPresets: "host", toolbar: "host", launch: "host",
  launchAsk: "host", spendWarn: "host", pad: "host", hiddenRepos: "host", enterSends: "host", dictateTerms: "host",
  autoSend: "host", serialSessions: "host", confirmQueue: "host", confirmClose: "host", readerTools: "host", annKnobs: "host", annTools: "host", annPrompt: "device",
  hints: "host", repoColors: "host", installAllow: "host", closeWhenDone: "host", localSessions: "host", agentWarn: "host", agentWindowWarn: "host", syncTs: "host",
  // identity and the host list itself; healthAxis is this screen's choice
  healthAxis: "device", deviceId: "device", deviceName: "device", hostBase: "device", hosts: "device", hostActive: "device",
  hostSwitch: "device", hostsGone: "device",
  // that host's ledger row and LAN identity: parked with it
  deviceToken: "host", lanIdentity: "host", passive: "host",
  // what that host's install log last said
  installLog: "host",
  // the link: the phone's own switches are device, what was MEASURED against a host is host
  dataSaver: "device", bgFresh: "device", uploadScale: "device", netPulse: "device", localRtBar: "device", unfoldToEnd: "device", repoSort: "device",
  upKbps: "host", netlog: "host", netTraffic: "host", netSync: "host", localRt: "host",
  // the session tab strip: its SHAPE is this screen's, its open counts are that host's sessions
  sessionTabs: "device", sessionTabsCount: "device", sessionTabsOrder: "device", sessionTabsLimit: "device", tabOpens: "host", tabFiles: "host",
  sessionTabsSync: "device", tabsSaverAsked: "device", tabOrderShared: "host", tabOpensShared: "host",
  // work in flight: that host's words, that host's queue
  outbox: "host", compose: "host", composeDrafts: "host", composeOutbox: "host", composeSheets: "host",
  deadUploads: "host", dictations: "host", pendingStars: "host", pendingFollowUps: "host", backlogDraft: "host",
  // the language spoken into THIS phone (the vocabulary, `dictateTerms`, is the person's and synced)
  dictateLang: "device", dictateLangs: "device",
  fanoutText: "host", fanoutSel: "host", fanoutModel: "host", backlogRepo: "host", backlogShowArchived: "host",
  // retired stores, read once by a migration: never moved, so the migration finds them
  giveups: "device", giveupsMigrated: "device", padRescue: "device", padRescueMigrated: "device",
  activityDismissed: "host", activityConfirmedDone: "host",
  pullState: "host", pullAuto: "host", pullBrowserAsk: "host", pullAutoSave: "host",
  // what that host last said, cached for an offline cold start
  snapSessions: "host", snapRepos: "host", snapReposAt: "host", snapRecent: "host", snapClosed: "host",
  snapBacklog: "host", snapHistory: "host", snapBuilds: "host", snapCapture: "host", snapSchedules: "host",
  snapCliHealth: "host", snapAt: "host", themeOverlay: "host", themeOverlayCss: "host", slashCache: "host", fileMtimes: "host", artMarks: "host", fileRemarks: "host",
  newImages: "host", cmdHistory: "host", usage: "host", notifSeen: "host",
  costNoticed: "host", agentNoticed: "host", spendNoticed: "host",
  sessionOrder: "host", collapsedRepos: "host", sendMemory: "host", slotAskOff: "host", launchLast: "host", wheelHidden: "host",
  // how this phone is held and read
  toolbarOpen: "device", readMode: "device", cliMode: "device", termCostOpen: "device",
  typingRoom: "device", hintChip: "device", termCornerPos: "device", wideSideW: "device", wideBesideW: "device", widePanelW: "device", sessChromeH: "device", closeKbOnSend: "device", shortcutCard: "device", busySend: "device", btwToCli: "device", theme: "device", textScale: "device", iconScale: "device", termZoom: "device",
  readerZoom: "device", scrollZoom: "device", gitZoom: "device", textDumpWrap: "device", closeCustomH: "device",
  schedPctLeft: "device", schedLeadMin: "device", closeBy: "device", closeKeepStar: "device", collageGap: "device",
  collageLabels: "device", toastLog: "device", hostedAck: "device",
  // dismissals and the app's own update machinery
  dismissInsecure: "device", dismissPhoneSetup: "device", codeFolderLater: "device", dismissedUpdate: "device", annHintHidden: "device",
  stowed: "device", stowTold: "device", hostBoots: "device",
  lastForcedReload: "device", webUpdateRecoverySeen: "device",
  webUpdateStaged: "host", webUpdateAuto: "host", webUpdateApply: "host", webUpdateApplyTries: "host",
  webUpdateSnooze: "host", routeLast: "host", routeResume: "host", headerViews: "host",
  // the brand migration's marks: about this phone's storage, never parked
  brandMigrated: "device", brandStores: "device",
  // the demo switch: about this phone, never parked with a host
  demo: "device",
  demoReturn: "device",
  demoTour: "device",
} as const satisfies Record<keyof typeof LS, KeyScope>;

/** The keys a host switch never moves. */
export const DEVICE_KEYS: ReadonlySet<string> = new Set(
  (Object.keys(KEY_SCOPE) as (keyof typeof LS)[]).filter((k) => KEY_SCOPE[k] === "device").map((k) => LS[k]),
);

/** Built keys (not in `LS`) and whom they follow. Every one is a host's. */
export const HOST_KEY_PREFIXES: readonly string[] = [TR_SEEN_PREFIX, EXT_PREFIX];

/** The predicate `planHostSwitch` is handed. An UNREGISTERED prefixed key (an
 *  older build's, a built one) is a host key: parked, never lost. */
export function isDeviceKey(key: string): boolean {
  return DEVICE_KEYS.has(key);
}

/** The synced half, as a set, checked against the shared allow-list at load: a key renamed here
 *  but not there syncs nothing while looking like it does. Loud in dev, silent local-only in prod. */
export const SYNCED = new Set<string>(SYNCED_SETTING_KEYS);
if (import.meta.env?.DEV) {
  const known = new Set<string>(Object.values(LS));
  const missing = SYNCED_SETTING_KEYS.filter((k) => !known.has(k));
  if (missing.length) console.warn("[storage] synced keys missing from the registry:", missing);
}

/** Raw string, or null. Never throws — private mode is not a crash. */
export function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Write a raw string. Goes through the patched `setItem`, so a synced key
 *  still syncs — do not reach past this to a stored reference. */
export function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota / private mode — non-fatal */ }
}

export function lsDel(key: string): void {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

/**
 * JSON read with a fallback. The forty-odd copies of this were all identical
 * except for what they considered empty, which is now the caller's single
 * argument rather than a literal buried in each `catch`.
 */
export function lsJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") return fallback;
    const v = JSON.parse(raw) as T;
    // `null` round-trips as a valid parse but is never what a caller wanted
    // back in place of its own default.
    return v === null ? fallback : v;
  } catch { return fallback; }
}

export function lsSetJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
}

/** `"1"`/`"0"` flags, with the default applied to an unset key. */
export function lsBool(key: string, fallback = false): boolean {
  const v = lsGet(key);
  return v === null ? fallback : v === "1" || v === "true";
}

export function lsSetBool(key: string, value: boolean): void { lsSet(key, value ? "1" : "0"); }

/**
 * A finite number, or the fallback. A hand-edited key reads as unset. The
 * `null` check is load-bearing: `Number(null)` is 0, so an UNSET key once
 * answered zero rather than the caller's default.
 */
export function lsNum(key: string, fallback: number): number {
  const raw = lsGet(key);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
/** The repo-readings x axis: a reading per ISO week or per commit. Default weeks. */
export type HealthAxis = "weeks" | "commits";
export const readHealthAxis = (): HealthAxis => (lsGet(LS.healthAxis) === "commits" ? "commits" : "weeks");
export const writeHealthAxis = (v: HealthAxis): void => lsSet(LS.healthAxis, v === "commits" ? "commits" : "weeks");
