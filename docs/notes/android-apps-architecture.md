# Android apps: leaving core as an optional extension

The phone's **Apps screen** (a card per Android repo: build, download, install by itself; the install
history; the "N waiting" launcher badge) is the surface of a job only some people have. It moves to
`packages/extensions/android-apps/`, optional, **on by default only when this desktop has an Android
repo**. This note is written before the first cut ([refactoring skill](../../.claude/skills/refactoring/SKILL.md),
step 1). Closest worked examples: [token-stats-architecture.md](token-stats-architecture.md) (a screen
leaving core, an adopted-id decision, the SDK read API) and the `links`/`scorecard` extensions (host
methods + pushes). Contract: [plugins-api.md](../plugins-api.md), [plugins.md](plugins.md#in-repo-extensions).
Reasoning for the process: [refactoring.md](refactoring.md).

Line numbers below are from the inventory of 2026-11-01 and rot after the first commit: every package
re-derives them with `grep -n`.

## 1. Why, and the scope

Not every user builds Android apps; today every phone's launcher draws "android apps", the Downloads
sheet carries a pointer to it, the host serves `/api/apps/readiness` and keeps an install log nobody
reads. The rule that decides what moves: **moves = the screen and everything only the screen reads;
stays = anything a person without the screen still needs, or that concerns the waterplane shell APK
itself.**

**Moves** (web unless noted):

| what | from | why it is the screen's |
|---|---|---|
| `AppsSheet.tsx` (368), `AppsHistory.tsx`, `appReady.ts`, `appSteps.ts`, `appsPane.ts`, `features/pull/AppsListSheet.tsx` | root, `features/pull` | the screen and its pure views |
| the **apps-screen half** of `installPolicy.ts`: `AppRow`, `appRows`, `readyApps`, `buildsOf`, `InstallBuild`/`BuildSource`, `KnownApp`, `snoozeText`, `waitingAppNote`, `appsSummary`, `appStateText`, `appInstallVerb`, `quietVerdict`/`quietOwnerText`/`installerName`, `cleanupText`/`cleanupLabel`, `isPlayBuild` users there | `installPolicy.ts` (610) | read only by the screen and the launcher count |
| `installLog.ts` (client store, `install.report` sender, `install.log` listener), `webapi` `appReadiness` | root | the history pane |
| ☰ launcher line + `appsReady` count (`LauncherScreen.tsx` ~198/252-275, `useLauncherModel.ts` ~516) | core launcher | becomes a `LauncherItemDef` with `useCount` |
| host: `GET /api/apps/readiness` (`routes/apihost.ts` ~238, `apitable.ts`, `server/http.ts`), `appready.ts`, `installlog.ts` + `InstallLogStore` plumbing (`main.ts`, `shutdown.ts`, `ctxseal.ts`, `routes/types.ts`, `routes/system.ts` `onInstallGet/Report` + hello push), wire `install.get/report/log`, `shared/src/installlog.ts`, `wire/install.ts` log types | host, shared | the screen's data |
| core buttons that open the screen (Downloads `onOpenApps`, `PullSheet` ×2, `BuildButtonsSheet` `onOpenAppsSetup`, the `whatsnew` "get the APK" door) | core | become extension-aware (section 5) |

**Stays core**, each with its reason:

- `toolchain.ts`, `signkey.ts`, `androidenv.ts`, the compliance rows, doctor, `optins`, the onboarding
  Android path: a person setting up an APK build needs them **before** deciding to switch anything on,
  and `isAndroidRepo` is what decides the default (section 6).
- **`apkInstallCheck` (the `apk-install` setup row) stays core.** It is a row on the repo-readings sheet,
  already conditional on `isAndroidRepo`, cheap, and worded from the same gradle reading as the keystore
  rows. Moving it through `api.setupCheck` would make the row vanish with the switch, but a repo whose
  APK cannot self-install is a *setup* finding whether or not the person looks at the Apps screen, and
  it feeds doctor/onboard. Its words must not point at a screen that may be off: `apkcheck.ts:180` names "the Android apps screen" (lowercase; a case-sensitive grep misses it), so P1 rewrites it to name the fix (what the repo needs) instead.
- **`apkRepoFacts` (the facts behind the report) stays core, handed to the extension as one read
  method**, see section 3: it reads `signkey` (`keyKind`), the outbox layout (`OUTBOX_SUBDIRS`), the build
  manager and the auto-download rule — four core managers. Moving it means four new API members for a
  130-line function whose gradle reading `apkInstallCheck` shares. **Owner decision: it stays core.**
- `nativeInstall.ts` (the Capacitor `Install` bridge client): `PullSheet` (a downloaded APK's own row),
  `usePhoneSetup`, onboard and `PhoneSetupSheet` use it. Exposed to the extension through the SDK, not copied.
- The **row-level** half of `installPolicy.ts` (`InstallCaps`, `NO_INSTALL`, `installOffer`, `allowToggle`,
  `autoInstallText`, `installIntroText`, `installStatusText`, `installVerbText`, `repeatedVersionText`,
  `cleanedText`, `failureText`, `toggleAllow`, `shellDistribution`, `isApkRow`, the Play texts): `PullSheet`
  needs them on every downloaded APK, apps screen or not.
- The `installAllow` synced setting (`shared/src/settings.ts` 160-173, mirrored to the shell), the `LS.installAllow` key,
  pull records' `install*` fields (`pull/pullTypes.ts` 49-68, written by the shell service), all generic
  builds/artifacts/autopull/passive code, and everything about the shell APK itself (`apkGate`, `whatsnew`,
  `AppUpdate`, `pair.ts`).
- `deviceName`/`deviceModel` (exported from `installLog.ts`, used by `PairForm.tsx` and `lanLink.ts`) move
  to a core `deviceInfo.ts` — they are pairing facts, not install-log facts.

## 2. Target layout

```
packages/extensions/android-apps/
  waterplane-plugin.json   id "android-apps", apiVersion "2.0", host/web, optional:true, autoOn:"androidRepo" (new, section 6)
  ship.json                { "ship": true, "on": true }       (release default; autoOn narrows it)
  README.md                what it is, the default rule, where the log file lives
  shared/wire.mts          AndroidAppsMethods, PUSH_LOG, InstallLogDoc/Entry/Reporter types, mergeInstallLog, cleanInstallEntry, installReportFrom
  host/index.mts           activate: serve(api, store); deactivate/shutdown flush
  host/installlog.mts      InstallLogStore (moved; same file path, chunked report, section 4)
  host/readiness.mts       the `readiness` method: api.repoApps() + stamp
  web/index.ts             manifest: id, sheets, launcherItems (useCount), appsDoor, pushes, hideWhen, boot
  web/AppsSheet.tsx, AppsHistory.tsx, appReady.ts, appSteps.ts, appsPane.ts, appRows.ts (the moved installPolicy half),
  web/installLog.ts        client store over pluginClient
  web/state.ts             readiness/log stores (links/state.ts shape)
  test/                    node:test over host + wire (links/test is the model)
  e2e/                     one e2e: default-on rule + readiness call (e2e/** is guarded: guards.mjs e2ewatchdog)
```

- **Public.** It was public core and stays public: `deploy/public-allowlist.txt` is `packages/**` by default,
  and only extensions that must stay private carry a `!` line; so **no `publictree.json`, no allowlist edit**.
  Public CLAUDE.md/docs may name it.
- Id and folder are `android-apps` (lower case, `PLUGIN_ID_RE`, webshape requires manifest id = folder).
- `deploy/ship.json` `builtins` gets `"android-apps": { "ship": true, "on": true }` like `ocr`/`scorecard`
  (public extensions are listed there; `scripts/release/build.mjs` writes it into `release.json`).
- Pure `.ts` siblings import with `.ts`; nothing a node test loads value-imports an alias (token-stats rule).
- Caps: the moved files keep their sizes; `AppsSheet.tsx` at 368 is under the 900 extension cap.
  `installPolicy.ts` (610) is **split by consumer**, not trimmed: its comments travel with their functions.
  The row half goes to `packages/shared/src/installrow.ts` (pure, `BRAND` only, so both core and the extension
  import it from `@waterplane/shared`); the apps half goes to `web/appRows.ts`.


## 3. The SDK, kit and host-API surface the extension needs

The extension may import only `@waterplane/sdk`, `@waterplane/kit`, `@waterplane/shared`, react,
lucide-react and its own folder (`local/extension-boundary`, `tools/extensionboundary.test.mjs`).
AppsSheet today imports thirteen core internals. For each:

| today | becomes |
|---|---|
| `api.appReadiness()` | `pluginClient("android-apps").call("readiness")` |
| `showToast`, `track` | `useCore().say.toast` / `say.track` (exist) |
| `SheetHead`, `Empty`, `Button`, `Row/RowSub`, `Hint`, `useRemoteResource`, `SetNote` | `@waterplane/kit` (all exported) |
| `SetLine` | **add** `export { SetLine } from "../SettingsKit"` to `kit/index.ts` |
| `hhmm`, `when` (`format`; `AppsHistory.tsx:12` imports `when`) | **add both** to the kit's format line |
| `agoText(ms)` (a duration, "just now") | **rewrite the call** onto kit `ago(ts)` (an instant, "Ns ago", `format.ts:128,196`); they are different words, not aliases. The wording changes, so the `appReady.test` expectations are re-pinned in P3b, said in that commit; no second word-maker is exported |
| `deviceId` (`link`) | **add** to the SDK (`export { deviceId } from "../link/linkLog"`); `deviceName`/`deviceModel`/`setDeviceName` from the new core `deviceInfo.ts`. `LS.deviceName` keeps its key |
| `pulls`, `PullRecord` | **new `sdk/downloads.ts`**: `usePullRecords()` (read-only) and the `PullRecord` type; the extension never writes a record |
| `cfgs`, `putCfg`, `pull.get/pull.save` (AppsListSheet "enable download by itself") | **decision: move `cfgs` + `putCfg` to a top-level `web/src/pullRules.ts`** (P2a); `features/pull/{store,actions}.ts` import it, `sdk/downloads.ts` `pullRules.use(repoDir)` / `enableBuilds(repoDir, done)` wrap it. Why not a bind seam: `sdk/` may not import a feature (`tools/eslint/boundaries.js:86`), and a `bindPullRules` seam adds a registration order to keep for what is plain state; `automationSlot.ts` and `pull.ts` are already top-level homes for exactly this. The `enableBuilds` body keeps the cfgs-not-yet-read path, so *never write defaults over a rule nobody has read* (`AppsListSheet.tsx:28`) stays in one place and is pinned |
| `useInstallSources`, `useInstallStatus`, `nativeInstall*`, `openInstallSettings`, `setCleanAfterInstall`, `readInstallAllow`/`writeInstallAllow`, `shellBridge` | **new `sdk/install.ts`**: `shellInstall` (`supported()`, `status()`, `install(id)`, `openSettings()`, `setCleanAfterInstall(b)`) + `useInstallCaps()`, `useInstallSources()`, `useInstallAllow()`/`setInstallAllow(list)`. Thin wrappers, no behaviour |
| `storage` (`LS.installLog`) | the log cache moves to `extStorage` (per host); `LS.installLog` is host-scoped and a cache of a host document, so the extension's `boot` clears it once and `keysPrefs.ts` drops it |
| install helpers from `@waterplane/shared` `installlog.ts` (`deviceLabel`, `filterInstallLog`, `installLogLine`, `installLogSummary`, `installTitle`, `InstallLogEntry`, `mergeInstallLog`, ...) | move whole to the extension's `shared/wire.mts`; **web files import them from `../shared/wire.mts`, never `@waterplane/shared`** (extensionboundary passes either way; the build breaks after P5 deletes `shared/src/installlog.ts`). Importers to repoint, from `grep -rlE "installLog\|InstallLog\|deviceLabel\|installTitle"`: `AppsHistory.tsx`, `appReady.ts`, `AppsSheet.tsx`, `installLog.ts` (web, all move); core remaining: `PairForm.tsx`, `lanLink.ts` (take `deviceInfo.ts`), `main.tsx`, `storage.ts`, `storage/keysPrefs.ts`, `storage.test.mjs` (P4); host `main.ts`, `shutdown.ts`, `ctxseal.ts`, `routes/{types,system}.ts`, `wire/install.ts`, `wire/messages/hosttools.ts`, `shared/test/installlog.test.mjs`, `host/test/installlog.test.mjs` (P5) |
| `installPolicy` row functions | `@waterplane/shared` `installrow.ts`; `InstallRow`, `InstallCaps`, `isPlayBuild` live there too (the apps half's `InstallBuild extends InstallRow`, so the split is at the type) and `appRows.ts` imports them |
| core nav: Downloads, Build sheet, Setup | `core.nav.open("pull")`, `openBuild`, `openSetup` (exist; verify `core.world.repos` and `core.conn.liveAsk/liveSend/trySend` for `AppsListSheet`) |
| `useInstallCaps` / `useInstallStatus` | core hooks; reached only through `sdk/install.ts` |

Two **manifest-level** additions (section 5 uses them): `FeatureManifest.hideWhen` and `FeatureManifest.appsDoor`, plus the
hook `useAppsDoor()`.

**Finding that forces `hideWhen`.** `contributionTable` (`core/featureRun.ts` ~277) draws every extension's launcher
items, menu items and chips whether the extension is on or not — `links` and `scorecard` show a line whose tap then
fails at the host. `available()` can only return a *sentence* (a dead button, forbidden by CLAUDE.md), and a `useCount`
returning `null` still draws the line (`LauncherScreen.tsx:259-275` draws it only when `nativeInstallSupported()`, with the
comment that an entry opening "not here" is worse than none). So an opt-in predicate
`hideWhen?: (core: CoreApi) => boolean`: `contributionTable` drops that feature's launcher items, menu items, chips,
repo actions **and its header-badge contribution** while it returns true. The android-apps manifest says
`hideWhen: () => isExtensionEnabled("android-apps") === false || !shellInstall.supported()`, so the line stays
Android-shell-only exactly as today, and is gone when the extension is off. `links`/`desktop` declare nothing and do
not change. Test: a browser PWA (no shell) draws no line and no badge term; the shell with the extension off draws none;
on draws one (and `LauncherScreen.tsx:198` base math is unchanged for the shell).

**Offline cold start (decided now).** Unlisted/not-yet-loaded reads as OFF (`sdk/extensions.ts:32-36`), and installing an
already-downloaded APK is phone-local; with `hideWhen` the only door would vanish whenever the tunnel is down at launch.
So `features/plugins/store.ts` caches the **last `plugin.list` per host** under a new host-scoped key (`LS.pluginList`, the
`LS.installLog` / `hosts.ts` scoping) and starts from it: a cached list is authoritative until the live one lands; a host
with no cache reads as today (unknown ⇒ off). Test (`features/plugins/store` test): cache `[android-apps on]`, cold start
with no connection ⇒ `enabledIn` true and the launcher line drawn; the other host's key does not leak; a live list
replaces the cache. This also makes the host-switch case honest: each desktop shows its own state at once.

**Host API** (`HostPluginApi`, additive, `PLUGIN_API_VERSION` unchanged), one member:

```ts
/** Facts about each Android app module in every PRIMARY checkout on this desktop (read-only, bounded async
 *  walks, one repo at a time): package, targetSdk, key kind, the outbox APK, the build rows, the auto-download
 *  rule and whether it would take the newest APK. [] when the desktop has none. */
repoApps(): Promise<AppRepoFacts[]>;
```

Implemented by core with today's `appReadinessReport` body + `apkRepoFacts` (they stay in `appready.ts`/`apkcheck.ts`;
**owner decision: readiness facts stay core**, only the HTTP route goes). `AppRepoFacts`/`AppReadinessReport` stay in
`shared/wire/install.ts`; `InstallLog*` types and `mergeInstallLog` move to the extension's `shared/wire.mts`. The install
log is a plain file store and `api.stateDir` gives it the same directory.

## 4. Transport and compatibility

**Today:** `GET /api/apps/readiness`; `install.get`, `install.report` (client) and `install.log` (host, sent on hello,
on `install.get`, broadcast on change). **After:** only the generic plugin channel.

| old | new |
|---|---|
| `GET /api/apps/readiness` | `plugin.call("android-apps", "readiness")` → `{ at, apps: AppRepoFacts[] }` |
| `install.report` (device + whole ring) | `plugin.call(..., "report", { device, entries })`, **chunked** (below); answers `{ n, at }` only |
| `install.get` | `plugin.call(..., "log")` → `InstallLogDoc` |
| `install.log` push | `api.push("changed", { n, at })` after a merge — a ping; phones re-`log` (pull) |

**Size caps decide the shape.** `PLUGIN_ARGS_MAX` and `PLUGIN_PUSH_MAX` are 64 KB (`shared/src/plugin/manifest.ts:16,17`);
`CALL_RESULT_MAX` is 512 KB. The ring is 500 entries (`INSTALL_LOG_CAP`, `installlog.ts:24`), a report up to 300
(`MAX_REPORT_ENTRIES`, :35), entries up to ~800 B of text (:29-31): one report is routinely over 64 KB and a whole-doc push
is far over it (`pluginapi.ts:473` returns an error *string*, it does not throw, so phones would silently never hear).
Therefore: (a) `report` is sent in **idempotent chunks of at most 100 entries and 48 KB serialized**, whichever first
(a merge is a union by entry id, so order and repeats are harmless); (b) the push carries only `{ n, at }` and the code
checks `api.push`'s return value, logging a string result; (c) `log` is the only large reply, and the store trims
oldest-first so the serialized doc stays under 480 KB. **Pin:** 300 max-size entries report in chunks each under the cap and
merge to the same ring as one whole report; a full 500-entry max-size doc stays under `CALL_RESULT_MAX`; push payload size
asserted.

The phone's report stays a **re-statement** (the ring from pull records, chunked, on every `welcome`): that is what made
the old protocol idempotent, and why switching the extension off loses nothing. At-most-once is unaffected:
`plugin.call` goes through `callOnce` by ackId, a read needs none, and a duplicated or timed-out chunk is harmless.

- **Reporting is gated:** the extension's `boot` attaches the report listener via `watchExtensionEnabled`; off ⇒ no calls.
- **`PROTOCOL_VERSION` stays 2.** The plugin channel already exists, and removing three messages is not something a
  version gate protects (the mismatch toast would fire on every phone for a change needing no phone action). The union
  drops the three messages; `demo/host/handlers.ts` (154, 369, 460) and `model.ts` 146 lose their entries.
- **Old phone bundle → new host.** No retired table: `routes/index.ts:35` (`if (!Object.hasOwn(ROUTES, msg.t)) return;`)
  already drops an unknown client message silently, with no error frame, so an old bundle's `install.get`/`install.report`
  cost nothing. The removed GET route simply 404s (AppsSheet tolerates a failed fetch). Nothing to delete next release.
- **New phone bundle → old host.** An older desktop does not list `android-apps`, so the Apps line is silently absent
  there (**decided: fine**, like any extension a host lacks); with the per-host list cache it appears and disappears
  correctly on a host switch.
- **The install log file is not moved.** The store opens `join(api.stateDir, "installs.json")` (`api.stateDir ==
  hostStateDir(root)`, `pluginapi.ts:331`; `hoststore.ts:161` already lists `installs.json`, keep that line): same path,
  same `{entries}` shape, `readJsonGuarded`/`writeJsonAtomic`. No migration. It reads on `activate` and flushes
  **synchronously** in both `deactivate` and `shutdown()` (`deactivateAll` is not awaited; a never-activated entry has no
  `shutdown` to call, so nothing is lost). A P0 pin reads a fixture `installs.json` through the new store: same rows.
- **`passive.ts`** is default-deny and `/api/apps/readiness` is already refused (`passive.test.mjs:37`); a locked passive
  token never holds a WS, so it never used `install.*`. When the route leaves `passive.test` / `apiroutes.test.mjs:49`,
  **replace it with another denied route** the file already pins, keeping one denied-route assertion.
  `hostrestpins.test.mjs:27` drops the three message names; `shared/test/wiresurface.test.mjs:131,132,256` pins the same
  three names and changes with the union (P5).

## 5. Core → extension seams

**Doors from core.** Core must not import the extension nor name its sheet id as a string. One tiny contribution point:

```ts
/** On FeatureManifest. The extension that owns the "my own Android apps" screen. */
appsDoor?: { open(core: CoreApi, cut: { kind: "all" } | { kind: "waiting" } | { kind: "repo"; repo: string }): void };
```

and `useAppsDoor(): AppsDoor | null`: the first feature declaring `appsDoor` **while its extension is on**, else `null`.
`appsPane.ts`' "next cut" handoff moves inside the extension. Callers (rule when off: **omit, or say why in words**; never a
dead or grey control, and an omitted prop is `undefined`, not a no-op function, so the wrapping `Hint` does not render):

| core site | extension on | extension off |
|---|---|---|
| `DownloadsSheet.tsx` 28 `onOpenApps` pointer (`PullSheet` ~403-411) | pointer button, `door.open({kind:"all"})` | **omitted** (the downloads list is complete without it) |
| `PullSheet.tsx` ~255 "allow it / apps" row button | opens the repo's card | the per-row **install-by-itself switch stays** (row-level, core); only the door is omitted |
| `PullSheet.tsx` ~375 version-gate switch and its **:395 `get the APK` door** ("This switch needs APK >= 0.1.8") | `get the APK` goes to the shell-APK path, never the Apps sheet | **keeps an action**: the same shell-APK door `whatsnew` uses (Downloads / the app-update download). If that lands on the sheet already open, show a sentence naming where the shell APK is. Never a gate message with no way forward |
| `BuildButtonsSheet.tsx` 91 `onOpenAppsSetup` (`BuildSheet.tsx:427-433` "get it on this phone", a `Hint` around only the Button) | button, `door.open({kind:"repo", repo})` | **omitted**: `undefined` is passed, the `onOpenAppsSetup &&` guard keeps the Hint out |
| `whatsnew/logic.ts` 79 "get the APK" `door: {kind:"sheet", id:"apps"}` | — | **re-pointed to `pull`** (Downloads), same verb; it is the shell APK, a download, not a feature. As landed (P4 review N2/N8): worded and aimed per distribution through `apkGate.ts` `shellApkWhere` — the files tab only when a download there passes that row's gate, else Play's page or the release page (`Door` `kind: "url"`); no door until the shell's caps are read |
| launcher ☰ line + "N waiting" | the extension's own `launcherItems` entry, `useCount` computed **with the same caps and allow list as the sheet** (not `NO_INSTALL`; today's `useLauncherModel.ts:518` mismatch is not copied), `openCount` = `door.open({kind:"waiting"})` (a count is a filter: the tap lands on exactly the n builds) | gone with `hideWhen`; core `LauncherMenuBadge` base loses `appsReady` and `useLauncherModel`'s `installPolicy` import |

