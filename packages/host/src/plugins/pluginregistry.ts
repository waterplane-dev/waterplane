/**
 * The installed plugins: loaded once at boot, activated when enabled, listed
 * to the phone (`plugin.list`), and the fan-out of core events to them
 * (docs/notes/plugins.md). The contract is `@waterplane/shared`'s `plugin.ts`.
 *
 * Error isolation is the rule every method here keeps: a manifest that does
 * not validate, an `activate()` that throws or hangs, a handler that throws —
 * each becomes the plugin's `state: "error"` or its status line, in words, and
 * never reaches the daemon. (A plugin runs in-process with the daemon's rights;
 * this is not a sandbox, it is that a bug in one does not take the host down.)
 *
 * On disk:
 * - `<STATE_DIR>/plugins.json` — `{ "enabled": { "<id>": false } }`, the
 *   person's switch per plugin; absent ⇒ enabled (installing one is the ask).
 *   Not the CONFIG dir's `plugin-paths.json`, which says where plugins are
 *   (`pluginloader.ts`).
 * - `<STATE_DIR>/plugins/<id>/settings.json` — the values a person set (or a
 *   plugin seeded), declared keys only, each cleaned by `cleanPluginValue`.
 * - `<STATE_DIR>/plugins/<id>/` — the plugin's own `dataDir`.
 *
 * Two kinds of entry, one API object (`makeApi`): EXTERNAL plugins found in the
 * config dir, and the IN-REPO extensions under `packages/extensions/<id>/`
 * (`builtin.ts`), loaded first, always on, never switched off, and left out of
 * the phone's plugin list unless broken — they are part of the product. The
 * exception is a builtin whose manifest says `optional` (opencode): listed, and
 * switchable like any plugin, its default from the release (`builtin.ts`).
 *
 * What an entry CONTRIBUTES beyond events lives on it too, so switching a
 * plugin off takes every contribution with it: setup rows and fixes
 * (`setupcontrib.ts` asks `setupChecks`/`runSetupFix`), and method handlers
 * (`call`, which the generic `plugin.call` wire message routes to through
 * `callOnce` and its ledger, `pluginrpc.ts`).
 */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BRAND, cleanPluginValue, PLUGIN_MANIFEST, promptFingerprint, pluginValues, PLUGIN_ARGS_MAX } from "@waterplane/shared";
import type { PluginCaller, PluginCallResult, PluginUsageProbe } from "@waterplane/shared";
import { createCallLedger } from "./pluginrpc.js";
import type {
  AnswerSuggestion, ComplianceCheck, DecisionLogEntry, DetectedPrompt, HandToAgentResult, HostPluginModule,
  PluginHookHold, PluginPromptEvent, PluginQuestionEvent, PluginStatus, PluginValue, PluginView, RepoTarget,
  SetupFixOutcome, SetupSubject, UsageInfo,
} from "@waterplane/shared";
import { forgetRules, isBlocked } from "../answergate.js";
import { unregisterBackend } from "../backends/index.js";
import { handToAgentVia } from "../agentintents.js";
import { discoverTargets, findTarget } from "../repos.js";
import type { HostCtx } from "../routes/types.js";
import type { SessionManager } from "../sessions.js";
import { cleanReply, findPluginRoute, type PluginRoute } from "./pluginroutes.js";
import { builtinDir, builtinHostModule, releaseBuiltins, shippedBuiltins, type ReleaseBuiltins } from "./builtin.js";
import { discoverPluginDirs, importHost, readPluginDir } from "./pluginloader.js";
import { makeApi } from "./pluginapi.js";
import { PluginStreams, type StreamSink } from "./pluginstreams.js";
import { setSetupSource } from "./setupcontrib.js";
import { PluginFiles, type ServedFile } from "./pluginfiles.js";
import { resolveAsset, type AssetResult } from "./pluginassets.js";
import { hostStateDir } from "../branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";
import type { Notify } from "../notifytypes.js";

const ACTIVATE_MS = 10_000;
const ACTION_MS = 90_000;
/** An in-process call (core asking a plugin): no socket, no device — and no route, so "unknown", never read as a local browser. */
const IN_PROCESS_CALLER: PluginCaller = { kind: "unknown", deviceId: null, deviceName: null };
/** A `call()` answer is data for the phone, not a transfer channel. */
const CALL_RESULT_MAX = 512 * 1024;

type Handler = (e: any) => unknown;

