/**
 * Plugins — the contract between the daemon, the phone, and code a user
 * provides from OUTSIDE this repo. Reasoning: docs/notes/plugins.md.
 *
 * A plugin EXTENDS the daemon. It is a directory with a manifest (`PLUGIN_MANIFEST`) (the
 * `PluginManifest` below) and a HOST module (`host.mjs`, ESM) the daemon
 * imports and calls `activate(api: HostPluginApi)` on. It runs in the daemon's
 * process with the daemon's trust — the daemon already spawns `claude`, so a
 * plugin crosses no boundary the daemon has not — but it only SEES what the API
 * hands it, so the core's rules (the answer gate, containment, metering) cannot
 * be skipped by accident.
 *
 * Not to be confused with what makes a REPO aware of the product (the core's own
 * skill, handed to every spawned `claude`): that is the daemon telling a
 * repo's agent what it offers, owned by the core, and no plugin's business.
 *
 * The phone runs a plugin's UI only as an in-repo extension's web half, built
 * into the bundle (docs/notes/plugins.md, "Trust") — never loaded lazily, never
 * outside the SDK. A plugin with no UI code DECLARES what it shows here
 * (settings fields, action buttons, per-session switches, a badge, a status
 * line, rows in the decision log, a suggested answer) and the app's own
 * components draw it.
 *
 * Pure types + a validator. Both ends and plugin authors read this file.
 *
 * The same `HostPluginApi` is handed to the IN-REPO extensions under
 * `packages/extensions/<id>/` (the static registry, always on) — one object
 * shape for both, so moving an extension out of the repo is a folder move.
 */
import type { PeerKind } from "./wire/messages.js";
import type { PluginStreamHandlers } from "./stream.js";
import { maturityProblems } from "./pluginmaturity.js";
import type { ComplianceCheck } from "./wire/repo.js";
import type { ContextEvent, ContextSample, DetectedPrompt } from "./wire/session.js";
import type { TranscriptDoc, TranscriptToolDetail } from "./wire/transcript.js";
import type { BackendSources } from "./backendsources.js";
import type { PluginThermalReader, PluginUsageProbe } from "./pluginreadings.js";
import type { BackendCapsV2, BackendFacts, PluginLaunchPlan, PluginLaunchRequest } from "./pluginlaunch.js";
import type { BindLook, BindVerdict } from "./bindconv.js";
import { BRAND, LEGACY } from "./brand.js";

/**
 * The plugin API's version, semver `MAJOR.MINOR.PATCH`. It versions everything a plugin
 * author builds against: `HostPluginApi`, the manifest (`PluginManifest`), the event
 * payloads, the module shape (`HostPluginModule`) and the backend descriptor
 * (`PluginBackendDef`).
 *
 * **Compatibility rule** (`pluginApiProblem`, run by the loader on every manifest): a
 * plugin declaring `apiVersion` `A.B` loads on a host speaking `X.Y` exactly when
 * `A === X` and `B <= Y`. Anything else is refused with a sentence and the plugin is
 * listed broken (`state: "error"`), never loaded half-way. The patch number is not
 * compared: a plugin cannot depend on one.
 *
 * A bare number (`"apiVersion": 1`, every manifest written before semver) means `1.0`.
 *
 * **What bumps what:**
 * - MAJOR (breaking): removing or renaming anything exported here; changing a member's
 *   type so an existing call no longer compiles or no longer means the same; making an
 *   optional field required, on either side; a manifest field the loader newly REFUSES;
 *   a call that used to succeed now throwing or being refused for input it used to
 *   accept; an event a plugin relied on no longer firing.
 * - MINOR (additive): a new API method, event, manifest field, optional field, backend
 *   cap or reader name. A plugin using one declares the new minor, so an older host
 *   refuses it in words instead of failing at the first call.
 * - PATCH: wording, documentation and fixes that change no shape — nothing a plugin
 *   can observe through types.
 *
 * **2.0** (backend contract v2, `PLUGIN_API_V2_DOC`): `PluginBackendDef` replaces the v1
 * reader caps (`hooks`, `promptBoxes`, `transcript`, `contextMeter`, `usageLimits`,
 * `usageProbe`, `asking`, `forkVia` inside caps) with `facts` — one ordered provider list per
 * fact — and `launchArgs` with an async `prepare`; it adds `measured`. A 1.x manifest that
 * lists `backends` is refused in words; there is no shim. Everything else in 2.0 is additive,
 * so a 1.x plugin that registers NO backend (a reader, a panel, a usage probe) still loads:
 * `V1_LAST_MINOR` is the newest 1.x it may declare.
 *
 * **2.1** (additive): `HostPluginApi.supports` (`dialogKeysThenTyped`), and a source turn's
 * `ended(at)` waits ≤1.5 s for a `sources.context` sample stamped `>= at` — no end-gate hold needed.
 * **2.2** (additive, `docs/plans/backend-parity-v3.md` §7): facts + slots `mode`/`commands`, Tab and
 * Shift+Tab in `SourceKeys`, context `window` + `compactions`, `tokens.session`. 2.1 plugins load as-is.
 */
export const PLUGIN_API_VERSION = "2.2.0";

/** Where the 2.0 backend contract is written down; the 1.x refusal names it. */
export const PLUGIN_API_V2_DOC = "docs/plans/backend-contract-v2.md";

/** The last 1.x minor: a 1.0–1.8 plugin with no `backends` in its manifest loads on 2.x. */
export const V1_LAST_MINOR = 8;

/** Who a `handle` method was called by (since 1.8): the socket's trust tier, and the paired
 *  device's id/name (null: no token, or an in-process call). Never a proof beyond pairing. */
export interface PluginCaller { kind: PeerKind; deviceId: string | null; deviceName: string | null }

/** A parsed `MAJOR.MINOR.PATCH`. */
export interface PluginApiVersion { major: number; minor: number; patch: number }

