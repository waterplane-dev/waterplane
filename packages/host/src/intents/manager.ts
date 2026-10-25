/**
 * The Intent store: one file, one tick, one lifecycle, one place a piece of
 * deferred work can be.
 *
 * ── What this replaces, and why it is a store rather than a fourth manager ──
 *
 * `launch.ts` and `schedule.ts` were the same 240 lines twice — launch's own
 * header admits "shape borrowed wholesale from `schedule.ts`" — and both were
 * right about the two rules that matter:
 *
 *   • at-most-once by an ID the client minted, upserted on replay;
 *   • the mutating state persisted BEFORE the side effect.
 *
 * What they were wrong about is that there were two of them. Five subsystems
 * said "queued" and meant five different things, each with its own JSON file,
 * its own poll loop and its own failure ladder, and the sixth — the phone's
 * send queue — deleted work on a clock. This is that pattern generalized, with
 * the other five to be folded in behind it.
 *
 * ── The rules this file exists to keep ──────────────────────────────────────
 *
 * **`op.ack ok` means "on the desktop's disk".** Not "accepted", not "in
 * memory": the whole promise being made to the user is that the moment the ack
 * lands the phone may forget the words, so `post()` persists SYNCHRONOUSLY and
 * the caller acks afterwards. The ordering is store → ack ledger → socket, and
 * it is the reason `post` is not async.
 *
 * **`starting` is written before the executor runs.** A crash between the two
 * leaves a row that is visibly stuck, never two claude processes in one
 * worktree and never a sweep that runs twice. Same argument for an `at`
 * trigger's `lastOccurrence`, which is stamped before the fire, exactly as
 * `schedule.ts` did.
 *
 * **At-most-once by intent id, forever.** The ack ledger's TTL is 45 minutes
 * and a `files` trigger may wait six hours; a row that outlived its ack record
 * used to re-execute on a retry. The id lives in this store for the row's whole
 * life, so a replayed post finds the row and returns it. That second guard is
 * what will make deleting the phone's 30-minute TTL safe.
 *
 * **Nothing is armed with a timer.** A tick re-asks the pure rule
 * (`@waterplane/shared`'s `intentVerdict`), so a restart, a laptop sleep, a clock
 * jump and a DST switch cannot mis-fire anything. Events that make an answer
 * change — an upload landing, a turn ending, a post — kick the tick rather than
 * scheduling their own.
 *
 * **Eviction is compaction, never deletion of un-run work.** Nothing queued,
 * blocked, starting, running or recurring may leave the file at all, and what
 * does leave is appended to `intents-archive.jsonl` first. "Where did my words
 * go" has to have an answer, always.
 *
 * **Recurrence decides the list, and a one-off RUNS ITSELF.** An `at` trigger
 * is not one thing: a standing rule is a clock to arm, pause and skip, while a
 * one-off aimed at one place is waiting work that happens to carry an instant
 * (`@waterplane/shared`'s `isTimedWorkRow`). Three rules in this file turn on that
 * distinction and each of them was wrong for a one-off before it existed:
 * `execute()` only hands a `schedule:work` row to the child-making executor
 * when it is a standing rule — a one-off used to be TWO rows, and the first
 * could fail at rung 3 before the second existed, which is how seven of this
 * desktop's items ended up failed and in no backlog at all; `fire()` only
 * returns a hand-run row to `queued` when it has a next run to protect; and
 * `update()` may revive a FAILED one-off, because a row whose one instant has
 * passed is exactly the row a person still means.
 */
import { EventEmitter } from "node:events";
import type {
  Intent,
  IntentDraft,
  IntentPatch,
  IntentRequeue,
  IntentResult,
  IntentTarget,
  ItemName,
  NameAuthor,
} from "@waterplane/shared";
import { TICK_MS, isTerminal, type IntentCore, type IntentDeps } from "./contract.js";
import { armFrom, armNew, newBasis, setArmed, skipNext } from "./clock.js";
import { DiskSlice } from "./disk.js";
import { WriteSlice } from "./write.js";
import * as putback from "./requeue.js";
import { LadderSlice } from "./ladder.js";
import { FireSlice } from "./fire.js";
import { WatchSlice } from "./watch.js";

