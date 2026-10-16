/**
 * What a route handler is, and what it is handed.
 *
 * `main.ts` used to dispatch every client message from one 717-line `switch`
 * with 92 arms. Two problems came from that shape, and neither was tidiness:
 *
 *  - **Cross-cutting rules were per-arm things somebody had to remember.**
 *    `durableOp()` is the at-most-once wrapper every ackId-carrying op needs,
 *    and it was applied by hand inside six case bodies; `containRepoDir()` is
 *    described in `CLAUDE.md` as "the ONE gate on a directory a client named"
 *    and was likewise called by hand in two. Nothing about arm 93 would make
 *    either of them a compile error to omit. Here they are declared —
 *    `{ durable: true }`, `{ contain: "cwd" }` — so the dispatcher applies them
 *    and forgetting is visible in the table rather than invisible in a body.
 *  - **Every feature edited the same file.** `main.ts` is second only to
 *    `App.tsx` in churn for exactly this reason.
 *
 * The handler takes ONE object rather than positional arguments. That is not a
 * style choice: `noUnusedParameters` is on, and most handlers want two of the
 * four values, which with positional parameters means either underscore-prefixed
 * noise on every second handler or turning the check off.
 */
import type { ClientMessage, HostMessage, NotificationItem, NotificationKind, PeerKind, PullItem, SendStamp, SendView, AuthState, ClientRole } from "@waterplane/shared";
import type { WebSocket } from "ws";
import type { SessionManager } from "../sessions.js";
import type { BacklogManager } from "../backlog.js";
import type { ReviewManager } from "../review.js";
import type { FanoutManager } from "../fanout.js";
import type { BuildManager } from "../builds.js";
import type { CaptureManager } from "../capture.js";
import type { AssessStore } from "../assess.js";
import type { NamingManager } from "../naming.js";
import type { AutoPullManager } from "../autopull.js";
import type { IntentManager } from "../intents/manager.js";
import type { OpenDeliveries } from "../opendeliveries.js";
import type { UpdateChecker } from "../update.js";
import type { PluginRegistry } from "../plugins/pluginregistry.js";
import type { DecisionLog } from "../decisionlog.js";
import type { SentLog } from "../sentlog.js";
import type { SettingsStore } from "../settings.js";
import type { InstallLogStore } from "../installlog.js";
import type { NotifyPrefsStore } from "../notifyprefs.js";
import type { AuthManager } from "../auth.js";
import type { Meter } from "../meter.js";
import type { UsageChecker } from "../usage.js";
import type { UsageSourceRegistry } from "../usagesources.js";
import type { BudgetStore } from "../budget.js";
import type { BillingStore } from "../billing.js";
import type { AckLedger } from "../acks.js";
import type { NetStats } from "../netstats.js";

/** The verdict an ackId-carrying op is remembered by. Mirrors `acks.ts`. */
export interface OpVerdict {
  ok: boolean;
  reason?: string;
  sessionId?: string;
  runId?: string;
  launchId?: string;
  /** The durable row this op produced or found. Same string as `launchId` when
   *  the op was a parked create — the two names are one row now. */
  intentId?: string;
  /** `assess.apply` only: the pad-note ids whose backlog row actually landed.
   *  Absent means this op cannot say (so: nothing was filed); `[]` means it can
   *  say, and nothing was. See the `op.ack` wire type — a phone clears exactly
   *  `ticked ∩ filed`, and that is the only thing standing between a refused
   *  post and a tombstoned note. */
  filed?: string[];
}

/** What `deliverInput` answers — see `deliver.ts` for what the four states mean.
 *  `rescued` is the fifth and is NOT one of deliver.ts's: it is what happened
 *  INSTEAD of a delivery, when the session was gone and the host kept the words
 *  as a work item rather than handing the problem back to the phone. */
export interface InputVerdict {
  ok: boolean;
  reason?: string;
  state?: "ok" | "notready" | "unconfirmed" | "unsubmitted" | "rescued" | "forked";
  retryable?: boolean;
}

/**
 * Everything a handler may reach for, constructed once in `main()`.
 *
 * This is deliberately a bag of the daemon's managers rather than a narrower
 * per-route interface. The managers are singletons with real lifetimes (PTYs,
 * timers, files on disk) and were module-level `const`s reached by import; the
 * change that matters is that they are now PASSED, which is what lets a test
 * construct two of them instead of booting the whole daemon.
 */
export interface HostCtx {
  readonly ROOT: string;
  readonly BOOT_ID: string;