/** Parse a manifest's `apiVersion`: a semver string (`"1.2"` or `"1.2.3"`) or a bare
 *  non-negative integer (`1` ⇒ `1.0.0`). Anything else ⇒ null. */
export function parsePluginApiVersion(v: unknown): PluginApiVersion | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? { major: v, minor: 0, patch: 0 } : null;
  if (typeof v !== "string") return null;
  const m = /^(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?$/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) } : null;
}

/**
 * Why a plugin declaring `declared` cannot load on a host speaking `host`
 * (default: this one), in a sentence — or null when it can. The rule is
 * `PLUGIN_API_VERSION`'s: same major, minor no newer than the host's.
 */
export function pluginApiProblem(declared: unknown, host: string = PLUGIN_API_VERSION, opts: { backends?: boolean } = {}): string | null {
  const h = parsePluginApiVersion(host);
  if (!h) throw new Error(`PLUGIN_API_VERSION ${host} is not semver`);
  const range = `${h.major}.0 up to ${h.major}.${h.minor}`;
  const said = `apiVersion is ${JSON.stringify(declared)}; this daemon speaks ${host}`;
  const d = parsePluginApiVersion(declared);
  if (!d) return `${said}, and loads plugins written for ${range} — "apiVersion" must be a version like "${h.major}.${h.minor}"`;
  // 2.0 broke only the backend descriptor: a 1.x plugin registering no backend is unaffected.
  if (h.major === 2 && d.major === 1 && d.minor <= V1_LAST_MINOR && opts.backends === false) return null;
  if (d.major !== h.major) {
    // A 1.x plugin on a 2.x daemon: v1 is broken, not shimmed — the sentence names where 2.0 is written down.
    const where = d.major < h.major && h.major === 2 ? ` — the 2.0 contract is ${PLUGIN_API_V2_DOC}` : "";
    return `${said}, and loads plugins written for ${range}; ${d.major > h.major ? "this plugin needs a newer daemon" : "this plugin was written for an older API and must be updated"}${where}`;
  }
  if (d.minor > h.minor) return `${said}, and loads plugins written for ${range}; this plugin needs a newer daemon`;
  return null;
}

/** What a plugin's methods take and answer — a type-level convenience only: args arrive from
 *  the wire UNCHECKED, so every handler validates. */
export type PluginMethods = { [method: string]: { args: unknown; result: unknown } };

/** What `plugin.call` resolves to on the phone. Never rejects. */
export type PluginCallResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

/** `plugin.push` event names, `plugin.call` ack ids, and the byte caps on args and pushed data. */
export const PLUGIN_EVENT_RE = /^[a-z][a-zA-Z0-9._-]{0,39}$/;
export const PLUGIN_ACK_RE = /^[A-Za-z0-9._:-]{1,80}$/;
export const PLUGIN_ARGS_MAX = 64 * 1024;
export const PLUGIN_PUSH_MAX = 64 * 1024;

/** `[a-z][a-z0-9-]{1,39}` — also the plugin's directory under `<state dir>/plugins/` (the host state dir, not the config dir). */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

export type PluginValue = boolean | string | number;

/** One setting, drawn by the app in the plugin's section of Settings. */
export type PluginField =
  | { kind: "switch"; key: string; label: string; note?: string; default: boolean }
  | { kind: "choice"; key: string; label: string; note?: string; default: string;
      options: { value: string; label: string }[] }
  | { kind: "number"; key: string; label: string; note?: string; default: number;
      min: number; max: number; step?: number; unit?: string }
  | { kind: "text"; key: string; label: string; note?: string; default: string;
      multiline?: boolean; placeholder?: string };

/** A button. `global` ones sit in the plugin's Settings section; `session` ones
 *  in a session's toolbar menu and receive that session's id. */
export interface PluginActionDef {
  id: string;
  label: string;
  note?: string;
  scope: "global" | "session";
}

/** A per-session switch the plugin reads (`api.session(id).toggles[id]`).
 *  Drawn in the session's toolbar menu; `default` applies until someone flips it. */
export interface PluginToggleDef {
  id: string;
  label: string;
  note?: string;
  default: boolean;
}

/** The manifest's file name, current and every past identity's (newest first;
 *  the loader accepts a legacy one with a deprecation line). */
export const PLUGIN_MANIFEST: string = BRAND.pluginManifest;
export const LEGACY_PLUGIN_MANIFESTS: readonly string[] = LEGACY.map((l) => l.pluginManifest);

/** `<config dir>/<PLUGIN_PATHS_FILE>` lists plugin directories kept elsewhere:
 *  `{ "paths": ["~/code/my-plugin"] }` (`~` expanded, relative to the config dir).
 *  Not the STATE dir's `plugins.json`, which holds the person's on/off switches. */
export const PLUGIN_PATHS_FILE = "plugin-paths.json";
/** That file's name before API 1.0.0; the loader renames an old one once, never deletes it. */
export const LEGACY_PLUGIN_PATHS_FILE = "plugins.json";

/** The manifest, a JSON file named `PLUGIN_MANIFEST`. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** The plugin API this plugin was written against: semver (`"1.0"`), or a bare major
   *  (`1`, read as `1.0`). Checked by `pluginApiProblem` before any of its code runs. */
  apiVersion: string | number;
  description?: string;
  maturity?: "stable" | "preview" | "experimental"; // absent = "unrated" (`pluginMaturity`)
  /** Host module, relative to the plugin dir. Absent ⇒ `host.mjs`. */
  host?: string;
  settings?: PluginField[];
  actions?: PluginActionDef[];
  toggles?: PluginToggleDef[];
  /** Environment variables the host module reads through `api.env()`. The
   *  phone shows set/unset for each, never a value. Only these are readable. */
  env?: string[];
  /**
   * The plugin may ANSWER a choice box unattended (`api.answer`). The core then
   * draws its own per-session switch, "let <name> answer", default OFF, and the
   * gate in `answerGate` decides every call — the plugin cannot skip it.
   */
  answers?: boolean;
  /** In-repo extensions only: the web half's source module, relative to the extension dir
   *  (`web/index.ts`). Compiled into the phone bundle, never loaded from outside the repo. */
  web?: string;
  /**
   * The backend ids this plugin will register with `api.backend()`. An id not
   * listed here is refused at registration, so what a plugin may add to the
   * launcher is readable from its manifest before it runs.
   */
  backends?: string[];
  /**
   * In-repo extensions only: the person may switch this one OFF (an ordinary
   * builtin is always on). Its default comes from the install's `release.json`
   * (`builtins`, written from `deploy/ship.json`), else on. Listed on the phone
   * so the switch can be reached.
   */
  optional?: boolean;
  /** Folder (inside the extension) of static files served at `GET|HEAD /api/plugin/<id>/asset/<file>`; gated like `/api/*`, 403 while off. */
  assets?: string;
  /** Labelled "experimental" wherever its backends are listed (`BackendInfo.experimental`). */
  experimental?: boolean;
}

