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

`PLUGIN_API_VERSION` is `MAJOR.MINOR.PATCH` (`2.2.0` now). A manifest's `apiVersion` (`"2.2"`, or a
bare `2`, meaning `2.0`) loads when its **major
equals the host's and its minor is no newer**; the patch is never compared. Anything else is
refused before any of its code runs, as a sentence naming both versions and which side is behind
(`pluginApiProblem`, from `manifestProblems`), and the plugin is listed broken. What bumps which
number is in the JSDoc on `PLUGIN_API_VERSION` — removing, renaming or narrowing anything is MAJOR,
adding anything is MINOR — and the public reference, [docs/plugins-api.md](../plugins-api.md), is
GENERATED from `plugin.ts` (`npm run docs:plugins`; `tools/plugindocs.test.mjs` fails when stale), so
the contract and its documentation are one file. Pinned by `packages/shared/test/pluginapi.test.mjs`.

**2.0 was a deliberate break** (backend contract v2, [the plan](../plans/backend-contract-v2.md)): a
backend says WHERE each fact comes from in one provider table (`facts`), not in a string per reader on
`caps`, and its launch is `prepare()` (async) instead of `launchArgs()`. A 1.x manifest is refused
with a sentence that names the 2.0 contract; a 2.0 def that still carries `caps.hooks`/`promptBoxes`/
`transcript`/… is refused naming the keys that moved. Every in-repo extension moved with it; an
external BACKEND plugin written for 1.x stops loading until it is ported. **Only the backend
descriptor broke**, so a 1.x plugin whose manifest lists no `backends` (a reader, a panel, a usage
probe) still loads on 2.x if it declares 1.0–1.8 (`V1_LAST_MINOR`; `pluginApiProblem(…, {backends:false})`
— the loader passes whether the manifest lists backends).

**2.1 is additive**: `api.supports.dialogKeysThenTyped` (absent on a 2.0 host, so a plugin asks
before it relies on it — see "Typed answers" under Backends), and a source turn's `ended(at)` WAITS
≤ `CONTEXT_FRESH_MS` (1.5 s) for a `sources.context` sample stamped at or after `at`, so a plugin
needs no end-gate hold of its own to get THIS turn's context fill.

**2.2 is additive** ([backend parity v3 §7](../plans/backend-parity-v3.md)): the `mode` and
`commands` facts and their slots, Tab / Shift+Tab in `SourceKeys`, `SourceContextSample.window` and
`context.compactions`, and `tokens.session` — all under Backends below. A 2.1 plugin loads unchanged;
one that fills a 2.2 slot declares `"2.2"`, so a 2.1 host refuses it in words instead of ignoring it.

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
| an engine too big for every OTA update (2026-10-24, `ocr`) | the ONE exception: an extension's manifest `assets` dir is served by the host at `/api/plugin/<id>/asset/<file>` and downloaded to the phone when the person ENABLES the extension, kept in IndexedDB (`sdk` `extAssets`, store `extassets`) for offline use — not Cache Storage, which the APK (no service worker) and plain http (no Cache API) lack; the `/ext-asset/` service-worker route stays unused. Only a worker/WASM engine and its data, started by the extension's bundle code; never a sheet, row or UI piece, never fetched when a sheet opens. Same trust: the host already serves the bundle |
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
| `bindConversation(look)` / `tail(path, onLine)` / `screen(sessionId)` / `sessionFiles(hostSessionId)` (2.0) | the backend toolkit (`plugins/plugintoolkit/`), so a backend plugin stops copying helpers: `bindConversation` is `shared/bindconv.ts`'s pure ladder over the candidates the plugin's own queries found (exactly one survivor or nothing); `tail` is `tailJsonl` (complete lines once, rotation-safe, ≤ 1 MiB per `advance()`); `screen` is the live VT grid as rows plus the `echo.ts`-squashed form (null for an unknown session); `sessionFiles` is the launch dir the host wrote for a session THIS plugin's backend spawned (null otherwise) |
| `supports` (2.1) | `{ dialogKeysThenTyped: true }` on this host; absent on a 2.0 host |
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
- **By NAME, registered BEFORE the backend that names them** (`facts.dialogs: [{ screen: "<name>" }]`,
  `facts.transcript: [{ store: "<name>" }]`), so `registerBackend`'s `factProblems` still refuses a
  misspelling in words. Lookups happen at CALL time: a reader whose plugin was switched
  off answers nothing, and a session still running on it reads as having no box and no record.