  readonly sessions: SessionManager;
  readonly backlog: BacklogManager;
  /** Check / validate / next-step — the verbs on work that has already settled.
   *  Its own manager because a verdict is not lifecycle; see `review.ts`. */
  readonly review: ReviewManager;
  readonly fanout: FanoutManager;
  readonly builds: BuildManager;
  /** The verified capture loop — targets per repo, and a run that IS an intent.
   *  Its own manager beside `builds` because a capture is a build with a claim
   *  on the end of it, and the claim is the part nothing else here makes. */
  readonly capture: CaptureManager;
  /** The assessment proposals, keyed by run (intent) id — `reviews.json`'s
   *  sidecar shape, for its reason: a proposal is not lifecycle. */
  readonly assess: AssessStore;
  /** Titles for untitled backlog rows — the cheapest completion this daemon
   *  buys, and the one that may never write over a name a person typed. */
  readonly naming: NamingManager;
  readonly autopull: AutoPullManager;
  /**
   * The durable Intent store — one file, one tick, one lifecycle. It is what
   * `schedules` and `launches` used to be: both of those managers are gone, and
   * their messages are answered by adapters over this (`intents/adapters.ts`),
   * which is why `scheduleSnapshot()` and `launchSnapshot()` are still here.
   */
  readonly intents: IntentManager;
  /** Deliveries whose fate the host could not confirm, and is still asking about. */
  readonly openDeliveries: OpenDeliveries;
  readonly updates: UpdateChecker;
  /** The installed plugins (`plugins/pluginregistry.ts`, docs/notes/plugins.md). */
  readonly plugins: PluginRegistry;
  /** Limit auto-continues + plugin decisions; a change broadcasts `decisions.log`. */
  readonly decisionLog: DecisionLog;
  readonly sentLogStore: SentLog;
  /** What the phones installed, and when, and which phone. */
  readonly installLog: InstallLogStore;
  readonly settings: SettingsStore;
  readonly notifyPrefs: NotifyPrefsStore;
  readonly auth: AuthManager;
  readonly meter: Meter;
  readonly usage: UsageChecker;
  /** Usage readings per source (`usagesources.ts`): claude adapted first, then each contributed probe. */
  readonly usageSources: UsageSourceRegistry;
  readonly budget: BudgetStore;
  /** Which kind of account claude bills to (`billing.ts`). */
  readonly billing: BillingStore;
  readonly acks: AckLedger;
  readonly netstats: NetStats;

  /** Which sessions each socket streams. A frame goes only to attached sockets. */
  readonly attached: WeakMap<WebSocket, Set<string>>;
  readonly clients: Set<WebSocket>;
  readonly wsKind: WeakMap<WebSocket, PeerKind>;
  /** A socket's role (`notify` = the APK's background link, sent only its
   *  allow-list by `send`). Set at the upgrade, overridden by `hello.role`. */
  readonly wsRole: WeakMap<WebSocket, ClientRole>;

  /** The in-app notification feed, newest first. */
  readonly notifications: NotificationItem[];
  /** Per-session memory of the strip's files already announced: relPath → mtime. */
  readonly imgSeen: Map<string, Map<string, number>>;
  readonly pullSeen: Map<string, { scope: "outbox" | "repo"; paths: Set<string> }>;
  /** Apply a just-saved auto-download rule to what is already on disk — bounded,
   *  because a rule is usually switched on while looking at the file it is for
   *  (`autopull.ts`, `catchUpCandidates`). Returns what it queued. */
  pullCatchUp(cwd: string): Promise<PullItem[]>;
  /** Deliveries running right now, so a retry that races the first one joins it
   *  rather than typing a second copy. Memory only, on purpose. */
  readonly inputsInFlight: Map<string, Promise<InputVerdict>>;

  send(ws: WebSocket, msg: HostMessage): void;
  broadcast(msg: HostMessage): void;
  notify(kind: NotificationKind, p: {
    title: string; body: string; sessionId?: string; tag?: string;
    image?: { repoId: string; relPath: string };
    file?: { repoId: string; relPath: string; name: string; size: number; mtime?: number };
    pull?: string;
    /** Id of the plugin that posted it (host-filled); a tap opens that plugin. */
    plugin?: string;
  }): void;