/** One installed plugin, as the registry holds it. */
export interface PluginEntry {
  dir: string;
  source: string;
  manifest: PluginManifestLike;
  hostFile: string | null;
  /** Fixed at load (manifest problems, duplicate id, import failure). */
  loadError: string | null;
  /** Loaded from a past brand's manifest file name; the phone says to rename it. */
  manifestLegacy?: boolean;
  enabled: boolean;
  state: "active" | "error" | "off";
  error?: string;
  status: PluginStatus | null;
  mod: HostPluginModule | null;
  /** Bumped on every activation, so an API handed to a previous one goes quiet. */
  gen: number;
  handlers: { prompt: Set<Handler>; question: Set<Handler>; action: Set<Handler> };
  onSettings: Set<(v: Record<string, PluginValue>) => void>;
  stored: Record<string, PluginValue>;
  /** An in-repo extension (`packages/extensions/<id>/`): always on, never listed unless broken. */
  builtin?: boolean;
  /** Contributed setup rows, asked on every check of every repo. */
  setupChecks: Set<(s: SetupSubject) => ComplianceCheck | null>;
  /** Contributed fixes by fix id — the ids its rows name in `fix`. */
  setupFixes: Map<string, (s: SetupSubject) => SetupFixOutcome>;
  /** `handle(method, fn)` — what `call()` routes to. */
  methods: Map<string, (args: unknown, caller: PluginCaller) => unknown>;
  /** Backend ids this activation registered (`api.backend`) — unregistered when it is switched off. */
  backends: Set<string>;
  /** Unregisters for the readers this activation contributed (`api.screenReader` / `api.storeReader` / `api.thermalReader`). */
  readers: Set<() => void>;
  /** `api.onHook` — what `/api/plugin/<id>/hook` hands its body to. */
  hook: { fn: (payload: unknown, hold: PluginHookHold) => unknown; maxHoldMs: number } | null;
  /** `api.route` — what `* /api/plugin/<id>/*` asks, in registration order (since 1.2). */
  routes: PluginRoute[];
  /** Responses held open right now; each answers `{}` when called (switch-off). */
  holds: Set<() => void>;
}

/** What `/api/plugin/<id>/hook` answers: an HTTP status and a JSON body. */
export interface PluginHookReply { status: number; body: unknown }
type PluginManifestLike = PluginView["manifest"];

/** What the registry needs from the host. Functions read `ctx` at CALL time. */
export interface RegistryDeps {
  root: string;
  configDir: string;
  sessions: SessionManager;
  decision(row: DecisionLogEntry): void;
  meter(e: { service: string; model: string; kind: string; inTok: number; outTok: number; ts: number }): void;
  notify: Notify;
  usage(): UsageInfo;
  /** The plugin list changed — broadcast it. */
  changed(): void;
  /** `api.push` — broadcast `plugin.push` to every phone. Absent ⇒ the api refuses in words. */
  push?(plugin: string, event: string, data: unknown): void;
  /** The daemon's ctx, read at CALL time: `api.handToAgent` is its backlog add. Absent ⇒ refused in words. */
  host?: Pick<HostCtx, "backlog" | "intents" | "containRepoDir">;
  /** Test seam: a repo by id. Absent ⇒ `repos.ts`'s `findTarget(root, id)`, the ids `GET /api/repos` hands out. */
  findRepo?(repoId: string): Promise<RepoTarget | null>;
  /** Test seam: a repo by its worktree's REALPATH. Absent ⇒ `discoverTargets(root)` realpath-compared. */
  findRepoByPath?(realPath: string): Promise<RepoTarget | null>;
  /** Test seam over `handToAgentVia(host, …)`. */
  handToAgent?(p: HandToAgentArgs): Promise<HandToAgentResult>;
  /** The daemon's port, for `api.hookSink()` (loopback). Absent ⇒ the default port. */
  hookPort?: number;
  /** How `api.stream` reaches the sockets (`pluginstreams.ts`), read at CALL time. Absent ⇒ every
   *  `stream.open` is refused in words. */
  streamSink?(): StreamSink | null;
  /** `api.usageProbe` — the host's usage-source registry (`usagesources.ts`). Absent ⇒ refused in words. */
  usageProbe?(plugin: string, def: PluginUsageProbe): () => void;
}

export interface HandToAgentArgs { repoDir: string; text: string; label?: string; id?: string; origin: string; fire: boolean }

/** Fix ids `compliance.ts` answers itself — a plugin may not take one. */
export const CORE_FIX_IDS: readonly string[] = ["gitignore", "claude-md", "visual-check", "auto-compact", "state-dir", "android-toolchain", "signing-key", "builds-configured"];

const isPlainObject = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);
const isEnabledDoc = (v: unknown): boolean => isPlainObject(v) && ((v as { enabled?: unknown }).enabled === undefined || isPlainObject((v as { enabled?: unknown }).enabled));
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 400);

/** Race a promise against a clock; the reason says which. */
function within<T>(p: Promise<T> | T, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const clock = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([Promise.resolve(p), clock]).finally(() => clearTimeout(t));
}

export class PluginRegistry {
  readonly entries: PluginEntry[] = [];
  /** Plain problems with the configuration itself (a bad plugin-paths.json). */
  configProblems: string[] = [];
  /** Session id → fingerprint of the box plugins were last told about (gate condition 3). */
  readonly told = new Map<string, string>();
  private readonly ledger = createCallLedger();
  /** `api.stream`'s registry and every socket's open subs (`pluginstreams.ts`). */
  readonly streams: PluginStreams;
  /** `api.offerFile`'s live offers (`pluginfiles.ts`): memory only, each file deleted when it ends. */
  readonly files = new PluginFiles();
  private readonly stateDir: string;
  private readonly enabledPath: string;
  private builtinsStarted = false;
  private builtinsDone!: () => void;
  /** Resolves once `loadBuiltins()` has run — `main()` awaits it before listening. */
  readonly builtinsLoaded = new Promise<void>((r) => { this.builtinsDone = r; });