/** What the phone knows about one installed plugin. */
export interface PluginView {
  manifest: PluginManifest;
  /** Where it was loaded from — shown, so "which copy is this?" has an answer. */
  source: string;
  /** The person's switch. A disabled plugin is not activated at all. */
  enabled: boolean;
  /** `active` = activated; `error` = failed to load or activate (`error` says
   *  why, verbatim); `off` = disabled by the person. */
  state: "active" | "error" | "off";
  error?: string;
  /** Current settings, defaults filled in. */
  values: Record<string, PluginValue>;
  /** One line the plugin sets about itself ("no GEMINI_API_KEY — set it via the
   *  secret sheet"). */
  status?: PluginStatus | null;
  /** Declared env names → set or not. */
  env?: Record<string, boolean>;
}

export interface PluginStatus {
  tone: "ok" | "warn" | "bad";
  text: string;
}

/** A plugin's suggested answer for a session's current question. Rendered by
 *  the existing inline-suggestion UI; a person still taps unless the plugin
 *  answered through the gate. */
export interface AnswerSuggestion {
  /** Plugin id and display name. */
  by: string;
  byName: string;
  /** 1-based option for a choice box; null when abstaining or for free text. */
  choice: number | null;
  /** A drafted free-text reply (a question with no box). */
  reply?: string;
  confidence: number;
  rationale: string;
  model?: string;
}

/** A small label a plugin puts on a session row ("on · 3/10", "paused"). */
export interface PluginBadge {
  text: string;
  tone: "ok" | "warn" | "bad" | "dim";
}

/**
 * One row of the DECISION LOG — every automatic thing done or proposed on a
 * session's behalf: a usage-limit auto-continue (`source: "limit"`) or a
 * plugin's suggestion/answer (`source: "plugin"`, `plugin` set).
 */
export interface DecisionLogEntry {
  id: string;
  ts: number;
  sessionId: string;
  sessionTitle: string;
  source: "limit" | "plugin";
  plugin?: string;
  /** Limit rows: which step. */
  phase?: "blocked" | "attempt" | "resumed" | "gaveup";
  /** What was being decided — the box's question, or the limit sentence. */
  question: string;
  options: { index: number; label: string }[];
  /** What the plugin did: `suggested`, `answered`, `abstained`, `blocked`,
   *  `capped`, `error`, … — free words from the plugin, `limit` for limit rows. */
  outcome: string;
  choice: number | null;
  answer?: string;
  confidence?: number;
  rationale: string;
  model?: string;
  contextSent?: string;
  images?: number;
  inTok?: number;
  outTok?: number;
  error?: string;
  archived?: boolean;
}

// ── the host API a plugin's `activate()` receives ─────────────────────────────

/** A detected choice box, handed to `on("prompt")`. */
export interface PluginPromptEvent {
  sessionId: string;
  question: string;
  options: { index: number; label: string }[];
  /** `question` (2.0): a question the CLI posed on its own channel; a plugin may answer one of
   *  its OPTIONS through the gate, never its typed words — those are only a person's. */
  kind: "trust" | "tool" | "plan" | "select" | "question";
  multi?: boolean;
  /** Core's answer gate would refuse this box whatever the switches say
   *  (trust/tool/plan, or a destructive option). Suggesting is still allowed. */
  blocked: boolean;
}

/** A turn that ended asking something with no box, handed to `on("question")`. */
export interface PluginQuestionEvent {
  sessionId: string;
  /** The question as the core's `question.ts` read it. */
  question: string;
  /** The screen's tail it was read from. */
  tail: string;
  /** True when a person asked for a draft now (a session action), bypassing
   *  the plugin's own heuristics. */
  forced?: boolean;
}

export interface PluginSession {
  id: string;
  title: string;
  repoDir: string;
  cwd: string;
  /** A phone is looking at it right now. */
  watched: boolean;
  /** The plugin's own per-session switches, defaults applied. */
  toggles: Record<string, boolean>;
  /** The core's "let <plugin> answer" switch (always false without `answers`). */
  mayAnswer: boolean;
}

export interface HostPluginApi {
  readonly id: string;
  /** `<state dir>/plugins/<id>/` — the plugin's own files. Created on activate. */
  readonly dataDir: string;
  /** The daemon's global state dir (WATERPLANE_STATE_DIR, outside the root) — read-only by convention; for migrating old state. */
  readonly stateDir: string;
  /** @deprecated the same path as `stateDir`; kept one release for plugins written against it. */
  readonly usmcDir: string;
  log(msg: string): void;

  settings(): Record<string, PluginValue>;
  /** Called after the person changes a setting. Returns an unsubscribe. */
  onSettings(fn: (values: Record<string, PluginValue>) => void): () => void;
  /** Seed settings once (e.g. migrated from an older store). Keys not declared
   *  in the manifest are ignored. Never overwrites a value the person set. */
  seedSettings(values: Record<string, PluginValue>): void;
  setStatus(s: PluginStatus | null): void;
  /** Declared env names only; anything else reads undefined. Read live, so a
   *  secret set from the phone applies without a restart. */
  env(name: string): string | undefined;