  backlogSnapshot(): HostMessage;
  /** Both of these are now VIEWS of the intent store — see `intents/adapters.ts`
   *  for why the old vocabularies are still spoken. */
  scheduleSnapshot(): HostMessage;
  launchSnapshot(): HostMessage;
  intentSnapshot(): HostMessage;
  /**
   * One repo's newest assessment run.
   *
   * Its OWN snapshot, and the reason is a gap rather than a preference: an
   * assess row is neither `isBacklogRow` (which wants a prompt payload) nor
   * `isBuildRow`, so it appears in no other snapshot — a run would be invisible
   * for the entire time it works.
   */
  assessSnapshot(repoDir: string): HostMessage;
  deliverySnapshot(): HostMessage;

  authStateFor(kind: PeerKind): AuthState;
  enforceAuth(): void;
  broadcastAuthState(): void;
  recomputeWatched(): void;
  publishBudget(force?: boolean): void;
  syncUsagePolling(): void;
  /** Types a create's first prompt. It ANSWERS with the delivery verdict (the
   *  work-item executor settles its row on it); a route that only wants the
   *  side effect can go on ignoring the result. */
  startPrompt(sessionId: string, text: string): Promise<unknown>;
  /** `ackId` is carried only so a verdict settled later can name the client row
   *  it retires — see `opendeliveries.ts`. `cwd` is the repo the words were
   *  composed for: a hint, read ONLY when the session turns out to be gone, and
   *  then the difference between refusing and keeping them (`rescued`). */
  deliverInput(id: string, text: string, ackId?: string, cwd?: string, view?: SendView): Promise<InputVerdict>;

  /** At-most-once per ackId. Prefer the table's `durable: true` — this stays
   *  exposed for the handlers that wrap only PART of their work. */
  /** `stamp` is the message's own `firstSentAt`/`sentAt` — pass the message: it
   *  is what refuses a pre-loss re-send after a lost ledger (`acks.ts`). */
  durableOp(ws: WebSocket, ackId: string | undefined, exec: () => OpVerdict | Promise<OpVerdict>, stamp?: SendStamp): void;
  /** The one gate on a directory a client named. Prefer `contain` in the table. */
  containRepoDir(dir: unknown): Promise<string | null>;
}

/** Narrow `ClientMessage` to the arm(s) one handler serves. */
export type MsgOf<K extends ClientMessage["t"]> = Extract<ClientMessage, { t: K }>;

/** What every handler is handed. One object — see the note at the top. */
export interface RouteArgs<K extends ClientMessage["t"]> {
  readonly c: HostCtx;
  readonly msg: MsgOf<K>;
  readonly ws: WebSocket;
  /** The session ids this socket is streaming. */
  readonly att: Set<string>;
  /**
   * The client-named directory, already contained — present only when the
   * table entry declared `contain`. A handler that declared it can use this
   * without checking; one that did not has no directory to be wrong about.
   */
  readonly dir: string;
}

export type Route<K extends ClientMessage["t"]> = (a: RouteArgs<K>) => void;

/**
 * A route that returns a VERDICT instead of answering the socket itself. The
 * dispatcher wraps it in `durableOp`, so a re-sent ackId is re-acked from the
 * ledger and the work is not done twice.
 */
export type DurableRoute<K extends ClientMessage["t"]> = (a: RouteArgs<K>) => OpVerdict | Promise<OpVerdict>;

/**
 * A route plus the cross-cutting rules it needs applied.
 *
 * `durable` and `contain` are DECLARED rather than called because both are
 * rules a new handler can silently omit and neither failure is visible until it
 * matters — a duplicated fan-out across twelve repos, or an agent spawned
 * outside the configured root. Stated here, the omission is in the table where
 * a reviewer reads it, next to ninety siblings that got it right.
 */
export interface RouteSpec<K extends ClientMessage["t"]> {
  /**
   * At-most-once per ackId. The handler RETURNS its verdict; the dispatcher
   * acks it, remembers it, and re-acks a repeat from the ledger without
   * running anything.
   */
  durable?: true;
  /**
   * The field naming a directory the CLIENT chose. It is resolved through
   * `containRepoDir` before the handler runs, and a refusal never reaches the
   * handler at all — which is the point: a create spawns `claude` there and a
   * build runs a shell command there.
   */
  contain?: keyof MsgOf<K> & string;
  /** What to say when `contain` refuses. The default names no feature. */
  refusal?: string;
  run: DurableRoute<K> | Route<K>;
}

export type RouteEntry<K extends ClientMessage["t"]> = Route<K> | RouteSpec<K>;

export type RouteTable = { [K in ClientMessage["t"]]?: RouteEntry<K> };