- **The preflight lines** are the other thing `--doctor` could not get from a plugin (it loads none):
  `HostPluginModule.doctor({ usedBackends })` is asked of the IN-REPO extensions only, without
  `activate` (`plugins/builtin.ts`'s `builtinDoctorChecks`), and answers `[]` where its backend is not
  wanted.

## Backends (`api.backend`, `hookSink`, `onHook`)

A plugin may add a CLI to the launcher. It is the same
`BackendDescriptor` core's three are, registered while the plugin is on:

- **Declared first.** The manifest lists `backends: ["<id>"]`; `api.backend(def)` refuses any other
  id. Then `registerBackend` refuses a taken id and a `facts` table that names a reader core has no
  such reader for ("facts.dialogs: no screen reader called `copilot-numbered` answers dialogs; this
  host has: …"), an unknown fact name, or a screen or store reader where only a source may answer (`delivery`, and
  2.2's `mode` and `commands`: no reader of either exists, core's or contributed).
  Every refusal is a THROWN sentence, so a refusal in `activate()` lists the plugin broken with that
  reason, and nothing is half-registered.
- **One provider table, one deriver** (contract 2.0, `backends/derive.ts`). `caps` holds only the
  binary facts (`turns`, `slash`, `effort` — the level NAMES, `permissionModes`, `remoteControl`);
  optional `launchModes` (2.2) is the subset of `permissionModes` a session can START in — a mode the CLI
  switches into live but has no launch flag for is left out; absent means every `permissionModes` entry,
  and an empty list, a mode outside `permissionModes` or a mode listed twice is refused at registration
  in words. **Narrowing the set refuses stored launches**: a backlog item, schedule, intent, fork or
  limit relaunch whose stored mode is outside it is refused at create in words (`sessions.ts`,
  `shared/launchmodes.ts`'s `launchModeRefusal`) — never started in the default in silence; the
  phone's `launchFor` leaves such a mode off a fresh launch and SAYS so (`launchModeDropNote`: a
  toast at the create, a note under Settings' permission row);
  `facts` maps each `FactName` to an ordered `Provider[]` — `{ source: true }` (the backend's own
  `sources` slot), `{ screen: "<reader>" }`, `{ store: "<reader>" }` — first that answers wins, a throw
  passes to the next, an empty list means "has none". `derive(descriptor)` is the ONE reader of that
  table: `screen(fact)`, `store(fact)`, `askSource(fact)`, `hooksInBand`, `keepsClaudeLog` and
  `wireCaps()` (the wire `BackendInfo.caps`, byte-identical to 1.x's —
  `packages/host/test/backendinfos.pin.test.mjs`). No gate in core reads a `caps` reader string any
  more. `forkVia: "server"` and `measured: { versions, version() }` sit beside `caps`.
- **What the plugin cannot say is the core's** (`pluginDescriptor`): `healthScope` is always false
  (the health board measures core readers against the claude TUI); booleans left out are false;
  delivery anchors left out are null, which is `deliver.ts`'s existing no-anchor rule; a
  `prepare()` plan whose `args` are not a list of strings is a refused launch in words; a `models()`
  that throws or answers garbage is an EMPTY catalogue (a free-text field, never a guessed list); a
  `measured.version()` that throws is an unknown version. The host AWAITS a plugin's `prepare()`
  (any promise; `create()` awaits it before the spawn, core backends' stay synchronous); a plan that
  does not say `instructionsVia` and `askRulesVia` is refused in words, and its `files` are written
  by the HOST before the spawn (`launchfiles.ts`): `session:<name>` ⇒ `<state dir>/launch/<hostSessionId>/<name>`,
  an absolute path only inside the plugin's `dataDir` (realpath, no symlink on the way), ≤ 16 files,
  ≤ 1 MiB each — anything else refuses the whole plan before a byte is written. In an `env` value a
  comma-separated item spelled `session:<name>` becomes that path. The dir is never the repo and never
  `~/.<cli>`; it is swept 7 days after its session is gone (`sweepLaunchDirs`, in the boot orphan
  sweep, never a dir a live session owns), and the plugin finds it again through `api.sessionFiles`. The
  descriptor is frozen, but `delivery`, `caps`, `facts`, `forkVia` and `sources` are read THROUGH the def on every access
  (a def may answer them from getters a knob switches; the opencode extension does). Path containment is untouched: a session's `cwd` is contained by
  `containRepoDir` before any backend is asked anything.
- **The repo-facing text and the ask rules travel IN the launch plan.** `PluginLaunchRequest` carries
  `instructions` (the core's one text, `reposkill.ts`'s `repoInstructions` — the outbox/inbox, builds,
  screenshots; a plugin never writes its own) and `askRules` (already cut for the repo,
  `shared/askrules.ts`). The plan says how each reached the CLI, and the phone is told in words:
  `instructionsVia` ∈ `plugin-dir` (claude's `--plugin-dir`) · `env-file` (a launch file plus an env
  pointing at its dir — Copilot's `AGENTS.md` under `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`, measured
  1.0.91) · `config` · `flag` · `none` (published as `SessionInfo.told`, so the phone says the agent
  was NOT told); `askRulesVia` ∈ `native` (the CLI's own policy) · `gate` (the CLI has allow/deny but
  no ASK, so the host's answer gate holds the rules the session was LAUNCHED with and refuses to
  auto-answer a box matching one — `answergate.ts`, memory only, a re-attached session falls back to
  its repo's current rules) · `none`. Both are stored with the live record, so a re-attach still
  publishes them.
- **The slots beyond turns/dialogs** (`BackendSources`, `shared/backendsources.ts`), each reached
  only through its `facts` provider and absent from the wire caps where nothing answers:
  `questions` (a question with no choice box, `kind:"question"` on the one answer dispatcher),
  `usage` (an ACCOUNT's windows, `usagesources.ts` — never `source:"claude"` — plus an optional
  `wall(s)`, the backend's own verdict on whether THIS session is blocked, which `sessions/wall.ts` walks as the
  `limits` fact; `resetAt` only when the CLI stated it — a wall WITHOUT one schedules nothing: no
  probe, no ladder, no unattended `continue`; its `why` rides as `SessionLimit.needsYou` and the
  phone says it needs the person), `agents` (a
  backend's own running subagents, polled on `agents.ts`'s cadence; rows with `endedAt` are not
  running), `conversations` (`list(cwd)` feeds the archive and the resume picker; `remove` is optional and is
  what the delete uses; `fork` is optional, consumed by `session.create` for a backend without
  `forkVia: "server"`; declaring it turns the wire `fork` cap on). The wire caps these add (`efforts`,
  `questions`, `plan`, `usage`, `agents`, `conversations`) are ABSENT, never `false`, where no provider
  answers. **`plan` (`PlanSource`) is consumed by the host** (P4b1, 2.2 wave): `sessions/sidechannel.ts`
  watches it — only where the `plan` fact is `{source:true}`, the table the wire cap is read from — and
  publishes a posed plan as the SAME box claude's screen read produces: `kind:"plan"`, the question
  worded as claude's (so `planbox.ts`'s `isPlanBox` knows it), two rows (1 = `approve()`, 2 =
  `keepPlanning()`), `nav`, `askId` = the plan's id, the text on `DetectedPrompt.plan` capped at
  `PLAN_CAP` with `path` EMPTY — there is no file, and a made-up path would be a wrong value. Oldest
  first with dialogs and questions; `closed` retires it; the channel going down hands it back. It is
  answered only through `answerBox` → `sourceanswer.ts`'s `answerSourcePlan`: a PERSON's tap (the
  answer gate refuses a `plan` box, and the plan rung refuses an answer without `byPerson` again),
  never words, and at most ONE verb call per plan — a latch released only when the answer provably
  did nothing (the source said no or threw, its keys were refused); a re-pose under the same id keeps
  it. A `SourceKeys` reply is typed by the core while the plan is still open; a reply carrying words
  is refused, nothing typed.
- **Typed answers (2.1).** A question's or dialog row's `answer()` may resolve to `SourceKeys`
  (`{keys}`), `SourceTyped` (`{typed, then?:"\r"}`, ≤ `SOURCE_TYPED_MAX` = 1000 characters, no
  control character) or, for a row that takes a reason, both (`{keys, typed, then?}` — keys first, a
  pause of 500 ms, the words, Return as a separate write). `sourceanswer.ts` is the one place
  words reach a session outside `deliver.ts`; it types only while the source still holds that
  question open and a gated plugin never carries words. A plugin that needs the combined form checks
  `api.supports?.dialogKeysThenTyped`.
- **The 2.2 slots** (`shared/backendsources.ts`; typed and validated, each consumer named on its
  bullet as it lands). Each answers only through `{source:true}` and, like every source, says
  `null` for "cannot say". One rule judges every answer, `shared/sourceshape.ts`, asked by the host's
  consumers and the testkit alike; an answer it refuses is dropped WHOLE to absent, never clamped.
  - `mode` (`ModeSource`): `current(s)` is one of the descriptor's `caps.permissionModes` or null
    (anything else is unknown, never a guess); optional `watch`; `set(s, target)` either switches
    itself (`{ok, reason?}`) or answers ONE press as `SourceKeys` (Shift+Tab, say) that the core
    types and then re-reads `current()` until it moves — `livemode.ts`'s ladder (stop on the target,
    a repeat or 6 presses), never counting positions. **Consumed by `sessions/livemode.ts`** (P4b1):
    `SessionInfo.liveMode` = `current()` judged by `sourceModeProblem` (null, a throw or a refused
    answer DELETES the field), re-read on the quiet tick, on the channel's `up` edge and on every
    `watch` call — a cue to re-read `current()`, never a second reading that could disagree.
    `session.mode` asks `set()` once per step: `{ok}` ⇒ `current()` is polled until it reads the
    target, and a switch the reading does not show is said in words; keys ⇒ bounded by
    `sourceKeysProblem`, typed only from a reading (none ⇒ nothing pressed), re-read until it moves.
    The footer walk's refusals (a box open, remote control off) and its per-session chain hold; the
    footer itself is never asked for such a backend, and no claude backend has the fact.
  - `commands` (`CommandSource`): `list(cwd)` — the CLI's slash commands as it lists them: `name` with
    its slash, one word (`"/compact"`), unique, at most `SOURCE_COMMANDS_MAX` (200); optional
    `description`, `args` as its help writes them, and `local` (runs in the TUI, starts no turn — the
    delivery's proof is then the screen moving). **Consumed (P4b2):** `GET /api/slash?backend=<id>`
    answers `list(cwd)` validated whole by `sourceCommandsProblems` — a malformed, null, throwing or
    late (5 s) answer is `{ commands: [], why }`, never a partial list and never claude's — each row
    `source: "backend"`, `local: true` only where the plugin said so. A delivery asks the session's
    own `delivery.isLocalCommand`/`startsNoTurn` (claude's list used to be asked of every backend),
    and a listed command's `local` beats that static rule: `true` ⇒ the proof is the screen moving.
  - Context: `SourceContextSample.window` is the window the CLI STATES for the model in use — absent
    is unknown, never a table lookup or a neighbouring model's; `context.compactions(s)` is this
    session's, oldest first (`at`, and `preTok` / `postTok` / `auto` only where stated). **Consumed
    (P3):** `window` makes the phone's percentage present for that session and scales its graph;
    `compactions()` marks the graph. Both are asked on every turn end and every graph read.
  - Spend: `tokens.session(s)` is THIS session's spend so far in the backend's own figures — `tok`,
    `agentTok`, `usd` / `agentUsd` only where the CLI states dollars, and `native {amount, unit,
    agentAmount?}` for a unit that is not dollars (Copilot's AI credits): never converted, never
    summed with dollars or another unit. Every figure finite and ≥ 0, absent when not stated.
    **Consumed (P2):** a session with no claude log is judged from it (the session budget; why the
    period/week views do not take it: [host.md](host.md#sessionbudgetts--a-sessions-own-budget)).
  - `conversations.fork(id, atTurn)` (**consumed, P4b2**) is called by `session.create` carrying
    `forkAtTurn` for a backend without `forkVia: "server"`: the turn id is the one from the plugin's
    own transcript, the answer must be a NEW bare id within 20 s, and the new conversation is resumed
    plainly under the same backend. Declaring `fork` turns the wire `fork` cap on — declare it only if
    it works.
  - Wire caps: `modes: true` (the phone may switch live; the reading is `SessionInfo.liveMode`, as
    claude's) and `commands: true` (the slash sheet lists the backend's own commands; `slash` keeps
    meaning claude's set) — sent only while the source answers, ABSENT otherwise, never `false`, so
    claude's frame is unchanged (`backendinfos.pin.test.mjs`).
  - Worked example, Codex 0.160.0 (an external plugin): the window is Codex's own
    `modelContextWindow` only when it is `floor(95 %)` of the `model_context_window` THIS launch wrote
    — never Codex's 258400 fallback; the fill is `last.totalTokens` (the figure `/status` calls used);
    compactions come off the rollout's `compacted` lines; the plan box is the TUI's own (keys `1` /
    `3`, no server request); the mode is `thread/settings/updated` with one Shift+Tab per step, while
    approvals and sandbox are taken only at launch (`-a`/`-s` keep the daemon), which is why it
    declares `launchModes`; fork is `thread/fork` + `codex resume <new id>`.
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
  printable character or Return / Escape / an arrow, or (2.2) Tab / Shift+Tab (`\t`, `\x1b[Z`) — each
  of those counts as one. Anything else is refused in words, nothing typed (`boxes.ts`'s
  `sourceKeysProblem`; the testkit restates it and `plugintestkit.test.mjs` pins the two together).
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

**Setup rows and the doctor.** Every backend that declares `measured` gets a core
`backend-cli-<id>` row on the desktop checklist (binary resolves, running version;
`plugins/setupcontrib.ts`'s `backendCliRows`) — no plugin code. What only the plugin can tell
(signed in, local runner ready) goes through `api.setupCheck` (synchronous: serve a cached answer
and refresh in the background; return `null` when you cannot tell) and, for `npm run doctor`, an
exported `doctor({ usedBackends })` that stands alone. External plugins' `doctor` is asked too
(`plugins/builtin.ts`'s `externalDoctorChecks`): the host imports the host module WITHOUT
`activate` — the same trust the loader already gives it — so its top-level code must have no side
effects; each call is bounded to 10 s and a throw drops the lines. Neither may call a model:
`--version`, config files and free local probes only.

### Testing a backend plugin

A plugin repo depends on nothing from this one at runtime, but its TESTS share one kit:
`packages/plugin-testkit/` (plain ESM, no build, not a workspace). It holds `fakeApi(opts)`, a fake
`HostPluginApi` as of 2.1 that records every call (`api._calls`) — `env()` answers declared names only,
`backend()` refuses an id the manifest does not list, and `bindConversation`/`tail`/`screen`/
`sessionFiles`/`supports` behave as `plugintoolkit/` does — and `runConformance(...)`, the contract a
host enforces on registration, run from one `node --test` file. Validators and constants are imported
from `packages/shared/dist` (run `npm run build:shared` once); the rules that live only in host TS
are restated in the kit and pinned to the host's real checks by `packages/host/test/plugintestkit.test.mjs`,
and `tools/plugintestkit.test.mjs` fails when `HostPluginApi` gains a member the fake lacks.

Two kinds of check: PINNED ones (descriptor shape, ids, facts, files, plan vias, keys, typed answers, `caps`) get the same fixtures through the host and the kit, so they cannot drift; `caps` is judged the host's way (it normalises, never refuses: an absent cap is fine, a mistyped one is flagged). `planLints` (a non-string `env` value, a non-list `dropEnv`, a relative `exec`) is KIT-ONLY: the host silently drops or keeps those, the kit fails them as lints, and the host test pins only that the host accepts them.

A new plugin (the Gemini CLI, say) adds `test/conformance.test.mjs`:

```js
import { runConformance } from "<kit>/index.mjs";
import * as plugin from "../host.mjs";
import manifest from "../waterplane-plugin.json" with { type: "json" };
runConformance({ plugin, manifest, env: { GEMINI_CLI_BIN: "/nonexistent/gemini" } });
```

Point the binary env at a path that does not exist: the suite then never runs the CLI or a model.
It checks the manifest and API version; that `activate` registers only manifest-declared ids; the
descriptor (2.0 shape, no 1.x caps); every `facts` name and reader, and every `{source:true}` backed
by its `sources` slot; `prepare()` answering a plan (`instructionsVia`, `askRulesVia`, string args,
`files` at most 16 and 1 MiB, `session:<name>` or inside `dataDir`) for a fresh launch and each
resume; `models()` lists (empty allowed); `measured.version()` answering or throwing but never hanging.
Pass `answers: async () => [{ label, answer }]` to have the answers a source gives checked against the
bounds (`SourceKeys` at most 8 allowed keys, `SourceTyped` at most 1000 characters, no control chars).
The 2.2 slots a backend fills are asked once COLD (no channel attached: a throw or null is fine, a hang
is not) and any answer must hold `sourceshape.ts`'s shape; pass `readings: async () => [{ label, kind,
value }]` (`kind` ∈ `mode`/`commands`/`spend`/`compactions`/`context`) to check what the slots make of
your own fixtures, a parsed `/help` or a recorded usage event, against the same rule.

How a plugin reaches the kit: the two in-tree-style plugins keep a thin `test/fakeapi.mjs` that
imports `packages/plugin-testkit/index.mjs` from `$WATERPLANE_REPO` (else `$MAIN_REPO`, else
`~/dev/usmc`), so no install step and a plugin's other test files keep importing `./fakeapi.mjs`. An
author without a checkout beside theirs uses a `file:` devDependency on that directory
(`@waterplane/plugin-testkit`); the kit finds `shared/dist` relative to itself, so it needs the
checkout either way.

## In-repo extensions

`packages/extensions/<id>/` holds a feature built as a plugin but shipped with waterplane:
`waterplane-plugin.json` + `host/` + `web/` (+ `shared/` later) + `README.md` — the external layout
verbatim, so moving one out is a folder move, not a rewrite. One folder holding the whole extension
also means a diff confined to it is visibly confined. The first
is `requirements` (the setup row and its set-up fix, moved out of `host/src/requirements.ts`; the
row's words are pinned by `packages/host/test/requirementsrow.test.mjs`). The second is `token-stats`, **web-only** (no `host/`): the token statistics screen, reading the ledgers through `@waterplane/sdk`'s `ledgers`; see [token-stats-architecture.md](token-stats-architecture.md). `scorecard` is optional and shows a repo's public OpenSSF Scorecard (host reads the API, phone draws a chip and a sheet; README in its folder). The third is `opencode`, **host-only** and **private** (left out of the public snapshot, `deploy/public-allowlist.txt`): the opencode BACKEND on `api.backend()` — the descriptor, the hybrid and its `serve` children, and its two readers on `api.screenReader`/`api.storeReader` (above) — the first extension that is `optional` and `experimental`. Its tests, e2e and stubs live in its folder (`test/`, `e2e/`, `scripts/`); core finds them by glob, and builds and tests without them (`tools/publictree.test.mjs`, `scripts/verify-public-tree.mjs`).

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

**A folder-trust question outside the gate.** Delivery answers claude's first-launch trust box itself
(`deliver/deliverrun.ts`, `trustKeys`) — and ONLY claude's: `delivery.autoAcceptsTrust`, set by
`backends/claude.ts` alone (a plugin's `delivery` cannot carry it). Any other backend whose screen
shows claude's trust words or its own `delivery.trustPromptRe` (`derive.ts`'s `trustRule`) gets
`retry` naming it ("<label> is asking whether to trust this folder — answer it on the phone or in
the terminal"), nothing typed, and auto-fire (`autoFireBlocker`) will not walk into its `trust`
box. Final review B1: Gemini's question squashed to claude's words, and a digit there trusts the
repo's own hooks and servers for good.

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

- **Kept:** the Gemini price table in `meter.ts`, which any plugin meters against. (The highlighter's
  text reader, `readtext.ts`, was kept here too and removed on 2026-10-18: core makes no Gemini call.)
- **Removed:** `oracle.ts`, `oracleFlags.ts`, the `oracle.*` wire messages, the per-session oracle
  counters in `sessions/roster.ts`, the `gemini` setup-checklist row and its `setup-gemini.sh` fix
  (a key the core no longer needs is not a finding), the oracle settings/toolbar/log UI.
- **Legacy on disk:** `sent.json` rows with `source: "oracle"` still type-check and render.

## Plugin manager

Plan: [plugin-manager-and-self-update.md](../plans/plugin-manager-and-self-update.md). Code:
`packages/host/src/updates/`; wire: `shared/src/wire/updates.ts`. The phone lists, installs and
updates plugins from Settings → Tools → updates.

- **Discovery is a read.** `catalog.ts` lists the PUBLIC repos of the `waterplane-dev` org
  (`BRAND.githubOrg`) that carry the `waterplane-plugin` topic (`PLUGIN_TOPIC`), then reads each repo's
  manifest and newest release tag through `github.ts`. Unauthenticated, so few calls (60 an hour
  is the ceiling): `checker.ts` runs once a day, a few minutes after boot, and on a tap, with a
  **10-minute floor** between checks; a failed check does not reset the floor's clock into a retry loop.
  The phone's `updates.autoCheck` governs only the daily one; `WATERPLANE_UPDATE_CHECK=0` stops all.
  A check never installs anything.
- **Maturity** is what the plugin SAYS: `maturity` in `waterplane-plugin.json`, `stable` |
  `preview` | `experimental`; absent is `unrated`, never shown as stable. The words ("Preview: may break
  between versions") live in ONE place, `shared/src/pluginmaturity.ts` (`pluginMaturity`); the host and
  the phone both word a plugin through it. A value outside the three is a manifest problem.
- **Zero dependencies.** A plugin whose `package.json` lists `dependencies` is refused at install
  and at update (`dependenciesProblem`): there is no `npm ci` anywhere in this feature, so a
  dependency would be code nobody fetched. Bundle it into the plugin or do without.
- **Install by repo or by URL.** A repo from the list, or a pasted address. The address comes from a
  phone, so `gitops.ts` holds it to an allowlist BEFORE it reaches argv (`https://`, `ssh://`,
  `git@host:path`; no `file:`, no local path; git runs with `protocol.ext`/`protocol.file` off). The
  repo is cloned to a temp dir and validated (manifest problems, dependencies, duplicate id) before
  anything is moved into `<config dir>/plugins/<id>/`; then `PluginRegistry.loadOne` loads it
  **live**, no restart. Version: the newest version tag (the GitHub release for a github.com
  address, `git ls-remote --tags` otherwise), else the default branch ("untagged").
- **The install record**, `<plugin dir>/.waterplane-install.json` (`installrecord.ts`): `{url, kind:
  tag|branch, ref, commit, installedAt}`. It is what makes a plugin `manager`-installed. **No record ⇒
  `local`**: a dir put there by hand, or a `plugin-paths.json` checkout, is listed and **never
  updated**. The record is added to the clone's `.git/info/exclude`, so it does not make the tree dirty.
- **Update.** A tagged install moves to the newest tag; an untagged one tracks the default branch's
  head. A **dirty working tree is refused** (nothing changed, said in words): the person's edits are
  the last copy. The new code is validated again (manifest, dependencies) before the swap. **A
  restart is needed** to run it: an ESM module cannot be re-imported, so the phone says "updated,
  restart to switch" and the running plugin is the old one until then.
- **Knobs** (`.env.example`, "Update check"): `WATERPLANE_UPDATE_CHECK` (`0` = no checks),
  `WATERPLANE_GITHUB_API` and `WATERPLANE_GITHUB_RAW` (where the reads go; tests point both at a fake
  local server).

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
- `packages/host/src/updates/` — the plugin manager and the self-update view: `github.ts` (the
  unauthenticated reads), `catalog.ts` (org + topic → rows), `checker.ts` (daily/on-demand, floor, cache,
  `status()`), `self.ts` (install mode, newest release), `gitops.ts` (URL allowlist, git), `remote.ts`
  (what to install from an address), `installrecord.ts`, `apply.ts` (install, update, self
  update/rollback), `restart.ts` (supervised in-process restart), `wire.ts`.
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