  on(event: "prompt", fn: (e: PluginPromptEvent) => void | Promise<void>): () => void;
  on(event: "question", fn: (e: PluginQuestionEvent) => void | Promise<void>): () => void;
  /** A declared action was tapped. The returned message is shown on the phone. */
  on(event: "action", fn: (e: { action: string; sessionId?: string }) =>
    { ok: boolean; message: string } | Promise<{ ok: boolean; message: string }>): () => void;

  session(id: string): PluginSession | null;
  /** The last `lines` lines of the rendered screen/scrollback, plain text. */
  scrollback(id: string, lines?: number): string;
  /**
   * Toolkit (2.0). Which backend conversation is this session's: the host's pure ladder
   * (`bindconv.ts`) over the candidates YOUR queries found. Exactly one survivor or nothing.
   */
  bindConversation(look: BindLook): BindVerdict;
  /**
   * Follow a JSONL file the CLI appends to: each complete line once, rotation-safe (inode or shrink
   * re-reads from 0), 1 MiB per `advance()`. `advance()` is true when it read, false when nothing is
   * new, null when the file is absent or the tail closed.
   */
  tail(path: string, onLine: (obj: unknown) => void, opts?: { filter?: (line: string) => boolean }): { advance(): boolean | null; offset(): number; close(): void };
  /** The host's reading of the session's live screen: the last rows, and the squashed (`echo.ts`) form. Null for an unknown session. */
  screen(sessionId: string): { rows(lines?: number): string[]; squashed(lines?: number): string } | null;
  /** The directory the host wrote this session's launch `files` into, if this plugin's backend spawned it. */
  sessionFiles(hostSessionId: string): string | null;
  /** What this host does beyond 2.0 (absent on a 2.0 host ⇒ "no"). `dialogKeysThenTyped`: a takesText
   *  row's `answer` may return `{keys, typed: extra.text, then?}` — keys, 500 ms, words, Return apart. */
  readonly supports?: { readonly dialogKeysThenTyped?: boolean };
  /** A file inside the session's repo (containment-guarded); null if absent or outside. */
  readRepoFile(sessionId: string, relPath: string, maxBytes?: number): string | null;
  /** Recent images in the session repo's inbox/outbox, base64, newest first. */
  inlineImages(sessionId: string, max?: number): { mime: string; data: string; relPath: string }[];

  /** Show (or clear) a suggestion on the session's current question. */
  suggest(sessionId: string, s: Omit<AnswerSuggestion, "by" | "byName"> | null): void;
  /**
   * Answer the session's CURRENT choice box with option `choice`, through the
   * core's gate: the manifest declared `answers`, the session's "let <plugin>
   * answer" switch is on, the box is the one the event described and is not
   * blocked. Refused ⇒ `{ ok:false, reason }` in words, nothing typed.
   * Every answer lands in the sent log as `source:"plugin"`.
   */
  answer(sessionId: string, choice: number, why: string): Promise<{ ok: boolean; reason?: string }>;
  /**
   * May this plugin answer a request on the strength of a standing rule a PERSON made on this
   * session — by tapping an option its dialog marked `remember: { key }` (`SourceDialog`)? `ok`
   * only for that exact key, on that session, made on a dialog THIS plugin's backend posed, and
   * only when the manifest declared `answers`; every yes is audited like a gated answer (sent row
   * `source:"plugin"`, decision row, autofire note). Memory only: gone on a restart, the
   * session's exit, or this plugin's switch-off (a tmux detach keeps them).
   */
  ruleAllows(sessionId: string, key: string, why: string): { ok: boolean; reason?: string };
  /** The standing rules a person made on this session on this plugin's dialogs, oldest first. */
  rules(sessionId: string): { key: string; label: string; at: number; uses: number }[];
  /** Drop this plugin's standing rules on this session (a "forget" action). Returns how many. */
  forgetRules(sessionId: string): number;
  setBadge(sessionId: string, badge: PluginBadge | null): void;
  /** Append a decision-log row (`source`/`plugin` are filled in). */
  decision(row: Omit<DecisionLogEntry, "id" | "ts" | "source" | "plugin" | "sessionTitle"> & { sessionTitle?: string }): void;
  /** Record a paid model call, so it shows in the phone's usage numbers. */
  meter(call: { service: string; model: string; inTok: number; outTok: number }): void;
  /** `urgent` (since 1.6): a request a person must approve now; lands on the loud "approval" kind. Use for nothing else. `tag` (optional, no version bump): a stable key, a later notification with the same tag replaces the earlier one in the OS tray; the host namespaces it per plugin. */ notify(n: { title: string; body: string; sessionId?: string; urgent?: boolean; tag?: string }): void;
  /** The Claude plan usage (5-hour / weekly %), or null when unknown. */
  claudeUsage(): { sessionPct: number | null; weeklyPct: number | null } | null;

  /** One repo by its id (`GET /api/repos`) or absolute worktree path (realpath); null when unknown or outside the root. */
  repo(repoId: string): Promise<PluginRepoScope | null>;
  /**
   * Contribute a row to every repo's setup checklist. Called on each check of
   * each repo, so keep it cheap; null = no row for this repo. A throw drops the
   * row and becomes the plugin's status line. Returns an unregister.
   */
  setupCheck(fn: (repo: SetupSubject) => ComplianceCheck | null): () => void;
  /**
   * Handle the fix a contributed row names in `fix`. Ids the core owns
   * (`gitignore`, `claude-md`, …) or another plugin already took are refused:
   * the call throws, saying which. Returns an unregister.
   */
  setupFix(id: string, fn: (repo: SetupSubject) => SetupFixOutcome): () => void;
  /**
   * Answer `method` when the phone (or core) calls this plugin — the registry's
   * `call(pluginId, method, args)`. One handler per method; a second replaces
   * the first. The second argument (since 1.8) says who asked: the socket's trust tier and, when
   * it presented a paired device's token, that device's id and name. A handler that ignores it is
   * unchanged. A throw is the caller's `{ ok:false, error }` and the plugin's
   * status line. Returns an unregister.
   */
  handle(method: string, fn: (args: unknown, caller: PluginCaller) => unknown | Promise<unknown>): () => void;
  /**
   * Broadcast `event` to every phone as `plugin.push` (the web half's `pushes`).
   * Returns null when sent, or a refusal in words (bad event name, not JSON, over
   * PLUGIN_PUSH_MAX, this plugin not running).
   */
  push(event: string, data?: unknown): string | null;
  /**
   * Put `prompt` in that repo's backlog for its agent — the SAME path the
   * phone's and an agent's backlog adds take (`addClientBacklogItem`), so it is
   * contained, persisted, at-most-once by `key`, and fired by the intent ladder.
   * It waits for a person's tap unless `fire` is set, and even then it runs
   * only when the ladder lets it. Never types into a session directly.
   */
  handToAgent(repoId: string, prompt: string, opts?: { label?: string; key?: string; fire?: boolean }): Promise<HandToAgentResult>;