  constructor(readonly deps: RegistryDeps) {
    this.stateDir = hostStateDir(deps.root);
    this.enabledPath = join(this.stateDir, "plugins.json");
    setSetupSource(this);
    this.streams = new PluginStreams({
      plugin: (id) => {
        const e = this.byId(id);
        if (!e) return null;
        const refusal = e.state === "active" ? null : `${e.manifest.name} is ${e.state === "off" ? "turned off" : `not running: ${e.error ?? "error"}`}`;
        return { name: e.manifest.name, refusal };
      },
      failed: (id, what, err) => { const e = this.byId(id); if (e) this.handlerFailed(e, what, err); },
      sink: () => deps.streamSink?.() ?? null,
    });
  }

  private newEntry(p: Pick<PluginEntry, "dir" | "source" | "manifest" | "hostFile" | "loadError" | "enabled" | "stored" | "manifestLegacy"> & { builtin?: boolean }): PluginEntry {
    return {
      ...p, state: "off", status: null, mod: null, gen: 0,
      handlers: { prompt: new Set(), question: new Set(), action: new Set() }, onSettings: new Set(),
      setupChecks: new Set(), setupFixes: new Map(), methods: new Map(),
      backends: new Set(), readers: new Set(), hook: null, routes: [], holds: new Set(),
    };
  }

  /**
   * The in-repo extensions (`builtin.ts`). Boot, BEFORE the server listens and
   * before `loadAll()`: their setup rows are part of the checklist the first
   * request reads, and an external plugin must not claim a builtin's id. Never
   * throws — a broken one is an error entry, like any plugin.
   */
  async loadBuiltins(ids?: readonly string[], rel: ReleaseBuiltins | null = releaseBuiltins()): Promise<void> {
    if (this.builtinsStarted) return this.builtinsLoaded;
    this.builtinsStarted = true;
    try { await this.loadBuiltinIds(ids ?? shippedBuiltins(rel), rel); } finally { this.builtinsDone(); }
  }

  private async loadBuiltinIds(ids: readonly string[], rel: ReleaseBuiltins | null): Promise<void> {
    const switched = this.readEnabled();
    for (const id of ids) {
      const dir = builtinDir(id);
      // Where THIS build keeps the host module — the `.mts` under tsx, the compiled `.mjs` in
      // `dist/extensions/` otherwise — never manifest-relative: a release ships only the latter.
      const hostFile = builtinHostModule(id);
      const d = readPluginDir(dir, `built in (${id})`, { hostFile });
      let loadError = d.problems.length ? d.problems.join("; ") : null;
      if (!loadError && d.manifest.id !== id) loadError = `${PLUGIN_MANIFEST} says id "${d.manifest.id}", its folder says "${id}"`;
      // Always on — unless the manifest says `optional`: then the person's switch, else the release's default, else on.
      const optional = !loadError && d.manifest.optional === true;
      const enabled = !optional || (typeof switched[id] === "boolean" ? switched[id]! : rel?.[id]?.on !== false);
      const e = this.newEntry({
        dir, source: d.source, manifest: d.manifest, hostFile: loadError ? null : hostFile, loadError,
        enabled, stored: loadError ? {} : this.readStored(d.manifest.id, d.manifest), builtin: true,
        ...(d.manifestLegacy ? { manifestLegacy: true } : {}),
      });
      if (loadError) { e.state = "error"; e.error = loadError; console.warn(`[${BRAND.slug}] extension ${id}: ${loadError}`); }
      this.entries.push(e);
      if (!loadError && enabled) await this.activate(e);
    }
  }

  /** Discover, validate, import and activate. Boot only; never throws. */
  async loadAll(): Promise<void> {
    const { dirs, problems, notes } = discoverPluginDirs(this.deps.configDir);
    this.configProblems = problems;
    for (const n of notes) console.log(`[${BRAND.slug}] plugins: ${n}`);
    for (const p of problems) console.warn(`[${BRAND.slug}] plugins: ${p}`);
    const enabled = this.readEnabled();
    const ids = new Map<string, string>(this.entries.filter((e) => e.builtin).map((e) => [e.manifest.id, e.source]));
    for (const { dir, source } of dirs) {
      const d = readPluginDir(dir, source);
      let loadError = d.problems.length ? d.problems.join("; ") : null;
      const prior = ids.get(d.manifest.id);
      if (!loadError && prior) loadError = `duplicate id "${d.manifest.id}" — already loaded from ${prior}`;
      if (!loadError) ids.set(d.manifest.id, source);
      const e = this.newEntry({
        dir, source, manifest: d.manifest, hostFile: d.hostFile, loadError,
        enabled: enabled[d.manifest.id] !== false,
        stored: loadError ? {} : this.readStored(d.manifest.id, d.manifest),
        ...(d.manifestLegacy ? { manifestLegacy: true } : {}),
      });
      if (d.manifestLegacy) console.warn(`[${BRAND.slug}] plugin ${source}: still has an older manifest name; rename it to ${PLUGIN_MANIFEST}`);
      if (loadError) { e.state = "error"; e.error = loadError; console.warn(`[${BRAND.slug}] plugin ${source}: ${loadError}`); }
      this.entries.push(e);
    }
    for (const e of this.entries) if (!e.builtin && !e.loadError && e.enabled) await this.activate(e);
    const ext = this.entries.filter((e) => !e.builtin);
    const n = ext.filter((e) => e.state === "active").length;
    if (ext.length) console.log(`[${BRAND.slug}] plugins: ${n} active of ${ext.length} installed.`);
    this.deps.changed();
  }