**Core words that name the screen** are rewritten to name what the person does or needs, not the screen (a person with the
extension off reads a missing screen). Full list from `grep -rniE "apps (screen|list|sheet)|android apps" packages/{web,host,shared}/src`:
`installPolicy.ts:315` (`installIntroText`, "the Apps screen turns it on per app"), `phoneSetup.ts:54`, `host/apkcheck.ts:180`
(lowercase "Android apps screen"; the first draft's `grep -n "Apps"` missed it), `host/reposkilltext.ts:253,262` (P6: say *when
the Android apps extension is on*), and comments `BuildSheet.tsx:116`, `Banners.tsx:124`, `useInstallCaps.ts:6`,
`webapiFiles.ts:139`, `demohttp.ts:203`, `shared/wire/install.ts:127`, `apkcheck.ts:206`. The boundary test (section 7)
scans case-insensitively so this list cannot regrow.

Not a toast, not a "turn it on in settings" button on a core surface: someone who never builds Android apps should not
see the feature mentioned. The settings extension list (`features/plugins`) is where the switch and the reason for its
state are said (section 6).

**The sheet id (owner decision: reload on the Apps sheet lands on the launcher).** The extension's sheet is
`feature:android-apps/main`, `persisted: false` (the `links` pattern), not an adopted core id. Nothing in core opens it by
id (the door does); a persisted overlay would paint a restored route while the extension reads off (the cold-offline state,
now also covered by the list cache, but a route that cannot be restored must not exist); and readiness now comes through
a plugin call, so the old "paints the real rows with no host" comment is false. The `overlay:apps` usage counter restarts
under the new id (`usage` keeps both rows). `routing.ts` drops `"apps"` from `Overlay`, `PERSISTED_OVERLAYS` and the 68-75
comment; a stale `#o=apps` hash must resolve to home (pinned, `routing.test.mjs` ~144).