  /**
   * Register a backend (a CLI the launcher may spawn). THROWS a sentence — and
   * the plugin is listed broken when that escapes `activate()` — when the id is
   * not in the manifest's `backends`, is already taken, or `facts` names a reader
   * this host does not have (or one not allowed for that fact). Unregistered when the plugin is switched off; the
   * returned function unregisters it earlier.
   */
  backend(def: PluginBackendDef): () => void;
  /**
   * Contribute a SCREEN reader under `name` (since 1.1): the reader for a TUI whose choice dialog
   * has no numbers and is answered by walking a selection (`PluginScreenReader`). A backend this
   * plugin registers may then name it as a `{screen}` provider in `facts.dialogs` — so register it FIRST. THROWS
   * a sentence when the name is not a short lowercase word or is already taken (core's own
   * `claude-numbered` among them). Unregistered with the plugin; the returned function earlier.
   * A reader is measured against ONE binary's screen and pinned by the plugin's own fixtures.
   */
  screenReader(name: string, reader: PluginScreenReader): () => void;
  /**
   * Contribute a STORE reader under `name` (since 1.1): the reader of a CLI's own conversation
   * record — a database or files on disk it writes (`PluginStoreReader`). A backend may then name
   * it as a `{store}` provider in `facts.transcript`, and the core asks it for the reader view, the context graph, the tool
   * details, which conversation a session is in, and the backend's ledger. Same rules as
   * `screenReader`: register it before the backend; a taken name (`claude-jsonl`) throws.
   */
  storeReader(name: string, reader: PluginStoreReader): () => void;
  /**
   * Contribute a THERMAL reader under `name` (since 1.3): temperature and fan speed for the
   * machine readout, where the core has no reader of its own (macOS keeps the SMC behind root).
   * Asked on the readout's slow cadence, before the core's own sysfs reader; the first reading wins. A reading
   * the core cannot vouch for (non-finite, outside 1..149 °C, a negative rpm) is DROPPED — answer null. A note
   * (`{ note, fix? }`) is shown only when nothing reads. A throw or an answer slower than
   * `PLUGIN_THERMAL_TIMEOUT_MS` counts as no reading. Same naming rules as `screenReader`.
   */
  thermalReader(name: string, reader: PluginThermalReader): () => void;
  /**
   * Contribute a USAGE PROBE (since 1.7): one account's quota as its own segment beside claude's on
   * the usage chip. `claude` or a taken `source` throws. Null = ABSENT; a throw or timeout keeps
   * the last reading until its reset; an unvouchable window is dropped. Returns an unregister.
   */
  usageProbe(def: PluginUsageProbe): () => void;
  /**
   * The loopback URL this plugin's hooks POST to:
   * `http://127.0.0.1:<port>/api/plugin/<id>/hook`. Loopback only, like the
   * core's own hook sink; a remote caller is refused.
   */
  hookSink(): string;
  /**
   * Receive the posts to `hookSink()`. The handler's return value (JSON) is the
   * HTTP response body; `undefined` answers `{}`. Return a Promise to HOLD the
   * response (a CLI that waits on its hook for a permission answer): the core
   * answers `{}` itself after `maxHoldMs` (default `PLUGIN_HOOK_HOLD_DEFAULT_MS`,
   * at most `PLUGIN_HOOK_HOLD_MAX_MS`) and calls `hold.onExpired` — so keep it
   * BELOW the CLI's own hook timeout, or the CLI kills the hook first. One
   * handler per plugin; a second replaces the first. A throw answers `{}` and
   * becomes the status line.
   */
  onHook(fn: (payload: unknown, hold: PluginHookHold) => unknown | Promise<unknown>, opts?: { maxHoldMs?: number }): () => void;
  /**
   * Serve an HTTP route (since 1.2) at `/api/plugin/<id>/<pattern>`. It sits behind the SAME
   * origin/Host gate and token gate as every core `/api` route — never loopback-only, never exempt.
   * `pattern` is `/`-separated: literal segments, `:name` (exactly one segment, handed over RAW in
   * `params`), and a trailing `*` (what follows, in `rest`). JSON in and out: the body is parsed
   * (`{}` when there is none or it is not JSON; past `PLUGIN_ROUTE_BODY_MAX` the request is a 413),
   * and the reply's `body` goes back as JSON with its `status` (default 200). A GET must not
   * change anything — the core's rule for every `/api` GET. THROWS a sentence for a method outside
   * `PluginHttpMethod`, a malformed pattern, one whose first segment is `hook` (the sink's), or one
   * this plugin already serves for that method. A throw in the handler answers 500
   * `{ ok:false, error }` and becomes the status line. Unregistered with the plugin; the returned
   * function earlier.
   */
  route(method: PluginHttpMethod, pattern: string, fn: (req: PluginHttpRequest) => PluginHttpReply | Promise<PluginHttpReply>): () => void;
  /** Since 1.4. Serve live stream `name` to the sockets that open it: binary frames on the one
   *  socket, never durable or retried (`shared/stream.ts` has the whole contract). THROWS on a bad
   *  name or one already served. The returned function ends every open subscription. */
  stream(name: string, handlers: PluginStreamHandlers): () => void;
  /** Since 1.5: ONE `dataDir` file to the phone's download path, deleted once fetched or at its TTL (`pluginfile.ts`). */
  offerFile(file: string, opts: import("./pluginfile.js").PluginFileOfferOpts): import("./pluginfile.js").PluginFileOffer;
}

