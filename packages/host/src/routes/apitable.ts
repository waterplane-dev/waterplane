/**
 * The HTTP API's registration: `route(method, pattern, handler)` and
 * `mount(name, fn)`, the matcher, and the context every table is handed.
 *
 * The `api.ts` if-chain as data (host-architecture.md, "api.ts — the HTTP
 * routes as tables"). First match wins, in table order, and the end of the
 * table is the caller's 404 — which is what the chain did, now with the order
 * written down in one place and the routes listable (`listApiRoutes`), so a
 * pin can hold the list instead of a reader re-deriving it from forty `if`s.
 *
 * What a table can NOT do is reach a request before the frame has judged it:
 * the origin/Host gate and the token gate run in `server/http.ts` before
 * `handleApi`, and nothing here re-checks, loosens or skips them.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OnboardManager } from "../onboard.js";
import type { SetupWatcher } from "../setupwatch.js";
import type { PeerStore } from "../peers/store.js";
import type { AppReadinessReport, PeerKind, RepoTarget } from "@waterplane/shared";
import type { IntentManager } from "../intents/manager.js";
import type { BacklogManager } from "../backlog.js";
import type { PushManager } from "../push.js";
import type { CaptureManager } from "../capture.js";
import type { SessionManager } from "../sessions.js";
import type { UiStats } from "../uistats.js";
import type { NetStats } from "../netstats.js";
import type { TokenStatsStore } from "../tokenstats.js";
import type { UsageLog } from "../usagelog.js";
import type { UsageSourceRegistry } from "../usagesources.js";

export interface ApiCtx {
  root: string;
  push: PushManager;
  sessions: SessionManager;
  uiStats: UiStats;
  netstats: NetStats;
  /** The host's own setup sweep — repo listings read its verdicts, and the
   *  checklist routes write theirs back into it. */
  setup: SetupWatcher;
  /** The health index cache (`healthwatch.ts`): `/api/repos` reads it, never runs the engine. */
  health?: import("../healthwatch.js").HealthWatch;
  /** The persisted attention items (`attentionstore.ts`) — `/api/repos` derives
   *  `gitFailed`/`buildFailed` from them, the same predicate as the bell. */
  attention?: Pick<import("../attentionstore.js").AttentionStore, "unhandled">;
  /** Resolve an attention item whose cause the listing saw go away (a failed
   *  push since pushed another way) — `clients.ts`' resolver, which re-sends the feed. */
  resolveAttention?: (key: string, note: string) => number;
  /** Build runs in flight — `/api/repos` marks a repo whose build is running. */
  builds?: Pick<import("../builds.js").BuildManager, "runningIn">;
  /** Sessions parked until their files arrive. An inbox POST is the event that
   *  most often opens one, and waiting up to a tick for it would be latency
   *  nobody asked for — so the upload route kicks the gate directly. */
  launches: { fileLanded(cwd: string): void };
  /** The configured budget periods (an agent's `window` trigger may name one). */
  periods?: () => readonly import("@waterplane/shared").BudgetPeriod[];
  /** Token usage across every conversation log on disk — the statistics
   *  screen's source (`tokenstats.ts`). */
  tokenStats: TokenStatsStore;
  /** The `/usage` readings this daemon has taken, kept (`usagelog.ts`). */
  usageLog: UsageLog;
  /** The other sources' kept readings (`usagesourcelog.ts`), by source id. */
  usageSources: Pick<UsageSourceRegistry, "history">;
  /** The checker's poll period, passed through so the history can say what
   *  a dense series would have looked like. */
  usagePollMs: number;
  /** This daemon's boot id (`welcome.bootId`): a resume point is valid only for the boot that issued it. */
  bootId?: string;
  /** The week-end burn (`weekburn.ts`): `GET|POST /api/weekburn`. */
  weekBurn?: import("../weekburn.js").WeekBurn;
  /** The account facts the socket pushes, as one read (`GET /api/usagenow`, `UsageNowDoc`). */
  usageNow?(): import("@waterplane/shared").UsageNowDoc;
  /**
   * The verified capture loop, so an AGENT can trigger one without a phone and
   * without a session (`capture.ts`).
   *
   * This is the one caller that gets the verdict in a response body instead of
   * over the socket, and it is why the whole loop prints a ~50-token line: an
   * agent that asked for a picture and was handed the picture pays for that
   * image on every later turn of the conversation it is in.
   */
  capture: CaptureManager;
  /** The intent store and the containment gate, for the agent's loopback
   *  route (`agentintents.ts`) — the same `post` the phone's `intent.post`
   *  reaches, through the same `postClientDraft`. */
  intents: IntentManager;
  /** The ack ledger, read-only here: `/api/health` says when its receipts stop
   *  reaching the disk (`acks.ts`'s `lastWriteError`). */
  acks?: { lastWriteError(): string | null };
  /** …and `backlog.add`, for the agent's backlog add (`addClientBacklogItem`,
   *  the same path the socket's `backlog.add` takes). */
  backlog: BacklogManager;
  containRepoDir(dir: unknown): Promise<string | null>;
  /** The peer ledger + the trusted-path rule (`peers/routes.ts`): `/api/peers*` and `/api/peer/*`. */
  peers?: PeerStore;
  canManage?(kind: PeerKind): boolean;
  /** The first-app onboarding job (`onboard.ts`, `/api/onboard*`). */
  onboard?: OnboardManager;
  /** Every Android app module across the repos, as facts (`apkcheck.ts`' `apkRepoFacts`) —
   *  `GET /api/apps/readiness`. A closure because the build list and the auto-download rule
   *  belong to their managers, which this table does not otherwise reach. */
  appReadiness?(): Promise<AppReadinessReport>;
  /** A plugin's hook sink (`PluginRegistry.hook`): status + JSON body, possibly HELD. Never rejects. */
  pluginHook?(pluginId: string, payload: unknown): Promise<{ status: number; body: unknown }>;
  /** A plugin's own route (`api.route`, `PluginRegistry.route`): the runner, or null when nothing
   *  is served at `parts` for `method`. Never rejects. */
  pluginRoute?(pluginId: string, method: string, parts: readonly string[]):
    ((req: { query: Record<string, string>; body: unknown }) => Promise<{ status: number; body: unknown }>) | null;
  /** A plugin's static asset (`manifest.assets`, `PluginRegistry.assetFile`). */
  pluginAsset?(pluginId: string, file: string): import("../plugins/pluginassets.js").AssetResult;
  /** A file a plugin offered (`api.offerFile`, `PluginRegistry.offeredFile`); null when gone. */
  pluginFile?(pluginId: string, token: string): { file: string; name: string; size: number; mtime: number; token: string; delivered(): void } | null;
}