/**
 * Origins the manager ROUTES on.
 *
 * `origin` is otherwise free-form provenance ("rescue", "retry:<id>", a fan-out
 * target). These two are the schedule adapters, and they exist because "at
 * 03:00, queue a work item in this repo" needs no session to be READY — which
 * the ladder expresses as a `fresh` repo target — while what it actually does is
 * add a row rather than spawn anything. Two shapes, one target: the origin is
 * what tells them apart, and the fan-out's targets and follow-ups are routed the
 * same way for the same reason.
 */
// Defined in `@waterplane/shared` (the phone asks `queuesBacklogItem` too), re-exported
// here for the adapters that have always imported them from this file.
export { ORIGIN_SCHEDULE_WORK, ORIGIN_SCHEDULE_SWEEP, ORIGIN_SCHEDULE_BUILD } from "@waterplane/shared";

export type { ExecutorResult, IntentExecutors, IntentDeps } from "./contract.js";

export class IntentManager extends EventEmitter {
  private rows: Intent[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Ids whose executor is in flight, so a tick cannot re-enter a slow spawn.
   *  The persisted `starting` state covers restarts; this covers overlap. */
  private readonly inflight = new Map<string, number>();
  private ticking = false;
  /**
   * The last repo listing a pass actually took, for `wouldNotRun()`.
   *
   * `IntentDeps.knownDirs()` is async and a pass only spends it when a LIVE row
   * is aimed at `repos`; the pre-flight is synchronous and runs off a wire op,
   * so it reuses this rather than going and getting one. `null` until a pass
   * has read one, and `null` is read as "nobody said" there — never as "none of
   * those repos exist", which is the answer that would refuse a sweep on a
   * listing this host has never seen.
   */
  private lastKnownDirs: Set<string> | null = null;
  /**
   * The completion baseline: the target session's finished-turn count at the
   * moment BEFORE anything was typed. The row completes on the first `Stop`
   * past it — its own turn's end — so the pre-delivery Stop that made the
   * session ready in the first place cannot instantly complete it.
   *
   * In memory, deliberately: a stop count is per-boot, and a row that was
   * `running` when the process died is reconciled from the CLI's own log
   * instead. This is the backlog's `fireStop`, moved here so there is one copy
   * for every executor rather than one per manager.
   */
  private readonly stopBase = new Map<string, number>();
  /**
   * A `Stop` seen while the row was still `starting`.
   *
   * Delivery is not instant, and on a fast turn the agent can finish before
   * `deliverPrompt` has finished proving that it typed. The turn-end signal
   * arrives against a row that is not yet `running`, and dropping it would
   * leave that row waiting for ever for a Stop that already happened.
   */
  private readonly stopSeen = new Map<string, number>();
  /** How each `running` row is allowed to finish — see `ExecutorResult.watch`. */
  private readonly watchMode = new Map<string, "turn" | "hook">();
  /**
   * Rows `reconcile()` RE-ADOPTED: delivered before a restart, into a session
   * that came back with it (tmux), so they went back to `running` rather than
   * being settled off the log. Only the sentence depends on it — the row still
   * finishes on its Stop or on the silence sweep, like any other — but that
   * sentence is the one place a person learns the ending was watched across a
   * restart rather than seen whole. In memory, like `stopBase`: a second
   * restart re-adopts it again.
   */
  private readonly readopted = new Set<string>();
  /** Every slice's way in — see the constructor. */
  private readonly core: IntentCore;
  /** `intents.json`, its archive and the boot conversions (`intents/disk.ts`). */
  private readonly disk: DiskSlice;
  /** The write verbs — post, upsert and the edits (`intents/write.ts`). */
  private readonly writer: WriteSlice;
  /** The tick's pass over the pending rows, and `block` (`intents/ladder.ts`). */
  private readonly ladder: LadderSlice;
  /** Firing one row and the transitions it ends in (`intents/fire.ts`). */
  private readonly fireSlice: FireSlice;
  /** Completion and restart reconciliation; owns `reconciled` (`intents/watch.ts`). */
  private readonly watch: WatchSlice;

  constructor(private readonly deps: IntentDeps) {
    super();
    // The ONE object every slice reaches shared state through (`IntentCore`,
    // intents/contract.ts). Each member delegates at CALL time to the slice that
    // owns the method, grouped below by owning slice.
    this.core = {
      // facade
      deps: this.deps,
      rows: () => this.rows,
      setRows: (next) => { this.rows = next; },
      inflight: this.inflight,
      stopBase: this.stopBase,
      stopSeen: this.stopSeen,
      watchMode: this.watchMode,
      readopted: this.readopted,
      lastKnownDirs: () => this.lastKnownDirs,
      setLastKnownDirs: (dirs) => { this.lastKnownDirs = dirs; },
      emit: (event, ...args) => { this.emit(event, ...args); },
      kick: () => this.kick(),
      get: (id) => this.get(id),
      pending: () => this.pending(),
      // disk
      persist: () => this.disk.persist(),
      lastWriteError: () => this.disk.lastWriteError(),
      readOnly: () => this.disk.readOnly(),
      archive: (rows) => this.disk.archive(rows),
      chainFacts: () => this.disk.chainFacts(),
      present: (cwd, rel) => this.disk.present(cwd, rel),
      // clock
      armNew: (row, now) => armNew(this.core, row, now),
      newBasis: (row) => newBasis(row),
      armFrom: (row, basis, now) => armFrom(this.core, row, basis, now),
      // ladder
      pass: () => this.ladder.pass(),
      // fire
      fire: (row, opts) => this.fire(row, opts),
      settle: (row, state, result, missing) => this.settle(row, state, result, missing),
      replace: (row) => this.fireSlice.replace(row),
      resolveSessionFor: (row) => this.fireSlice.resolveSessionFor(row),
      unspend: (row, occurrence) => this.fireSlice.unspend(row, occurrence),
      stampCleared: (row, occurrence) => this.fireSlice.stampCleared(row, occurrence),
      recordMissed: (row, occurrence, detail, now) => this.fireSlice.recordMissed(row, occurrence, detail, now),
      // watch
      complete: (row, detail, now) => this.watch.complete(row, detail, now),
      sweepRunning: (now) => this.watch.sweepRunning(now),
    };
    this.disk = new DiskSlice(this.core);
    this.writer = new WriteSlice(this.core);
    this.ladder = new LadderSlice(this.core);
    this.fireSlice = new FireSlice(this.core);
    this.watch = new WatchSlice(this.core);
    this.disk.load();
    this.disk.foldLegacyWorkParents();
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** Newest first — the order every list in this app is read in. */
  list(): Intent[] {
    return [...this.rows].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Intent | undefined {
    return this.rows.find((r) => r.id === id);
  }

  /** Rows still expecting to run — what a badge counts. */
  pending(): Intent[] {
    return this.rows.filter((r) => !isTerminal(r));
  }

  // ── Writing — delegations (`intents/write.ts`) ─────────────────────────────

  post(draft: IntentDraft, now = Date.now()): { ok: boolean; intent?: Intent; existing?: boolean; reason?: string } { return this.writer.post(draft, now); }
  upsert(draft: IntentDraft, now = Date.now()): Intent | null { return this.writer.upsert(draft, now); }
  waive(id: string, rung: string, on: boolean): { ok: boolean; reason?: string } { return this.writer.waive(id, rung, on); }
  update(id: string, patch: IntentPatch, now = Date.now()): { ok: boolean; reason?: string } { return this.writer.update(id, patch, now); }
  retarget(id: string, target: IntentTarget, cwd?: string, now = Date.now()): { ok: boolean; reason?: string } { return this.writer.retarget(id, target, cwd, now); }
  edit(id: string, patch: Parameters<WriteSlice["edit"]>[1]): { ok: boolean; refused?: string } { return this.writer.edit(id, patch); }
  name(id: string, n: ItemName, by: Exclude<NameAuthor, "hand">): { headline: boolean; category: boolean } { return this.writer.name(id, n, by); }

  // ── Row verbs — delegations (`intents/requeue.ts`) ─────────────────────────

  markDone(id: string, detail = "marked done by hand"): boolean { return putback.markDone(this.core, id, detail); }
  requeue(id: string, opts?: { allowDone?: true; by?: IntentRequeue["by"] }): boolean { return putback.requeue(this.core, id, opts); }
  requeueFailed(id: string, by: { kind: "assess"; runId: string } | { kind: "hand" } | { kind: "run" }, opts?: { kick?: false }): { ok: boolean; reason?: string } { return putback.requeueFailed(this.core, id, by, opts); }
  emitChanged(): void { putback.emitChanged(this.core); }
  cancel(id: string, reason = "called off from the phone"): boolean { return putback.cancel(this.core, id, reason); }
  dismiss(id: string): boolean { return putback.dismiss(this.core, id); }
  remove(id: string): boolean { return putback.remove(this.core, id); }
  runNow(id: string): Promise<{ ok: boolean; reason?: string }> { return putback.runNow(this.core, id); }
  noteSession(id: string, sessionId: string): void { putback.noteSession(this.core, id, sessionId); }
  fileLanded(cwd: string): void { putback.fileLanded(this.core, cwd); }

  // ── The loop ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    // Reconciliation decides what half the rows even mean; a tick before it
    // would re-fire work that may already have run.
    if (!this.watch.reconciled || this.ticking) return;
    this.ticking = true;
    try {
      await this.pass();
    } catch { /* a verdict that threw is one missed pass, not a dead loop */ }
    finally { this.ticking = false; }
  }

  /** `ladderpass.test.mjs` calls `store.pass()` — the body is `intents/ladder.ts`. */
  private pass(): Promise<void> { return this.ladder.pass(); }

  // ── Completion and restart reconciliation — delegations (`intents/watch.ts`) ──

  onTurnEnded(sessionId: string, stopCount: number): void { this.watch.onTurnEnded(sessionId, stopCount); }
  onSessionExit(sessionId: string): void { this.watch.onSessionExit(sessionId); }
  /** Called once by `main.ts`, after `sessions.rediscover()`. */
  reconcile(): Promise<void> { return this.watch.reconcile(); }

  // ── Firing — delegations (`intents/fire.ts`) ─────────────────────────────
  /** `requeue.test.mjs` calls `store.fire(row, {})`, and the core's `fire` arrow forwards here — the body is `intents/fire.ts`. */
  private fire(row: Intent, opts: Parameters<FireSlice["fire"]>[1]): Promise<string | void> { return this.fireSlice.fire(row, opts); }
  /** `backlogedit.test.mjs` calls `store.settle(…)`, and the core's `settle` arrow forwards here — the body is `intents/fire.ts`. */
  private settle(row: Intent, state: "done" | "failed" | "canceled", result: IntentResult, missing?: string[]): void { this.fireSlice.settle(row, state, result, missing); }

  // ── Delegations: the clock (`intents/clock.ts`) and the disk (`intents/disk.ts`) ──

  skipNext(id: string): { ok: boolean; reason?: string; nextAt?: number | null } { return skipNext(this.core, id); }
  setArmed(id: string, armed: boolean): boolean { return setArmed(this.core, id, armed); }
  migrateLegacy(convert: Parameters<DiskSlice["migrateLegacy"]>[0]): void { this.disk.migrateLegacy(convert); }
  migrateFileAt(src: string, label: string, convert: (raw: unknown, now: number) => IntentDraft[]): void { this.disk.migrateFileAt(src, label, convert); }
  /** Write now, whatever a debounce would have said. Called on SIGTERM. */
  flush(): void { this.disk.flush(); }
  /** `intents.json`: the read-only sentence (a newer schema), why the last write failed (null once one landed), and the boot feed row `main.ts` notifies (`intents/disk.ts`). */
  readOnly(): string | null { return this.disk.readOnly(); }
  lastWriteError(): string | null { return this.disk.lastWriteError(); }
  storeNotice(): { title: string; body: string; tag: string } | null { return this.disk.storeNotice(); }
}
