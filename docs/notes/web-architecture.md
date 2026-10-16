# Web architecture: core, SDK, features

How `packages/web/src` is being cut up, why it is cut this way, and — the part most people are
here for — **how to add a feature without touching `App.tsx`**. The per-module reasoning for
everything that already exists is in [web.md](web.md); this note is about the shape.

## Why

`App.tsx` reached 17,000 lines. Not through neglect: each change added a few, each few were worth
writing, and no single one was the one that made it too big. The cost is not the size itself, it is
that **every feature lived in one file, so every change conflicted with every other** — several
sessions edit this tree at once, and two unrelated sheets meant two edits to the same function, the
same `switch (msg.t)` and the same `overlayViews` table.

The fix is folders a change can stay inside. A feature's state, its wire-message handling and its
sheets move into `features/<name>/`, and the folder reaches the rest of the app through a small,
typed contract rather than by being inside the component that holds everything.

## The three parts

```
packages/web/src/
  core/        App's side of the contract
    api.ts       bindCore() / core() — the CoreApi singleton, rebound by App every render
    dispatch.ts  dispatchFeatureMessage(), runFeatureCommand(), bootFeatures()
    featureRun.ts  the pure runner behind all four: per-feature isolation + saying a failure once
    sheets.ts    featureSheets() merged into overlayViews; runSheetLeave()
    settingsRows.ts  featureSettingsRows(group) — drawn at the end of each Settings group
    toolbarItems.ts  featureToolbarItem(id, ctx) — asked by renderToolbarItem's default arm
    <module>/    the things there must be ONE of, as hooks App calls (table below)
  sdk/         the ONE import a feature needs
    index.ts     re-exports everything below; anything not exported here is not the contract
    types.ts     CoreApi, FeatureManifest, SheetDef, CommandDef, SettingsRowsDef, ToolbarItemDef,
                 MessageHandlers, DurableOp, ConnInfo, QueueBacklogOpts, UploadApi/UploadBuf
    store.ts     createStore() / useStore() — one value, one emit, one writer
    hooks.ts     useCore(), useLatest(), useQueueEntries(), useRepoMap() + the pure mapWith/mapWithout
    cached.ts    cachedList() — a host list per repo, seeded from the device cache, with its age
    repoRun.ts   repoRunStore() — per-repo configs + capped runs + streamed output (build, capture)
  features/
    registry.ts  FEATURES: every feature's manifest, listed once
    <name>/      the prescribed layout below — index.ts, store.ts, actions.ts, logic.ts, …
```

The rest of `src/` — the ~250 flat modules — stays where it is. `ws.ts`, `routing.ts`,
`outbox.ts`, `storage.ts`, `download.ts` and `PromptComposer.tsx` are core in all but folder, and a
feature imports any top-level module it needs directly (`format.ts`, `Sheet.tsx`, `Empty.tsx`,
`Unavailable.tsx`, …) — except the five that ARE App's side of the contract (`ws`, `outbox`,
`routing`, `App`, `main`; see the deny-list below). Moving them would be churn in every open branch
for no boundary gained.

### The feature layout

Every `features/<x>/` has the same shape, so opening any feature is opening the same thing:

- `index.ts` — manifest + public API only, no logic
- `store.ts` — createStore stores only, and their read hooks/selectors
- `actions.ts` — functions that write stores / send frames
- `logic.ts` — pure, tested by `logic.test.mjs`
- `<Name>Sheet.tsx` — the sheet component
- other components `<Name>.tsx`
- `README.md`

Two refinements, each for a reason. **A store's read hooks live in `store.ts` beside it**
(`useUsage`, `useCliRollup`, `useBuildNames`, …): a reader is a view of the store's shape, so it
changes when the store does, in the same file; `actions.ts` is for WRITERS. **The manifest may hold
two kinds of one-liner** that are not "logic": a `messages` handler that is a bare
`store.set(msg.x)` (a wrapper in `actions.ts` would be a name for an assignment), and a SheetDef's
`render` GUARD — `render: () => repo ? createElement(XSheet, { repo }) : null`. That guard must be in
`render`, not in the component: `overlayViews` treats a null from `render` as "no sheet here" and
falls through to the screen beneath, while a component that returns null is still a mounted sheet
and draws a blank one.