  /**
   * Load ONE plugin dir after boot (an install from the updates view takes effect without a restart).
   * Refused in words, nothing added, when the dir does not read or its id is already loaded; a plugin
   * that reads but fails to start is LISTED in error like at boot, and its reason is returned.
   */
  async loadOne(dir: string): Promise<string | null> {
    const d = readPluginDir(dir, dir);
    if (d.problems.length) return d.problems.join("; ");
    if (this.entries.some((x) => x.manifest.id === d.manifest.id)) return `a plugin with the id "${d.manifest.id}" is already loaded`;
    const e = this.newEntry({
      dir, source: dir, manifest: d.manifest, hostFile: d.hostFile, loadError: null,
      enabled: this.readEnabled()[d.manifest.id] !== false,
      stored: this.readStored(d.manifest.id, d.manifest),
      ...(d.manifestLegacy ? { manifestLegacy: true } : {}),
    });
    this.entries.push(e);
    if (e.enabled) await this.activate(e);
    this.deps.changed();
    return e.state === "error" ? (e.error ?? "failed to start") : null;
  }

  /** The loadable plugin with this id (never a duplicate or broken copy). */
  byId(id: string): PluginEntry | null {
    return this.entries.find((e) => e.manifest.id === id && !e.loadError?.startsWith("duplicate id")) ?? null;
  }

  views(): PluginView[] {
    return this.entries.filter((e) => !e.builtin || e.state === "error" || e.manifest.optional === true).map((e) => ({
      manifest: e.manifest, source: e.source, enabled: e.enabled, state: e.state,
      ...(e.error ? { error: e.error } : {}),
      ...(e.manifestLegacy ? { manifestLegacy: true } : {}),
      values: e.loadError ? {} : pluginValues(e.manifest, e.stored),
      status: e.status,
      env: Object.fromEntries((e.manifest.env ?? []).map((n) => [n, !!process.env[n]])),
    }));
  }

  // ── activation ──────────────────────────────────────────────────────────

  private async activate(e: PluginEntry): Promise<void> {
    e.gen += 1;
    e.error = undefined;
    try {
      mkdirSync(join(this.stateDir, "plugins", e.manifest.id), { recursive: true });
      if (!e.mod) e.mod = await importHost(e.hostFile!);
      e.state = "active"; // before activate(): its own api calls must land
      await within(e.mod.activate(makeApi(this, e, e.gen)), ACTIVATE_MS, "activate()");
    } catch (err) {
      this.clearHandlers(e);
      e.state = "error";
      e.error = `failed to start: ${msgOf(err)}`;
      console.warn(`[${BRAND.slug}] plugin ${e.manifest.id}: ${e.error}`);
    }
  }

  private async deactivate(e: PluginEntry): Promise<void> {
    const was = e.state === "active";
    e.gen += 1;
    this.clearHandlers(e);
    e.state = "off";
    e.error = undefined;
    for (const s of this.deps.sessions.list()) {
      this.deps.sessions.setPluginBadge(s.id, e.manifest.id, null);
      if (s.suggestion?.by === e.manifest.id) this.deps.sessions.setSuggestion(s.id, null);
    }
    if (was && e.mod?.deactivate) {
      try { await within(e.mod.deactivate(), ACTIVATE_MS, "deactivate()"); } catch (err) { console.warn(`[${BRAND.slug}] plugin ${e.manifest.id}: ${msgOf(err)}`); }
    }
  }

  private clearHandlers(e: PluginEntry): void {
    e.handlers.prompt.clear(); e.handlers.question.clear(); e.handlers.action.clear(); e.onSettings.clear();
    e.setupChecks.clear(); e.setupFixes.clear(); e.methods.clear();
    // Its backends leave the launcher with it (a live session keeps running on
    // the descriptor it was spawned with; the next create is refused in words),
    // and every response it was holding is answered `{}` now — the CLI then
    // goes its own way rather than wait out a plugin that is gone.
    for (const b of [...e.backends]) { try { unregisterBackend(b); } catch { /* never a core id */ } }
    e.backends.clear();
    // …and the readers it contributed, AFTER its backends: a name still named by a live
    // session then answers nothing (`backends/readers.ts`), never a stale reader.
    for (const off of [...e.readers]) { try { off(); } catch { /* best effort */ } }
    e.readers.clear();
    // Every standing rule a person made on its dialogs goes with it (`answergate.ts`): a
    // plugin switched back on starts asking again.
    forgetRules({ plugin: e.manifest.id });
    e.hook = null;
    e.routes.length = 0;
    // Every stream it served ends, and the phones watching are told (`stream.ended`, cause "plugin").
    this.streams.dropPlugin(e.manifest.id, `${e.manifest.name} is no longer running`);
    // Every file it offered is withdrawn and deleted (`pluginfiles.ts`).
    this.files.dropPlugin(e.manifest.id);
    for (const release of [...e.holds]) release();
    e.holds.clear();
  }

