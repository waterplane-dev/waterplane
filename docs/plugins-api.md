# Plugin API reference

<!-- GENERATED from packages/shared/src/plugin.ts by scripts/gen-plugin-docs.mjs — do not edit by hand. -->
<!-- Rewrite with `npm run docs:plugins`; `tools/plugindocs.test.mjs` fails when this is stale. -->

Start a new plugin from `examples/plugin-template/`; installing one and the list of plugins are in
`docs/plugins.md`. **Publishing yours? Tag its GitHub repo with the `waterplane-plugin` topic**, so
it shows up at https://github.com/topics/waterplane-plugin. A plugin is not a fork, so that topic is
the only place it is counted.

**API version: `1.8.0`** (`PLUGIN_API_VERSION`). A manifest's `apiVersion` loads when it has the
same major and a minor no newer than this one; the rules for what bumps which number are under
`PLUGIN_API_VERSION` below. Why the API looks the way it does: `docs/notes/plugins.md`.

## Overview

Plugins — the contract between the daemon, the phone, and code a user
provides from OUTSIDE this repo. Reasoning: docs/notes/plugins.md.

A plugin EXTENDS the daemon. It is a directory with a manifest (`PLUGIN_MANIFEST`) (the
`PluginManifest` below) and a HOST module (`host.mjs`, ESM) the daemon
imports and calls `activate(api: HostPluginApi)` on. It runs in the daemon's
process with the daemon's trust — the daemon already spawns `claude`, so a
plugin crosses no boundary the daemon has not — but it only SEES what the API
hands it, so the core's rules (the answer gate, containment, metering) cannot
be skipped by accident.

Not to be confused with what makes a REPO aware of the product (the core's own
skill, handed to every spawned `claude`): that is the daemon telling a
repo's agent what it offers, owned by the core, and no plugin's business.

The phone runs a plugin's UI only as an in-repo extension's web half, built
into the bundle (docs/notes/plugins.md, "Trust") — never loaded lazily, never
outside the SDK. A plugin with no UI code DECLARES what it shows here
(settings fields, action buttons, per-session switches, a badge, a status
line, rows in the decision log, a suggested answer) and the app's own
components draw it.

Pure types + a validator. Both ends and plugin authors read this file.

The same `HostPluginApi` is handed to the IN-REPO extensions under
`packages/extensions/<id>/` (the static registry, always on) — one object
shape for both, so moving an extension out of the repo is a folder move.

## Contents