## 6. The conditional default

**Today.** `optional: true` ⇒ the registry (`plugins/pluginregistry.ts` `loadBuiltinIds`, ~228) computes
`enabled = typeof switched[id] === "boolean" ? switched[id] : rel?.[id]?.on !== false`, where `switched` is
`<state dir>/plugins.json` `{ enabled: {id: bool} }` (written only by the person's switch, `setEnabled`, ~477) and `rel` is
`release.json` `builtins` (from `deploy/ship.json` / the extension's `ship.json`). A dev checkout has no release file:
optional ⇒ on. There is no per-desktop condition anywhere. `loadBuiltinIds` is the only place `enabled` is decided and
runs before listen.

**Design.** One manifest field, one registry step, one derived cache; a person's choice is never touched or overridden.

1. Manifest (`shared/src/plugin/manifest.ts`): `autoOn?: "androidRepo"`, a closed union naming a **host-supplied probe**;
   a manifest cannot invent one and core never runs extension code to decide whether the extension exists.
2. `PluginRegistryDeps` gains `probes: Record<"androidRepo", () => Promise<boolean | null>>`. `main.ts` supplies a walk
   over `discoverTargets(ROOT)` primaries using `androidenv.ts` (bounded, one repo at a time). **`null` = unknown**: a
   repo that exhausted `isAndroidRepo`'s 400-directory / depth-6 budget (`androidenv.ts:281-310`) without a hit makes the
   whole answer `null`, not `false`.
3. **Derived cache `<stateDir>/auto-probe.json`** `{ androidRepo: { result: boolean, at } }`. It is **not** `plugins.json`,
   is never a person's choice, and is deletable at no cost. `resolveAuto` writes it after each definite probe (`null`
   writes nothing).
4. `loadBuiltinIds`, optional builtin with `autoOn` and **no stored boolean**: `enabled` = `release.on !== false &&
   cachedProbe(true)` read from the cache file, synchronously; so a restart with cached `true` is on and activated at once
   (no off→on flash, no "turned off" replies to an open sheet); no cache or cached `false` ⇒ off, `auto = {pending:true}`,
   not activated. A stored boolean ⇒ today's path. Boot never awaits a probe.
5. `resolveAuto()` runs once after the server listens, then from an `unref`'d 15-minute timer, and on the repo-discovery
   change event if `discoverTargets` has one (grep; else the timer alone). For each auto entry: run the probe; then
   **re-check the choice after the await**: an in-memory `e.chosen`, set synchronously by `setEnabled`, and a fresh
   `readEnabled()`; if either says a choice exists, **do nothing**. This closes the race where a tap OFF during the walk
   would otherwise be overridden in memory for the whole uptime. Otherwise: result `true` and entry off ⇒ activate and
   `deps.changed()` (**off→on only**). Result `false` while on ⇒ **never turns itself off during uptime (decided)**: the
   cache is updated so the *next boot* starts off. `null` ⇒ keep state and cache.
6. **A choice always wins and is never overwritten**: `setEnabled` writes both answers for builtins (already) and sets
   `e.chosen`; `resolveAuto` never writes `plugins.json`.
7. **No way back to automatic (decided)**: the switch is final like every extension; `plugin.enable` stays true/false.
   `PluginView` gains `auto?: { state: "on" | "off"; why: string }`, present **only while no stored choice exists**;
   `PluginsSettings.tsx` shows it under the switch: *"on automatically — a repo on this desktop is an Android app"* /
   *"off automatically — no repo here is an Android app; checked every 15 minutes"*. Flipping it records the choice, removes
   the line, and the line says the choice now stays.

**Accepted limits, stated.** (a) A new Android repo created from the phone turns the extension on within ~15 minutes (or at
once if a discovery event exists); the words above say so. (b) A monorepo exhausting the 400-dir budget yields `null`, so a
first-ever boot (no cache) still starts off and the owner can flip it; this is the one residual false negative, and the
switch is the escape. (c) During uptime auto-on never turns off.

Release behaviour: `deploy/ship.json` `"android-apps": { "ship": true, "on": true }` means "release default on", and
`autoOn` narrows it per desktop; a release wanting it off for everyone sets `on:false` (probe skipped). A dev checkout has
no `release.json` ⇒ the probe decides.

## 7. Guardrails before moves (package P0 — tests only, they pass on today's tree)

- **Routes and overlay pins:** `routing.test.mjs` (~144) asserts `Overlay`/`PERSISTED_OVERLAYS`; P0 adds the stale-hash
  case (`#o=apps` ⇒ home). The route/message lists (`apiroutes.test.mjs` 49, `passive.test.mjs` 37, `hostrestpins.test.mjs`
  27, `shared/test/wiresurface.test.mjs` 131/132/256) are recorded as data that P5 edits with the code.
- **A "core no longer names it" test** (`tools/androidappsboundary.test.mjs`, tier `edit`, paths `packages/{web,host,shared}/src/**`
  in `scripts/guards/guards.mjs`): comments-stripped scan for `\bAppsSheet\b|\bappsPane\b|\bAppsHistory\b|"android-apps"` and the
  literal overlay `"apps"`, plus a **case-insensitive** scan of strings for `apps? (screen|list|sheet)` and `android apps`.
  The allowlist P0 fills with today's hits shrinks with each package (the `webshape` ratchet shape); `"android-apps"` has no entry.
- **Line ratchet:** `webshape` gets `installPolicy.ts` (610) so the split lowers it.
- **Install-log continuity** (section 4), **wire round-trip** for the moved `InstallLogDoc` (`desktop` test is the model),
  `mergeInstallLog` identical before/after on a fixture, and the **max-size ring pins** of section 4 (chunked report, doc <480 KB, push size).
- **Default-mechanism pins** (P1), all in host tests: probe true/false/null × stored true/false/absent × release on/off;
  (a) **tap during probe**: `setEnabled(false)` while the probe is pending ⇒ after it resolves the entry is still off and
  inactive; (b) **restart with cached `true`**: the first `plugin.list` after boot already says enabled/active, no off→on
  transition observed; (c) **`plugins.json` bytes unchanged** by boot and every `resolveAuto`; (d) boot does not await the
  probe; (e) `null` keeps cache and state; (f) `true→false` during uptime does not deactivate.
- **`extensionboundary`** forbids the extension importing core and `coreExtensionImport` the reverse; `webshape` checks id =
  folder and that the sheet is `feature:` and not persisted; `extensionclasses` checks every literal `className` the moved
  screen uses is defined in a stylesheet (the one most likely to catch a moved `apps-*` class).
- **Behaviour pins green through every package:** `appReady.test` (re-pinned once, for the `ago` wording), `appSteps.test`,
  `installPolicy.test` (split by half), `pull/logic.test`, `storage.test` (54), host `installlog.test`, e2e `autopull`,
  `artifacts`, `build`, `onboard`, `passive`, and the `journey-first-app` UI journey.

## 8. Cut order — work packages

One commit each (P4 is one commit across web and host, see below), each sized for one agent (≤ 60 turns), briefed with
`file:line` excerpts, `grep -n` then `sed -n` ranges ≤80 lines. Each verified in a clean worktree:
`scripts/verify-rev.sh <rev> <e2e filters>`. Builders write NEW files only; cutovers hold the shared files one at a time.
Review lands with the package, before main. Never build `packages/web/dist` from this tree; agents build to scratch.

| # | package | model | files | verified by |
|---|---|---|---|---|
| **P0** (landed `b47709c3`) | Pins (section 7): boundary test + ratchets, stale-hash, install-log fixture and max-size-ring pins, route-list data | Sonnet | `tools/`, `scripts/guards/guards.mjs`, `*.test.mjs` | `test:unit`, `test:host`, lint; `verify-rev.sh <rev>` |
| **P1** (landed `817a950c`) | **Host seams**: `autoOn`, probe (`null` on budget exhaustion), `auto-probe.json` cache, `loadBuiltinIds` cached boot, `resolveAuto` with `chosen` re-check, `PluginView.auto`, `api.repoApps()`; reword `apkcheck.ts:180`; the six default-mechanism pins | Opus | `shared/src/plugin/{manifest,api}.ts`, `host/src/plugins/{pluginregistry,pluginapi}.ts`, `main.ts`, `appready.ts`, `androidenv.ts` (probe wrapper), `apkcheck.ts`, host tests | `test:host`; `verify-rev.sh <rev> plugin api` |
| **P2a** (landed `6ff309f4`) | **Pure splits**: row half of `installPolicy.ts` → `shared/src/installrow.ts` (+ `InstallRow`, `InstallCaps`, `isPlayBuild`), `deviceInfo.ts` out of `installLog.ts`, `cfgs`+`putCfg` → top-level `pullRules.ts`; reword `installPolicy.ts:315` and `phoneSetup.ts:54`; old import paths re-export | Sonnet | `installPolicy.ts`, new `shared/src/installrow.ts`, `deviceInfo.ts`, `pullRules.ts`, `features/pull/{store,actions}.ts`, `PairForm.tsx`, `lanLink.ts`, `phoneSetup.ts`, tests | `build:shared`, `test:unit`, lint; `verify-rev.sh <rev> autopull artifacts` |
| **P2b** (landed `153b6441`) | **Web seams**: `hideWhen` (+ header badge, browser-PWA test), `appsDoor` + `useAppsDoor`, `sdk/install.ts`, `sdk/downloads.ts`, kit (`SetLine`, `hhmm`, `when`), `deviceId` export, the per-host `plugin.list` cache (`LS.pluginList`) with its offline test, `PluginsSettings` auto words | Opus | `sdk/{types,index,install,downloads}.ts`, `kit/index.ts`, `core/{featureRun,extensionPoints}.ts`, `features/plugins/{PluginsSettings,store}.tsx`, `storage/keysPrefs.ts` (key), tests. Needs P1 (`PluginView.auto`) and P2a | `test:unit`, lint (`extension-boundary`), `test:ui` smoke; `verify-rev.sh <rev> plugin` |
| **P3a** (landed `ec78ccfa`) | **Host+shared half (new files only)**: manifest, `ship.json`, README, `shared/wire.mts`, `host/{index,installlog,readiness}.mts` (chunked report, ping push, trim), tests, e2e. Registry sees it (`autoOn`) but nothing calls it; core still serves the old route, so the store opens `installs.json` **read-only** (one `WRITE` constant, flipped in P4) | Sonnet | `packages/extensions/android-apps/{waterplane-plugin.json,ship.json,README.md,shared,host,test,e2e}` | `test:unit`, extension tests; `verify-rev.sh <rev> android-apps`. Needs P1 |
| **P3b** (landed `4ffe117c`) | **Web half (new files only)**: copies of `AppsSheet/AppsHistory/appReady/appSteps/appsPane`, `appRows.ts`, `installLog.ts` (chunked report, pull on ping), `state.ts`, rewritten on section 3 (`../shared/wire.mts` imports, `ago`); `index.ts` with **only** `sheets` (the `features/registry.ts` glob would otherwise draw a second launcher line) | Sonnet | `packages/extensions/android-apps/web/` + moved tests | `test:unit`, lint, `extensionclasses`, `webshape`. Needs P2b, P3a |
| **P4** (landed `61e88d21`) | **The switch — one commit, web + the host ownership swap (serial, one agent, Opus)**. P4 flips `ship:true` (extension `ship.json` + `deploy/ship.json`) and the manifest description. Web: manifest gains `launcherItems`, `appsDoor`, `hideWhen`, `pushes`, `boot`; core launcher drops `appsReady`; `DownloadsSheet`/`PullSheet` (incl. `:395`)/`BuildButtonsSheet`/`whatsnew` use the door or their off-state; routing + `tools/logic.ts` drop `"apps"`; `main.tsx` drops `startInstallLog`; `keysPrefs.ts` drops `LS.installLog`; old web files deleted; **demo**: `md.plugins` default lists an enabled, active `android-apps` and its fixture registers independent of `?demoPlugins` (other demos stay as they were), `demohttp.ts:204` readiness stub, `demo/scenarios/scenarios.test.mjs:274`; `scripts/media/apk-install.mjs:626-631` selector (`button.more-act[title^="apps"]` leaves with the move; **load `docs-media` first**). Host, in the same commit: extension `WRITE = true`, and core's `onInstallReport` stops writing / the core `InstallLogStore` is never saved again (a one-line neutering, deleted by P5), so **the extension store becomes the sole writer exactly when the core store stops** — no window with unpersisted reports, none with two writers | Opus | `core/launcher/*`, `features/{pull,build,whatsnew,tools}/*`, `routing.ts`, `main.tsx`, `storage/keysPrefs.ts`, `demo/**`, deleted web files, `scripts/media/apk-install.mjs`, `host/src/routes/system.ts` (one handler), extension `host/installlog.mts` | `verify-rev.sh <rev> autopull artifacts build onboard passive`, `test:ui` journey-first-app, a 412×915 headless run against the pre-split commit (launcher badge shape, hazard 4). Needs P3b |
| **P5** (landed, this commit) | **Host dead-code removal (serial)**: remove the route, `onInstallGet/Report`, the hello push, `InstallLogStore` plumbing (`ctxseal`, `routes/types`, `shutdown`, `main.ts`), `install.*` from the wire union and demo handlers, `shared/src/installlog.ts`, `wire/install.ts` log types; update route/message lists (`apiroutes`, `passive` — keep one denied route —, `hostrestpins`, `shared/test/wiresurface.test.mjs`); **no retired table**. **Stale readers until then:** a pre-P4 OTA bundle still cached on a phone reads core's boot-time `install.log` snapshot (hello push + `install.get`, `system.ts`) and so draws a log that stops growing, while its `install.report`s are dropped by the neutered handler — self-healing on the next OTA; delete the push in the same release that updates the APK's embedded bundle. The demo's `/api/apps/readiness` + `install.get` answers go with it: the demo host lives inside each bundle, so removing them from the new bundle is consistent (old bundles keep their own copy) | Opus | `routes/{system,apihost,types,apitable}.ts`, `server/http.ts`, `main.ts`, `ctxseal.ts`, `shutdown.ts`, `shared/src/wire/messages/{clienthost,hosttools}.ts`, `shared/test/{installlog,wiresurface}.test.mjs`, `host/test/installlog.test.mjs`, test lists | `build:shared`, `test:host`; `verify-rev.sh <rev> api passive autopull`; then `npm run restart` and `/api/health` `ptys.masters` check |
| **P6** (landed `28b8259f`) | Docs and agent words: `reposkilltext.ts:253,262` ("when the Android apps extension is on"), `docs/requirements/apk.md` R-apk-014/015/020 and `downloads.md` 29, `notes/{web,host,plugins}.md` extension list, `features/pull/README.md`, the `web-files`/`host-machine` skill descriptions naming `installPolicy.ts + AppsSheet.tsx`, `CLAUDE.md` "Also:" list (stay under the 12.8k budget, `tools/claudemd.test.mjs`) | Sonnet | docs only (+ the one TS string) | `test:unit` (requirements, claudemd); `verify-rev.sh <rev>` |

**Order and green-ness.** P0 alone, first. Then P1 and P2a in parallel (disjoint: host plugins vs web/shared), then P2b
(needs P1's `PluginView.auto` and P2a's shared split). P3a needs P1; P3b needs P2b and P3a; P3a and P3b are disjoint
directories and run in parallel once their inputs land. P4 then P5, serial; no other package touches `routing.ts`,
`LauncherScreen.tsx`, `main.ts` or `routes/system.ts` while one is open. P6 can start with P3. Main is green after each
because: through P3b the extension is registered but reachable by nothing (its sheet has no door, its manifest no launcher
line) and read-only; P4 flips every user, writer and drawn line in one commit, so there is never a second launcher line,
a second writer, or an unpersisted report; P5 only deletes code nothing calls (old bundles' messages are dropped by
`routes/index.ts:35`).

**Hazards.** (1) The glob registers the extension the moment `web/index.ts` exists: P3b contributes no launcher line until P4.
(2) Effect/hook order: `startInstallLog` is attached from `main.tsx` because `App.tsx` returns early once per overlay; the
extension's `boot` replaces it and must be checked for the same property (an unmounted sheet must still hear the `changed`
ping). (3) `LauncherMenuBadge` count math: the vault's counted items already lift into the header row; the apps count joins
that machinery, so the badge total changes shape — compare in the 412×915 run. (4) The shared tree: stage by explicit path.

## 9. Decisions (owner, 2026-11-01) — no open questions

1. **Readiness facts stay core** (`apkRepoFacts`, `appready.ts`) behind the one read-only `api.repoApps()`.
2. **No "back to automatic".** The switch is final, like every extension.
3. **Reload on the Apps sheet lands on the launcher** (`persisted: false`, not an adopted core id).

Defaults applied (stated as decided; the owner can veto): a newer phone with an older desktop silently omits the Apps line;
auto-on never turns itself off during uptime (only the next boot re-evaluates, via the cache).