  /** The port `api.hookSink()` names. */
  hookPort(): number { return this.deps.hookPort ?? 8770; }

  /** Which plugin declares backend `id` in its manifest, as "the plugin <Name>"; null when none does. */
  backendOwner(id: string): string | null {
    const e = this.entries.find((x) => !x.loadError && (x.manifest.backends ?? []).includes(id));
    return e ? `the plugin ${e.manifest.name}` : null;
  }

  /**
   * One POST to `/api/plugin/<id>/hook` (loopback already checked by the
   * route). 404 in words for an unknown, broken or switched-off plugin, or one
   * that takes no hooks. Otherwise 200 with the handler's answer — HELD while
   * its promise is pending, and `{}` once `maxHoldMs` passes, the plugin is
   * switched off, the handler throws, or it answers something that is not JSON.
   * Never rejects.
   */
  async hook(pluginId: string, payload: unknown): Promise<PluginHookReply> {
    const e = this.byId(pluginId);
    if (!e) return { status: 404, body: { ok: false, error: `no plugin "${pluginId}" is installed` } };
    if (e.state !== "active") return { status: 404, body: { ok: false, error: `${e.manifest.name} is ${e.state === "off" ? "turned off" : "not running"}` } };
    const h = e.hook;
    if (!h) return { status: 404, body: { ok: false, error: `${e.manifest.name} takes no hooks` } };
    let expiredFns: (() => void)[] | null = [];
    const hold: PluginHookHold = {
      maxHoldMs: h.maxHoldMs,
      onExpired: (fn) => { if (typeof fn === "function") { if (expiredFns) expiredFns.push(fn); } },
    };
    let r: unknown;
    try { r = h.fn(payload, hold); } catch (err) { this.handlerFailed(e, "hook", err); return { status: 200, body: {} }; }
    const jsonBody = (v: unknown): unknown => {
      if (v === undefined || v === null) return {};
      try { JSON.stringify(v); return v; } catch { return {}; }
    };
    if (!r || typeof (r as Promise<unknown>).then !== "function") { expiredFns = null; return { status: 200, body: jsonBody(r) }; }
    return new Promise<PluginHookReply>((resolve) => {
      let done = false;
      const finish = (body: unknown, expired: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        e.holds.delete(release);
        const fns = expiredFns ?? [];
        expiredFns = null;
        resolve({ status: 200, body });
        if (expired) for (const fn of fns) { try { fn(); } catch (err) { this.handlerFailed(e, "hook expiry", err); } }
      };
      const release = () => finish({}, true);
      const timer = setTimeout(release, h.maxHoldMs);
      e.holds.add(release);
      (r as Promise<unknown>).then((v) => finish(jsonBody(v), false), (err) => { this.handlerFailed(e, "hook", err); finish({}, false); });
    });
  }

  /**
   * The runner for `METHOD /api/plugin/<id>/<parts…>` (`api.route`), or null when the plugin is not
   * running or serves nothing there — the caller then answers the core's plain 404, as for any
   * path nobody serves. The runner never rejects: a throw is a 500 in words and the status line.
   */
  /** A file a running plugin offered (`api.offerFile`), for `GET /api/plugin-file/<id>/<token>`; null = gone. */
  offeredFile(pluginId: string, token: string): ServedFile | null {
    const e = this.byId(pluginId);
    if (!e || e.state !== "active") return null;
    return this.files.get(pluginId, token);
  }

  /** `GET|HEAD /api/plugin/<id>/asset/<file>`: unknown plugin / no `assets` / no file ⇒ 404 in words; switched off or not running ⇒ 403. */
  assetFile(pluginId: string, file: string): AssetResult {
    const e = this.byId(pluginId);
    if (!e) return { ok: false, status: 404, error: "no such plugin" };
    if (e.state !== "active") return { ok: false, status: 403, error: `${e.manifest.name} is ${e.state === "off" ? "turned off" : "not running"}` };
    return resolveAsset(e.manifest.name, e.dir, e.manifest.assets, file);
  }

  route(pluginId: string, method: string, parts: readonly string[]): ((req: { query: Record<string, string>; body: unknown }) => Promise<PluginHookReply>) | null {
    const e = this.byId(pluginId);
    if (!e || e.state !== "active") return null;
    const hit = findPluginRoute(e.routes, method, parts);
    if (!hit) return null;
    const { route, params, rest } = hit;
    return async ({ query, body }) => {
      try {
        return cleanReply(await route.fn({ method: route.method, params, rest, query, body }));
      } catch (err) {
        this.handlerFailed(e, `route ${route.method} ${route.pattern}`, err);
        return { status: 500, body: { ok: false, error: String((err as Error)?.message || err) } };
      }
    };
  }

  /** Shutdown: best effort, never awaited by the flush. */
  deactivateAll(): void {
    for (const e of this.entries) if (e.state === "active") void this.deactivate(e).catch(() => {});
  }