/** One request as a handler sees it. */
export interface ApiReq {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  /** The pattern's `:name` segments, RAW — the matcher never decodes. */
  params: Record<string, string>;
  /** What a trailing `*` matched, one entry per segment (empty for none). */
  rest: string[];
}

/** A request inside the repo scope (`/api/repos/:id/…`): the target is already resolved. */
export interface RepoReq extends ApiReq {
  target: RepoTarget;
  /** `target.worktreePath` — what nearly every repo route acts on. */
  wt: string;
}

/** Answer the request — or return `false`: "not mine", the next entry is asked. */
export type ApiHandler<R extends ApiReq = ApiReq> = (r: R, ctx: ApiCtx) => unknown;

export interface ApiRoute<R extends ApiReq = ApiReq> {
  kind: "route";
  /** One verb, or `"*"` for any. */
  method: string;
  pattern: string;
  segs: readonly string[];
  handler: ApiHandler<R>;
  /** A scope's own table, relative to `prefix` — for `listApiRoutes` only. */
  sub?: { prefix: string; table: readonly ApiEntry<never>[] };
}

/** A delegating handler with its own dispatch: `true` = it answered. */
export interface ApiMount {
  kind: "mount";
  name: string;
  handler: (r: Omit<ApiReq, "params" | "rest">, ctx: ApiCtx) => Promise<boolean>;
}

export type ApiEntry<R extends ApiReq = ApiReq> = ApiRoute<R> | ApiMount;

/**
 * Register a route. A pattern is `/`-separated: a literal segment, `:name`
 * (exactly one segment — any string, the empty one included), and a trailing
 * `*` (zero or more further segments, handed over as `rest`).
 */
export function route<R extends ApiReq = ApiReq>(method: string, pattern: string, handler: ApiHandler<R>): ApiRoute<R> {
  const segs = pattern.split("/");
  if (segs.slice(0, -1).includes("*")) throw new Error(`route ${pattern}: \`*\` is only allowed last`);
  return { kind: "route", method, pattern, segs, handler };
}

export function mount(name: string, handler: ApiMount["handler"]): ApiMount {
  return { kind: "mount", name, handler };
}

/** Match `parts` (a path split on `/`) against a route's segments. */
export function matchSegs(segs: readonly string[], parts: readonly string[]): { params: Record<string, string>; rest: string[] } | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === "*" && i === segs.length - 1) return { params, rest: parts.slice(i) };
    if (i >= parts.length) return null;
    if (s.startsWith(":")) params[s.slice(1)] = parts[i]!;
    else if (s !== parts[i]) return null;
  }
  return parts.length === segs.length ? { params, rest: [] } : null;
}

/**
 * Ask each entry in order; `true` once one answered. `base` is everything but
 * the match; `parts` is what the patterns are matched against (the whole path
 * for the top table, what follows the scope for a scope's own).
 */
export async function dispatchApi<R extends ApiReq>(
  table: readonly ApiEntry<R>[],
  base: Omit<R, "params" | "rest">,
  parts: readonly string[],
  ctx: ApiCtx,
): Promise<boolean> {
  for (const e of table) {
    if (e.kind === "mount") {
      if (await e.handler(base, ctx)) return true;
      continue;
    }
    if (e.method !== "*" && e.method !== base.method) continue;
    const m = matchSegs(e.segs, parts);
    if (!m) continue;
    if ((await e.handler({ ...base, ...m } as R, ctx)) === false) continue;
    return true;
  }
  return false;
}

/** Every entry as `METHOD pattern` / `MOUNT name`, scopes expanded, in table order. */
export function listApiRoutes(table: readonly ApiEntry<never>[]): string[] {
  const out: string[] = [];
  const walk = (t: readonly ApiEntry<never>[], prefix: string): void => {
    for (const e of t) {
      if (e.kind === "mount") { out.push(`MOUNT ${e.name}`); continue; }
      out.push(`${e.method} ${prefix}${e.pattern}`);
      if (e.sub) walk(e.sub.table, `${prefix}${e.sub.prefix}/`);
    }
  };
  walk(table, "");
  return out;
}