// ── plugin HTTP routes (`api.route`, since 1.2) ─────────────────────────────

/** The verbs a plugin route may answer. */
export type PluginHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** The largest JSON body a plugin route is handed. */
export const PLUGIN_ROUTE_BODY_MAX = 1_000_000;

/** What a plugin route's handler is handed. */
export interface PluginHttpRequest {
  readonly method: PluginHttpMethod;
  /** The pattern's `:name` segments, raw (still percent-encoded). */
  readonly params: Readonly<Record<string, string>>;
  /** What the pattern's trailing `*` matched, one entry per segment. */
  readonly rest: readonly string[];
  /** The query string, the first value of each key. */
  readonly query: Readonly<Record<string, string>>;
  /** The parsed JSON body; `{}` when there is none. Unchecked: validate it. */
  readonly body: unknown;
}

/** What a plugin route answers: an HTTP status (default 200) and a JSON body (default `{}`). */
export interface PluginHttpReply {
  readonly status?: number;
  readonly body?: unknown;
}

// ── plugin backends (`api.backend`, docs/analysis/backends-design.md §3) ──────

/** A backend id: a short lowercase word — the same rule the host's registry applies. */
export const PLUGIN_BACKEND_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A backend a plugin registers (2.0). Reader names in `facts` are plain strings — a name this host
 * has no reader for is refused at registration in words, never armed. `delivery` fields left out
 * are the "no anchor" defaults (`submitKey` "\r", every regex null, no local commands), which is
 * the shape `deliver.ts` already falls back to. A plugin backend is never on the claude health
 * board (`healthScope` is the core's to say, and it says false); `measured` is its health signal.
 *
 * `delivery`, `caps`, `facts`, `forkVia` and `sources` may be GETTERS (a knob read per call
 * switches them): the core reads them through on every access and never copies them at
 * registration. Each answer must name readers this host has — checked at registration.
 */
export interface PluginBackendDef {
  id: string;
  label: string;
  bin(): string;
  spawnEnv?: Readonly<Record<string, string>>;
  /** One launch's plan (replaces 1.x's sync `launchArgs`). A refusal is a thrown sentence. */
  prepare(req: PluginLaunchRequest): Promise<PluginLaunchPlan>;
  delivery?: {
    submitKey?: string;
    textThenSubmitDelayMs?: number;
    requiresChannel?: boolean;
    pastePlaceholder?: RegExp | null;
    composerCursorRe?: RegExp | null;
    composerRuleRe?: RegExp | null;
    /** An empty composer's hint text when it is NOT drawn dim (dim is discounted already). */
    composerPlaceholderRe?: RegExp | null;
    /** Read with claude's trust words before every delivery: a match makes delivery `retry` with a
     * sentence, nothing typed (only claude's own descriptor may answer a trust box). */
    trustPromptRe?: RegExp | null;
    isLocalCommand?(text: string): boolean;
    startsNoTurn?(text: string): boolean;
  };
  caps: BackendCapsV2;
  /** Which provider answers each fact, in order (replaces 1.x's reader caps). */
  facts: BackendFacts;
  /** The backend forks a conversation on its own server (opencode's `POST /session/{id}/fork`). */
  forkVia?: "server";
  /** The CLI versions this plugin was MEASURED on, and how to ask the running one (null = cannot
   *  tell). The host compares and says a drift in a sentence — never a refusal — and the phone
   *  shows it verbatim where a backend is chosen (launch picker, Settings, new-repo menu). */
  measured: { versions: readonly string[]; version(): Promise<string | null> };
  /** The model catalogue. Empty ⇒ a free-text field on the phone, never a guessed list. */
  models(): Promise<{
    aliases: string[]; ids: string[];
    where?: Record<string, "local" | "hosted">; zeroCost?: string[];
    contextWindow?: Record<string, number>; unavailable?: string;
    /** A sentence about the list, under the picker; the backend still launches. */
    note?: string;
  }>;
  /** A source per fact beside the screen readers (`backendsources.ts`). */
  sources?: BackendSources;
}

// ── contributed readers (`api.screenReader` / `api.storeReader`, since 1.1) ───

/** A reader name: the same short lowercase word a backend id is. */
export const PLUGIN_READER_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** One run of cells painted alike on a rendered row. Colour keys are `def`, `pal:<n>` or `rgb:<n>`. */
export interface PluginScreenSpan {
  /** Column of the first cell in the run. */
  readonly from: number;
  /** Column of the last cell in the run, inclusive. */
  readonly to: number;
  /** The characters in the run, one per cell — spaces included. */
  readonly text: string;
  readonly bg: string;
  readonly fg: string;
}

/** One row of the session's rendered screen, as a screen reader is handed it. */
export interface PluginScreenRow {
  readonly text: string;
  /** Left to right, contiguous, covering every column of the grid. */
  spans: PluginScreenSpan[];
}

/** What a screen reader parsed: which option is armed (1-based) and how many there are. */
export interface PluginScreenBox {
  readonly armed: number;
  readonly options: readonly unknown[];
}

/**
 * A screen reader for a dialog with NO numbers, answered by walking the selection onto an option
 * and pressing Return. The core keeps the shape every box reader has — a cheap byte gate, an
 * expensive render, a miss budget so a half-drawn repaint cannot retire a live box, a walk that
 * RE-READS after every key and refuses rather than pressing Return on the wrong row — and asks the
 * reader only the questions that are about one TUI's pixels.
 *
 * Every member must be pure and must not throw; a throw reads as "no box".
 */
export interface PluginScreenReader<B extends PluginScreenBox = PluginScreenBox> {
  /** The cheap gate, on the ANSI-stripped tail of the scrollback: could a dialog be up at all? */
  candidate(strippedTail: string): boolean;
  /** The rendered rows, parsed: a box when its armed option is readable, else null. */
  read(rows: PluginScreenRow[]): B | null;
  /** The box as the phone is shown it. Options numbered 1.., `nav: true`. */
  prompt(box: B): DetectedPrompt;
  /** Rows that did NOT parse: is the dialog still drawn (spend a miss, keep the box) or gone? */
  stillUp(rows: PluginScreenRow[]): boolean;
  /** One step toward option `choice` — null when the box has no such option. */
  navTo(box: B, choice: number): { dir: "left" | "right" } | null;
}

/** What one pass of conversation discovery is handed (`PluginStoreReader.discover`). */
export interface PluginStoreLook {
  /** The session's working directory, realpath-resolved. */
  readonly dir: string;
  /** Did this session's own launch write a conversation row (`createsRecord`)? */
  readonly ownRow: boolean;
  readonly spawnedAt: number;
  /** The last prompt this host WATCHED land on screen, and when, while the id is unknown. */
  readonly probe?: { readonly text: string; readonly at: number };
  /** Conversation ids other live sessions have already adopted. */
  readonly adopted: ReadonlySet<string>;
  /** What the previous pass handed back as `carry` (null on the first, and after a new prompt). */
  readonly carry: unknown;
  readonly now: number;
}

/** The context series out of a store, before the core puts a window on it. */
export interface PluginStoreContext {
  readonly samples: ContextSample[];
  readonly events: ContextEvent[];
  /** The model the LAST assistant message ran under — the window is that model's. Null when unknown. */
  readonly model: string | null;
  readonly truncated: boolean;
  /** The change stamp a poll compares against. */
  readonly updatedAt: number;
}

/**
 * A store reader: the CLI's own conversation record, read and never written. Every member is
 * keyed by the CLI's own conversation id (`SessionInfo.backendSessionId`) and DEGRADES TO NULL —
 * a store that cannot be read is an absent fact, never a thrown error and never a zero.
 */
export interface PluginStoreReader {
  /** The `TranscriptDoc.source` the reader view carries for this store. */
  readonly source: TranscriptDoc["source"];
  /** The store's own change stamp for one conversation; null = unknown. */
  updatedAt(conversationId: string): number | null;
  /** May a poll answer "unchanged" for this stamp against the client's `since`? */
  pollUnchanged(stamp: number | null, since: number): boolean;
  /** The conversation as the reader's document; null when the store or the conversation is not there. */
  transcript(conversationId: string, detail: "lite" | "full"): Omit<TranscriptDoc, "sessionId" | "source"> | null;
  /** The inputs/results one turn's `lite` tool blocks withheld. */
  toolDetails(conversationId: string, turnId: string): Record<string, TranscriptToolDetail> | null;
  /** How full the context window has been, over time. */
  contextSeries(conversationId: string): PluginStoreContext | null;
  /**
   * One pass of finding WHICH conversation a session is in, for a backend whose launch does not
   * know the id. `id` only when exactly one candidate answers — a guess points the reader at
   * somebody else's conversation. `carry` is handed back on the next pass.
   */
  discover(look: PluginStoreLook): { id: string | null; carry: unknown };
  /**
   * The backend's own ledger, served verbatim at `GET /api/tokenstats/<backendId>` for a backend
   * whose `facts.transcript` names this reader and which has no `sources.tokens`. JSON; a store
   * that cannot be read answers `{ available: false, reason }`, never throws.
   */
  ledger?(maxAgeMs: number | undefined): Promise<unknown>;
}

export * from "./pluginreadings.js";
export * from "./pluginlaunch.js";

/** One line of the preflight report a builtin's `doctor` contributes. */
export interface PluginDoctorCheck {
  /** Short stable name, e.g. `opencode-binary`. */
  id: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

/** How long the core holds a hook's HTTP response for a pending answer by default, and at most. */
export const PLUGIN_HOOK_HOLD_DEFAULT_MS = 8_000;
export const PLUGIN_HOOK_HOLD_MAX_MS = 60_000;

/** What an `onHook` handler is handed beside the payload. */
export interface PluginHookHold {
  /** How long the core holds this response before answering `{}` itself. */
  readonly maxHoldMs: number;
  /** Called once when the core answered `{}` instead of the handler: the hold
   *  ran out, or the plugin was switched off. The CLI then goes its own way. */
  onExpired(fn: () => void): void;
}

/**
 * One repo, as a plugin may look at it (`api.repo(repoId)`): its files and git
 * facts through the core's containment guard — a path that leaves the worktree,
 * or names a secret (`.env*`), reads as null, never as an error.
 */
export interface PluginRepoScope {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly isPrimary: boolean;
  /** Absolute path of the worktree. */
  readonly worktree: string;
  /** A text file inside the worktree; null if absent, outside, binary or a secret. */
  readFile(relPath: string, maxBytes?: number): string | null;
  /** One directory's entries (not recursive); null if absent or outside. Secrets are left out. */
  listDir(relPath?: string): { name: string; dir: boolean }[] | null;
  /** HEAD and the working tree, read now — synchronous subprocesses, not from a setup check. `head` is null in a repo with no commit. */
  git(): { branch: string; head: string | null; changed: number } | null;
}

/** What a contributed setup check or fix is handed: the worktree it is about. */
export interface SetupSubject {
  /** Absolute path of the worktree being checked. */
  worktree: string;
}

/** A contributed fix's outcome: `applied` says whether it changed anything, `note` says what, in words. */
export interface SetupFixOutcome {
  applied: boolean;
  note: string;
}

/** `api.handToAgent`'s answer: the intent id the prompt now waits under, or why not. */
export type HandToAgentResult =
  /** `existing`: the `key` named a row the store already held (nothing new was written); `state`: that row's state then (absent when new). */
  | { ok: true; intentId: string; existing: boolean; state?: string }
  | { ok: false; reason: string };

/**
 * A plugin module's shape. `deactivate` runs on disable and on shutdown
 * (started, never awaited there). `shutdown` runs ONLY as the daemon exits, after
 * every store is flushed, SYNCHRONOUSLY and whether or not the plugin is still
 * switched on — the place to kill child processes it owns (a switched-off
 * plugin's running sessions keep their children until then).
 */
export interface HostPluginModule {
  activate(api: HostPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  shutdown?(): void;
  /**
   * Lines for the preflight report (`npm run doctor` and the boot summary), since 1.1. Asked of
   * the IN-REPO extensions only, WITHOUT `activate` — the doctor loads no plugin — so it must
   * stand alone. `usedBackends` are the backend ids this host's recent sessions ran on: a line
   * about a binary nobody asked for says "something is wrong" about nothing, so answer [] then.
   * Never throws; a throw drops the lines.
   */
  doctor?(req: { usedBackends: readonly string[] }): Promise<PluginDoctorCheck[]>;
}

/** Register every method of a typed table with `api.handle`; returns one unregister.
 * Args arrive from the wire UNCHECKED — the types are a convenience, each handler validates. */
export function handleAll<M extends PluginMethods>(
  api: Pick<HostPluginApi, "handle">,
  fns: { [K in keyof M & string]: (args: M[K]["args"], caller: PluginCaller) => M[K]["result"] | Promise<M[K]["result"]> },
): () => void {
  const offs = Object.keys(fns).map((k) => api.handle(k, (a, c) => (fns as Record<string, (x: unknown, c: PluginCaller) => unknown>)[k]!(a, c)));
  return () => { for (const off of offs) off(); };
}

/** Validate a parsed manifest: problems in words (empty = valid). Unknown fields are allowed — a newer manifest on an older daemon loads with what it understands. */
export function manifestProblems(m: unknown): string[] {
  const out: string[] = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return [`${PLUGIN_MANIFEST} is not a JSON object`];
  const o = m as Record<string, unknown>;
  if (typeof o.id !== "string" || !PLUGIN_ID_RE.test(o.id)) out.push(`id must match ${PLUGIN_ID_RE}`);
  if (typeof o.name !== "string" || !o.name.trim()) out.push("name is required");
  if (typeof o.version !== "string") out.push("version is required");
  const api = pluginApiProblem(o.apiVersion, PLUGIN_API_VERSION, { backends: Array.isArray(o.backends) && o.backends.length > 0 }); if (api) out.push(api);
  const keys = new Set<string>();
  for (const f of Array.isArray(o.settings) ? o.settings as PluginField[] : []) {
    if (!f || typeof f.key !== "string" || !f.key) { out.push("a setting has no key"); continue; }
    if (keys.has(f.key)) out.push(`setting "${f.key}" is declared twice`);
    keys.add(f.key);
    if (!["switch", "choice", "number", "text"].includes(f.kind)) out.push(`setting "${f.key}" has unknown kind "${String(f.kind)}"`);
    if (f.kind === "number" && !(f.min <= f.default && f.default <= f.max)) out.push(`setting "${f.key}" default is outside min..max`);
    if (f.kind === "choice" && !f.options?.some((x) => x.value === f.default)) out.push(`setting "${f.key}" default is not one of its options`);
  }
  for (const a of Array.isArray(o.actions) ? o.actions as PluginActionDef[] : []) {
    if (!a?.id || !a.label) out.push("an action needs an id and a label");
    else if (a.scope !== "global" && a.scope !== "session") out.push(`action "${a.id}" scope must be global or session`);
  }
  for (const t of Array.isArray(o.toggles) ? o.toggles as PluginToggleDef[] : []) if (!t?.id || !t.label || typeof t.default !== "boolean") out.push("a toggle needs an id, a label and a boolean default");
  if (o.env !== undefined && (!Array.isArray(o.env) || o.env.some((e) => typeof e !== "string"))) out.push("env must be a list of names");
  if (o.web !== undefined && typeof o.web !== "string") out.push("web must be a path string");
  if (o.assets !== undefined && (typeof o.assets !== "string" || !o.assets || /^([\\/]|[A-Za-z]:)/.test(o.assets) || o.assets.split(/[\\/]/).includes(".."))) out.push("assets must be a folder path inside the extension (relative, no ..)");
  for (const k of ["optional", "experimental"]) if (o[k] !== undefined && typeof o[k] !== "boolean") out.push(`${k} must be true or false`);
  if (o.backends !== undefined) {
    if (!Array.isArray(o.backends)) out.push("backends must be a list of backend ids");
    else for (const b of o.backends) {
      if (typeof b !== "string" || !PLUGIN_BACKEND_ID_RE.test(b)) out.push(`backend id ${JSON.stringify(b)} is not a short lowercase word (letters, digits, dashes)`);
    }
  }
  return [...out, ...maturityProblems(o)];
}

/** A value as the manifest allows it, or undefined (refused, never repaired). */
export function cleanPluginValue(f: PluginField, v: unknown): PluginValue | undefined {
  switch (f.kind) {
    case "switch": return typeof v === "boolean" ? v : undefined;
    case "choice": return typeof v === "string" && f.options.some((o) => o.value === v) ? v : undefined;
    case "number": return typeof v === "number" && Number.isFinite(v) && v >= f.min && v <= f.max ? v : undefined;
    case "text": return typeof v === "string" && v.length <= 20_000 ? v : undefined;
  }
}

/** The settings with defaults filled in. */
export function pluginValues(m: PluginManifest, stored: Record<string, unknown>): Record<string, PluginValue> {
  const out: Record<string, PluginValue> = {};
  for (const f of m.settings ?? []) out[f.key] = cleanPluginValue(f, stored[f.key]) ?? f.default;
  return out;
}