  /**
   * The process is exiting: every loaded module's synchronous `shutdown()` —
   * switched on or not, since a switched-off plugin's running sessions keep
   * what it spawned (opencode's per-session servers). Last in the flush
   * (`server/shutdown.ts`). Never throws.
   */
  shutdownAll(): void {
    for (const e of this.entries) {
      if (!e.mod?.shutdown) continue;
      try { e.mod.shutdown(); } catch (err) { console.warn(`[${BRAND.slug}] plugin ${e.manifest.id}: shutdown(): ${msgOf(err)}`); }
    }
  }

  // ── the person's controls (routes) ──────────────────────────────────────

  async setEnabled(id: string, enabled: boolean): Promise<string | null> {
    const e = this.byId(id);
    if (!e) return `no plugin "${id}" is installed`;
    if (e.loadError) return `${e.manifest.name} cannot be turned on: ${e.loadError}`;
    if (e.builtin && e.manifest.optional !== true) return `${e.manifest.name} is part of ${BRAND.displayName} and is always on`;
    e.enabled = enabled;
    const all = this.readEnabled();
    // An optional builtin's absent flag means the RELEASE's default, which may be off — so both answers are written.
    if (e.builtin) all[id] = enabled;
    else if (enabled) delete all[id]; else all[id] = false;
    this.writeJson(this.enabledPath, { enabled: all });
    if (enabled && e.state !== "active") await this.activate(e);
    if (!enabled && e.state !== "off") await this.deactivate(e);
    this.deps.changed();
    return null;
  }

  /** Apply settings atomically: one refused value refuses the whole change, in words. */
  setValues(id: string, values: Record<string, unknown>): string | null {
    const e = this.byId(id);
    if (!e || e.loadError) return e ? `${e.manifest.name} is broken: ${e.loadError}` : `no plugin "${id}" is installed`;
    const next = { ...e.stored };
    for (const [k, v] of Object.entries(values ?? {})) {
      const f = e.manifest.settings?.find((x) => x.key === k);
      if (!f) return `${e.manifest.name} has no setting "${k}"`;
      const c = cleanPluginValue(f, v);
      if (c === undefined) {
        const range = f.kind === "number" ? ` (allowed ${f.min}–${f.max})` : f.kind === "choice" ? ` (allowed: ${f.options.map((o) => o.value).join(", ")})` : "";
        return `"${f.label}" cannot be ${JSON.stringify(v)}${range}`;
      }
      next[k] = c;
    }
    e.stored = next;
    this.writeStored(e);
    const vals = pluginValues(e.manifest, e.stored);
    for (const fn of e.onSettings) { try { fn(vals); } catch (err) { this.handlerFailed(e, "settings", err); } }
    this.deps.changed();
    return null;
  }

  seed(e: PluginEntry, values: Record<string, PluginValue>): void {
    let n = 0;
    for (const [k, v] of Object.entries(values ?? {})) {
      if (k in e.stored) continue; // never over a value the person set
      const f = e.manifest.settings?.find((x) => x.key === k);
      const c = f ? cleanPluginValue(f, v) : undefined;
      if (c !== undefined) { e.stored[k] = c; n++; }
    }
    if (n) { this.writeStored(e); this.deps.changed(); }
  }

  sessionToggle(id: string, sessionId: string, toggle: string, value: boolean | null): string | null {
    const e = this.byId(id);
    if (!e) return `no plugin "${id}" is installed`;
    if (!e.manifest.toggles?.some((t) => t.id === toggle)) return `${e.manifest.name} has no switch "${toggle}"`;
    return this.deps.sessions.setPluginToggle(sessionId, id, toggle, value) ? null : "that session is not open";
  }

  sessionAnswer(id: string, sessionId: string, value: boolean): string | null {
    const e = this.byId(id);
    if (!e) return `no plugin "${id}" is installed`;
    if (value && !e.manifest.answers) return `${e.manifest.name} did not declare "answers", so it may only suggest`;
    return this.deps.sessions.setPluginAnswer(sessionId, id, value) ? null : "that session is not open";
  }

  /** Any active answering plugin with its switch on somewhere — the usage reading is then worth keeping warm. */
  wantsUsage(): boolean {
    return this.entries.some((e) => e.state === "active" && e.manifest.answers && this.deps.sessions.anyPluginAnswer(e.manifest.id));
  }

  async action(id: string, action: string, sessionId?: string): Promise<{ ok: boolean; message: string }> {
    const e = this.byId(id);
    if (!e) return { ok: false, message: `no plugin "${id}" is installed` };
    if (e.state !== "active") return { ok: false, message: `${e.manifest.name} is ${e.state === "off" ? "turned off" : `not running: ${e.error ?? "error"}`}` };
    const def = e.manifest.actions?.find((a) => a.id === action);
    if (!def) return { ok: false, message: `${e.manifest.name} has no action "${action}"` };
    if (def.scope === "session" && (!sessionId || !this.deps.sessions.get(sessionId))) return { ok: false, message: "that action needs an open session" };
    const [fn] = [...e.handlers.action];
    if (!fn) return { ok: false, message: `${e.manifest.name} does not handle "${def.label}"` };
    try {
      const r: any = await within(fn({ action, ...(def.scope === "session" ? { sessionId } : {}) }), ACTION_MS, `"${def.label}"`);
      return { ok: !!r?.ok, message: typeof r?.message === "string" ? r.message.slice(0, 1000) : (r?.ok ? "done" : "failed") };
    } catch (err) {
      this.handlerFailed(e, "action", err);
      return { ok: false, message: `${def.label} failed: ${msgOf(err)}` };
    }
  }

