# waterplane plugins — extending waterplane from outside the repo

**Contract:** `packages/shared/src/plugin.ts` (types, manifest validator, value cleaning). This note is
the reasoning; the contract is the rule.

Two things that sound alike and are kept apart on purpose:

- **A waterplane plugin EXTENDS waterplane** — a person's own code, kept outside this repo, that adds behaviour
  to the daemon and declares what the phone should show for it. The Gemini decision oracle is the
  first one; it used to be core code and is now a plugin repo outside this one.
- **Making a repo waterplane-aware** is the core telling a driven repo's agent what waterplane offers it (the
  `waterplane` skill, `reposkill.ts`, handed to every spawned `claude` via `--plugin-dir`). No plugin adds
  to that, and a plugin never instructs a repo's agent.

## Where plugins come from

- Every directory under `<config dir>/plugins/` (default `~/.config/waterplane/plugins/`), and every path
  listed in `<config dir>/plugin-paths.json` (`{ "paths": ["~/code/<plugin-repo>"] }`) — the second so
  a plugin can live in its own git repo without a symlink. **That file was `plugins.json` until API
  1.0.0**, the same name as the state dir's `{enabled}` switch file below, and two files nobody could
  tell apart by name is how one gets edited for the other. The loader renames an old one once on boot
  (`migratePluginPaths`: renamed, never deleted; a failed rename reads it in place; both present ⇒
  the new one is read and the old one is NAMED as ignored; an `{enabled}`-only file is left alone, for
  a setup where the two dirs are one).
- A plugin directory holds `waterplane-plugin.json` (`PluginManifest`) and `host.mjs` (or the manifest's
  `host`). The manifest is validated by `manifestProblems`; a plugin with problems, a duplicate id,
  an incompatible `apiVersion` (below), or an `activate()` that throws is **listed with `state: "error"` and the
  reason verbatim** — never skipped in silence, never taking the daemon down.
- **Loaded once at boot** (`import()` of the file URL). A changed plugin needs `npm run restart`,
  which the plugin's section says. Hot reload is not worth an ESM cache-busting scheme in v1.

## Publishing one: the `waterplane-plugin` topic

**A plugin author tags their plugin's GitHub repo with the `waterplane-plugin` topic.** The
template's README (`examples/plugin-template/`), [docs/plugins.md](../plugins.md), the generated
reference's intro and `CONTRIBUTING.md` all ask for it, and the README links the topic search.
Why: plugins exist so nobody has to fork to customise, which means the fork count — the number
GitHub shows for "people building on this" — undercounts exactly the people the plugin API serves.
A topic is the one signal GitHub keeps for free that a repo outside this one can add to, and its
search page doubles as the place people find plugins. The curated list in `docs/plugins.md` is
what this project vouches for; the topic is everything that exists.

## The API is versioned: semver, one rule

`PLUGIN_API_VERSION` is `MAJOR.MINOR.PATCH` (`1.3.0` now). A manifest's `apiVersion` (`"1.2"`, or a
bare `1`, which is what every manifest before semver says and means `1.0`) loads when its **major
equals the host's and its minor is no newer**; the patch is never compared. Anything else is
refused before any of its code runs, as a sentence naming both versions and which side is behind
(`pluginApiProblem`, from `manifestProblems`), and the plugin is listed broken. What bumps which
number is in the JSDoc on `PLUGIN_API_VERSION` — removing, renaming or narrowing anything is MAJOR,
adding anything is MINOR — and the public reference, [docs/plugins-api.md](../plugins-api.md), is
GENERATED from `plugin.ts` (`npm run docs:plugins`; `tools/plugindocs.test.mjs` fails when stale), so
the contract and its documentation are one file. Pinned by `packages/shared/test/pluginapi.test.mjs`.

## The fork contract

A fork customises waterplane **from outside the core**, so it can keep pulling upstream:

