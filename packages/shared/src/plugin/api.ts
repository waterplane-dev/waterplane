import type { PluginValue, PluginStatus } from "./manifest.js";
import type { PluginRepoScope, SetupSubject, SetupFixOutcome, HandToAgentResult, PluginHookHold } from "./module.js";
import type { PluginBackendDef, PluginScreenReader, PluginStoreReader, PluginHttpMethod, PluginHttpRequest, PluginHttpReply } from "./backend.js";
import type { PeerKind } from "../wire/messages.js";
import type { PluginStreamHandlers } from "../stream.js";
import type { ComplianceCheck } from "../wire/repo.js";
import type { PluginThermalReader, PluginUsageProbe } from "../pluginreadings.js";
import type { BindLook, BindVerdict } from "../bindconv.js";

/** Who a `handle` method was called by (since 1.8): the socket's trust tier, and the paired
 *  device's id/name (null: no token, or an in-process call). Never a proof beyond pairing. */
export interface PluginCaller { kind: PeerKind; deviceId: string | null; deviceName: string | null }

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

  /**
   * One repo by its id (the ids `GET /api/repos` hands out), or by its absolute worktree path
   * (realpath-compared against the repos the host lists — a CLI names its repo by path); null when
   * unknown or outside the root.
   */
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
  offerFile(file: string, opts: import("../pluginfile.js").PluginFileOfferOpts): import("../pluginfile.js").PluginFileOffer;
}