  // ── contributions: setup rows, fixes, methods ───────────────────────────

  /** Every active plugin's setup rows for one worktree, in load order (builtins first). A throw becomes a warn row naming the plugin. */
  setupChecks(s: SetupSubject): ComplianceCheck[] {
    const out: ComplianceCheck[] = [];
    for (const e of this.entries) {
      if (e.state !== "active") continue;
      for (const fn of [...e.setupChecks]) {
        try {
          const c = fn({ worktree: s.worktree });
          if (c && typeof c.id === "string" && typeof c.label === "string") out.push(c);
        } catch (err) {
          this.handlerFailed(e, "setup check", err);
          out.push({ id: `${e.manifest.id}-check`, label: e.manifest.name, status: "warn", detail: `setup check failed: ${msgOf(err)}`, fix: null });
        }
      }
    }
    return out;
  }

  /** The fix ids active plugins answer, in load order. */
  setupFixIds(): string[] {
    return this.entries.filter((e) => e.state === "active").flatMap((e) => [...e.setupFixes.keys()]);
  }

  /**
   * Run one contributed fix. Null when no active plugin answers `id`. A throw is
   * the plugin's status line AND is rethrown, so `fixRepoCompliance` answers it
   * the way it answers a core fix that threw: `ok: false` with the reason.
   */
  runSetupFix(id: string, s: SetupSubject): SetupFixOutcome | null {
    for (const e of this.entries) {
      const fn = e.state === "active" ? e.setupFixes.get(id) : undefined;
      if (!fn) continue;
      try {
        const r = fn({ worktree: s.worktree });
        return { applied: !!r?.applied, note: String(r?.note ?? "").slice(0, 1000) };
      } catch (err) {
        this.handlerFailed(e, `fix "${id}"`, err);
        throw err;
      }
    }
    return null;
  }

  /** A repo by id — `api.repo()` and `api.handToAgent` both start here. */
  findRepo(repoId: string): Promise<RepoTarget | null> {
    return this.deps.findRepo ? this.deps.findRepo(repoId) : findTarget(this.deps.root, repoId);
  }