- **Plugins** (this note) for behaviour, and **config overlays** in the config dir for wording and
  data: `prompts/<name>.md` (the unattended prompts, `prompts.ts`), `models.json` (the model
  catalogue), `theme.json` (colour tokens, the terminal palette, the display name, the icons —
  `themeoverlay.ts`, [host.md](host.md#themeoverlayts--a-forks-look-and-name-config-dirthemejson)). The
  doctor's `overlays` row lists which are active and warns on a refused entry. **Never edit core** to customise; a change the plugin API cannot express
  is a request for an API minor bump, not a patch to carry.
- **The web side: a fork's plugin has no UI code on the phone.** Plugin UI runs on the phone ONLY as
  an in-repo extension (`packages/extensions/<id>/web/`) compiled INTO the bundle — found eagerly by
  `features/registry.ts`, never loaded lazily, never fetched from the host, never reaching past the SDK
  (`local/extension-boundary`). An external plugin DECLARES its UI (settings fields, actions, a badge,
  a status line, decision-log rows) and the app draws it with its own components. Why, and what that
  rule buys: [Trust](#trust). A fork that needs a sheet of its own carries an in-repo extension
  folder — a folder add, not a core edit.
- **A new feature talks over the generic `plugin.call` / `plugin.push` messages**
  (`api.handle`, `api.push`), never a new member of the wire unions — the wire stays closed, and
  `PROTOCOL_VERSION` is not a fork's to bump.
- **HTTP**: `api.route()` is coming with the host `api.ts` split; until then a plugin has
  `hookSink()`/`onHook` (loopback only) and no routes of its own.
- Build against [docs/plugins-api.md](../plugins-api.md) and declare the `apiVersion` you used.

## Trust

A host module runs **in the daemon's process with the daemon's rights**. The daemon already spawns
`claude` (arbitrary code) for anyone on the tailnet, so a plugin the machine's owner put in their own
config dir crosses no boundary the daemon has not. What the API buys is not a sandbox, it is that
**the core's rules cannot be skipped by accident**: a plugin that answers a box goes through
`answergate.ts`; a file it reads goes through the containment guard; a model call it makes is metered.

**The phone runs plugin UI only as bundle code: never loaded lazily, never outside the SDK.** This
replaces the older "the phone never runs plugin code". Its stated reason, that the APK's verified
bundle is the only JS the phone executes, was weaker than it sounded: the OTA bundle is checked by
sha256 from the same host's own manifest (protection against truncation, not a hostile host), and the
host is trusted by construction (it spawns `claude`). Serving a plugin's UI through that bundle
crosses no boundary that installing the plugin did not already cross. What the rule really bought,
and what holds it now:

| concern | answer |
|---|---|
| offline: a sheet must exist with the tunnel down | a plugin's web half ships INSIDE the webbundle / OTA update and is staged with it; never fetched when a sheet opens |
| crash isolation: a bad plugin must not take the app down | one error boundary per contributed sheet, row, chip and action; a throw shows `Unavailable` with the reason, like a host plugin in `state: "error"` |
| version skew between plugin UI and app | `sdkVersion` in the manifest, checked at load like `apiVersion`; React, lucide and the kit are the app's, never bundled by the plugin |
| access to the phone's origin (localStorage, auth token, the socket) | the same trust as the host half, which can do worse; in-repo it is lint-enforced by `local/extension-boundary`, for an external one it is what installing means |
| the invariants (one socket, the queue, no draft clobber, the answer gate) | the ONLY route to each goes through the SDK: send = the queue, answer = the gate, wire = `plugin.call` on the one socket. Reaching past the SDK is what the lint catches |

Still true: a plugin that wants no UI code DECLARES its UI (settings fields, action buttons,
per-session toggles, a badge, a status line, decision-log rows, a suggested answer) and the app
draws it with its own components; the wire stays a closed union (`plugin.*`, `decisions.*`), so no
plugin needs a protocol change. There is therefore no declarative list-view language: code on the
shared kit replaces it. Today only in-repo extensions have a web half (see "In-repo extensions");
an external one would ship a prebuilt chunk that the host adds to the webbundle, built when an
external plugin needs UI. The contract as requirements: `docs/requirements/plugins.md`.

## The seams (what `HostPluginApi` wraps)

| plugin sees | core source |
|---|---|
| `on("prompt")` | the `sessions.on("prompt")` choice-box event (`server/sessionEvents.ts`), with `blocked` precomputed by the gate |
| `on("question")` | the turn-end question the core already detects (`question.ts`, `SessionInfo.asking`), fired on idle only when there is one. `forced` is never set by the core today: a plugin that wants a "draft a reply now" button declares a `session` action and drafts from `api.scrollback` in its own handler |
| `on("action")` | a tap on a declared action (`plugin.action`), answered with `plugin.actionResult` |
| `suggest()` | `SessionInfo.suggestion` (`AnswerSuggestion`), drawn by `PromptAnswer.tsx` / `ReplyBar.tsx` |
| `answer()` | **`answergate.ts`** (`gateAnswer`), then the same host path a phone's tap on an option takes (`"<n>\r"` into `sessions.input`, or `choosePromptBox` for an unnumbered box) |
| `ruleAllows()` / `rules()` / `forgetRules()` | **`answergate.ts`**'s standing rules: made only by a person's tap on a `remember` option (`answerBox` `byPerson`), see "Standing rules" below |
| `setBadge()` | `SessionInfo.pluginBadges[id]` |
| `decision()` | the decision log (`decisionlog.ts`, `<state dir>/decision-log.json`) |
| `meter()` | `meter.ts`, `service` as given, `kind: "plugin:<id>"` |
| `notify()` | the notification feed, kind `plugin` |
| `settings()`/`seedSettings()` | `<state dir>/plugins/<id>/settings.json`, cleaned by `cleanPluginValue` |
| `env()` | `process.env`, **only names the manifest declared**, read live |
| `repo(repoId)` | `repos.ts`'s `findTarget`, then every path through `contained` + `inRoot` (a symlink out reads as absent) and never an `isSecretFile` name — `readFile`, `listDir` (secrets left out), `git()` (branch, HEAD, changed count; null outside a repo) |
| `setupCheck()`/`setupFix()` | the setup checklist: `compliance.ts` asks `plugins/setupcontrib.ts`, which asks the registry, for the contributed rows (at the place the requirements row always sat, before the APK row) and fixes. A fix id the core owns (`CORE_FIX_IDS`) or another plugin took is refused by THROWING in `activate()`, so the plugin is listed broken with the reason |
| `handle()` | the registry's `call(pluginId, method, args)` — the one entry the generic `plugin.call` wire message routes to, through `callOnce` and its ledger (`plugins/pluginrpc.ts`). Answers `{ok, result}` or `{ok:false, error}` in words; a result past 512 KB or not JSON is refused |
| `push(event, data)` | broadcast as `plugin.push {plugin, event, data}` to every phone (the web half's `pushes`). Returns null when sent, else the refusal in words: bad event name (`PLUGIN_EVENT_RE`), not JSON, over 64 KB, plugin not running |
| `handToAgent()` | `agentintents.ts`'s `handToAgentVia` → `addClientBacklogItem`, the SAME add the phone's `backlog.add` and an agent's `POST /api/agent/backlog` take: contained, persisted, `origin: "plugin:<id>"`, waiting for a tap (`manual`) unless `fire`, then fired by the intent ladder. A `key` makes it at-most-once in the store (`plugin-<id>-<key>`, 64 chars in all). The first argument is a repo id, or an absolute worktree path (starts with `/`, matched by realpath — ids stay `sha1(worktreePath)[:10]`, which a plugin must not re-derive). Never `deliver.ts`, never a session's PTY |
| `backend(def)` | `backends/registry.ts`'s `registerBackend`, through `pluginapi.ts`'s `pluginDescriptor` (see **Backends** below). Refused by THROWING a sentence; unregistered on switch-off |
| `screenReader(name, r)` / `storeReader(name, r)` (1.1) | `backends/readers.ts`'s `registerScreenReader` / `registerStoreReader` (see **Contributed readers** below). A malformed or taken name THROWS; unregistered on switch-off, after the plugin's backends |
| `thermalReader(name, r)` (1.3) | `sysstat.ts`'s `registerThermalReader`: asked on the readout's slow cadence BEFORE core's own sysfs reader, first reading wins. Every figure passes `cleanThermal` — a temperature outside 1..149 °C, a non-finite or negative figure is DROPPED, never shown — and a throw or an answer past `PLUGIN_THERMAL_TIMEOUT_MS` is no reading. Its `{ note, fix }` shows only when nothing reads. Added so macOS's SMC helpers (which third-party tool, built how) live outside this repo; core names none of them. Unregistered on switch-off |
| `hookSink()` / `onHook()` | the loopback route `POST /api/plugin/<id>/hook` (`routes/apisystem.ts`) → `PluginRegistry.hook`, the response HELD while the handler's promise is pending (see **Backends**) |
| `route(method, pattern, fn)` (1.2) | `* /api/plugin/<id>/*` in `routes/apisystem.ts` → `PluginRegistry.route`, matched with the core's own `matchSegs` (`routes/apitable.ts`). Namespaced under the plugin's id and served by `handleApi`, so it is behind the SAME origin/Host and token gates as every core route — not loopback-only, not in `OPAQUE_READ_ROUTES`. JSON in (≤ `PLUGIN_ROUTE_BODY_MAX`, else 413) and out. `hook…` is refused (the sink's), and so is a duplicate method + pattern; a path no plugin route matches is the core's plain 404. Unregistered on switch-off |

**Who called (`handle`'s second argument, since 1.8).** `fn(args, caller)` gets `caller: PluginCaller = { kind, deviceId, deviceName }`: `kind` is the socket's trust tier (`loopback`/`tailscale`/`lan`/...), `deviceId`/`deviceName` are the paired device's from the device ledger (`routes/system.ts`'s `callerOf`), null for a socket with no token (a tailscale-trusted browser) and for an in-process call, whose `kind` is `unknown` (never `loopback`: no socket, so never a local browser). It is never a proof beyond pairing: a name the person typed at pairing, on a tier the network decided. A handler that ignores it is unchanged.

## Contributed readers (`api.screenReader`, `api.storeReader`, since 1.1)

A reader used to be core's alone ("a plugin that wants a new reader contributes it to core"). That
made a second backend's readers PUBLIC CORE by construction, and the owner decided opencode stays
private — so the two shapes core actually dispatches on are now an API, and a backend extension brings
its readers with it. **The reader answers only questions about its own binary; the core keeps every
rule that is not about pixels or rows**:

- **`PluginScreenReader`** — a dialog with NO numbers, answered by walking a selection. Core
  (`sessions/boxes.ts`'s `checkNavBox`, `choosePromptBox`) keeps the cheap gate on the stripped tail,
  the render, the miss budget and the resize grace, and the walk that sends ONE arrow per pass,
  RE-READS, and refuses rather than pressing Return on the wrong row. The reader answers
  `candidate(tail)`, `read(rows)`, `prompt(box)`, `stillUp(rows)`, `navTo(box, choice)`. A throw is "no box".
- **`PluginStoreReader`** — the CLI's own conversation record, read and never written: `transcript`,
  `toolDetails`, `contextSeries`, `updatedAt` + `pollUnchanged` (the 204 poll), `discover(look)` (WHICH
  conversation a session is in — exactly one candidate or none; `carry` is the reader's state between
  passes, opaque to core), and an optional `ledger(maxAgeMs)` served verbatim at
  `GET /api/tokenstats/<backendId>` when the backend has no `sources.tokens`. Core keeps the
  watcher's cadence (`sessions/convid.ts`), the poll contract (`sessions/record.ts`), the window on the
  series (`backendContextWindow`, `windowFrom: "config"`), and the fallback to the approximate history
  document. Every member degrades to null; a throw is absent.
- **By NAME, registered BEFORE the backend that names them**, so `registerBackend`'s reader check
  still refuses a misspelling in words. Lookups happen at CALL time: a reader whose plugin was switched
  off answers nothing, and a session still running on it reads as having no box and no record.
- **The preflight lines** are the other thing `--doctor` could not get from a plugin (it loads none):
  `HostPluginModule.doctor({ usedBackends })` is asked of the IN-REPO extensions only, without
  `activate` (`plugins/builtin.ts`'s `builtinDoctorChecks`), and answers `[]` where its backend is not
  wanted.

## Backends (`api.backend`, `hookSink`, `onHook`)

A plugin may add a CLI to the launcher. It is the same
`BackendDescriptor` core's three are, registered while the plugin is on:

- **Declared first.** The manifest lists `backends: ["<id>"]`; `api.backend(def)` refuses any other
  id. Then `registerBackend` refuses a taken id and a `caps.promptBoxes`/`caps.transcript` NAME core
  has no reader for ("no screen reader called `copilot-numbered`; this host has: …"). Every refusal
  is a THROWN sentence, so a refusal in `activate()` lists the plugin broken with that reason, and
  nothing is half-registered.
- **What the plugin cannot say is the core's** (`pluginDescriptor`): `healthScope` is always false
  (the health board measures core readers against the claude TUI); booleans left out are false;
  delivery anchors left out are null, which is `deliver.ts`'s existing no-anchor rule; a
  `launchArgs` answer that is not a list of strings is a refused launch in words; a `models()` that
  throws or answers garbage is an EMPTY catalogue (a free-text field, never a guessed list). The
  descriptor is frozen, but `delivery`, `caps` and `sources` are read THROUGH the def on every access
  (a def may answer them from getters a knob switches; the opencode extension does). Path containment is untouched: a session's `cwd` is contained by
  `containRepoDir` before any backend is asked anything.
- **Switching the plugin off unregisters its backends** (`clearHandlers`), so the next
  `session.create` on that id is refused by `resolveBackend` in words naming what would work; a
  session already running keeps its descriptor until it ends. Every backends change re-broadcasts
  `{t:"backends"}` and asks a NEW backend for its catalogue (`primeNewBackendModels`) — core's are
  primed once at boot and never re-asked.
- **Its hooks reach the daemon by loopback only.** `api.hookSink()` is
  `http://127.0.0.1:<port>/api/plugin/<id>/hook`; the route applies `/api/hook`'s loopback test
  (403 otherwise), answers 404 in words for an unknown, broken or switched-off plugin or one with no
  `onHook`, and otherwise hands the JSON body to the ONE `onHook` handler. Its return value is the
  response body (`undefined` ⇒ `{}`). A Promise HOLDS the response — the shape a CLI that waits on
  its hook for a permission answer needs — until it settles, or until `maxHoldMs` (default 8 s,
  `PLUGIN_HOOK_HOLD_DEFAULT_MS`; at most 60 s), when the core answers `{}` itself and calls
  `hold.onExpired`. Switching the plugin off answers every held response `{}` at once. A throw or a
  rejection answers `{}` and becomes the status line. **Keep `maxHoldMs` below the CLI's own hook
  timeout**: Copilot 1.0.91 SIGTERMs a hook at its `timeoutSec`, then shows its TUI dialog and never
  re-fires (measured on copilot 1.0.91), so a hold that outlives it answers nobody.
- **A held hook is answered through the box, not around it.** The plugin turns the hook into a
  `SourceDialog` on its `sources.dialogs`; the side channel publishes it with `askId` and `nav`, and
  the phone's tap (and a gated plugin's `answer()`) reaches `sessions.answerBox`, which calls that
  dialog's `answer()` — which resolves the held promise. There is no other way for a hook response to
  carry an answer.
- **A dialog that has moved into the CLI's own TUI is answered by keys the CORE types (WP3c).** Past
  the hold, Copilot shows its own numbered dialog, answered by the digit alone. A plugin gets no
  keystroke API — typing into a session is core's, and anything answering a box goes through the one
  dispatcher — so the dialog's `answer(choice)` resolves to `{ keys: "1" }` instead of typing, and
  `answerBox` types exactly those keys into THAT session through `core.input`, the raw path a digit
  tap takes. Only for a dialog the source itself posed and still has open (keep it open until the
  CLI confirms; retire it then), only as the result of that `answer()` call — a tap or the gate's
  gated answer — and bounded (`SourceKeys` in `shared/backendsources.ts`): at most 8 keys, each a
  printable character or Return / Escape / an arrow (an arrow counts as one). Anything else is
  refused in words, nothing typed (`boxes.ts`'s `sourceKeysProblem`).
- **A pane that outlives the daemon is parked, not dropped.** `rediscover()` runs before external
  plugins activate, so a live tmux record whose backend is not registered yet is held in
  `parkedLive` (`sessions/tmux.ts`), retried on every backends change, and — once `loadAll()` has
  settled and it is still unknown — shown as an `alive` closed row whose `unadopted` sentence names
  the plugin that declares it (or says none does). Registering the backend later adopts it and takes
  the row away.
- **Core's own `claude` is on the same seam** (`backends/claude-sources.ts`, design §10): its
  `/api/hook` sink routes and hands the payload to claude's `sources.turns`, exactly the job a
  plugin's `onHook` does for its CLI. Two optional flags a plugin may also state carry what is
  different: `inBand` (a hook pipe in the CLI process: no `sideChannel` published, never held) and
  `turns.verifyEnds` (an end that is a REQUEST, held against claude's working line — only for that TUI).

The fixture `scripts/fixtures/plugin-backend-stub/` is the whole pattern in 100 lines: `stubcli` runs
the claude stub TUI with `STUB_HOOK_URL` at the sink, and turns `SessionStart` / `UserPromptSubmit` /
`Stop` / a held `permissionRequest` into channel health, turns and a dialog, and a `tuiDialog` into
a dialog answered `{ keys }`, which `e2e-pluginbackend.mjs` reads back off the stub's `STUB_LOG`.

## In-repo extensions

`packages/extensions/<id>/` holds a feature built as a plugin but shipped with waterplane:
`waterplane-plugin.json` + `host/` + `web/` (+ `shared/` later) + `README.md` — the external layout
verbatim, so moving one out is a folder move, not a rewrite. One folder holding the whole extension
also means a diff confined to it is visibly confined. The first
is `requirements` (the setup row and its set-up fix, moved out of `host/src/requirements.ts`; the
row's words are pinned by `packages/host/test/requirementsrow.test.mjs`). The second is `token-stats`, **web-only** (no `host/`): the token statistics screen, reading the ledgers through `@waterplane/sdk`'s `ledgers`; see [token-stats-architecture.md](token-stats-architecture.md). The third is `opencode`, **host-only** and **private** (left out of the public snapshot, `deploy/public-allowlist.txt`): the opencode BACKEND on `api.backend()` — the descriptor, the hybrid and its `serve` children, and its two readers on `api.screenReader`/`api.storeReader` (above) — the first extension that is `optional` and `experimental`. Its tests, e2e and stubs live in its folder (`test/`, `e2e/`, `scripts/`); core finds them by glob, and builds and tests without them (`tools/publictree.test.mjs`, `scripts/verify-public-tree.mjs`).

**What a backend extension needed from the API** (additive, `PLUGIN_API_VERSION` unchanged): `PluginLaunchRequest.cwd`/`hostSessionId`/`forkAtTurn`, `PluginLaunchPlan.exec`, `delivery`/`caps`/`sources` read THROUGH a def's getters (`pluginDescriptor` never copies them), and `HostPluginModule.shutdown()` — synchronous, run by `PluginRegistry.shutdownAll()` as the daemon exits, for every loaded module, the place to kill child processes (`deactivate` is a switch-off, which must not kill a running session's server). Manifest: `optional`, `experimental` (→ `BackendInfo.experimental`).

**The import boundary** is `local/extension-boundary` (`tools/eslint/rules.js`, pinned by
`tools/extensionboundary.test.mjs`, and the ESLint block covers the `.mts` files): `host/**` and
`shared/**` import only `@waterplane/shared`, `node:*` builtins (host only) and paths inside their own
extension — never `packages/host/src`; the daemon arrives as the `HostPluginApi` handed to
`activate`. Core imports an extension only through `features/registry.ts` → `<id>/web/index.ts`
and `plugins/builtin.ts` → `<id>/host/index` (today that one resolves a path string, not an
import). The web half's list is in [web-architecture.md](web-architecture.md#the-boundary-enforced).

- **The same `HostPluginApi` object** (`makeApi`), for every folder `packages/host/src/plugins/builtin.ts`
  DISCOVERS (a manifest naming a `host` module, in id order) — a folder, never a core edit, so a
  private extension's absence is nothing to configure. Loaded by `loadBuiltins()` before any external plugin (so
  none can take a builtin's id), always on (`setEnabled` refuses in words) unless its manifest says
  `optional` (opencode: switchable like any plugin, listed, default from the release's `builtins` —
  `deploy/ship.json`, [distribution.md](distribution.md)), and otherwise left out of
  `plugin.list` unless broken — a broken one is listed like any plugin, never skipped in silence.
  `main()` awaits `builtinsLoaded` before listening, because their rows are part of the first
  checklist.
- **The web half** (`web/index.ts`, `export const manifest: FeatureManifest`) is compiled into the phone
  bundle: found by `features/registry.ts`'s EXTENSIONS glob (eager, by folder — never a core edit), resolved through the `@waterplane/sdk` /
  `@waterplane/kit` aliases (`packages/web/tsconfig.json`, `vite.config.ts`), hashed into `BUILD_ID` and
  chunked with the sheets. It may import only `@waterplane/sdk`, `@waterplane/kit`, `@waterplane/shared`, react,
  lucide-react and its own folder. Its points: `sheets` (ids `feature:<id>/<name>`, never persisted),
  `repoActions`, `repoChips`, `setupRows` (words for a row the host half contributes), `pushes`
  (`plugin.push` by event, only for its own id), and `pluginClient<M>(id)` for calls.
- **A host half imports `@waterplane/shared` and node only**, never a host module (the lint above).
- **How it is compiled without moving `dist/main.js`:** the sources are `.mts` (the folder is not a
  package, so a `.ts` would compile to CommonJS, where `import.meta` does not exist) and a second
  `tsc` in the host's `build` script, `packages/host/tsconfig.extensions.json` (`rootDir:
  ../extensions`), emits them to `packages/host/dist/extensions/<id>/host/*.mjs`. Under tsx the
  `.mts` source is imported directly. A path a module resolves relative to itself therefore has TWO
  depths — `requirements.mts` lists both for `update.mjs`, and
  `packages/host/test/requirementsscript.test.mjs` pins both layouts.

### The requirements extension's sheet (work package 4)

The first extension with a UI. Its list is `parseRequirementsArea` (`@waterplane/shared`, the grammar of
`scripts/requirements/update.mjs`'s `parseArea`, a status outside the four DROPPED exactly as
`countRequirements` does, so the list and the setup row's count agree — asserted over every real area
file). The sheet's cut is one predicate (`web/cut.ts`): the chips' counts, the rows and "n of N" are
all made from it, a status chip counting what is left with the area and the search applied. **The
update has two doors — the sheet's button and the setup row's hand-to-agent button
(`SetupRowDef.agent`) — and both only add a backlog row that waits for a tap**: `handToAgent` without
`fire`, keyed once per build state (`updateKey`), because the run spends model money and the person
has not yet read the brief. A shipped commit's subject and date come from one `git log --no-walk` on
the host; tapping one opens the repo's git screen (working tree only — `nav.openGit`; a per-commit
screen is a follow-up). The chip's count is `summary` (area files only), asked once per repo on mount
with a five-minute TTL and skipped while the link is down.

### `plugin.call`, `plugin.reply`, `plugin.push` — the generic channel (`PROTOCOL_VERSION` 2)

One socket, three messages; a plugin never needs a protocol change. `plugin.call {plugin, method,
args?, ackId}` → `plugin.reply {ackId, plugin, method, ok, result?|error?}` to the ASKING socket
only; `plugin.push` is broadcast. An older host ignores `plugin.call`, so a call times out ("did not
answer within 100 s"). `handleAll<M>(api, fns)` (`@waterplane/shared`) registers a typed method table;
args arrive UNCHECKED, so every handler validates. Args are capped at 64 KB (JSON), a result at 512 KB.

**`plugin.call` is a live question, never a queue entry, never in the ack ledger.** The host's
`createCallLedger` (in memory, 10 min, 500 entries) keeps the PROMISE by ackId: a doubled frame, or a
read re-sent after a reconnect, runs the handler once (a repeat mid-flight joins it); the same ackId
naming a different call is refused. The phone (`core/pluginCall.ts`, `sdk/pluginClient.ts`) re-sends
ONLY `read()` calls, with the SAME ackId; a pending `call()` when the socket drops resolves "the link
dropped before <plugin> answered — it may have run; look before trying again". **A write that must be
at-most-once across a host restart uses `handToAgent`'s `key`, never a retried call.**

### Streams — live binary on the one socket (`api.stream`, plugin API 1.4)

**What.** A plugin serves a named live stream (`api.stream(name, {open, params?, input?, keyframe?,
ack?, close?})`); a phone opens it with `stream.open {reqId, plugin, name, params}` and gets
`stream.opened {streamId}` or `stream.refused {reason}`. Frames are binary WebSocket messages (the
12-byte header in `shared/stream.ts`, `{binary: true, compress: false}` — deflate on video burns CPU
for nothing) sent with `sub.send` to **the socket that opened the stream and no other**. Upstream,
`stream.params` re-steers, `stream.input` carries one event (≤ 4 KB), `stream.ack` reports what
arrived (`sub.lastAck`), `stream.keyframe` asks for a decodable frame, `stream.close` ends it. The
first user is the live desktop ([desktop-stream-plan.md](../analysis/desktop-stream-plan.md)); the
seam is generic. Host half: `packages/host/src/plugins/pluginstreams.ts`.

**Why one socket.** `local/no-second-socket` stands: one socket carries auth, the queue's acks and
the PTY, and a second one would need its own origin check, token, reconnect and liveness. So video
shares the TCP connection — which is why the PTY has priority below. A socket that never sent
`stream.open` never receives a binary frame, so an old APK bundle (whose `ws.ts` reads every frame as
text) is untouched; `e2e-stream.mjs` asserts zero binary frames on such a socket.

**Not durable.** No `stream.*` message is queued offline, ackId'd, in the ack ledger, or retried: a
stream opened an hour late is for a screen nobody watches, and a click delivered late lands on a
different screen (`intent.cancel`'s reasoning). Input is at-most-once because it is never retried.
A dead socket (close or `terminate()`) ends every sub on it with cause `socket` and sends nothing; the
phone reopens on reconnect. An unknown `streamId` is ignored in silence — a stale close after a
reconnect is normal. Switching a plugin off (or its unregister function, or `sub.end`) ends its subs
with cause `plugin` and tells the phone (`stream.ended`). `sub.end(reason, "replaced")` (additive)
ends one with cause `replaced` instead: a plugin with a cap on views ends the OLDEST rather than
refusing the newest — the live desktop's two-view cap once locked a phone out after two reconnects,
because a dropped tunnel leaves subs on sockets not yet known dead (ping 20 s × 2) — and a phone
never reopens a `replaced` view by itself (two screens would take it from each other for ever),
only on a tap. Shutdown ends everything quietly. One host
log line per open and close: plugin, name, id, cause.

**Refusals are sentences.** No such plugin, not running, no such stream, params over 8 KB or not
JSON, more than `STREAM_MAX_PER_SOCKET` (2) open on the socket, or the plugin's own `open` returning a
string or throwing — each is `stream.refused` with the words, and nothing is sent. An `open` that
takes over 10 s is refused; if it later says yes, `close(sub, "error")` follows so the plugin lets go.

**Backpressure, and the PTY first.** Per sub, a `droppable` frame is skipped while the socket's
`bufferedAmount` is past `streamBacklogLimit` of the params' `bitrateKbps` (≈0.4 s of video, 64 KB–1
MiB; 256 KB without one). Any skip marks the sub "needs key": every non-key frame is then skipped
until a key frame goes out. **The key that ends the episode, and the ask for it, wait for the drain**:
the producer's `keyframe` handler is called once the buffer is back under the line (checked on the
next frame offered and on every `stream.ack`), once per drain, and a key offered while the buffer is
still past the line is skipped too. Before, a skip asked at once and the key went out regardless: on
a link slower than a fixed bitrate that was P skipped → ask → IDR into the over-line socket → P
skipped → …, an IDR every other frame, the buffer growing to `WS_PTY_BACKLOG_BYTES` before the PTY
hold fired — the terminal seconds late, then torn. Now the buffer stays near the line (the line
plus one frame), and `pluginstreams.test.mjs` pins it with a simulated slow link. A key in a
healthy run (the producer's own GOP, a re-aim; no episode) may still go out past the line, up to
`STREAM_KEY_OVERSHOOT` (2) × the line; further behind it is skipped and starts an episode. A key
that is also `droppable` (a still the next still replaces) is droppable first. **While that socket's PTY is held back, every stream frame
is skipped, a key frame too** (`liveness.ts`'s `ptyHoldsStreams`: the buffer is past
`WS_PTY_BACKLOG_BYTES`, or a terminal on the socket is torn and waiting for its full replay with
bytes still queued). That is how a keyframe is "deferred": nothing is held in memory and nothing can
go out late — the sub needs a key, and the keyframe ask waits until the PTY lets go (the next frame
the producer offers, or the next `stream.ack`, ~4 a second). The alternative, buffering the key
until the PTY drains, keeps a stale picture in host memory and sends it late; asking again costs one
fresh IDR. `sentBytes` counts payload bytes, so `sentBytes − lastAck.rxBytes` is what is in flight.

**Security.** Streams ride the authenticated device socket, through the same gate as everything else
(`wsops.ts`): `Origin`/`Host`, then a device token where one is needed. A peer token unlocks only
`/api/peer/*` and never opens a socket (`pluginstreams.test.mjs` pins `deviceFor(peerToken) === null`).
Whether a stream may take INPUT is the plugin's decision (the desktop's control switch lives in its
own settings and its `input` handler).

### A file for the phone, outside every repo (`api.offerFile`, plugin API 1.5)

**What.** `api.offerFile(file, {name, ttlMs?, onGone?})` hands ONE file the plugin wrote into its own
`dataDir` to the phone's one download path: the phone calls `files.downloadArtifact({…, src: path})`
and the queue fetches `GET /api/plugin-file/<id>/<token>` instead of a repo artifact (`PullItem.src`).
**Why.** The only way bytes reached the phone was a repo's transport dir, and some files must never sit
in a repo — an extension's encrypted backup file is the first. **Rules** (`pluginfiles.ts`): the file's realpath
lies inside the realpath of `dataDir`, the path is not a symlink, the name is a plain file name; the
token is 24 random bytes; the core DELETES the file once one response delivered its last byte (a
resumed range that ends at the last byte counts), at its TTL (10 min default, 1 h at most), on
`withdraw`, or when the plugin stops — `onGone` says which. Its own `/api/plugin-file/` prefix, so no
plugin route can shadow it; behind the same origin/Host and token gates as every `/api` route and
NOT in `OPAQUE_READ_ROUTES`. Memory only: a restart forgets the offers and the plugin sweeps its own
leftovers. `packages/host/test/pluginfiles.test.mjs`.

## The answer gate

The one thing a plugin can do that types into a session without a person's tap, so the core owns
every condition and a plugin cannot skip one:

1. the manifest declared `answers: true`;
2. the session's core-owned **"let <plugin> answer"** switch is on (`SessionInfo.pluginAnswer[id]`,
   default OFF, flipped only by `plugin.sessionAnswer` from the phone);
3. the session's CURRENT box is the one the plugin was told about (same fingerprint) — a box that
   moved on is not answered with a stale choice;
4. the box is not blocked: `trust`/`tool`/`plan` kinds never, and never a box whose question or
   options name something destructive, permission-granting or secret (the list that used to be the
   oracle's `isBlocked`, now core's);
5. `choice` is one of the box's options.

Refused ⇒ `{ ok: false, reason }` in words and nothing typed. Accepted ⇒ typed through the ordinary
answer path, a `sent.json` row with `source: "plugin"`, a decision-log row, and an `autofire`
notification. Caps (per session, per week) are the PLUGIN's policy, not the gate's: they are about
what the plugin spends, and the oracle keeps its own.

### Standing rules: a "don't ask again" a person tapped

Some CLIs ask permission through a hook whose answer cannot persist anything (Copilot 1.0.91: the
hook output is allow/deny + message + interrupt, and the identical request fires the hook again —
measured in the Copilot plugin's repo). Their "don't ask again" therefore has to be kept by
somebody else, and since a kept rule answers later requests with nobody tapping, it is the GATE's,
never the plugin's:

- A plugin marks one option of a dialog it posed with `remember: { key, label }`
  (`SourceDialog`, `shared/backendsources.ts`). The `key` never reaches the wire; what does is
  `PromptOption.remembers: { label }` — the label the HOST will keep the rule under
  (`answergate.ts`'s `ruleLabel`) — and the phone's answer card says it ON the option, before the
  tap: *won't ask again for: <label> — this session only* (`PromptAnswer.tsx`, `remembersText`).
  A person must be able to see that a tap answers future requests too. Only where a rule can be
  made at all: a backend no plugin registered has no owner to key one by, so it promises nothing.
- **Only a person's tap makes the rule.** The phone's two answer routes (`routes/session.ts`: the
  digit and the `promptChoice`) call `answerBox` with `byPerson`; when the CLI's own channel took
  that answer (`ok`, or its `{keys}` were typed), `answerBox` records `{session, plugin, backend,
  key, label}` in `answergate.ts` (`rememberRule`). `plugin` is the id of the plugin that
  REGISTERED the session's backend (`BackendDescriptor.plugin`, set by `api.backend()`) — the owner
  of the source that posed the dialog. Rules are keyed by it, never by the backend id alone: two
  plugins may DECLARE one backend, and the second must not answer on the first one's rules. A
  gated answer (`api.answer`) never makes one.
- `api.ruleAllows(sessionId, key, why)` (`gateRule`) is `ok` only for THAT key, on THAT session,
  made on THAT plugin's dialog, whose backend the plugin's manifest declares — **and only for a
  plugin whose manifest declared `answers`**: a rule answers with nobody tapping, so it is an
  answer, and `ruleRefusal` asks the same first rung `gateRefusal` does. Each refusal is a sentence. Every yes is audited
  exactly as a gated answer: a `sent.json` row `source: "plugin"`, a decision row ("Allowed by a
  standing rule: …"), an `autofire` notification.
- `api.rules(sessionId)` lists this plugin's (for its badge); `api.forgetRules(sessionId)` drops
  them (a session action). **What a person sees is the host's list, not the plugin's**: every
  change (made, used, forgotten) is copied onto `SessionInfo.pluginRules` (`onRulesChanged` →
  `roster.ts`'s `setPluginRules`, one `updated` per real change), and the session menu's plugins block
  draws it per plugin, each rule with how often it answered (`sessionRuleGroups`).
- **Memory only**: a restart forgets them, as do the session's `exit` (`server/sessionEvents.ts`)
  and the plugin's switch-off (`clearHandlers`, by its id). **A tmux detach keeps them**, on
  purpose: a detach is the phone letting go of the pane, not the conversation ending — the
  re-attached session is the same conversation, in the same CLI process, that the person made the
  rule in, and the CLI's own "don't ask again" would survive it too. Only `exit` (the process
  ended) ends one.
- Additive to the API (`PLUGIN_API_VERSION` stays 1) and to the wire (`remembers`,
  `pluginRules`; `PROTOCOL_VERSION` stays 2). Pinned by `answergate.test.mjs` (every refusal —
  undeclared `answers`, another plugin on the same backend — the audit, the clearing), `sidechannel.test.mjs` (only a person's tap on a `remember` option that
  the CLI took makes one) and `scripts/e2e-pluginbackend.mjs` (the round trip through the stub).

## The decision log

It was the oracle's log, and it also held the usage-limit auto-continue events. It is now core's:
`DecisionLogEntry` with `source: "limit" | "plugin"`, one sheet, one file. On first boot the old
`.waterplane/oracle-log.json` is migrated into `<state dir>/decision-log.json` (oracle rows become
`source: "plugin", plugin: "oracle"`), and the old file is renamed `.migrated`, never deleted.

## What the oracle left behind in core

- **Kept:** the highlighter's text reader (`readtext.ts`: `postGemini` + `readImageText`), its own
  key and kill switch (`WATERPLANE_OCR`); the Gemini price table in `meter.ts`, which it and any plugin
  meter against.
- **Removed:** `oracle.ts`, `oracleFlags.ts`, the `oracle.*` wire messages, the per-session oracle
  counters in `sessions/roster.ts`, the `gemini` setup-checklist row and its `setup-gemini.sh` fix
  (a key the core no longer needs is not a finding), the oracle settings/toolbar/log UI.
- **Legacy on disk:** `sent.json` rows with `source: "oracle"` still type-check and render.

## Where it lives in the host

- `packages/host/src/plugins/pluginloader.ts` — discovery (`<config dir>/plugins/*/`, `plugin-paths.json`
  `{paths}` with the one-time rename of an old `plugins.json`, `~` expanded, relative to the config dir, deduped by realpath), `readPluginDir` (every
  broken shape a problem in words) and `importHost` (the module or its `default` must export
  `activate`).
- `packages/host/src/plugins/pluginregistry.ts` — `PluginRegistry`: load, activate (10 s budget; a
  throw or a hang is `state: "error"`), enable/disable, settings, per-session switches, the event
  fan-out, `plugin.list` after every change. The person's on/off switch per plugin is
  `<state dir>/plugins.json` (`{ "enabled": { "<id>": false } }` — NOT the config dir's
  `plugin-paths.json`; absent ⇒ on — installing one is
  the ask); values are `<state dir>/plugins/<id>/settings.json`. A `plugin.set` with one refused
  value applies NONE of them and says which, with the allowed range. A duplicate id is listed as an
  error beside the first copy (same id; the routes address the first).
- `packages/host/src/plugins/builtin.ts` — the in-repo extension list and where each host half is
  imported from (built vs tsx). `packages/host/src/plugins/setupcontrib.ts` — the seam
  `compliance.ts` asks for contributed setup rows and fixes; no registry ⇒ none.
- `packages/host/src/plugins/pluginapi.ts` — the `HostPluginApi` one activation receives. Every
  side-effecting call is dead once that activation is switched off (a generation counter), so a
  timer a plugin forgot cannot act for a plugin the person turned off.
- `packages/host/src/answergate.ts` — `isBlocked`/`isBlockedText` (the oracle's blocklist, core's
  now), the pure `gateRefusal` and `gateAnswer`. Condition 3 (same box) is the fingerprint the
  registry recorded when it fired `prompt` for that session. A checkbox (`multi`) box is refused too
  and is `blocked` in the event: a digit TOGGLES a row there.
- `packages/host/src/plugins/pluginstreams.ts` — `api.stream`'s registry (`name → handlers` per
  plugin, `streamId → sub` per socket) and the backpressure state machine ("Streams" above); the
  `stream.*` routes are in `routes/system.ts`, the socket's end in `server/wsops.ts`'s close handler.
- `packages/host/src/plugins/pluginfiles.ts` — `api.offerFile`'s offers (token → file, TTL timer,
  delete on delivery) and `rangeLastByte`; the route is `GET /api/plugin-file/:id/:token` in
  `routes/apisystem.ts`.
- `packages/host/src/decisionlog.ts` — the log and its migration.
- Per-session state (`pluginToggles`, `pluginAnswer`, `pluginBadges`) is on the session record
  (`sessions/roster.ts`), **memory only**: a restart puts every "let <plugin> answer" switch back to
  OFF, the safe direction for a switch that types unattended. `suggestion` is cleared exactly where
  the oracle's was (real input, the box going away).
- The usage reading is kept warm (`syncUsagePolling`) while an active answering plugin has its switch
  on in some session, so `api.claudeUsage()` is not a stale number.
- Loaded after boot, never in `--doctor`; `deactivate()` is started on SIGTERM, never awaited.
- Tests: `packages/host/test/{plugins,pluginseam,pluginbackend,pluginstreams,answergate,decisionlog}.test.mjs`, `scripts/e2e-stream.mjs` (fixture `scripts/fixtures/plugin-stream/`), and `scripts/e2e-plugin.mjs`
  against the fixture in `scripts/fixtures/plugin-echo/`; `scripts/e2e-pluginbackend.mjs` against
  `scripts/fixtures/plugin-backend-stub/` (backend listed, spawned, hooked off the sink, a held hook
  answered by a tap and expired to `{}`, switch-off refuses the next create).
