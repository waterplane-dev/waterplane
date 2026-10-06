/**
 * `ServerCtx` — `main.ts`'s module-level names as one record.
 *
 * `HostCtx` (`routes/types.ts`) already is this record for the routes. This
 * adds the names the OTHER functions of `main.ts` close over once they live in
 * `server/*.ts` factories, derived by script (every free identifier of each
 * M2–M6 region that is bound at `main.ts` module scope and defined outside that
 * region), minus what `HostCtx` already carries. See
 * docs/notes/host-architecture.md, "ServerCtx".
 *
 * **The one rule for a `server/` factory: read `ctx.<x>` at CALL time, never
 * destructure at construction.** `main.ts` fills this object incrementally, in
 * boot order, and several readers (the IntentManager deps literal, `startPrompt`,
 * `announceBuild`) reference names defined AFTER them. A factory that wrote
 * `const { backlog } = ctx` at its top would capture `undefined` for ever and
 * still type-check.
 *
 * Types only — `hostshape` refuses any runtime token in this file.
 */
import type { WebSocket } from "ws";
import type { AssessNote, BuildRun, ClientMessage, Intent, NewImage } from "@waterplane/shared";
import type { HostCtx } from "../routes/types.js";
import type { DeliveryResult } from "../deliver.js";
import type { PushManager } from "../push.js";
import type { OnboardManager } from "../onboard.js";
import type { SetupWatcher } from "../setupwatch.js";
import type { CliHealthStore } from "../clihealth.js";
import type { TokenStatsStore } from "../tokenstats.js";
import type { UiStats } from "../uistats.js";
import type { UsageLog } from "../usagelog.js";
import type { SmartPick } from "../smartpick.js";
import type { ExecutorResult } from "../intents/manager.js";
import type { PeerStore } from "../peers/store.js";

/** A file a scan found — the shape `scanOutboxDocs`/`scanPullCandidates` answer. */
export interface ScannedFile { name: string; relPath: string; size: number; mtime: number }

export interface ServerCtx extends HostCtx {
  // ── constants (main.ts, top) ───────────────────────────────────────────────
  /** Read by wsops (`welcome`), http (`listenWithRetry`), shutdown. */
  readonly PORT: number;
  /** `--doctor`: a report never starts anything. Read by deliveries
   *  (`openDeliveries.start()` gate). Gate exactly what main gates today. */
  readonly DOCTOR: boolean;

  // ── constructions that stay in main.ts ─────────────────────────────────────
  /** Read by http (`handleApi` deps). clients takes it at construction. */
  readonly push: PushManager;
  /** Read by sessionEvents, http. */
  readonly setupWatch: SetupWatcher;
  /** The peer ledger (`peers/store.ts`). Read by http (`/api/peers*`, `/api/peer/*`). */
  readonly peers: PeerStore;
  /** The first-app onboarding job. Read by http (`/api/onboard*`). */
  readonly onboard: OnboardManager;
  /** Read by shutdown (flush). */
  readonly cliHealthStore: CliHealthStore;
  /** Read by http, shutdown. */
  readonly tokenStats: TokenStatsStore;
  /** Read by http. */
  readonly uiStats: UiStats;
  /** Read by http, shutdown. */
  readonly usageLog: UsageLog;
  /** Read by intentDeps, intentEvents, http. Defined AFTER the deps literal. */
  readonly smartpick: SmartPick;
  /** Read by intentDeps. Defined AFTER the deps literal. */
  readonly assessExecutor: (i: Intent) => Promise<ExecutorResult>;

  // ── clients (server/clients.ts) ────────────────────────────────────────────
  /** The token each socket presented. Read by wsops (`attachWs`). */
  readonly wsToken: WeakMap<WebSocket, string>;
  /** The ledger device id each token-authenticated socket is. Read by wsops. */
  readonly wsDevice: WeakMap<WebSocket, string>;
  /** Close every socket of a revoked device; how many. Read by http. */
  closeDevice(id: string): number;
  /** Is anybody looking at this session right now? Read by intentDeps and by
   *  main's linger sweep. */
  isAttachedToSomeone(id: string): boolean;

  // ── deliveries (server/deliveries.ts) ──────────────────────────────────────
  /** Narrows `HostCtx.startPrompt`: the work-item executor passes
   *  `{ rescue: false }` and settles its row on the verdict. Written as a
   *  property, not a method signature, so `hostpins`' chain pin (which skips
   *  only `routes/types.ts` by name) does not count it as a call. */
  readonly startPrompt: (sessionId: string, text: string, opts?: { rescue?: boolean }) => Promise<DeliveryResult>;
  /** Read by intentDeps (the `freshSession`/`session` executors). A property
   *  for the same pin reason as `startPrompt`. */
  readonly deliverChain: (sessionId: string, steps: readonly string[]) => Promise<{ last: DeliveryResult; step: number }>;

  // ── scan (server/scan.ts) ──────────────────────────────────────────────────
  /** Per-repo memory of outbox documents already announced. Read by sessionEvents. */
  readonly outSeen: Map<string, Set<string>>;
  /** Read by intentEvents (`settled` of a build row). */
  announceBuild(run: BuildRun): void;
  /** Read by sessionEvents. */
  scanImages(cwd: string): NewImage[];
  /** Read by sessionEvents. */
  scanOutboxDocs(cwd: string): ScannedFile[];
  /** Read by sessionEvents. */
  scanPullCandidates(cwd: string, scope: "outbox" | "repo"): ScannedFile[];
  /** Read by sessionEvents. */
  pullNewFiles(id: string, cwd: string): void;
  /** Read by sessionEvents. */
  fmtSize(b: number): string;

  // ── intentEvents (server/intentEvents.ts) ──────────────────────────────────
  /** Read by main's `makeAssessExecutor({ notes })`, built BEFORE the snapshots:
   *  main must pass a late-bound arrow, not the member's value. */
  padNotesFor(cwd: string): AssessNote[];

  // ── stays in main.ts ───────────────────────────────────────────────────────
  /** `dispatch(ctx, ws, msg)`. Read by wsops (`attachWs`'s message handler). */
  handleClientMessage(ws: WebSocket, msg: ClientMessage): void;
}

/**
 * The same record while `main.ts` is still filling it, one assignment per name
 * at the position that name is defined today. Handed to factories as a
 * `ServerCtx` (a mutable record is assignable to the readonly one).
 */
export type ServerCtxDraft = { -readonly [K in keyof ServerCtx]: ServerCtx[K] };