  /**
   * A repo by its worktree's realpath, among the repos this host lists — the lookup behind a path
   * `api.repo()`/`api.handToAgent` is given when its spelling is not the one the id was made from
   * (`/tmp` vs `/private/tmp`, a symlinked root). Never a folder outside the list.
   */
  async findRepoByPath(realPath: string): Promise<RepoTarget | null> {
    if (this.deps.findRepoByPath) return this.deps.findRepoByPath(realPath);
    const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };
    for (const t of await discoverTargets(this.deps.root)) if (real(t.worktreePath) === realPath) return t;
    return null;
  }

  /** The backlog add behind `api.handToAgent`, or why there is none. */
  handToAgent(p: HandToAgentArgs): Promise<HandToAgentResult> {
    if (this.deps.handToAgent) return this.deps.handToAgent(p);
    const host = this.deps.host;
    if (!host) return Promise.resolve({ ok: false, reason: "this host has no backlog to hand work to" });
    return handToAgentVia({ containRepoDir: (d) => host.containRepoDir(d), backlog: host.backlog, intents: host.intents }, p);
  }

  /** Who already answers fix `id`, in words — null when it is free for `e`. */
  fixTaken(e: PluginEntry, id: string): string | null {
    if (CORE_FIX_IDS.includes(id)) return `fix "${id}" belongs to ${BRAND.displayName}'s own checklist`;
    const other = this.entries.find((x) => x !== e && x.state === "active" && x.setupFixes.has(id));
    return other ? `fix "${id}" is already handled by ${other.manifest.name}` : null;
  }

  /**
   * Call a method a plugin registered with `api.handle`. The ONE entry point
   * the generic `plugin.call` wire message routes to; nothing else reaches a
   * handler. Every failure is a sentence, never a throw.
   */
  async call(pluginId: string, method: string, args: unknown, caller: PluginCaller = IN_PROCESS_CALLER): Promise<PluginCallResult> {
    const e = this.byId(pluginId);
    if (!e) return { ok: false, error: `no plugin "${pluginId}" is installed` };
    if (e.state !== "active") return { ok: false, error: `${e.manifest.name} is ${e.state === "off" ? "turned off" : `not running: ${e.error ?? "error"}`}` };
    const fn = e.methods.get(method);
    if (!fn) return { ok: false, error: `${e.manifest.name} has no method "${method}"` };
    try {
      const result = await within(fn(args, caller), ACTION_MS, `${e.manifest.name} "${method}"`);
      let size = 0;
      try { size = Buffer.byteLength(JSON.stringify(result ?? null), "utf8"); } catch { return { ok: false, error: `${e.manifest.name} "${method}" answered something that is not JSON` }; }
      if (size > CALL_RESULT_MAX) return { ok: false, error: `${e.manifest.name} "${method}" answered ${Math.round(size / 1024)} KB — over the ${CALL_RESULT_MAX / 1024} KB a call may carry` };
      return { ok: true, result: result ?? null };
    } catch (err) {
      this.handlerFailed(e, `"${method}"`, err);
      return { ok: false, error: `${e.manifest.name} "${method}" failed: ${msgOf(err)}` };
    }
  }

  /** `call` through the ledger: a repeated ackId runs the handler once. Args must be JSON and small. */
  callOnce(ackId: string, pluginId: string, method: string, args: unknown, caller: PluginCaller = IN_PROCESS_CALLER): Promise<PluginCallResult> {
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(args ?? null), "utf8"); } catch { return Promise.resolve({ ok: false, error: "the arguments are not JSON" }); }
    if (bytes > PLUGIN_ARGS_MAX) return Promise.resolve({ ok: false, error: `the arguments are ${Math.round(bytes / 1024)} KB — over the ${PLUGIN_ARGS_MAX / 1024} KB a call may carry` });
    return this.ledger.run(ackId, `${pluginId}\0${method}`, () => this.call(pluginId, method, args, caller));
  }

  // ── events from the core ────────────────────────────────────────────────

  /** A choice box appeared (`sessions.on("prompt")`). */
  firePrompt(sessionId: string, p: DetectedPrompt): void {
    this.told.set(sessionId, promptFingerprint(p));
    const ev: PluginPromptEvent = {
      sessionId, question: p.question, options: p.options.map((o) => ({ index: o.index, label: o.label })),
      kind: p.kind, ...(p.multi ? { multi: true } : {}),
      blocked: isBlocked(p) || !!p.multi,
    };
    this.fire("prompt", ev);
  }

  /** A turn ended asking something with no box. */
  fireQuestion(ev: PluginQuestionEvent): void { this.fire("question", ev); }

  private fire(kind: "prompt" | "question", ev: object): void {
    for (const e of this.entries) {
      if (e.state !== "active") continue;
      for (const fn of [...e.handlers[kind]]) {
        try {
          const r = fn(ev);
          if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch((err) => this.handlerFailed(e, kind, err));
        } catch (err) { this.handlerFailed(e, kind, err); }
      }
    }
  }

  /** A throwing handler is the plugin's status line, never the daemon's problem. */
  handlerFailed(e: PluginEntry, what: string, err: unknown): void {
    console.warn(`[${BRAND.slug}] plugin ${e.manifest.id}: ${what} handler threw: ${msgOf(err)}`);
    this.setStatus(e, { tone: "bad", text: `${what} handler failed: ${msgOf(err)}` });
  }

  setStatus(e: PluginEntry, s: PluginStatus | null): void {
    const next = s ? { tone: s.tone, text: String(s.text).slice(0, 300) } : null;
    if (JSON.stringify(next) === JSON.stringify(e.status)) return;
    e.status = next;
    this.deps.changed();
  }

  /** Stamp and show a plugin's suggestion. */
  suggest(e: PluginEntry, sessionId: string, s: Omit<AnswerSuggestion, "by" | "byName"> | null): void {
    const cur = this.deps.sessions.get(sessionId)?.suggestion;
    if (!s) { if (cur?.by === e.manifest.id) this.deps.sessions.setSuggestion(sessionId, null); return; }
    const conf = Number(s.confidence);
    this.deps.sessions.setSuggestion(sessionId, {
      by: e.manifest.id, byName: e.manifest.name,
      choice: typeof s.choice === "number" && Number.isInteger(s.choice) ? s.choice : null,
      ...(typeof s.reply === "string" ? { reply: s.reply.slice(0, 4000) } : {}),
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
      rationale: String(s.rationale ?? "").slice(0, 600),
      ...(s.model ? { model: String(s.model) } : {}),
    });
  }

  // ── disk ────────────────────────────────────────────────────────────────

  private readEnabled(): Record<string, boolean> {
    // `{ enabled: {...} }`. Anything else that is there is moved aside, not left for the next
    // switch to overwrite — a person's on/off choices are the one thing here nothing can re-derive.
    const doc = readJsonGuarded<{ enabled?: Record<string, boolean> } | null>(this.enabledPath, null, isEnabledDoc);
    return doc?.enabled ?? {};
  }

  private readStored(id: string, m: PluginManifestLike): Record<string, PluginValue> {
    const out: Record<string, PluginValue> = {};
    // Absent is a plugin with nothing stored yet; a file that is not an object is moved aside.
    const doc = readJsonGuarded<Record<string, unknown>>(join(this.stateDir, "plugins", id, "settings.json"), {}, isPlainObject);
    for (const f of m.settings ?? []) {
      const c = f.key in doc ? cleanPluginValue(f, doc[f.key]) : undefined;
      if (c !== undefined) out[f.key] = c;
    }
    return out;
  }

  private writeStored(e: PluginEntry): void {
    this.writeJson(join(this.stateDir, "plugins", e.manifest.id, "settings.json"), e.stored);
  }

  private writeJson(path: string, doc: unknown): void {
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      writeJsonAtomic(path, doc, { space: 2 });
    } catch (err) { console.warn(`[${BRAND.slug}] plugins: could not write ${path}: ${msgOf(err)}`); }
  }
}