- [`PLUGIN_API_VERSION`](#plugin_api_version) — const
- [`PluginCaller`](#plugincaller) — interface
- [`PluginApiVersion`](#pluginapiversion) — interface
- [`parsePluginApiVersion`](#parsepluginapiversion) — function
- [`pluginApiProblem`](#pluginapiproblem) — function
- [`PluginMethods`](#pluginmethods) — type
- [`PluginCallResult`](#plugincallresult) — type
- [`PLUGIN_EVENT_RE`](#plugin_event_re) — const
- [`PLUGIN_ACK_RE`](#plugin_ack_re) — const
- [`PLUGIN_ARGS_MAX`](#plugin_args_max) — const
- [`PLUGIN_PUSH_MAX`](#plugin_push_max) — const
- [`PLUGIN_ID_RE`](#plugin_id_re) — const
- [`PluginValue`](#pluginvalue) — type
- [`PluginField`](#pluginfield) — type
- [`PluginActionDef`](#pluginactiondef) — interface
- [`PluginToggleDef`](#plugintoggledef) — interface
- [`PLUGIN_MANIFEST`](#plugin_manifest) — const
- [`LEGACY_PLUGIN_MANIFESTS`](#legacy_plugin_manifests) — const
- [`PLUGIN_PATHS_FILE`](#plugin_paths_file) — const
- [`LEGACY_PLUGIN_PATHS_FILE`](#legacy_plugin_paths_file) — const
- [`PluginManifest`](#pluginmanifest) — interface
- [`PluginView`](#pluginview) — interface
- [`PluginStatus`](#pluginstatus) — interface
- [`AnswerSuggestion`](#answersuggestion) — interface
- [`PluginBadge`](#pluginbadge) — interface
- [`DecisionLogEntry`](#decisionlogentry) — interface
- [`PluginPromptEvent`](#pluginpromptevent) — interface
- [`PluginQuestionEvent`](#pluginquestionevent) — interface
- [`PluginSession`](#pluginsession) — interface
- [`HostPluginApi`](#hostpluginapi) — interface
- [`PluginHttpMethod`](#pluginhttpmethod) — type
- [`PLUGIN_ROUTE_BODY_MAX`](#plugin_route_body_max) — const
- [`PluginHttpRequest`](#pluginhttprequest) — interface
- [`PluginHttpReply`](#pluginhttpreply) — interface
- [`PLUGIN_BACKEND_ID_RE`](#plugin_backend_id_re) — const
- [`PluginLaunchRequest`](#pluginlaunchrequest) — interface
- [`PluginLaunchPlan`](#pluginlaunchplan) — interface
- [`PluginBackendDef`](#pluginbackenddef) — interface
- [`PLUGIN_READER_NAME_RE`](#plugin_reader_name_re) — const
- [`PluginScreenSpan`](#pluginscreenspan) — interface
- [`PluginScreenRow`](#pluginscreenrow) — interface
- [`PluginScreenBox`](#pluginscreenbox) — interface
- [`PluginScreenReader`](#pluginscreenreader) — interface
- [`PluginStoreLook`](#pluginstorelook) — interface
- [`PluginStoreContext`](#pluginstorecontext) — interface
- [`PluginStoreReader`](#pluginstorereader) — interface
- [`PLUGIN_THERMAL_TIMEOUT_MS`](#plugin_thermal_timeout_ms) — const
- [`PluginThermalReading`](#pluginthermalreading) — type
- [`PluginThermalReader`](#pluginthermalreader) — interface
- [`PluginUsageProbe`](#pluginusageprobe) — interface
- [`PLUGIN_USAGE_PROBE_TIMEOUT_MS`](#plugin_usage_probe_timeout_ms) — const
- [`PluginDoctorCheck`](#plugindoctorcheck) — interface
- [`PLUGIN_HOOK_HOLD_DEFAULT_MS`](#plugin_hook_hold_default_ms) — const
- [`PLUGIN_HOOK_HOLD_MAX_MS`](#plugin_hook_hold_max_ms) — const
- [`PluginHookHold`](#pluginhookhold) — interface
- [`PluginRepoScope`](#pluginreposcope) — interface
- [`SetupSubject`](#setupsubject) — interface
- [`SetupFixOutcome`](#setupfixoutcome) — interface
- [`HandToAgentResult`](#handtoagentresult) — type
- [`HostPluginModule`](#hostpluginmodule) — interface
- [`handleAll`](#handleall) — function
- [`manifestProblems`](#manifestproblems) — function
- [`cleanPluginValue`](#cleanpluginvalue) — function
- [`pluginValues`](#pluginvalues) — function

## PLUGIN_API_VERSION

*const*

The plugin API's version, semver `MAJOR.MINOR.PATCH`. It versions everything a plugin
author builds against: `HostPluginApi`, the manifest (`PluginManifest`), the event
payloads, the module shape (`HostPluginModule`) and the backend descriptor
(`PluginBackendDef`).

**Compatibility rule** (`pluginApiProblem`, run by the loader on every manifest): a
plugin declaring `apiVersion` `A.B` loads on a host speaking `X.Y` exactly when
`A === X` and `B <= Y`. Anything else is refused with a sentence and the plugin is
listed broken (`state: "error"`), never loaded half-way. The patch number is not
compared: a plugin cannot depend on one.

A bare number (`"apiVersion": 1`, every manifest written before semver) means `1.0`.

**What bumps what:**
- MAJOR (breaking): removing or renaming anything exported here; changing a member's
  type so an existing call no longer compiles or no longer means the same; making an
  optional field required, on either side; a manifest field the loader newly REFUSES;
  a call that used to succeed now throwing or being refused for input it used to
  accept; an event a plugin relied on no longer firing.
- MINOR (additive): a new API method, event, manifest field, optional field, backend
  cap or reader name. A plugin using one declares the new minor, so an older host
  refuses it in words instead of failing at the first call.
- PATCH: wording, documentation and fixes that change no shape — nothing a plugin
  can observe through types.

```ts
export const PLUGIN_API_VERSION = "1.8.0";
```

## PluginCaller

*interface*

Who a `handle` method was called by (since 1.8): the socket's trust tier, and the paired
 device's id/name (null: no token, or an in-process call). Never a proof beyond pairing.

```ts
export interface PluginCaller { … }
```

| member | signature | notes |
|---|---|---|
| `kind` | `kind: PeerKind` |  |
| `deviceId` | `deviceId: string \| null` |  |
| `deviceName` | `deviceName: string \| null` |  |

## PluginApiVersion

*interface*

A parsed `MAJOR.MINOR.PATCH`.

```ts
export interface PluginApiVersion { … }
```

| member | signature | notes |
|---|---|---|
| `major` | `major: number` |  |
| `minor` | `minor: number` |  |
| `patch` | `patch: number` |  |

## parsePluginApiVersion

*function*

Parse a manifest's `apiVersion`: a semver string (`"1.2"` or `"1.2.3"`) or a bare
 non-negative integer (`1` ⇒ `1.0.0`). Anything else ⇒ null.

```ts
export function parsePluginApiVersion(v: unknown): PluginApiVersion | null;
```

## pluginApiProblem

*function*

Why a plugin declaring `declared` cannot load on a host speaking `host`
(default: this one), in a sentence — or null when it can. The rule is
`PLUGIN_API_VERSION`'s: same major, minor no newer than the host's.

```ts
export function pluginApiProblem(declared: unknown, host: string = PLUGIN_API_VERSION): string | null;
```

## PluginMethods

*type*

What a plugin's methods take and answer — a type-level convenience only: args arrive from
 the wire UNCHECKED, so every handler validates.

```ts
export type PluginMethods = {
    [method: string]: {
        args: unknown;
        result: unknown;
    };
};
```

## PluginCallResult

*type*

What `plugin.call` resolves to on the phone. Never rejects.

```ts
export type PluginCallResult<T = unknown> = {
    ok: true;
    result: T;
} | {
    ok: false;
    error: string;
};
```

## PLUGIN_EVENT_RE

*const*

`plugin.push` event names, `plugin.call` ack ids, and the byte caps on args and pushed data.

```ts
export const PLUGIN_EVENT_RE = /^[a-z][a-zA-Z0-9._-]{0,39}$/;
```

## PLUGIN_ACK_RE

*const*

```ts
export const PLUGIN_ACK_RE = /^[A-Za-z0-9._:-]{1,80}$/;
```

## PLUGIN_ARGS_MAX

*const*

```ts
export const PLUGIN_ARGS_MAX = 64 * 1024;
```

## PLUGIN_PUSH_MAX

*const*

```ts
export const PLUGIN_PUSH_MAX = 64 * 1024;
```

## PLUGIN_ID_RE

*const*

`[a-z][a-z0-9-]{1,39}` — also the plugin's directory under `<state dir>/plugins/` (the host state dir, not the config dir).

```ts
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
```

## PluginValue

*type*

```ts
export type PluginValue = boolean | string | number;
```

## PluginField

*type*

One setting, drawn by the app in the plugin's section of Settings.

```ts
export type PluginField = {
    kind: "switch";
    key: string;
    label: string;
    note?: string;
    default: boolean;
} | {
    kind: "choice";
    key: string;
    label: string;
    note?: string;
    default: string;
    options: {
        value: string;
        label: string;
    }[];
} | {
    kind: "number";
    key: string;
    label: string;
    note?: string;
    default: number;
    min: number;
    max: number;
    step?: number;
    unit?: string;
} | {
    kind: "text";
    key: string;
    label: string;
    note?: string;
    default: string;
    multiline?: boolean;
    placeholder?: string;
};
```

## PluginActionDef

*interface*

A button. `global` ones sit in the plugin's Settings section; `session` ones
 in a session's toolbar menu and receive that session's id.

```ts
export interface PluginActionDef { … }
```

| member | signature | notes |
|---|---|---|
| `id` | `id: string` |  |
| `label` | `label: string` |  |
| `note` | `note?: string` |  |
| `scope` | `scope: "global" \| "session"` |  |

## PluginToggleDef

*interface*

A per-session switch the plugin reads (`api.session(id).toggles[id]`).
 Drawn in the session's toolbar menu; `default` applies until someone flips it.

```ts
export interface PluginToggleDef { … }
```

| member | signature | notes |
|---|---|---|
| `id` | `id: string` |  |
| `label` | `label: string` |  |
| `note` | `note?: string` |  |
| `default` | `default: boolean` |  |

## PLUGIN_MANIFEST

*const*

The manifest's file name, current and every past identity's (newest first;
 the loader accepts a legacy one with a deprecation line).

```ts
export const PLUGIN_MANIFEST: string = BRAND.pluginManifest;
```

## LEGACY_PLUGIN_MANIFESTS

*const*

```ts
export const LEGACY_PLUGIN_MANIFESTS: readonly string[] = LEGACY.map((l) => l.pluginManifest);
```

## PLUGIN_PATHS_FILE

*const*

`<config dir>/<PLUGIN_PATHS_FILE>` lists plugin directories kept elsewhere:
 `{ "paths": ["~/code/my-plugin"] }` (`~` expanded, relative to the config dir).
 Not the STATE dir's `plugins.json`, which holds the person's on/off switches.

```ts
export const PLUGIN_PATHS_FILE = "plugin-paths.json";
```

## LEGACY_PLUGIN_PATHS_FILE

*const*

That file's name before API 1.0.0; the loader renames an old one once, never deletes it.

```ts
export const LEGACY_PLUGIN_PATHS_FILE = "plugins.json";
```

## PluginManifest

*interface*

The manifest, a JSON file named `PLUGIN_MANIFEST`.

```ts
export interface PluginManifest { … }
```

| member | signature | notes |
|---|---|---|
| `id` | `id: string` |  |
| `name` | `name: string` |  |
| `version` | `version: string` |  |
| `apiVersion` | `apiVersion: string \| number` | The plugin API this plugin was written against: semver (`"1.0"`), or a bare major (`1`, read as `1.0`). Checked by `pluginApiProblem` before any of its code runs. |
| `description` | `description?: string` |  |
| `host` | `host?: string` | Host module, relative to the plugin dir. Absent ⇒ `host.mjs`. |
| `settings` | `settings?: PluginField[]` |  |
| `actions` | `actions?: PluginActionDef[]` |  |
| `toggles` | `toggles?: PluginToggleDef[]` |  |
| `env` | `env?: string[]` | Environment variables the host module reads through `api.env()`. The phone shows set/unset for each, never a value. Only these are readable. |
| `answers` | `answers?: boolean` | The plugin may ANSWER a choice box unattended (`api.answer`). The core then draws its own per-session switch, "let <name> answer", default OFF, and the gate in `answerGate` decides every call — the plugin cannot skip it. |
| `web` | `web?: string` | In-repo extensions only: the web half's source module, relative to the extension dir (`web/index.ts`). Compiled into the phone bundle, never loaded from outside the repo. |
| `backends` | `backends?: string[]` | The backend ids this plugin will register with `api.backend()`. An id not listed here is refused at registration, so what a plugin may add to the launcher is readable from its manifest before it runs. |
| `optional` | `optional?: boolean` | In-repo extensions only: the person may switch this one OFF (an ordinary builtin is always on). Its default comes from the install's `release.json` (`builtins`, written from `deploy/ship.json`), else on. Listed on the phone so the switch can be reached. |
| `experimental` | `experimental?: boolean` | Labelled "experimental" wherever its backends are listed (`BackendInfo.experimental`). |

## PluginView

*interface*

What the phone knows about one installed plugin.

```ts
export interface PluginView { … }
```

| member | signature | notes |
|---|---|---|
| `manifest` | `manifest: PluginManifest` |  |
| `source` | `source: string` | Where it was loaded from — shown, so "which copy is this?" has an answer. |
| `enabled` | `enabled: boolean` | The person's switch. A disabled plugin is not activated at all. |
| `state` | `state: "active" \| "error" \| "off"` | `active` = activated; `error` = failed to load or activate (`error` says why, verbatim); `off` = disabled by the person. |
| `error` | `error?: string` |  |
| `values` | `values: Record<string, PluginValue>` | Current settings, defaults filled in. |
| `status` | `status?: PluginStatus \| null` | One line the plugin sets about itself ("no GEMINI_API_KEY — set it via the secret sheet"). |
| `env` | `env?: Record<string, boolean>` | Declared env names → set or not. |

## PluginStatus

*interface*

```ts
export interface PluginStatus { … }
```

| member | signature | notes |
|---|---|---|
| `tone` | `tone: "ok" \| "warn" \| "bad"` |  |
| `text` | `text: string` |  |

## AnswerSuggestion

*interface*

A plugin's suggested answer for a session's current question. Rendered by
 the existing inline-suggestion UI; a person still taps unless the plugin
 answered through the gate.

```ts
export interface AnswerSuggestion { … }
```

| member | signature | notes |
|---|---|---|
| `by` | `by: string` | Plugin id and display name. |
| `byName` | `byName: string` |  |
| `choice` | `choice: number \| null` | 1-based option for a choice box; null when abstaining or for free text. |
| `reply` | `reply?: string` | A drafted free-text reply (a question with no box). |
| `confidence` | `confidence: number` |  |
| `rationale` | `rationale: string` |  |
| `model` | `model?: string` |  |

## PluginBadge

*interface*

A small label a plugin puts on a session row ("on · 3/10", "paused").

```ts
export interface PluginBadge { … }
```

| member | signature | notes |
|---|---|---|
| `text` | `text: string` |  |
| `tone` | `tone: "ok" \| "warn" \| "bad" \| "dim"` |  |

## DecisionLogEntry

*interface*

One row of the DECISION LOG — every automatic thing done or proposed on a
session's behalf: a usage-limit auto-continue (`source: "limit"`) or a
plugin's suggestion/answer (`source: "plugin"`, `plugin` set).

```ts
export interface DecisionLogEntry { … }
```

| member | signature | notes |
|---|---|---|
| `id` | `id: string` |  |
| `ts` | `ts: number` |  |
| `sessionId` | `sessionId: string` |  |
| `sessionTitle` | `sessionTitle: string` |  |
| `source` | `source: "limit" \| "plugin"` |  |
| `plugin` | `plugin?: string` |  |
| `phase` | `phase?: "blocked" \| "attempt" \| "resumed" \| "gaveup"` | Limit rows: which step. |
| `question` | `question: string` | What was being decided — the box's question, or the limit sentence. |
| `options` | `options: { index: number; label: string; }[]` |  |
| `outcome` | `outcome: string` | What the plugin did: `suggested`, `answered`, `abstained`, `blocked`, `capped`, `error`, … — free words from the plugin, `limit` for limit rows. |
| `choice` | `choice: number \| null` |  |
| `answer` | `answer?: string` |  |
| `confidence` | `confidence?: number` |  |
| `rationale` | `rationale: string` |  |
| `model` | `model?: string` |  |
| `contextSent` | `contextSent?: string` |  |
| `images` | `images?: number` |  |
| `inTok` | `inTok?: number` |  |
| `outTok` | `outTok?: number` |  |
| `error` | `error?: string` |  |
| `archived` | `archived?: boolean` |  |

## PluginPromptEvent

*interface*

A detected choice box, handed to `on("prompt")`.

```ts
export interface PluginPromptEvent { … }
```

| member | signature | notes |
|---|---|---|
| `sessionId` | `sessionId: string` |  |
| `question` | `question: string` |  |
| `options` | `options: { index: number; label: string; }[]` |  |
| `kind` | `kind: "trust" \| "tool" \| "plan" \| "select"` |  |
| `multi` | `multi?: boolean` |  |
| `blocked` | `blocked: boolean` | Core's answer gate would refuse this box whatever the switches say (trust/tool/plan, or a destructive option). Suggesting is still allowed. |

## PluginQuestionEvent

*interface*

A turn that ended asking something with no box, handed to `on("question")`.

```ts
export interface PluginQuestionEvent { … }
```

| member | signature | notes |
|---|---|---|
| `sessionId` | `sessionId: string` |  |
| `question` | `question: string` | The question as the core's `question.ts` read it. |
| `tail` | `tail: string` | The screen's tail it was read from. |
| `forced` | `forced?: boolean` | True when a person asked for a draft now (a session action), bypassing the plugin's own heuristics. |

## PluginSession

*interface*

```ts
export interface PluginSession { … }
```

| member | signature | notes |
|---|---|---|
| `id` | `id: string` |  |
| `title` | `title: string` |  |
| `repoDir` | `repoDir: string` |  |
| `cwd` | `cwd: string` |  |
| `watched` | `watched: boolean` | A phone is looking at it right now. |
| `toggles` | `toggles: Record<string, boolean>` | The plugin's own per-session switches, defaults applied. |
| `mayAnswer` | `mayAnswer: boolean` | The core's "let <plugin> answer" switch (always false without `answers`). |

## HostPluginApi

*interface*

```ts
export interface HostPluginApi { … }
```

| member | signature | notes |
|---|---|---|
| `id` | `readonly id: string` |  |
| `dataDir` | `readonly dataDir: string` | `<state dir>/plugins/<id>/` — the plugin's own files. Created on activate. |
| `stateDir` | `readonly stateDir: string` | The daemon's global state dir (WATERPLANE_STATE_DIR, outside the root) — read-only by convention; for migrating old state. |
| `usmcDir` | `readonly usmcDir: string` | @deprecated the same path as `stateDir`; kept one release for plugins written against it. |
| `log` | `log(msg: string): void` |  |
| `settings` | `settings(): Record<string, PluginValue>` |  |
| `onSettings` | `onSettings(fn: (values: Record<string, PluginValue>) => void): () => void` | Called after the person changes a setting. Returns an unsubscribe. |
| `seedSettings` | `seedSettings(values: Record<string, PluginValue>): void` | Seed settings once (e.g. migrated from an older store). Keys not declared in the manifest are ignored. Never overwrites a value the person set. |
| `setStatus` | `setStatus(s: PluginStatus \| null): void` |  |
| `env` | `env(name: string): string \| undefined` | Declared env names only; anything else reads undefined. Read live, so a secret set from the phone applies without a restart. |
| `on` | `on(event: "prompt", fn: (e: PluginPromptEvent) => void \| Promise<void>): () => void` |  |
| `on` | `on(event: "question", fn: (e: PluginQuestionEvent) => void \| Promise<void>): () => void` |  |
| `on` | `on(event: "action", fn: (e: { action: string; sessionId?: string; }) => { ok: boolean; message: string; } \| Promise<{ ok: boolean; message: string; }>): () => void` | A declared action was tapped. The returned message is shown on the phone. |
| `session` | `session(id: string): PluginSession \| null` |  |
| `scrollback` | `scrollback(id: string, lines?: number): string` | The last `lines` lines of the rendered screen/scrollback, plain text. |
| `readRepoFile` | `readRepoFile(sessionId: string, relPath: string, maxBytes?: number): string \| null` | A file inside the session's repo (containment-guarded); null if absent or outside. |
| `inlineImages` | `inlineImages(sessionId: string, max?: number): { mime: string; data: string; relPath: string; }[]` | Recent images in the session repo's inbox/outbox, base64, newest first. |
| `suggest` | `suggest(sessionId: string, s: Omit<AnswerSuggestion, "by" \| "byName"> \| null): void` | Show (or clear) a suggestion on the session's current question. |
| `answer` | `answer(sessionId: string, choice: number, why: string): Promise<{ ok: boolean; reason?: string; }>` | Answer the session's CURRENT choice box with option `choice`, through the core's gate: the manifest declared `answers`, the session's "let <plugin> answer" switch is on, the box is the one the event described and is not blocked. Refused ⇒ `{ ok:false, reason }` in words, nothing typed. Every answer lands in the sent log as `source:"plugin"`. |
| `ruleAllows` | `ruleAllows(sessionId: string, key: string, why: string): { ok: boolean; reason?: string; }` | May this plugin answer a request on the strength of a standing rule a PERSON made on this session — by tapping an option its dialog marked `remember: { key }` (`SourceDialog`)? `ok` only for that exact key, on that session, made on a dialog THIS plugin's backend posed, and only when the manifest declared `answers`; every yes is audited like a gated answer (sent row `source:"plugin"`, decision row, autofire note). Memory only: gone on a restart, the session's exit, or this plugin's switch-off (a tmux detach keeps them). |
| `rules` | `rules(sessionId: string): { key: string; label: string; at: number; uses: number; }[]` | The standing rules a person made on this session on this plugin's dialogs, oldest first. |
| `forgetRules` | `forgetRules(sessionId: string): number` | Drop this plugin's standing rules on this session (a "forget" action). Returns how many. |
| `setBadge` | `setBadge(sessionId: string, badge: PluginBadge \| null): void` |  |
| `decision` | `decision(row: Omit<DecisionLogEntry, "id" \| "ts" \| "source" \| "plugin" \| "sessionTitle"> & { sessionTitle?: string; }): void` | Append a decision-log row (`source`/`plugin` are filled in). |
| `meter` | `meter(call: { service: string; model: string; inTok: number; outTok: number; }): void` | Record a paid model call, so it shows in the phone's usage numbers. |
| `notify` | `notify(n: { title: string; body: string; sessionId?: string; urgent?: boolean; }): void` | `urgent` (since 1.6): a request a person must approve now; lands on the loud "approval" kind. Use for nothing else. |
| `claudeUsage` | `claudeUsage(): { sessionPct: number \| null; weeklyPct: number \| null; } \| null` | The Claude plan usage (5-hour / weekly %), or null when unknown. |
| `repo` | `repo(repoId: string): Promise<PluginRepoScope \| null>` | One repo by its id (`GET /api/repos`) or absolute worktree path (realpath); null when unknown or outside the root. |
| `setupCheck` | `setupCheck(fn: (repo: SetupSubject) => ComplianceCheck \| null): () => void` | Contribute a row to every repo's setup checklist. Called on each check of each repo, so keep it cheap; null = no row for this repo. A throw drops the row and becomes the plugin's status line. Returns an unregister. |
| `setupFix` | `setupFix(id: string, fn: (repo: SetupSubject) => SetupFixOutcome): () => void` | Handle the fix a contributed row names in `fix`. Ids the core owns (`gitignore`, `claude-md`, …) or another plugin already took are refused: the call throws, saying which. Returns an unregister. |
| `handle` | `handle(method: string, fn: (args: unknown, caller: PluginCaller) => unknown \| Promise<unknown>): () => void` | Answer `method` when the phone (or core) calls this plugin — the registry's `call(pluginId, method, args)`. One handler per method; a second replaces the first. The second argument (since 1.8) says who asked: the socket's trust tier and, when it presented a paired device's token, that device's id and name. A handler that ignores it is unchanged. A throw is the caller's `{ ok:false, error }` and the plugin's status line. Returns an unregister. |
| `push` | `push(event: string, data?: unknown): string \| null` | Broadcast `event` to every phone as `plugin.push` (the web half's `pushes`). Returns null when sent, or a refusal in words (bad event name, not JSON, over PLUGIN_PUSH_MAX, this plugin not running). |
| `handToAgent` | `handToAgent(repoId: string, prompt: string, opts?: { label?: string; key?: string; fire?: boolean; }): Promise<HandToAgentResult>` | Put `prompt` in that repo's backlog for its agent — the SAME path the phone's and an agent's backlog adds take (`addClientBacklogItem`), so it is contained, persisted, at-most-once by `key`, and fired by the intent ladder. It waits for a person's tap unless `fire` is set, and even then it runs only when the ladder lets it. Never types into a session directly. |
| `backend` | `backend(def: PluginBackendDef): () => void` | Register a backend (a CLI the launcher may spawn). THROWS a sentence — and the plugin is listed broken when that escapes `activate()` — when the id is not in the manifest's `backends`, is already taken, or `caps` names a reader this host does not have. Unregistered when the plugin is switched off; the returned function unregisters it earlier. |
| `screenReader` | `screenReader(name: string, reader: PluginScreenReader): () => void` | Contribute a SCREEN reader under `name` (since 1.1): the reader for a TUI whose choice dialog has no numbers and is answered by walking a selection (`PluginScreenReader`). A backend this plugin registers may then name it in `caps.promptBoxes` — so register the reader FIRST. THROWS a sentence when the name is not a short lowercase word or is already taken (core's own `claude-numbered` among them). Unregistered with the plugin; the returned function earlier. A reader is measured against ONE binary's screen and pinned by the plugin's own fixtures. |
| `storeReader` | `storeReader(name: string, reader: PluginStoreReader): () => void` | Contribute a STORE reader under `name` (since 1.1): the reader of a CLI's own conversation record — a database or files on disk it writes (`PluginStoreReader`). A backend may then name it in `caps.transcript`, and the core asks it for the reader view, the context graph, the tool details, which conversation a session is in, and the backend's ledger. Same rules as `screenReader`: register it before the backend; a taken name (`claude-jsonl`) throws. |
| `thermalReader` | `thermalReader(name: string, reader: PluginThermalReader): () => void` | Contribute a THERMAL reader under `name` (since 1.3): temperature and fan speed for the machine readout, where the core has no reader of its own (macOS keeps the SMC behind root). Asked on the readout's slow cadence, before the core's own sysfs reader; the first reading wins. A reading the core cannot vouch for (non-finite, outside 1..149 °C, a negative rpm) is DROPPED — answer null. A note (`{ note, fix? }`) is shown only when nothing reads. A throw or an answer slower than `PLUGIN_THERMAL_TIMEOUT_MS` counts as no reading. Same naming rules as `screenReader`. |
| `usageProbe` | `usageProbe(def: PluginUsageProbe): () => void` | Contribute a USAGE PROBE (since 1.7): one account's quota as its own segment beside claude's on the usage chip. `claude` or a taken `source` throws. Null = ABSENT; a throw or timeout keeps the last reading until its reset; an unvouchable window is dropped. Returns an unregister. |
| `hookSink` | `hookSink(): string` | The loopback URL this plugin's hooks POST to: `http://127.0.0.1:<port>/api/plugin/<id>/hook`. Loopback only, like the core's own hook sink; a remote caller is refused. |
| `onHook` | `onHook(fn: (payload: unknown, hold: PluginHookHold) => unknown \| Promise<unknown>, opts?: { maxHoldMs?: number; }): () => void` | Receive the posts to `hookSink()`. The handler's return value (JSON) is the HTTP response body; `undefined` answers `{}`. Return a Promise to HOLD the response (a CLI that waits on its hook for a permission answer): the core answers `{}` itself after `maxHoldMs` (default `PLUGIN_HOOK_HOLD_DEFAULT_MS`, at most `PLUGIN_HOOK_HOLD_MAX_MS`) and calls `hold.onExpired` — so keep it BELOW the CLI's own hook timeout, or the CLI kills the hook first. One handler per plugin; a second replaces the first. A throw answers `{}` and becomes the status line. |
| `route` | `route(method: PluginHttpMethod, pattern: string, fn: (req: PluginHttpRequest) => PluginHttpReply \| Promise<PluginHttpReply>): () => void` | Serve an HTTP route (since 1.2) at `/api/plugin/<id>/<pattern>`. It sits behind the SAME origin/Host gate and token gate as every core `/api` route — never loopback-only, never exempt. `pattern` is `/`-separated: literal segments, `:name` (exactly one segment, handed over RAW in `params`), and a trailing `*` (what follows, in `rest`). JSON in and out: the body is parsed (`{}` when there is none or it is not JSON; past `PLUGIN_ROUTE_BODY_MAX` the request is a 413), and the reply's `body` goes back as JSON with its `status` (default 200). A GET must not change anything — the core's rule for every `/api` GET. THROWS a sentence for a method outside `PluginHttpMethod`, a malformed pattern, one whose first segment is `hook` (the sink's), or one this plugin already serves for that method. A throw in the handler answers 500 `{ ok:false, error }` and becomes the status line. Unregistered with the plugin; the returned function earlier. |
| `stream` | `stream(name: string, handlers: PluginStreamHandlers): () => void` | Since 1.4. Serve live stream `name` to the sockets that open it: binary frames on the one socket, never durable or retried (`shared/stream.ts` has the whole contract). THROWS on a bad name or one already served. The returned function ends every open subscription. |
| `offerFile` | `offerFile(file: string, opts: import("./pluginfile.js").PluginFileOfferOpts): import("./pluginfile.js").PluginFileOffer` | Since 1.5: ONE `dataDir` file to the phone's download path, deleted once fetched or at its TTL (`pluginfile.ts`). |

## PluginHttpMethod

*type*

The verbs a plugin route may answer.

```ts
export type PluginHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
```

## PLUGIN_ROUTE_BODY_MAX

*const*

The largest JSON body a plugin route is handed.

```ts
export const PLUGIN_ROUTE_BODY_MAX = 1000000;
```

## PluginHttpRequest

*interface*

What a plugin route's handler is handed.

```ts
export interface PluginHttpRequest { … }
```

| member | signature | notes |
|---|---|---|
| `method` | `readonly method: PluginHttpMethod` |  |
| `params` | `readonly params: Readonly<Record<string, string>>` | The pattern's `:name` segments, raw (still percent-encoded). |
| `rest` | `readonly rest: readonly string[]` | What the pattern's trailing `*` matched, one entry per segment. |
| `query` | `readonly query: Readonly<Record<string, string>>` | The query string, the first value of each key. |
| `body` | `readonly body: unknown` | The parsed JSON body; `{}` when there is none. Unchecked: validate it. |

## PluginHttpReply

*interface*

What a plugin route answers: an HTTP status (default 200) and a JSON body (default `{}`).

```ts
export interface PluginHttpReply { … }
```

| member | signature | notes |
|---|---|---|
| `status` | `readonly status?: number` |  |
| `body` | `readonly body?: unknown` |  |

## PLUGIN_BACKEND_ID_RE

*const*

A backend id: a short lowercase word — the same rule the host's registry applies.

```ts
export const PLUGIN_BACKEND_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
```

## PluginLaunchRequest

*interface*

What `launchArgs` is handed. `hookPort` is the daemon's loopback port.

```ts
export interface PluginLaunchRequest { … }
```

| member | signature | notes |
|---|---|---|
| `resumeMode` | `readonly resumeMode?: "continue" \| "pick" \| "fork"` |  |
| `resumeSessionId` | `readonly resumeSessionId?: string` |  |
| `launch` | `readonly launch: LaunchOpts` |  |
| `hookPort` | `readonly hookPort: number` |  |
| `cwd` | `readonly cwd?: string` | The session's working directory and the host's own id for it — for a backend that brings up a per-session server before its TUI (opencode's hybrid). Every other backend ignores them. |
| `hostSessionId` | `readonly hostSessionId?: string` |  |
| `forkAtTurn` | `readonly forkAtTurn?: string` | Fork `resumeSessionId` AT this turn — only reaches a backend with `caps.forkVia: "server"`. |

## PluginLaunchPlan

*interface*

What `launchArgs` answers. `sessionId` is CLAUDE's conversation uuid only (a
reader turns it into a path under claude's projects dir); any other CLI's id
rides on `backendSessionId`, and only when the launch KNOWS it. `env` is
merged after `spawnEnv` into the pane's environment.

```ts
export interface PluginLaunchPlan { … }
```

| member | signature | notes |
|---|---|---|
| `args` | `readonly args: string[]` |  |
| `sessionId` | `readonly sessionId?: string` |  |
| `backendSessionId` | `readonly backendSessionId?: string` |  |
| `createsRecord` | `readonly createsRecord?: boolean` |  |
| `env` | `readonly env?: Readonly<Record<string, string>>` |  |
| `exec` | `readonly exec?: string` | Spawn THIS program in the PTY instead of `bin()` (absolute path), `args` as its argv — e.g. a POSIX `sh` that waits for the backend's own server, then `exec`s the CLI. |

## PluginBackendDef

*interface*

A backend a plugin registers: the host descriptor's shape with the reader
names as plain strings — a name this host has no reader for is refused at
registration in words, never armed. Booleans left out are false; `delivery`
fields left out are the "no anchor" defaults (`submitKey` "\r", every regex
null, no local commands), which is the shape `deliver.ts` already falls back
to. A plugin backend is never on the claude health board (`healthScope` is
the core's to say, and it says false).

`delivery`, `caps` and `sources` may be GETTERS (a knob read per call switches
them): the core reads them through on every access and never copies them at
registration. Each answer must name readers this host has — checked against
the answer at registration.

```ts
export interface PluginBackendDef { … }
```

| member | signature | notes |
|---|---|---|
| `id` | `id: string` |  |
| `label` | `label: string` |  |
| `bin` | `bin(): string` |  |
| `spawnEnv` | `spawnEnv?: Readonly<Record<string, string>>` |  |
| `launchArgs` | `launchArgs(req: PluginLaunchRequest): PluginLaunchPlan` |  |
| `delivery` | `delivery?: { submitKey?: string; textThenSubmitDelayMs?: number; requiresChannel?: boolean; pastePlaceholder?: RegExp \| null; composerCursorRe?: RegExp \| null; composerRuleRe?: RegExp \| null; composerPlaceholderRe?: RegExp \| null; trustPromptRe?: RegExp \| null; isLocalCommand?(text: string): boolean; startsNoTurn?(text: string): boolean; }` |  |
| `caps` | `caps: { hooks: "settings-inject" \| "plugin-inject" \| "none"; promptBoxes: false \| string; transcript: string; slash?: "claude" \| "own" \| "none"; contextMeter?: boolean; usageLimits?: boolean; usageProbe?: boolean; asking?: boolean; remoteControl?: boolean; effort?: boolean; permissionModes?: PermissionMode[]; forkVia?: "jsonl" \| "server" \| false; turns?: boolean; }` |  |
| `models` | `models(): Promise<{ aliases: string[]; ids: string[]; where?: Record<string, "local" \| "hosted">; zeroCost?: string[]; contextWindow?: Record<string, number>; unavailable?: string; note?: string; }>` | The model catalogue. Empty ⇒ a free-text field on the phone, never a guessed list. |
| `sources` | `sources?: BackendSources` | A source per fact beside the screen readers (`backendsources.ts`). |

## PLUGIN_READER_NAME_RE

*const*

A reader name: the same short lowercase word a backend id is.

```ts
export const PLUGIN_READER_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
```

## PluginScreenSpan

*interface*

One run of cells painted alike on a rendered row. Colour keys are `def`, `pal:<n>` or `rgb:<n>`.

```ts
export interface PluginScreenSpan { … }
```

| member | signature | notes |
|---|---|---|
| `from` | `readonly from: number` | Column of the first cell in the run. |
| `to` | `readonly to: number` | Column of the last cell in the run, inclusive. |
| `text` | `readonly text: string` | The characters in the run, one per cell — spaces included. |
| `bg` | `readonly bg: string` |  |
| `fg` | `readonly fg: string` |  |

## PluginScreenRow

*interface*

One row of the session's rendered screen, as a screen reader is handed it.

```ts
export interface PluginScreenRow { … }
```

| member | signature | notes |
|---|---|---|
| `text` | `readonly text: string` |  |
| `spans` | `spans: PluginScreenSpan[]` | Left to right, contiguous, covering every column of the grid. |

## PluginScreenBox

*interface*

What a screen reader parsed: which option is armed (1-based) and how many there are.

```ts
export interface PluginScreenBox { … }
```

| member | signature | notes |
|---|---|---|
| `armed` | `readonly armed: number` |  |
| `options` | `readonly options: readonly unknown[]` |  |

## PluginScreenReader

*interface*

A screen reader for a dialog with NO numbers, answered by walking the selection onto an option
and pressing Return. The core keeps the shape every box reader has — a cheap byte gate, an
expensive render, a miss budget so a half-drawn repaint cannot retire a live box, a walk that
RE-READS after every key and refuses rather than pressing Return on the wrong row — and asks the
reader only the questions that are about one TUI's pixels.

Every member must be pure and must not throw; a throw reads as "no box".

```ts
export interface PluginScreenReader<B extends PluginScreenBox = PluginScreenBox> { … }
```

| member | signature | notes |
|---|---|---|
| `candidate` | `candidate(strippedTail: string): boolean` | The cheap gate, on the ANSI-stripped tail of the scrollback: could a dialog be up at all? |
| `read` | `read(rows: PluginScreenRow[]): B \| null` | The rendered rows, parsed: a box when its armed option is readable, else null. |
| `prompt` | `prompt(box: B): DetectedPrompt` | The box as the phone is shown it. Options numbered 1.., `nav: true`. |
| `stillUp` | `stillUp(rows: PluginScreenRow[]): boolean` | Rows that did NOT parse: is the dialog still drawn (spend a miss, keep the box) or gone? |
| `navTo` | `navTo(box: B, choice: number): { dir: "left" \| "right"; } \| null` | One step toward option `choice` — null when the box has no such option. |

## PluginStoreLook

*interface*

What one pass of conversation discovery is handed (`PluginStoreReader.discover`).

```ts
export interface PluginStoreLook { … }
```

| member | signature | notes |
|---|---|---|
| `dir` | `readonly dir: string` | The session's working directory, realpath-resolved. |
| `ownRow` | `readonly ownRow: boolean` | Did this session's own launch write a conversation row (`createsRecord`)? |
| `spawnedAt` | `readonly spawnedAt: number` |  |
| `probe` | `readonly probe?: { readonly text: string; readonly at: number; }` | The last prompt this host WATCHED land on screen, and when, while the id is unknown. |
| `adopted` | `readonly adopted: ReadonlySet<string>` | Conversation ids other live sessions have already adopted. |
| `carry` | `readonly carry: unknown` | What the previous pass handed back as `carry` (null on the first, and after a new prompt). |
| `now` | `readonly now: number` |  |

## PluginStoreContext

*interface*

The context series out of a store, before the core puts a window on it.

```ts
export interface PluginStoreContext { … }
```

| member | signature | notes |
|---|---|---|
| `samples` | `readonly samples: ContextSample[]` |  |
| `events` | `readonly events: ContextEvent[]` |  |
| `model` | `readonly model: string \| null` | The model the LAST assistant message ran under — the window is that model's. Null when unknown. |
| `truncated` | `readonly truncated: boolean` |  |
| `updatedAt` | `readonly updatedAt: number` | The change stamp a poll compares against. |

## PluginStoreReader

*interface*

A store reader: the CLI's own conversation record, read and never written. Every member is
keyed by the CLI's own conversation id (`SessionInfo.backendSessionId`) and DEGRADES TO NULL —
a store that cannot be read is an absent fact, never a thrown error and never a zero.

```ts
export interface PluginStoreReader { … }
```

| member | signature | notes |
|---|---|---|
| `source` | `readonly source: TranscriptDoc["source"]` | The `TranscriptDoc.source` the reader view carries for this store. |
| `updatedAt` | `updatedAt(conversationId: string): number \| null` | The store's own change stamp for one conversation; null = unknown. |
| `pollUnchanged` | `pollUnchanged(stamp: number \| null, since: number): boolean` | May a poll answer "unchanged" for this stamp against the client's `since`? |
| `transcript` | `transcript(conversationId: string, detail: "lite" \| "full"): Omit<TranscriptDoc, "sessionId" \| "source"> \| null` | The conversation as the reader's document; null when the store or the conversation is not there. |
| `toolDetails` | `toolDetails(conversationId: string, turnId: string): Record<string, TranscriptToolDetail> \| null` | The inputs/results one turn's `lite` tool blocks withheld. |
| `contextSeries` | `contextSeries(conversationId: string): PluginStoreContext \| null` | How full the context window has been, over time. |
| `discover` | `discover(look: PluginStoreLook): { id: string \| null; carry: unknown; }` | One pass of finding WHICH conversation a session is in, for a backend whose launch does not know the id. `id` only when exactly one candidate answers — a guess points the reader at somebody else's conversation. `carry` is handed back on the next pass. |
| `ledger` | `ledger?(maxAgeMs: number \| undefined): Promise<unknown>` | The backend's own ledger, served verbatim at `GET /api/tokenstats/<backendId>` for a backend whose `caps.transcript` names this reader and which has no `sources.tokens`. JSON; a store that cannot be read answers `{ available: false, reason }`, never throws. |

## PLUGIN_THERMAL_TIMEOUT_MS

*const*

How long the core waits for a contributed thermal reader before it counts as no reading.

```ts
export const PLUGIN_THERMAL_TIMEOUT_MS = 8000;
```

## PluginThermalReading

*type*

What a contributed thermal reader answers (since 1.3). A READING carries what it read and
which tool read it (`source`, shown beside the figures — the numbers are that tool's); a
NOTE says why there is none and, optionally, shell commands that would fill it in (drawn as
copy blocks); null is "nothing to say".

```ts
export type PluginThermalReading = {
    cpuTempC?: number;
    gpuTempC?: number;
    fans: FanRow[];
    source: string;
} | {
    note: string;
    fix?: string[];
} | null;
```

## PluginThermalReader

*interface*

A thermal reader (`api.thermalReader`).

```ts
export interface PluginThermalReader { … }
```

| member | signature | notes |
|---|---|---|
| `read` | `read(): Promise<PluginThermalReading>` |  |

## PluginUsageProbe

*interface*

A usage probe (`api.usageProbe`, since 1.7): one account's quota as a `UsageReading`.

```ts
export interface PluginUsageProbe { … }
```

| member | signature | notes |
|---|---|---|
| `source` | `source: UsageSourceId` | The reading's id: short, lowercase, `[a-z0-9:_-]` (`USAGE_SOURCE_RE`). Never `claude`. |
| `label` | `label: string` | As drawn on the chip: `"Copilot"`. |
| `backend` | `backend?: string` | The backend id this account belongs to, when there is one (a session header shows its own). |
| `everyMs` | `everyMs?: number` | Poll period while polling is on; default 15 min, never less than 60 s. |
| `probe` | `probe(): Promise<UsageReading \| null>` | A reading, or null when there is nothing to say (the source is then absent). |

## PLUGIN_USAGE_PROBE_TIMEOUT_MS

*const*

How long a usage probe may take before it counts as a failure (its last reading is kept).

```ts
export const PLUGIN_USAGE_PROBE_TIMEOUT_MS = 20000;
```

## PluginDoctorCheck

*interface*

One line of the preflight report a builtin's `doctor` contributes.

```ts
export interface PluginDoctorCheck { … }
```

| member | signature | notes |
|---|---|---|
| `id` | `id: string` | Short stable name, e.g. `opencode-binary`. |
| `status` | `status: "ok" \| "warn" \| "fail"` |  |
| `detail` | `detail: string` |  |
| `fix` | `fix?: string` |  |

## PLUGIN_HOOK_HOLD_DEFAULT_MS

*const*

How long the core holds a hook's HTTP response for a pending answer by default, and at most.

```ts
export const PLUGIN_HOOK_HOLD_DEFAULT_MS = 8000;
```

## PLUGIN_HOOK_HOLD_MAX_MS

*const*

```ts
export const PLUGIN_HOOK_HOLD_MAX_MS = 60000;
```

## PluginHookHold

*interface*

What an `onHook` handler is handed beside the payload.

```ts
export interface PluginHookHold { … }
```

| member | signature | notes |
|---|---|---|
| `maxHoldMs` | `readonly maxHoldMs: number` | How long the core holds this response before answering `{}` itself. |
| `onExpired` | `onExpired(fn: () => void): void` | Called once when the core answered `{}` instead of the handler: the hold ran out, or the plugin was switched off. The CLI then goes its own way. |

## PluginRepoScope

*interface*

One repo, as a plugin may look at it (`api.repo(repoId)`): its files and git
facts through the core's containment guard — a path that leaves the worktree,
or names a secret (`.env*`), reads as null, never as an error.

```ts
export interface PluginRepoScope { … }
```

| member | signature | notes |
|---|---|---|
| `id` | `readonly id: string` |  |
| `name` | `readonly name: string` |  |
| `branch` | `readonly branch: string` |  |
| `isPrimary` | `readonly isPrimary: boolean` |  |
| `worktree` | `readonly worktree: string` | Absolute path of the worktree. |
| `readFile` | `readFile(relPath: string, maxBytes?: number): string \| null` | A text file inside the worktree; null if absent, outside, binary or a secret. |
| `listDir` | `listDir(relPath?: string): { name: string; dir: boolean; }[] \| null` | One directory's entries (not recursive); null if absent or outside. Secrets are left out. |
| `git` | `git(): { branch: string; head: string \| null; changed: number; } \| null` | HEAD and the working tree, read now — synchronous subprocesses, not from a setup check. `head` is null in a repo with no commit. |

## SetupSubject

*interface*

What a contributed setup check or fix is handed: the worktree it is about.

```ts
export interface SetupSubject { … }
```

| member | signature | notes |
|---|---|---|
| `worktree` | `worktree: string` | Absolute path of the worktree being checked. |

## SetupFixOutcome

*interface*

A contributed fix's outcome: `applied` says whether it changed anything, `note` says what, in words.

```ts
export interface SetupFixOutcome { … }
```

| member | signature | notes |
|---|---|---|
| `applied` | `applied: boolean` |  |
| `note` | `note: string` |  |

## HandToAgentResult

*type*

`api.handToAgent`'s answer: the intent id the prompt now waits under, or why not.

```ts
export type HandToAgentResult = {
    ok: true;
    intentId: string;
    existing: boolean;
    state?: string;
} | {
    ok: false;
    reason: string;
};
```

## HostPluginModule

*interface*

A plugin module's shape. `deactivate` runs on disable and on shutdown
(started, never awaited there). `shutdown` runs ONLY as the daemon exits, after
every store is flushed, SYNCHRONOUSLY and whether or not the plugin is still
switched on — the place to kill child processes it owns (a switched-off
plugin's running sessions keep their children until then).

```ts
export interface HostPluginModule { … }
```

| member | signature | notes |
|---|---|---|
| `activate` | `activate(api: HostPluginApi): void \| Promise<void>` |  |
| `deactivate` | `deactivate?(): void \| Promise<void>` |  |
| `shutdown` | `shutdown?(): void` |  |
| `doctor` | `doctor?(req: { usedBackends: readonly string[]; }): Promise<PluginDoctorCheck[]>` | Lines for the preflight report (`npm run doctor` and the boot summary), since 1.1. Asked of the IN-REPO extensions only, WITHOUT `activate` — the doctor loads no plugin — so it must stand alone. `usedBackends` are the backend ids this host's recent sessions ran on: a line about a binary nobody asked for says "something is wrong" about nothing, so answer [] then. Never throws; a throw drops the lines. |

## handleAll

*function*

Register every method of a typed table with `api.handle`; returns one unregister.
Args arrive from the wire UNCHECKED — the types are a convenience, each handler validates.

```ts
export function handleAll<M extends PluginMethods>(api: Pick<HostPluginApi, "handle">, fns: {
    [K in keyof M & string]: (args: M[K]["args"], caller: PluginCaller) => M[K]["result"] | Promise<M[K]["result"]>;
}): () => void;
```

## manifestProblems

*function*

Validate a parsed manifest. Returns the problems in words (empty =
valid). Unknown fields are allowed — a newer manifest on an older daemon
loads with what it understands.

```ts
export function manifestProblems(m: unknown): string[];
```

## cleanPluginValue

*function*

A value as the manifest allows it, or undefined (refused, never repaired).

```ts
export function cleanPluginValue(f: PluginField, v: unknown): PluginValue | undefined;
```

## pluginValues

*function*

The settings with defaults filled in.

```ts
export function pluginValues(m: PluginManifest, stored: Record<string, unknown>): Record<string, PluginValue>;
```