**A feature's sheet takes a name of its own** (`BuildButtonsSheet`, `VerifiedCaptureSheet`,
`HealthBoardSheet`, `DecisionLogSheet`, …), never the flat top-level file it replaces or wraps:
`BuildSheet.tsx` and `features/build/BuildSheet.tsx` would be two modules of one name, one
search hit apart, and the wrong one gets edited.

Imports without extensions (`from "./store"`, `from "../../sdk"`; only a `*.test.mjs` names the
`.ts`, for node's type stripping). Toasts via `core().say.toast` — a feature has no `showToast` of
its own. Map updates via the sdk's `mapWith`/`mapWithout`, never a hand-copied `new Map(prev)`.
`tools/webshape.test.mjs` fails on any other file name in a feature folder (any `*.test.mjs` is
allowed), and on a subfolder.

### `CoreApi` — what a feature may ask of App

Defined in `sdk/types.ts`. Ten groups:

- `conn` — `status` (a getter onto the live connection), `send`, `liveSend`, `liveSendAll`,
  `liveAsk`, and `info: ConnInfo` (tailscale IP/binary, the https front door, LAN IPs, port, root,
  auth).
- `queue` — `queueOp`, `submitInput`, `queueBacklog`, `queueImageUpload`, `answerPrompt`;
  `mintAckId` (the queue's own minter, for an op sent LIVE that still needs an id — counted per
  file by `queue.test.mjs` like every other mint); `entries` and `blocked` as of this render,
  `goneLanes`, `laneLabel`, `repoIdOf`, `drop`, `flush`, `idleReason`, `serial` (the one-at-a-time
  switch, written through to the flusher's ref); the row `verbs` — send now, hold, serial, remove,
  edit, retarget, restore, retry failed, move, add to a queued create, and the schedule cut's
  `scheduleQueueRows`/`dropScheduleQueue`; and `uploads: UploadApi`, the image-upload buffer whose
  bytes ride the queue.
- `nav` — the `overlay` on top, `open`, `close`, `attach`, `openRepo`, `openSend`,
  `startSessionWithPrompt`, `openBacklogCut`, `openScheduleCut`, `openActivity` (optionally on a
  cut), `openPadAt`, `followFire` (jump to the session a fired row lands in), `sendSeeded`.
- `launch` — `setOpt`, `wire` (the `launchFor` gate), `openCwd` (returns the pending screen's
  session id, or null when the tap was deferred to a launch question) and `relaunch`.
  `focusShell(key, { cwd?, title?, back? })` goes to a plain shell tab for a sheet whose job is half
  at a desktop prompt: the tab `key` went to last while it runs (a pending open still queued is
  re-entered, and re-keyed when the host names it), else a running plain shell in `cwd` (default the
  host root; never a companion), else a fresh one through `openCwd` with the shell as an override.
  It returns that shell's id (`pending:<ack>` while the open is queued; null, toasted, with no shell)
  so a sheet that owes the shell a line seeds it with `compose.seedDraft(id, …)` — an append, and a
  pending id's draft moves with the screen when the host names it.
  `back: { label, open }` draws "back to <label>" on THAT shell's screen only
  (`core/session/ReturnChip.tsx`), so the sheet and its shell are one tap apart both ways; × hides it
  with a toast naming the way back. `shellCant()` is the sentence for `Unavailable` where the
  sheet's button would be. Pure half and its tests: `core/launch/shellTab.ts`; memory-only state:
  `shellReturn.ts`.
- `term` — `snapshot()` (the local scrollback) and `geom()` (the grid the PTY was last sized to).
- `compose` — the `draft`, `insert` (into the box on screen), `seedDraft(sid, text)` (into a
  session's draft, for use after a navigation, where `insert` would type into the box being left),
  `gridText()` (the live terminal as text), `pushHistory`, `removePadNotes` (the one pad delete),
  and the sheet-draft trio `loadSheetDraft`/`seedSheetDraft`/`appendSheetDraft` (`seed` rescues
  first).
- `world` — sessions, repos and `visibleRepos`, the active session and repo, backends, recent and
  closed sessions, intents, launches, budget, meter, usage, the default `launch` opts, the app
  update, `pending` (a queued create is on screen); `schedules` and `backlog`, which are FEATURE
  stores re-exported here only because one feature may not import another — a cross-feature read,
  not core state; and the readers `repoForCwd`, `cwdVisible`, `sessionRepo`, `sessionRowTitle`,
  `sessionCan`, `sessionCant`, plus `refreshRepos()`.
- `files` — `downloadArtifact`, `openArtifact`, `openFileFrom`, `viewImage`, `attachForInbox`,
  `annotate(repo, files, "send" | "pad")`, `annotateUrl`, `editBacklogImage`, `browseTo`,
  `openSweep`.
- `send` — `renderRetime` (the Send sheet's re-time mode, drawn by the list that asked),
  `seedFromSchedule`, `seedFromIntent` and `targetFor` — seeds for the one Send sheet, never a copy
  of it.
- `say` — `toast`, `track`, `confirm`.

A component that lists the queue reads `useQueueEntries()` from `sdk`: it IS the queue core's store
(`outboxStore`, written only by `writeOutbox`).

**The contract grows here and nowhere else.** When a feature needs something of App's that is not
a member yet, the member is added to `CoreApi` and to App's one `bindCore({...})` literal — never a
per-feature `bindFooHost()` beside it, which would be a second injection path with its own timing
to get wrong. `compose` exists for that reason: the clipboard sheets needed the draft, the grid and
an insert, and the notification feed needed `openBacklogCut`. `compose` reads and ADDS to the
draft; there is deliberately no setter, because typed words are the last copy.

**Every member IS the core hook's function of the same name** (or App's, for the few App still
holds), passed by reference in `bindCore({...})` — not a wrapper, not a re-implementation. That is how the never-rules in `CLAUDE.md` survive the
split without a new rule each: there is still one socket (`conn.send` is `ws.ts`'s), one send path
(`queue.queueOp` is `core/queue`'s `queueOp`, ackIds and all), one download path (`files.downloadArtifact`
goes through `download.ts`'s queue), and `say.confirm` is `Confirm.tsx`'s `askConfirm`, never
`window.confirm`. `local/no-silent-send`, `local/no-draft-clobber` and `local/no-storage-key-literal`
are scoped to `packages/web/src/**`, so they cover `features/` without a line of config.
`no-silent-send` has a feature half on top: the JSX half only sees a send written INSIDE an `on*`
attribute, and `onScan={() => scanRepo(dir)}` hid a bare `core().conn.send` one file away. In
`features/**` every bare `conn.send` needs a receipt in its own function (`say.toast`, `liveSend`,
`liveAsk`, `queueOp`, a `nav.open` of the answering sheet, or a `conn.status` read) unless it is
written inside a `messages` handler or `boot`; anything else takes an inline
`eslint-disable-next-line local/no-silent-send -- <reason>`.

`nav.close(self)` takes the sheet's own id: **a sheet may only close ITSELF** (`core/route`'s `closeSheet`),
because a close that lands after the sheet's own action opened the next sheet would otherwise
unmount the new one. `conn.status` is a getter onto the live connection, never a render-time copy.

`DurableOp` moved from `App.tsx` into `sdk/types.ts` with its whole comment — which ClientMessages
are durable, and why each one joined — because a feature that queues a build needs the type, and the
reasoning goes where the type is.

### Why a singleton and not a React context

`core()` is a module function, like `showToast` and `track`, and for their reasons:

- App's socket handler is an effect with `[]` deps. It never re-subscribes, so a context value
  captured there would be the first render's for ever — which is why it reads the core hooks
  through one `useLatest`, and why `core()` read at call time is this render's.
- A feature's message handler, its store actions and its toolbar command are plain functions, not
  components. There is no hook to read a context through.

App calls `bindCore` on every render, before the `authGate` early return, so `world.sessions` is
this render's list and `nav.overlay` this render's sheet — the same timing `overlayRef.current =
overlay` already had. `core()` throws if nothing is bound, which only a feature running outside
App's lifecycle can hit; the sheets, handlers and boots are all driven BY App.

### `FeatureManifest` and the registry

A feature declares what it adds; it does not patch App:

- `sheets` — `SheetDef { id, persisted, render(core), onLeave? }`. The `id` is an existing member of
  `Overlay` in `routing.ts` (Back, the hash and a reload all key on it). `featureSheets()` turns them
  into entries of `overlayViews`' own shape and App spreads them in FIRST, so while App still draws
  a sheet itself App's entry wins — moving a sheet is deleting it in App. `onLeave` runs once when
  the sheet stops being the one on top (`runSheetLeave`, an effect on `[overlay]`): the place for
  "clear the scope when this closes", which App wrote as one effect per sheet.
- `messages` — handlers by wire `t`. `dispatchFeatureMessage` runs them AFTER App's own
  `switch (msg.t)`, in registry order, each in its own try/catch: one feature's bug does not stop
  the next hearing the frame. Moving a message into a feature is deleting its `case` in App (and
  `webshape` fails while both exist, `welcome` excepted).
  **A failure is SAID, not only logged** (`core/featureRun.ts`): the first throw per (feature,
  frame type) — or per `boot` — is a toast, "`<id>` stopped handling `<t>`", and a
  `feature-fail:<id>` count in the usage log; later throws for the same key only log, or a handler
  that throws on every `session.list` would toast for ever. A console line is not a report on a
  phone. One layer down, `ws.ts` guards only the DECODE: a throw inside a listener used to be
  swallowed as a "malformed frame", which hid App's own bugs and starved every listener after it;
  now each listener is isolated and logged loudly, so App's switch throwing cannot silence the
  feature dispatch listener registered after it.
  A chatty push (`build.output`, `capture.output`) keeps its guard on `core().nav.overlay` — a
  20-minute run is ~800 frames, and re-rendering for one nobody is looking at is the bug.
- `commands` — `CommandDef { id, run(core) }`, run by the toolbar switch's `default:` arm
  (`runFeatureCommand`). The toolbar item itself stays declared in `toolbar.ts`, which owns order
  and pinning.
- `settings` — `SettingsRowsDef { group, order, render(core), rows? }`: rows in one Settings
  group (`group` is a `SettingsGroupId` from `settingsIndex.ts`), `order` first, then registry
  order (`featureSettingsRows(group, band?)`) — `order < 0` at the HEAD of the group, before the
  core's rows, `order >= 0` at its END, and in Tools `-10 <= order < 0` opens the door rack, so a
  row moved out of App keeps the place it had. Every row id drawn must be in `settingsIndex.ts` —
  `settingsIndex.test.mjs` reads the core sheet plus every `features/*/<Name>Settings.tsx`, so the
  rows live in a file of that name. `render` is called during the settings sheet's render, after
  App's early return: it returns an element, and any hook goes inside that element's component.
  An extension catalogues the ids it draws in `rows` (kit `SetCustom`); words known only at run
  time go through `setRowWords` (the plugins row's installed plugins). A section nested in a row
  hides by `useNestedShown` (`nestedMatches`): under a query only the sections whose own words
  match stay, unless the row's catalogued words matched.
- `toolbarItems` — `ToolbarItemDef { id, render(core, { label, dismiss, active }) }`: a stateful
  toolbar item the feature draws itself (`plugins`' per-session group, the limit toggle). `renderToolbarItem`'s
  `default:` arm asks `featureToolbarItem` first: `undefined` means no feature declares the id and
  the generic button runs; `null` is the feature's "not now". The id, label and icon stay in
  `toolbar.ts`. A throw in either `render` hides that feature's piece only and is said once, a
  microtask later (never a state write during a render).
- `menuItems` — `MenuItemDef { id, label, icon, order?, available?, open(core, { active }) }`: a ☰
  line an EXTENSION owns outright, label and icon included, because a private extension may not
  put its name into `toolbar.ts`. It joins the catalog (`toolbarItems()` = core + contributed,
  bound by `extensionPoints.ts` via `bindMenuCatalog` — the registry's features import `toolbar.ts`,
  so it cannot import the registry) under the id `<manifest id>:<id>`: a colon no core id has, so
  the two never collide, and `loadToolbarCfg` keeps such ids even before the binding is made. The
  customize sheet orders and hides it and can pin it into the header like any core line.
- `boot` — once on App's mount (`bootFeatures`), may return a cleanup.

`features/registry.ts` is a static list. **Nothing is lazily loaded**: sheets are opened from a
phone on a link that may be gone, so they must already be in the bundle. `vite.config.ts` packs
`features/**` into the `sheets` chunk, for the update-boundary reason in its `manualChunks`
comment. Order in `FEATURES` is the order handlers and boots run in.

### State: stores with one writer

Host-fed data a feature owns leaves App's `useState` and lives in a `createStore` inside the
feature. **A store has ONE writer** — the feature's own message handler or an action its `index.ts`
exports — never a component. The sheet reads it with `useStore`; when the core's launcher or session header
needs a feature's number (an unread badge, a health chip) it imports a hook from the feature's
index (`useUnread()`), never the store. `set` with an equal value emits nothing, so a handler that
returns `prev` re-renders nothing — the same rule App's chatty pushes follow.

Two helpers exist because App already had the same code twice:

- `cachedList` — `buildCfgs`/`buildCfgsAt` and `captureTargets`/`captureTargetsAt` were each two
  `Map`s, a snapshot seed and a save-then-stamp. **An empty list is a claim** (`localState.ts`), so
  the reading survives the link and says how old it is. The load/save pair stays in
  `localState.ts`, which owns the keys.
- `repoRunStore` — build and capture are the same feature typed twice: that cached list, a list of
  runs upserted by id and capped at 60, and an output buffer per run kept to its 300k TAIL, pruned
  when its run falls off the list, re-rendering only while the sheet reading it is on top.

## The boundary, enforced

**Extensions have their own rule, `local/extension-boundary`** (same file, tested in
`tools/extensionboundary.test.mjs`): `packages/extensions/<id>/web/**` imports only `@waterplane/sdk`,
`@waterplane/kit`, `@waterplane/shared`, `react`, `react-dom`, `lucide-react` and paths inside its own
extension folder; and core (`packages/web/src`) imports an extension only as
`features/registry.ts` → `<id>/web/index.ts`. Its host half and the other direction are in
[plugins.md](plugins.md#in-repo-extensions).

**One exception to "extension sheets are `feature:<id>/<name>`": adopted core sheets.** The
token-stats extension declares the core id `"tokens"` with `persisted: true` (four core doors, the
`#o=tokens` deep link, the usage counters `overlay:tokens`). `tools/webshape.test.mjs` holds it as
`ADOPTED_CORE_SHEETS = { "token-stats": ["tokens"] }`: an extension may declare exactly those literal
core ids, and `persisted` must equal membership in `PERSISTED_OVERLAYS`; every other extension sheet
stays `feature:<id>/<name>` and never persisted. `core/sheets.ts` wraps `ExtBoundary` only for
`^feature:` ids, so an adopted sheet renders unwrapped (a follow-up).

**`kit/chart/`** (`@waterplane/kit`) holds what charts share with the core screens: `statsPlot.ts`,
`TokenComposition.tsx` (`KindBar`, `CacheVerdict`, `SLOT`) and `useBoxWidth.ts`. Core importers use
the direct path (`./kit/chart/TokenComposition`), never the barrel, so the kit does not become a
cycle through `Sheet`.

`local/feature-boundary` (`tools/eslint/rules.js`, tested in `tools/featureboundary.test.mjs`)
decides on the import PATH alone:

| file in | may import | may not |
| --- | --- | --- |
| `features/<a>/` | its own folder; `sdk` (the index only); top-level `src/*` modules except the deny-list; `import type` from anything top-level; packages | `features/<b>/`, `core/`, the registry, `sdk/<file>`; a VALUE import of the deny-list |
| `sdk/` | `core/api`; `core/pluginCalls.ts` and `core/prefs.ts` (the two core modules the sdk re-exposes); top-level modules | any feature; the registry |
| `core/**` | `sdk`, each other; top-level modules; a feature's INDEX (a core screen reads a feature's hook) | a feature's inner files; the registry — except `core/dispatch.ts`, `sheets.ts`, `settingsRows.ts`, `toolbarItems.ts`, `extensionPoints.ts`, the runners that call IN |
| `App.tsx` | a feature's index (`./features/<x>`) | a feature's inner files; the registry |
| any other `src/` module | — | any feature (even its index); the registry |

The deny-list — top-level modules a feature takes no VALUE import of, because each is App's side of
the contract and reached through `core()`:

| module | why | instead |
| --- | --- | --- |
| `ws` | the one socket | `core().conn` |
| `outbox` | the send queue, ackIds and all | `core().queue` |
| `routing` | the route stack, Back, the hash | `core().nav` |
| `App` | the component holding everything | `core()` |
| `main` | the entry point, never a library | — |

`import type` (per declaration, or every specifier `type`) is allowed: it is erased at build, and
re-declaring `Overlay` inside a feature would be the drift. A side-effect `import "../../ws"` is a
value import. **Only `App.tsx`, `core/**` and the registry import a feature**, by its index: a
`Backlog.tsx` that imported `features/build` would make build's change Backlog's change too; it
asks App (a prop) or reaches the feature through its sheet id. `core/**` is on the list because a
core SCREEN (the launcher, the session header) shows a dozen features' numbers, and re-plumbing
each feature's hook through App as a prop would add ~30 names and no boundary.

The registry is readable only from `core/` because it is how the core calls IN; App reads it
through `featureSheets()` and friends, and a feature is listed by it and never reads it. Packages
are not restricted — the boundary is about coupling inside this repo.

**Cross-feature needs** go to `sdk/` (if every feature could use it) or a top-level module (if it
is a fact of the app, like `format.ts`). A feature never imports another; if two features need the
same state, one of them is not a feature yet.

`tools/webshape.test.mjs` (in `npm run test:unit`) holds the rest:

- **the ratchet**: `App.tsx` may not exceed `MAX_APP_LINES`. Moving code out lowers the number in
  the same commit; raising it is a decision about the file every change conflicts in, never a way
  to make the check pass;
- every `features/<d>/` has an `index.ts` exporting `manifest` with `id: "<d>"`, and a
  `README.md` of 300+ characters;
- the registry imports each feature exactly once and nothing else;
- every `SheetDef`, written literally as `{ id: "<overlay>", persisted: …`, names an `Overlay`
  member, and its `persisted` agrees with `PERSISTED_OVERLAYS`;
- no file under `features/` is over 900 lines, and none under `core/` (`MAX_CORE_FILE_LINES`);
- every `core/<dir>/` is one of the core modules below (`CORE_DIRS`) — a stray `core/misc/` fails;
- **a move is a move**: `App.tsx` has no `case "<t>":` for any `t` a feature's `messages` declares
  (except `welcome`, which App keeps for its own reconnect work), and `overlayViews` has no entry for
  a feature's sheet id — App's entry would win over the spread and the feature's sheet would never
  render;
- `bindCore(` appears in `App()` before `if (authGate) return`, and no `use[A-Z]…(` hook call
  appears after that early return (a hook on only some renders);
- every element of a feature's `sheets: [...]` is an object literal with a literal `id` and
  `persisted` — a SheetDef built by a helper or mapped from a list would skip the Overlay check
  above without failing it;
- every file in a feature folder has one of the layout's names.

Two flat scans became recursive so a feature folder is not a blind spot: `strips.test.mjs` (classes
riding on `outbox-recover`) and `scripts/e2e-hints.mjs` (every `data-hint` names a real hint). The
unit-test glob is `packages/web/src/**/*.test.mjs`, so a feature's tests run where they live.

**The README-per-feature rule** exists because a folder is the unit a contributor opens first. It
says what the feature is for, what it owns (stores, sheets, message types), what it reads from
`core()`, and which rules from the skills or these notes apply to it.

`.github/CODEOWNERS` gets one line per feature folder, and the PR template asks whether the change
stayed inside one — a change that needed `core/`, `sdk/` or `App.tsx` says which and why.

## Extension points (in-repo extensions)

`packages/extensions/<id>/web/index.ts` exports a `FeatureManifest` named for the folder and is listed
by `features/registry.ts`'s EXTENSIONS glob, eager and in id order (`webshape.test.mjs` pins it). Beyond the feature
points it has four more, each read through ONE core module and each contained + said once on a throw:

- **`repoActions`** — lines in a repo's "⋯" menu (`core/launcher/RepoGroup.tsx`, main worktree only).
  `label` returns null for "not offered here"; never a grey control.
- **`repoChips`** — count chips on the group row; `useCount` is a hook called only inside
  `core/launcher/ExtRepoChip.tsx`. A count is a filter: `open(repo, filter)` opens exactly those rows.
- **`setupRows`** — the words (`fixVerb`, `agentVerb`, `guidance`) for a row the host half contributes
  (`setupRemedy.ts`'s `setupRowLookup`; a def naming a core guidance key or fix id is refused).
- **`pushes`** — `plugin.push` handlers by event, for the manifest whose id is `msg.plugin` only.

`core/extensionPoints.ts` is the one registry reader for the first three (lazy: `features/setup` →
`SetupSheet` → it → the registry is otherwise a cycle), so `REGISTRY_READERS` in `tools/eslint/rules.js`
is `core/dispatch`, `sheets`, `settingsRows`, `toolbarItems`, `extensionPoints`. `core/ExtBoundary.tsx`
wraps every extension sheet, menu line and chip. **Open sheet ids:** `Overlay` accepts
`feature:<manifest id>/<sheet>` (`routing.ts`'s `featureSheetId`, `FeatureSheetId`); never in
`PERSISTED_OVERLAYS`, so a reload does not restore one. **Calls:** `pluginClient<M>(id)` →
`core/pluginCall.ts` (the retry rule is in [plugins.md](plugins.md)). **Remembered choices:**
`extStorage(id)` (`sdk/extStorage.ts`) → `read(name, fallback)` / `write` / `remove` over
`storage.ts`'s `extKey` (`<prefix>ext.<id>.<name>`), a HOST key prefix (`HOST_KEY_PREFIXES`), so a choice
is per desktop and parks with it on a switch; an extension may not import `storage.ts` nor write a key
literal, so this is its one way to remember anything. **Words a person types** for somewhere that is
not a session (the live desktop's typing) go in the kit's `PromptComposer` — the one prompt box, lent;
it never sends, its caller does.

## The core modules

`core/` holds what there must be ONE of. Each is a hook App calls once, returning named members so
App's call sites keep their names; `bindCore` then binds `CoreApi` to those returns.

| `core/<dir>/` | what there is one of | pinned by |
| --- | --- | --- |
| `conn/` | the socket and the welcome facts (`ConnInfo`) | `local/no-second-socket` |
| `route/` | the route stack, Back, the overlay on top | — |
| `term/` | the PTY feed, the terminal and the reader; `focus(id)` (navigate to a session) and `onWelcome`/`onSessionUpdated`, so the reconnect refs stay inside the hook | `tail.test.mjs` (the feed's pure half) |
| `queue/` | the send queue: ackIds, lanes, pending sessions, the upload buffer, the usage budget and the handed-over launches (`q.budget`/`q.launches`), the queue bars; `wire.ts` is the socket's receipts for it as methods (`onOpAck`, `onDeliverySettled`, …) so each case in App's switch is one line, and `migrate.ts` the two one-shot migrations run on mount (`migratePadRescue` puts the retired pad rescue store back on the pad, the retired give-ups ledger comes back as failed rows; neither deletes its source) | `queue.test.mjs` (every `newAckId`/`mintAckId(` site and caller-supplied `queueOp` ackId, per file), `logic.test.mjs` |
| `launch/` | `createOp`, the launch opts and their gates (`askLaunchFirst`, `hostedGate`, both internal), the launch sheets and the model sheet | `createOp.test.mjs` (which reads core and every feature) |
| `compose/` | the compose bar and its draft (`useComposeDraft` above the queue, `useCompose` below the send core), the next-prompt strip | `compose.test.mjs` (every `setCompose("")` in the tree, each after its accept), `local/no-draft-clobber` |
| `send/` | `dispatchIntent` (the one map from a send decision onto the queue's paths), the Send sheet's entry, its seeds and the per-repo send memory | `bulkverbs.test.mjs` (the re-time sheet's `intent.waive`) |
| `sessions/` | session verbs (close, star, the host's close check, stars held for a dead link) and the chips both screens draw (`tags.tsx`) | — |
| `launcher/` | the launcher screen; its own state is module stores (it unmounts under every sheet, and a filter must survive the round trip) | `model.test.mjs` (order, cuts, roll-ups, bulk-close counts); `createOp.test.mjs` (reopen sites) |
| `session/` | the session screen (`SessionScreen`, `SessionHeader`, `TermArea`, `ToolbarMenu`) and `useSessionChrome` — typing room and its peek, full screen, the dismissed reply: chrome state that must outlive the screen unmounting under every sheet, so a hook App calls once | — |
| `settings/` | the settings sheet (the aggregator, like `overlayViews`) | `settingsIndex.test.mjs` (ids both ways, and a feature row's group) |

Single files at `core/`'s top are the feature runners (`api`, `dispatch`, `sheets`,
`settingsRows`, `toolbarItems`, `featureRun`); `prefs.ts`, this device's preferences as one store
(`usePref`/`setPref`/`prefRef`; a synced key's pref lists it in `keys` so another device's edit is
adopted — `prefs.test.mjs` reads the table back) over `prefStore.ts`, the machinery (a default is
never written back, the ref moves with the write); and `Banners.tsx`, the plain-HTTP banner and the
claude update bar both screens draw, their dismissals held outside either screen.

## Adding a feature, step by step

1. **Pick the name** — camelCase, the folder name and the manifest `id`, never renamed after (ids
   leak into logs and tests). Check the overlay id your sheet will use is already in `Overlay`
   (`routing.ts`); if it is new, add it there, and to `PERSISTED_OVERLAYS` only if a reload should
   land back on it.
2. **Make the folder** `packages/web/src/features/<name>/` with:
   - `store.ts` — `createStore(...)` for what the host tells you, and the `useFoo()` hooks that
     read it; nothing else.
   - `actions.ts` — the functions that write those stores and send frames (`openFoo`, `saveFoo`).
   - `logic.ts` + `logic.test.mjs` — anything pure (wording, ranking, merging).
   - `<Name>Sheet.tsx` — the sheet, built on `Sheet`/`SheetHead`, `Empty`, `Unavailable`; reads
     with `useStore`, acts through `useCore()` (`core.conn.liveSend`, `core.queue.queueOp`,
     `core.nav.close("<id>")`). Icons from `lucide-react`, never emoji; no greyed buttons.
   - `index.ts` — `export const manifest: FeatureManifest = { id: "<name>", sheets: [{ id:
     "<overlay>", persisted: false, render: () => createElement(FooSheet) }], messages: {
     "<name>.list": (msg) => store.set(msg.items) } }`, plus whatever App must call
     (`openFoo(repo)`) or read (`useFooCount()`). It is `.ts`, not `.tsx`: the JSX lives in the
     sheet file, and `render` is one `createElement` from `react`.
   - `README.md` — 300+ chars: what, owns, reads, rules.
   - tests are `*.test.mjs` (node type stripping; a test imports siblings with their `.ts`
     extension, as `sdk/sdk.test.mjs` does — source files import without one).
3. **Register it**: in `features/registry.ts`, `import { manifest as <name> } from "./<name>";`
   and add `<name>` to `FEATURES`.
4. **CODEOWNERS**: one line, `/packages/web/src/features/<name>/ @owner`.
5. **If it moves code out of `App.tsx`**: delete the moved state, the `case`s in the socket switch,
   the `overlayViews` entry and any effect `onLeave` replaces; point the remaining call sites at
   the feature's index exports; then lower `MAX_APP_LINES` in `tools/webshape.test.mjs` to the new
   count.
6. **Gate**: `npm run build:shared && npm run build && npm run lint && npm run test:unit`.

A toolbar command is the same shape: add the item to `toolbar.ts` (label, icon) and a
`commands: [{ id, run }]` entry in the manifest; App's `runToolbar` falls through to it. An item
that draws its own state (a count, a toggle) adds a `toolbarItems: [{ id, render }]` entry too. An
in-repo extension's line is `menuItems` instead — nothing in `toolbar.ts`. A
settings row is `settings: [{ group, order, render }]`, its component in `<Name>Settings.tsx`, its
id in `settingsIndex.ts`.

## What stays in App on purpose

What stays in App is the WIRING: one call per core hook, every one above `bindCore` and the
`authGate` early return (a hook's deps are the hooks called before it: the queue takes `conn`, the
launch core the queue, the send core both, `useCompose` all three); the `bindCore({...})` literal,
which is the whole of `CoreApi`; and the two screen elements. The ws switch (cases that are
one-liners into those hooks' methods, read through one `useLatest` so the `[]`-deps handler never
holds a first render's hook) is `core/conn/useHostFrames.ts`, and the overlay table (App's few
entries, the core modules' `sheets` and `featureSheets()`) is `core/route/overlayViews.tsx` — both
called from App at the place they used to be written ([app-architecture.md](app-architecture.md)).
None of it is a feature, and features reach all of it through `CoreApi`. The send-queue core is
`core/queue/` (pinned by `queue.test.mjs`), `createOp` is `core/launch/` (pinned by
`createOp.test.mjs`, which reads App, `core/launch`, `core/launcher`, `core/session`, `core/send`,
`core/queue` and every feature as one source), the route stack is `core/route/`.
