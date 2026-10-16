/**
 * The shapes the queue core is assembled from. `useQueue` builds ONE context
 * object per render — App's deps, the queue's refs, and every function below —
 * and each file of the core (`send.ts`, `pending.ts`, `verbs.ts`, `uploads.ts`)
 * adds its functions to it and calls the others through it. That is the same
 * closure App's inner functions had: rebuilt every render, reading refs for
 * anything a timer or a socket event reaches later.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  BudgetVerdict, HostMessage, PeriodState, LaunchIntent, OpenDelivery, RepoTarget, SendBlockReason, SerialWatch, SessionInfo, UsageBudget,
} from "@waterplane/shared";
import type { OutboxEntry } from "../../outbox";
import type { HostConnection } from "../../ws";
import type { Overlay } from "../../routing";
import type { SendSeed, SendTarget } from "../../sendIntent";
import type { DurableOp, QueueBacklogOpts, UploadBuf, UploadProgress } from "../../sdk/types.ts";

type Ref<T> = { readonly current: T };
type Msg<T extends HostMessage["t"]> = Extract<HostMessage, { t: T }>;
export type BudgetState = { budget: UsageBudget; verdict: BudgetVerdict; periods?: PeriodState[] } | null;

/** What App hands the queue: the socket, this render's lists and view, and the
 *  compose box it restores into. Everything the queue can own or derive — the
 *  refs over these values, its three preferences, the usage budget and the
 *  handed-over launches — it does (`QueueEnv`). */
export interface QueueDeps {
  /** The one socket (`useConnection`), passed whole rather than in pieces. */
  conn: { connRef: Ref<HostConnection>; status: string; reconnectAsk: boolean; setReconnectAsk(v: boolean): void };
  sessions: SessionInfo[];
  repos: RepoTarget[];
  activeId: string | null;
  setActiveId(id: string | null): void;
  setLastVisitedId(id: string | null): void;
  overlayRef: Ref<Overlay>;
  setOverlay(o: Overlay): void;
  wantNavRef: MutableRefObject<boolean>;
  /** The terminal feed's per-session buffers — an adopted pending screen gets one. */
  buffers: Ref<Map<string, string[]>>;
  readModeRef: Ref<boolean>;
  exitedRef: Ref<Set<string>>;
  composeTextRef: Ref<string>;
  setCompose: Dispatch<SetStateAction<string>>;
  pushHistory(text: string): void;
  openSend(seed: SendSeed): void;
  sendTargetFor(sessionId: string | undefined, cwd: string | undefined): SendTarget | undefined;
  repoForCwd(cwd: string): RepoTarget | null;
  /** `op.ack` named the session a FOCUSED op made: open it (App's view state). */
  focusSession(sessionId: string): void;
}

/** What every file of the queue core reads: App's deps flattened, plus what
 *  `useQueue` owns — refs where a timer or a socket event reads it later. */
export interface QueueEnv extends Omit<QueueDeps, "conn"> {
  connRef: Ref<HostConnection>;
  /** The socket's status as of this render (`useConnection`). */
  status: string;
  reconnectAsk: boolean;
  setReconnectAsk(v: boolean): void;
  sessionsRef: Ref<SessionInfo[]>;
  activeIdRef: Ref<string | null>;
  /** The screen's session (a real one or this queue's pending one), this render's. */
  getActive(): SessionInfo | null;
  budgetRef: MutableRefObject<BudgetState>;
  setBudget(b: BudgetState): void;
  serialSessionsRef: Ref<boolean>;
  confirmQueueRef: Ref<boolean>;
  autoSendRef: Ref<boolean>;
  launchesRef: Ref<LaunchIntent[]>;
  setLaunches(l: LaunchIntent[]): void;
}

/** The upload buffer's state (`uploads.ts`), shared with `runUpload`. */
export interface UploadState {
  uploading: string | null;
  parking: number;
  upProg: UploadProgress | null;
  setUploading(v: string | null): void;
  setUpProg(v: UploadProgress | null): void;
  inflightRef: MutableRefObject<number>;
  parkingRef: MutableRefObject<number>;
  upBytesRef: MutableRefObject<{ sent: number; total: number; startedAt: number; fullAt: number }>;
  allBufsRef: MutableRefObject<Set<UploadBuf>>;
  uploadBufRef: MutableRefObject<UploadBuf | null>;
  refreshUploadLabel(): void;
  /** A batch is up (`uploading != null`). */
  uploadPending: boolean;
  /** The row outlives the upload by a beat (`useLinger`). */
  uploadRowLinger: boolean;
}

export interface QueueRefs {
  /** The queue as of this render (the store). Handlers read `outboxRef`. */
  outbox: OutboxEntry[];
  outboxRef: MutableRefObject<OutboxEntry[]>;
  ackTimers: MutableRefObject<Map<string, number>>;
  uploadsInFlight: MutableRefObject<Set<string>>;
  uploadAborts: MutableRefObject<Map<string, AbortController>>;
  busyLanesRef: MutableRefObject<Set<string>>;
  /** Sessions whose OWN budget is spent (`sessionBudgetHeld`) — `selectSendable`'s `budgetHeldLanes`. */
  budgetHeldLanesRef: MutableRefObject<Set<string>>;
  busySerialRef: MutableRefObject<Set<string>>;
  serialWatchRef: MutableRefObject<SerialWatch[]>;
  holdQueueRef: MutableRefObject<boolean>;
  flushIdleReason: MutableRefObject<string | null>;
  queueBlockedRef: MutableRefObject<ReadonlyMap<string, SendBlockReason>>;
  /** The store half of `queueBlockedRef` (`blockedStore.set`). */
  setQueueBlocked(m: ReadonlyMap<string, SendBlockReason>): void;
  pendingKept: MutableRefObject<Map<string, PendingKept>>;
  pendingEntry: OutboxEntry | null;
  up: UploadState;
}

/** `useQueue.ts`: the one writer and the two ways a row enters or leaves. */
export interface CoreFns {
  writeOutbox(list: OutboxEntry[]): OutboxEntry[];
  addOutbox(e: OutboxEntry, frontOfLane?: boolean): void;
  addOutboxFirstInLane(e: OutboxEntry): void;
  failOutbox(ackId: string, reason: string, state?: OutboxEntry["failState"]): void;
  applyDeliverySettled(q: OpenDelivery): void;
  holdWall(sessionId: string): string | null;
}

/** `send.ts`: the flusher and every way words, ops and bytes are queued. */
export interface SendFns {
  retainUploadBytes(e: OutboxEntry, drop?: boolean): Promise<void>;
  ackWindowFor(e: OutboxEntry): number;
  nextRound(ackId: string): void;
  armAckTimeout(ackId: string, windowMs?: number): void;
  goneLanes(): string[];
  flushOutbox(armAll?: boolean): number;
  idleReason(fallback?: string): string;
  releaseLane(): void;
  uploadRefusal(text: string): string | null;
  guardUploadRefs(text: string, lane: string): boolean;
  guardChain(steps: readonly string[]): boolean;
  submitInput(id: string, cwd: string, text: string, kind: "prompt" | "command", holdUntilIdle?: boolean): boolean;
  queueOp(op: DurableOp, laneKey: string, text: string,
    opts?: { cwd?: string; focus?: boolean; frontOfLane?: boolean; ackId?: string; serial?: boolean }): boolean;
  queueImageUpload(repoId: string, blob: Blob, filename: string, lane: string, cwd: string): Promise<{ relPath: string; ackId: string } | null>;
  runUpload(e: OutboxEntry): Promise<void>;
  rewriteQueuedPath(from: string, to: string): void;
  armLane(sessionId: string): void;
  queueBacklog(opts: QueueBacklogOpts): boolean | null;
  answerPrompt(s: SessionInfo, data: string, label: string, submitBox?: boolean, choice?: number): void;
}

/** `pending.ts`: the session screen that exists before its session does. */
export interface PendingFns {
  enterPending(createAck: string): void;
  enterOldestPending(cwd: string): void;
  /** `+ later`: the session screen for words whose session starts when their backlog item runs. */
  enterLater(cwd: string): void;
  retryPendingCreate(): void;
  adoptPendingSession(createAck: string, sessionId: string): void;
  queueSessionPrompt(cwd: string, text: string, createAck: string, kind?: "prompt" | "command"): void;
  holdForLaunch(lane: string, createAck?: string): void;
  failPendingCreates(lane: string, reason: string, createAck?: string): void;
  failDependentUploads(e: OutboxEntry, reason: string): void;
}

/** `verbs.ts`: what a person does to a queued row. */
export interface VerbFns {
  restoreOutbox(): void;
  dismissOutbox(): void;
  editQueued(ackId: string, text: string): void;
  retargetQueued(ackId: string, to: { sessionId: string; cwd: string; mode?: "input" | "backlog"; targetSessionId?: string }): void;
  handToDesktop(ackId: string): void;
  toggleHoldQueued(ackId: string): void;
  toggleSerialQueued(ackId: string): void;
  scheduleQueueRows(scheduleId: string): OutboxEntry[];
  dropScheduleQueue(rows: readonly OutboxEntry[]): void;
  removeQueued(ackId: string): void;
  addPromptToQueuedCreate(ackId: string, text: string): void;
  moveQueued(ackId: string, dir: -1 | 1): void;
  sendQueuedNow(ackId: string): void;
  retryFailedQueued(): void;
  restoreQueued(ackId: string): void;
  repoIdOfEntry(e: OutboxEntry): string | null;
}

/** `uploads.ts`: the ordered batch an annotate flow fills. */
export interface UploadFns {
  ensureUploadBuf(repoId: string): UploadBuf;
  queueUpload(buf: UploadBuf, src: Blob | Promise<Blob>, name: string,
    note?: string | Promise<string | undefined>, size?: { w: number; h: number }): void;
  cancelUploads(): void;
  settleUploads(buf: UploadBuf): void;
}

export type QueueCtx = QueueEnv & QueueRefs & CoreFns & SendFns & PendingFns & VerbFns & UploadFns;
export type { Msg };

/** What a pending screen was opened FOR — keyed by its create's ackId, and
 *  after adoption by the session id it was named (`adoptedAt` set) until the
 *  session list has it. */
export interface PendingKept { cwd: string; title: string; ts: number; adoptedAt?: number }
