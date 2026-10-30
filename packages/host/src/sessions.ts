import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import type { IPty } from "node-pty";
import { SessionScreenLog } from "./screenlog.js";
// CJS bundle — only the default export resolves under Node ESM.
import type { RenderRow } from "./render.js";
import type { ClosedBy, ContextSeriesDoc, FollowUp, PermissionMode, HistoryEntry, LaunchOpts, LimitResumeMode, SessionBudget, SessionBudgetCal, SessionInfo, SessionLimit, SessionOrigin, SessionSearchResult, SessionSearchScope, SessionShellDetail, ShellLink, TranscriptDoc, TranscriptToolDetail } from "@waterplane/shared";
import { ptySize, SCREENLOG_MAX_LINES, sessionBudgetVerdict, launchModeRefusal } from "@waterplane/shared";
import { stripAnsi } from "./prompt.js";
import { detectUpdateBanner } from "./update.js";
import { DEFAULT_BACKEND, derive, namesStoreReader, resolveBackend, type BackendDescriptor } from "./backends/index.js"; import { backendBinRefusal } from "./binguard.js"; import { askRulesForCwd } from "./askrules.js"; import { holdAskRulesFor } from "./answergate.js";
import type { ClosedRow, LiveMeta, RecentRow, Session, SessionCore } from "./sessions/core.js";
// After the flat imports, before the slices (which import knobs too). Not behaviour: nothing
// in the host assigns process.env at import (tools/hostshape.test.mjs checks that).
import {
  SCROLLBACK_LIMIT, RAW_CAPTURE_CAP, REMOTE_URL_RE,
  IDLE_PING_MS,
  LIMIT_SWEEP_MS,
  TMUX_SERVER, TMUX_PREFIX,
} from "./sessions/knobs.js";
// After knobs, which tmux.ts also imports: knobs is still evaluated first.
import { adoptOrPark, armOrphanSweep, deleteLive, exitReport, hasLiveTmux, loadLive, persistLive, reattach, reclaimStaleLive, retryParked, settleParked, spawnBackend } from "./sessions/tmux.js";
export { droppedEnvNames, exitReport, paneUnsetNames, staleLiveIds, sweepSessionStores, tmuxEnvPrefix } from "./sessions/tmux.js";
import {
  adoptBackendId, adoptClaudeId, backendField, detectBackendId, detectClaudeId, readSignInAtSpawn, readSpawnVersion, refreshModel,
  stopClaudeIdWatch, watchBackendId, watchClaudeId,
} from "./sessions/convid.js";
import { healthScope, noteContextHealth, noteFor, noteLogHealth } from "./sessions/health.js";
import { CtxSlice } from "./sessions/ctxseries.js";
import { BudgetSlice } from "./sessions/budgetwatch.js"; import { ChannelSlice, type SendHold } from "./sessions/sidechannel.js";
import { RosterSlice } from "./sessions/roster.js";
import { WallSlice } from "./sessions/wall.js"; import { NetRetrySlice } from "./sessions/apiretry.js"; import { hasAccountLimit } from "./usagesources.js";
import { ResumeSlice } from "./sessions/resume.js";
import * as turn from "./sessions/turn.js"; import * as askwatch from "./sessions/askwatch.js"; import * as agentpoll from "./sessions/agentpoll.js"; import * as idle from "./sessions/idlewatch.js";
import * as boxes from "./sessions/boxes.js"; import * as boxread from "./sessions/boxread.js";
import * as drive from "./sessions/drive.js";
import * as record from "./sessions/record.js";
import { endSession } from "./sessions/endsession.js";
import * as links from "./sessions/links.js"; import * as mode from "./sessions/livemode.js"; import * as halt from "./sessions/haltall.js"; import { finishLaunch } from "./launchfiles.js"; import { repoInstructions, withHostApi } from "./reposkill.js";
import { env } from "./env.js"; import { answerTermQueries, lateQueryLog } from "./termqueries.js"; import { hostTermColors } from "./themeoverlay.js";
/** Matches DECSET/DECRST private-mode sequences, e.g. `\x1b[?1049h`, `\x1b[?1000;1006h`. */
const PRIVATE_MODE_RE = /\x1b\[\?([0-9;]+)([hl])/g;

/**
 * Owns every live `claude` PTY. Emits:
 *  - 'data'   (id, chunk, seq)      seq = cumulative output offset after this chunk
 *  - 'exit'   (id, code)
 *  - 'updated'(info)               whenever info (prompt/idle/title/rc) changes
 *  - 'prompt' (id, DetectedPrompt) when a choice prompt is detected
 *  - 'idle'   (id, info)           when a session goes quiet after working
 *  - 'turnEnded'(id, stopCount, net?) a finished turn (Stop, exact); `net` = an API give-up, settled late by 'netTurnSettled' (`apiretry.ts`)
 *  - 'history'(id, HistoryEntry[]) when the prompt/output history changes
 *  - 'limit'  (id, info, phase)    usage-limit lifecycle: "blocked" | "scheduled" | "attempt" | "resumed" | "gaveup"
 *  - 'limitQueue'()                the resume queue's host-wide state changed (who is resuming, hold-off)
 *  - 'updateBanner'(latest?)       the CLI printed its "Update available!" nag on screen
 *  - 'created'(info)               a session was registered (spawned, forked or re-attached)
 *  - 'awaiting'(id)                a dialog is on screen that no detector could parse (ON edge only)
 *  - 'closed'(ClosedSession[])     the closed-sessions stack changed
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  /** Recent/closed rows, stars, pins, watched ids and per-plugin session state (`sessions/roster.ts`). */
  private roster: RosterSlice;
  /** The context-window readings and the per-model window store (`sessions/ctxseries.ts`). */
  private ctx: CtxSlice;
  /** The usage-limit wall: the auto-continue config and the continue ladder (`sessions/wall.ts`). */
  private wall: WallSlice;
  /** The resume queue and resurrection: the resume* state and the revived pairings (`sessions/resume.ts`). */
  private resume: ResumeSlice;
  private budget: BudgetSlice; private channel: ChannelSlice; // own budget (sessions/budgetwatch.ts); the backend side channel (sessions/sidechannel.ts)
  private net: NetRetrySlice; // the retry after a transient API give-up (sessions/apiretry.ts)

  /** The one `SessionCore` the slices under `sessions/` are handed. Private —
   *  the class's public surface does not change — and built in the constructor,
   *  where every member is an arrow that delegates at CALL time. */
  private readonly core: SessionCore;

  constructor(private readonly root: string, private readonly port = Number(env("PORT") || 8770)) {
    super();
    // The hub (`sessions/core.ts`). Every member delegates at CALL time to the
    // slice that owns the method, grouped below by owning slice; state a slice
    // owns is read through an accessor, never captured. Building it has no
    // effect: nothing is called — which is why it is built FIRST, before the
    // slices that are handed it read their files.
    this.core = {
      root: this.root, port: this.port, sessions: this.sessions,
      emit: (event, ...args) => this.emit(event, ...args),
      create: (cwd, opts) => this.create(cwd, opts),
      // A re-attach (restart) of a session that never got its own words heals
      // from the reopen stack too — the conversation id is already known here.
      register: (id, proc, info, launch, cols, rows, backend, createsRecord) => {
        const out = this.register(id, proc, info, launch, cols, rows, backend, createsRecord);
        const made = this.sessions.get(id); const carry = this.closedCarry(info.claudeSessionId ?? info.backendSessionId, undefined);
        if (made && carry) record.adoptCarry(this.core, made, carry);
        return out;
      },
      backendField: (b) => backendField(b),
      // tmux.ts
      spawnBackend: (id, cwd, cols, rows, args, backend, launchEnv, dropEnv) => spawnBackend(this.core, id, cwd, cols, rows, args, backend, launchEnv, dropEnv),
      reattach: (m) => { reattach(this.core, m); this.net.restored(m.id); }, persistLive: (m) => persistLive(this.core, m), loadLive: (id) => loadLive(this.core, id),
      deleteLive: (id) => deleteLive(this.core, id), repointCompanions: (from, to) => drive.repointCompanions(this.core, from, to), hasLiveTmux: (id) => hasLiveTmux(id), armOrphanSweep: () => armOrphanSweep(this.core),
      // convid.ts
      detectClaudeId: (s) => detectClaudeId(this.core, s), adoptClaudeId: (s, cid) => adoptClaudeId(this.core, s, cid),
      watchClaudeId: (s) => watchClaudeId(this.core, s), stopClaudeIdWatch: (s) => stopClaudeIdWatch(s),
      detectBackendId: (s) => detectBackendId(this.core, s), adoptBackendId: (s, id) => adoptBackendId(this.core, s, id),
      watchBackendId: (s) => watchBackendId(this.core, s), refreshModel: (s, transcriptPath) => refreshModel(this.core, s, transcriptPath),
      // health.ts
      noteFor: (s, id, outcome, opts) => noteFor(s, id, outcome, opts),
      noteContextHealth: (s, cleaned, pct) => noteContextHealth(s, cleaned, pct),
      noteLogHealth: (s, outcome, raw, fixture) => noteLogHealth(s, outcome, raw, fixture),
      // ctxseries.ts
      refreshSpark: (s) => this.ctx.refreshSpark(s), checkContext: (s) => this.ctx.checkContext(s), checkMode: (s) => mode.checkMode(this.core, s), // + livemode.ts
      storeFor: (id) => this.ctx.storeFor(id), logFor: (id) => this.ctx.logFor(id), judgeBudget: (s) => this.budget.judge(s), clearIdle: (s) => idle.clearIdle(this.core, s), // + idlewatch.ts
      // roster.ts
      rememberRecent: (s) => this.roster.rememberRecent(s), applyStar: (info) => this.roster.applyStar(info),
      applyPromptLabels: (s) => this.roster.applyPromptLabels(s),
      pushClosed: (entry) => this.roster.pushClosed(entry), publishClosed: () => this.roster.publishClosed(), closedRowOf: (s, alive, exit) => this.roster.closedRowOf(s, alive, exit),
      closedRow: (id) => this.roster.closedRow(id), dropClosed: (id) => this.roster.dropClosed(id),
      isWatched: (id) => this.roster.isWatched(id),
      // wall.ts
      newLimitState: () => this.wall.newLimitState(), limitAuto: (s) => this.wall.limitAuto(s),
      limitRetry: (s, now, resetAt) => this.wall.limitRetry(s, now, resetAt), limitLog: (s) => this.wall.limitLog(s),
      checkLimit: (s) => this.wall.checkLimit(s),
      netTurnEnded: (s) => this.net.turnEnded(s), netTurnStarted: (s) => this.net.turnStarted(s), netTyped: (s) => this.net.typed(s), // apiretry.ts
      markLimitBlocked: (s, resetAt, weekly, sample, dated) => this.wall.markLimitBlocked(s, resetAt, weekly, sample, dated),
      scheduleLimitAttempt: (s, atOverride) => this.wall.scheduleLimitAttempt(s, atOverride),
      doLimitContinue: (s) => this.wall.doLimitContinue(s), clearLimitTimer: (s) => this.clearLimitTimer(s),
      noteGaveUp: (s, why) => this.wall.noteGaveUp(s, why), writeLimitCfg: () => this.wall.writeLimitCfg(),
      resumeMode: () => this.wall.resumeMode, assignResumeMode: (mode) => { this.wall.resumeMode = mode; },
      // resume.ts
      isResuming: (id) => this.resume.isResuming(id), resumeQueue: () => this.resume.queue(),
      resumeHoldUntil: () => this.resume.holdUntil(),
      resumeProven: () => this.resume.proven(), setResumeProven: (proven) => { this.resume.setProven(proven); },
      resumeFirstAt: (id) => this.resume.firstAt(id), dropResumeFirst: (id) => this.resume.dropFirst(id),
      releaseResume: (id, why) => this.resume.releaseResume(id, why), publishQueue: () => this.resume.publishQueue(),
      pumpResume: () => this.resume.pumpResume(), requestResume: (s) => this.resume.requestResume(s),
      clearResurrectTimer: (s) => this.resume.clearResurrectTimer(s), maybeScheduleResurrect: (s) => this.resume.maybeScheduleResurrect(s),
      // turn.ts
      setTurn: (s, active, opts) => turn.setTurn(this.core, s, active, opts), checkIdle: (s) => turn.checkIdle(this.core, s),
      armTurnWatch: (s, seqAt) => turn.armTurnWatch(this.core, s, seqAt), setAsking: (s, ask) => askwatch.setAsking(this.core, s, ask), setCliSuggestion: (s, text) => askwatch.setCliSuggestion(this.core, s, text), checkAsking: (s) => askwatch.checkAsking(this.core, s), checkCliSuggestion: (s) => askwatch.checkCliSuggestion(this.core, s),
      checkAgents: (s) => agentpoll.checkAgents(this.core, s), retireAgentPoll: (s) => agentpoll.retireAgentPoll(s), clearStopVerify: (s) => turn.clearStopVerify(s), sourceTurn: (s, e, f) => turn.sourceTurn(this.core, s, e, f), sourceIdentified: (s, id) => turn.sourceIdentified(this.core, s, id),
      // boxes.ts
      scheduleChecks: (s) => boxread.scheduleChecks(this.core, s), armPromptCheck: (s, delayMs) => boxread.armPromptCheck(this.core, s, delayMs), setAwaiting: (s, on) => boxread.setAwaiting(this.core, s, on),
      applyPrompt: (s, prompt) => boxread.applyPrompt(this.core, s, prompt), armLinksCheck: (s) => links.armLinksCheck(this.core, s), // + links.ts
      // drive.ts
      input: (id, data) => drive.input(this.core, id, data), write: (id, data) => drive.write(this.core, id, data),
      screenText: (id, lines) => drive.screenText(this.core, id, lines), screenCells: (id, lines) => drive.screenCells(this.core, id, lines),
      // record.ts
      lastTurnOf: (cwd, cid) => record.lastTurnOf(cwd, cid),
      recordPrompt: (id, text, kind) => record.recordPrompt(this.core, id, text, kind), finalizeCapture: (s) => record.finalizeCapture(this.core, s),
      loadSummary: (id) => record.loadSummary(this.core, id), loadHistory: (id) => record.loadHistory(this.core, id),
      historyPath: (id) => record.historyPath(this.core, id), summaryPath: (id) => record.summaryPath(this.core, id),
    };
    this.ctx = new CtxSlice(this.core, root); this.budget = new BudgetSlice(this.core); this.channel = new ChannelSlice(this.core);
    // Reads recent, then closed (+ the `hasLiveTmux` downgrade), then stars, then pins —
    // after ctxWindows and before revived/limit config, as before the split.
    this.roster = new RosterSlice(this.core);
    // Reads the revived pairings — after pins, before the limit config, as before the split.
    this.resume = new ResumeSlice(this.core);
    // Reads the limit config — LAST among the file reads, as before the split.
    this.wall = new WallSlice(this.core); this.net = new NetRetrySlice(this.core);
    // Limit detection is otherwise data-driven (checks run on PTY output), but
    // a blocked session is SILENT — a block that predates a host restart, or a
    // missed event, would never be noticed until a client attaches (the resize
    // repaint produces data). Sweep periodically so detection + auto-continue
    // work with no phone interaction at all.
    setInterval(() => {
      for (const s of this.sessions.values()) {
        if (!s.info.running) continue;
        // The context miniature rides this sweep and NOT its gates, which is
        // the point: it is read off the CLI's conversation LOG, never off the
        // screen, so neither "wait for a quiet moment" (below — that exists so
        // a scan does not read a half-drawn repaint) nor `sawData` ("this
        // process has seen bytes") says anything about whether there is a
        // curve to draw.
        //
        // Gated behind them it was rebuilt only when a session went quiet, and
        // `markIdle` is the only other caller — so a session mid-turn, spinner
        // repainting every frame, never refreshed at all. A NEW session's row
        // therefore carried no curve for the whole of its first turn, which is
        // exactly the session whose context is moving fastest, and a restored
        // one that had printed nothing to this process carried none either.
        // Costs a stat per session per sweep; `refreshSpark` returns
        // immediately when the log has not moved.
        try { if (this.ctx.refreshSpark(s)) this.emit("updated", s.info); } catch { /* keep sweeping */ }
        if (!s.sawData) continue;
        // Mid-turn, EXCEPT while the flag says blocked AND no resume of this
        // session is in flight.
        //
        // The skip is here so a scan does not run against a half-drawn repaint.
        // A session already marked blocked is the one case where that trade is
        // backwards: the other two paths into `checkLimit` both hang off
        // silence — `markIdle` runs IDLE_PING_MS after the last byte, and this
        // sweep skipped anything newer than that — so a session that came back
        // at the reset and worked for an hour straight, spinner repainting
        // every frame, was never quiet enough for either to fire, and wore "at
        // limit" for the whole hour while visibly running.
        //
        // A session `resumingIds` holds is carved back out, and that exemption
        // is load-bearing rather than caution: a resume has just typed
        // "continue", and between that echo and the CLI's answer the trimmed
        // scan sees no banner while `attempts > 0` already holds — which is a
        // clearing reason. Sweeping there clears the block a few hundred ms
        // before the wall reprints, so the resume never returns a
        // still-blocked verdict, the host-wide hold-off is never armed, and the
        // rest of the queue walks into the same wall spending an attempt each.
        // `e2e-limitqueue.mjs` fails exactly that way without this clause. The
        // verdict paths (`releaseResume`, the settle watchdog) are what ask
        // about a resuming session, and they are unaffected.
        if (Date.now() - s.lastDataAt < IDLE_PING_MS
            && !(s.info.limit?.blocked && !this.resume.isResuming(s.info.id))) continue;
        try { this.checkLimit(s); } catch { /* keep sweeping */ }
      }
    }, LIMIT_SWEEP_MS).unref();
  }

  /** Async for a plugin's `prepare()`; a core backend's plan is sync, so it spawns + registers before any await. */
  async create(cwd: string, opts: { cols?: number; rows?: number; title?: string; resume?: boolean; resumeMode?: "continue" | "pick" | "fork"; resumeSessionId?: string; forkAtTurn?: string; launch?: LaunchOpts; origin?: SessionOrigin; budget?: SessionBudget; carry?: record.SessionCarry | null } = {}): Promise<SessionInfo> {
    const id = randomUUID().slice(0, 8);
    // Same floor as `resize()`: a create carries the client's geometry too, and
    // a session BORN three rows tall is a session nothing can be confirmed in.
    const { cols, rows } = ptySize(opts.cols ?? 80, opts.rows ?? 30);
    const launch = opts.launch ?? {};
    // `resume: true` defaults to continue; everything else about what the argv
    // means is the BACKEND's business (`backends/claude.ts`), which is where the
    // resume modes, the minted `--session-id` and the hook injection now live.
    const resumeMode = opts.resumeMode ?? (opts.resume || opts.resumeSessionId ? "continue" : undefined);
    // WHICH binary. Absent ⇒ claude, so every launch that has ever been made
    // resolves exactly as before. An unknown id THROWS here — before the spawn,
    // before the live record, before anything is remembered — and the create
    // route turns that into a refused op carrying the sentence
    // (`resolveBackend`). Never `?? claude`: spawning something other than what
    // was asked for, silently, is the one outcome this indirection exists to
    // prevent. Same for a resume mode the backend has no flag for.
    const backend = resolveBackend(launch.backend); const refused = halt.openRefusal(backend, opts.origin); if (refused) throw new Error(refused); const modeRefused = launchModeRefusal(backend.label, launch.permissionMode, backend.caps) ?? backendBinRefusal(backend); /* `?? `: a missing or mid-upgrade binary is a sentence, never tmux's [exited] */ if (modeRefused) throw new Error(modeRefused); /* a mode it cannot START in (`caps.launchModes`): refused in words before `prepare` */ // a job never opens a shell; nothing AI opens while halted — before `prepare`, which may start a server
    // Two ids, never one field: `sessionId` is claude's uuid (a log path), `backendSessionId` the other backend's own; at most one, only when KNOWN (`backends/types.ts`).
    // Order (prepare → files → spawn → persist → register): a refused plan writes nothing, spawns nothing.
    const askRules = askRulesForCwd(cwd); // read per launch; the plan says how they hold
    const asked = backend.prepare({ resumeMode, resumeSessionId: opts.resumeSessionId, launch, hookPort: this.port, cwd, hostSessionId: id, ...(opts.forkAtTurn ? { forkAtTurn: opts.forkAtTurn } : {}), askRules, instructions: repoInstructions() });
    const { args, sessionId: claudeSessionId, backendSessionId, createsRecord, env: launchEnv, exec, dropEnv, instructionsVia: told0, askRulesVia } = finishLaunch(backend, asked instanceof Promise ? await asked : asked, this.root, id); const told = backend.caps.turns === false ? undefined : told0; // a shell has no agent to tell
    // The gate holds them (`answergate.ts`) — released again if the spawn throws (no session to forget them).
    const proc = holdAskRulesFor(id, askRulesVia, askRules, () => this.spawnBackend(id, cwd, cols, rows, args, exec ? { ...backend, bin: () => exec } : backend, withHostApi(this.port, launchEnv), dropEnv)); // `exec`: opencode's waiter (`LaunchPlan.exec`)

    const info: SessionInfo = {
      id,
      cwd,
      title: opts.title ?? basename(cwd),
      remoteControl: true,
      running: true,
      ...backendField(backend), ...record.shellTitleField(backend, cwd), ...(opts.origin?.companionOf ? { companionOf: opts.origin.companionOf } : {}),
      model: launch.model,
      effort: launch.effort,
      permissionMode: launch.permissionMode,
      remoteControlled: launch.remoteControlled,
      prompt: null,
      idle: false,
      // A backend with no ACCOUNT has no limit state — and that must read as
      // ABSENT, not as an unblocked one. A zeroed `SessionLimit` would put the
      // session in every list that counts limits, claiming "not at a limit"
      // about an account that does not exist; absent is the only shape that says
      // the question does not apply. Every limit path already bails on `!lim`.
      ...(hasAccountLimit(backend) ? { limit: this.newLimitState() } : {}),
      claudeSessionId,
      ...(backendSessionId ? { backendSessionId } : {}),
      createdAt: Date.now(), told, askRulesVia,
      ...(opts.budget ? { budget: { cfg: opts.budget, verdict: sessionBudgetVerdict(opts.budget, null, null, Date.now()) } } : {}),
    };
    this.roster.applyStar(info);
    // Persist so a boot after a restart can rebuild this session from tmux.
    this.persistLive({ id, cwd, title: info.title, launch, createdAt: info.createdAt, claudeSessionId, backendSessionId, told, askRulesVia, ...(askRulesVia === "gate" ? { askRules } : {}), ...(opts.origin ? { origin: opts.origin } : {}), ...(opts.budget ? { budget: opts.budget } : {}) });
    const out = this.register(id, proc, info, launch, cols, rows, backend, createsRecord === true); const made = this.sessions.get(id); if (made && opts.origin) made.origin = opts.origin; const carry = opts.carry ?? this.closedCarry(opts.resumeSessionId, resumeMode); if (made && carry) record.adoptCarry(this.core, made, carry); readSpawnVersion(this.core, made); readSignInAtSpawn(this.core, made); if (made) record.shellTabTitle(this.core, made); return out;
  }

  /**
   * Fork a session's conversation into a NEW parallel session: same cwd, same
   * launch flags, `--fork-session` so the branch gets its own session id and
   * the original stays running (and separately resumable). When the source's
   * claude session id is known the fork targets exactly that conversation
   * (`--resume <id> --fork-session`); only for legacy sessions without a known
   * id does it fall back to `--continue`. No geometry ⇒ the source's; `title` replaces "<src> (fork)".
   */
  async fork(id: string, opts: { cols?: number; rows?: number; title?: string } = {}): Promise<SessionInfo | null> {
    const s = this.sessions.get(id);
    if (!s || !s.info.running) return null;
    return this.create(s.info.cwd, {
      cols: opts.cols ?? s.cols, rows: opts.rows ?? s.rows,
      title: opts.title || `${s.info.title} (fork)`,
      resumeMode: "fork",
      resumeSessionId: s.info.claudeSessionId ?? s.info.backendSessionId, // opencode forks on its server (`caps.forkVia`)
      launch: s.launch, origin: { kind: "fork", fromSession: id },
    });
  }

  /**
   * Wire a spawned proc (fresh claude OR a tmux re-attach) into a Session:
   * install the PTY data/exit handlers, register it, announce it. Shared by
   * create() and reattach() so both behave identically downstream.
   *
   * `createsRecord` is the launch's own answer to "did this spawn create the
   * backend's conversation row" (`backends/types.ts`). It DEFAULTS TO FALSE, and
   * that default is load-bearing: `reattach()` takes it, and a re-attached
   * session's `spawnedAt` is the moment the pane was picked back up, so every
   * conversation started in that directory since is inside its window and none
   * of them is its own.
   */
  private register(id: string, proc: IPty, info: SessionInfo, launch: LaunchOpts, cols: number, rows: number, backend: BackendDescriptor = DEFAULT_BACKEND, createsRecord = false): SessionInfo {
    const session: Session = {
      info, proc, launch, backend, scrollback: "", screenLog: new SessionScreenLog(cols, rows), seq: 0, cols, rows, lastDataAt: Date.now(), sawData: false,
      promptTimer: null, promptDueAt: 0, lastPromptCheckAt: 0, promptRendering: false, promptGen: 0, promptMisses: 0, lastResizeAt: 0, idleTimer: null, agentTimer: null, idleNotified: false, askDismissed: null, history: record.loadHistory(this.core, id), capturing: null, captureBuf: "",
      naming: false,
      privateModes: new Set(), detaching: false, copyMode: false, scrollChain: Promise.resolve(),
      claudeIdTimer: null, storeIdTimer: null, createdRecord: createsRecord, spawnedAt: Date.now(),
      limitTimer: null, limitGaveUp: false, stopVerifyTimer: null, stopPending: false, turnFromScreen: false,
      hooksActive: false, turnHookSeen: false, turnActive: false, stopCount: 0, submits: [],
      resurrectTimer: null, killed: false,
    };
    // The tab name this session already had, from before the restart. It is
    // derived once and never again, so losing it across a restart would RENAME
    // every tab on the strip, which is the one thing a tab may not do.
    const prior = record.loadSummary(this.core, id);
    if (prior?.tab) info.tabTitle = prior.tab;
    this.sessions.set(id, session);
    this.roster.applyPromptLabels(session); // seed first/last/pinned from loaded history
    this.roster.rememberRecent(session);
    // Conversation id not knowable at spawn (--continue / pick / fork / tmux
    // re-attach) → poll the claude project dir until its jsonl shows up.
    //
    // Only where there IS a claude project dir to poll. A backend that writes no
    // such log has no id for this watcher to find, so arming it would be a
    // `readdir` every few seconds against a directory that will never exist, and
    // the one way it could ever "succeed" is by adopting a DIFFERENT session's
    // conversation id — a plausible wrong answer, which is the failure mode this
    // whole design refuses. An opencode id is discovered by asking opencode, not
    // by watching claude's filesystem.
    if (!info.claudeSessionId && derive(backend).keepsClaudeLog) this.watchClaudeId(session);
    // The same job for a backend whose record is opencode's store. Armed only
    // where the DESCRIPTOR says that is the record and no id is known yet —
    // never for claude (whose id has its own watcher and its own field), never
    // for a backend with no record at all, and never once an exact
    // `--session <id>` already told us.
    if (!info.backendSessionId && namesStoreReader(backend)) this.watchBackendId(session);

    // The tmux client's terminal queries: answered, and STRIPPED before any consumer below (`termqueries.ts`).
    const queries = answerTermQueries(proc, (chunk) => {
      session.scrollback = (session.scrollback + chunk).slice(-SCROLLBACK_LIMIT);
      // What was SHOWN, written down as it happens. It cannot be read back
      // later: the CLI draws in the alternate screen, which keeps no
      // scrollback, so a replay of the ring is one screen however long the
      // session has run (`screenlog.ts` carries the measurement). Cheap — the
      // bytes are parsed once, incrementally, and the grid is read on a
      // debounce.
      session.screenLog?.write(chunk);
      session.seq += chunk.length; // monotonic output offset for resumable replay
      session.lastDataAt = Date.now();
      session.sawData = true;
      // Track DECSET private modes so we can reconstruct terminal state on replay.
      PRIVATE_MODE_RE.lastIndex = 0;
      for (let mm = PRIVATE_MODE_RE.exec(chunk); mm; mm = PRIVATE_MODE_RE.exec(chunk)) {
        const on = mm[2] === "h";
        for (const part of mm[1].split(";")) {
          const num = Number(part);
          if (!num) continue;
          if (on) session.privateModes.add(num); else session.privateModes.delete(num);
        }
      }
      // While a prompt's turn is in flight, buffer raw output to clean on idle.
      if (session.capturing) session.captureBuf = (session.captureBuf + chunk).slice(-RAW_CAPTURE_CAP);
      // Capture the claude.ai session URL once it appears (remote-control sessions).
      if (session.info.remoteControlled && !session.info.remoteUrl) {
        const m = REMOTE_URL_RE.exec(session.scrollback);
        if (m) { session.info.remoteUrl = m[0]; this.emit("updated", session.info); }
      }
      // New output does NOT retire a prompt: a choice box
      // sits on screen with the TUI's working line animating under it, so
      // clearing here and re-detecting only after 600 ms of quiet made a LIVE
      // dialog blink in and out about once a second — visible for a fraction of
      // a second at a time, impossible to read and impossible to tap. Only the
      // verifier (checkPrompt → applyPrompt, strict, against the rendered
      // screen) may clear a prompt, and scheduleChecks guarantees it still runs
      // under a repaint storm.
      // A numbered-choice suggestion belongs to the box, so it lives exactly as
      // long as the box does (cleared in applyPrompt); a free-text REPLY
      // suggestion survives cosmetic redraws and is cleared on real input
      // instead (see input()/write()).
      const sug = session.info.suggestion;
      const replySug = sug && sug.choice == null && sug.reply != null;
      const staleChoiceSug = !!sug && !replySug && !session.info.prompt;
      if (staleChoiceSug) {
        session.info.suggestion = null;
        this.emit("updated", session.info);
      }
      // Nor does output alone end idle: a redraw is not work (`sessions/idlewatch.ts`).
      idle.noteOutput(this.core, session, session.seq - chunk.length);
      // The CLI prints its own "Update available!" nag when npm is ahead of the
      // installed binary — surface it so the in-app update button appears even
      // while the Homebrew cask lags. Scan only FRESH output (a short rolling
      // tail carries splits across chunks); a stale nag in scrollback won't
      // re-fire. Forward once per distinct version.
      session.updateTail = ((session.updateTail || "") + chunk).slice(-400);
      const ban = detectUpdateBanner(stripAnsi(session.updateTail));
      if (ban.available) {
        const key = ban.latest ?? "";
        if (session.updateBannerSeen !== key) {
          session.updateBannerSeen = key;
          this.emit("updateBanner", ban.latest);
        }
      }
      this.emit("data", id, chunk, session.seq);
      this.scheduleChecks(session);
    }, { colors: hostTermColors }, lateQueryLog(id, info.title)); // a fork's terminal colours (`themeoverlay.ts`), else TERM_COLORS.dark
    proc.onExit(({ exitCode, signal }) => { this.channel.detach(session); queries.dispose(); // the side channel goes with the PTY, detached or ended
      // Detach (close-keep-alive): our tmux CLIENT died but the session lives on
      // in the tmux server. Don't announce it as closed/exited — it isn't.
      if (session.detaching) {
        if (session.promptTimer) clearTimeout(session.promptTimer);
        if (session.idleTimer) clearTimeout(session.idleTimer);
        this.core.retireAgentPoll(session);
        this.clearStopVerify(session);
        this.clearLimitTimer(session);
        this.stopClaudeIdWatch(session);
        return;
      }
      const exitLine = exitReport(session.info, exitCode, signal, session.backend.bin());
      endSession(this.core, session, { exitLine, exitCode, signal, diedAtLimit: (sid) => this.resume.diedAtLimit(sid) });
    });

    // Announce creation so clients learn about sessions made internally (e.g. by
    // the backlog or a boot-time re-attach), not just via a WS session.create.
    this.channel.attach(session); this.emit("created", info); // a backend with `sources` brings its channel up first
    return info;
  }

  // ── tmux substrate (sessions/tmux.ts): one-line delegations for `create`,
  // `register` and `rediscover` below; slices reach them through `core`.
  private spawnBackend(id: string, cwd: string, cols: number, rows: number, args: string[], backend: BackendDescriptor, launchEnv?: Readonly<Record<string, string>>, dropEnv?: readonly string[]): IPty { return spawnBackend(this.core, id, cwd, cols, rows, args, backend, launchEnv, dropEnv); }
  private persistLive(m: LiveMeta): void { persistLive(this.core, m); }
  private loadLive(id: string): LiveMeta | null { return loadLive(this.core, id); }
  private armOrphanSweep(): void { armOrphanSweep(this.core); }

  // ── conversation ids and the running model (sessions/convid.ts): one-line
  // delegations for `register`; slices reach them through `core`.
  private watchClaudeId(s: Session): void { watchClaudeId(this.core, s); }
  private stopClaudeIdWatch(s: Session): void { stopClaudeIdWatch(s); }
  private watchBackendId(s: Session): void { watchBackendId(this.core, s); }

  /**
   * Boot recovery: re-attach every live `waterplane_*` tmux session that has a `live/` record (call
   * once on startup — this is what makes sessions survive a restart), then delete the records whose
   * pane is provably gone (`reclaimStaleLive` — only past a `tmux ls` that SUCCEEDED).
   */
  rediscover(): void {
    // The orphan sweep is armed from HERE, not from `main.ts`, because its whole correctness rests
    // on being asked after this has run: an id is alive if it is in the session map OR in `live/`,
    // and both are settled below. The timer is deferred and unref'd, so boot never waits on it.
    this.armOrphanSweep();
    let out = "";
    try { out = execFileSync("tmux", ["-L", TMUX_SERVER, "ls", "-F", "#{session_name}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return; } // no server ⇒ nothing running to recover
    const names = new Set(out.split("\n").map((s) => s.trim()).filter(Boolean)); for (const name of names) {
      if (!name.startsWith(TMUX_PREFIX)) continue;
      const id = name.slice(TMUX_PREFIX.length);
      if (this.sessions.has(id)) continue;
      // Only adopt a session we have a persisted live-record for under THIS root.
      // Every session we spawn writes one immediately (persistLive), so a real
      // session always has it; a `waterplane_*` pane with no record is not ours (a
      // leaked/foreign session sharing the socket) — skip it rather than
      // synthesizing metadata and adopting (and thereby persisting) it, which is
      // how test-stub sessions used to naturalize into the real UI.
      const meta = this.loadLive(id);
      if (!meta) continue;
      try { adoptOrPark(this.core, meta); } catch { /* skip a session we can't attach */ } // unknown backend ⇒ parked: `parked()`
    }
    reclaimStaleLive(this.core, names); // a failed `ls` returned above, never read as empty; after adoption, so map + parked are the `keep`
  }
  parked(who?: (backendId: string) => string | null): void { if (who) { settleParked(this.core, who); this.channel.sweep(); } else retryParked(this.core); } // `tmux.ts`: no `who` = backends changed, adopt; `who` = plugins settled, close what is left naming its plugin — and reap what a GONE session left behind (`sidechannel.ts`'s `sweep`)

  // ── boxes (sessions/boxes.ts): the choice box — when to look, reading and publishing it, the
  // answer walks. The private delegation is for `register`.
  private scheduleChecks(s: Session): void { boxread.scheduleChecks(this.core, s); }
  answerBox(id: string, choice: number, opts?: { walk?: boolean; byPerson?: boolean; text?: string }): Promise<{ ok: boolean; reason?: string }> { return boxes.answerBox(this.core, id, choice, opts); }

  // ── turn (sessions/turn.ts): the turn flag and the hook lifecycle (the turn watch and the
  // Stop verify behind it), and the turn queries. `clearStopVerify` is for `register`.
  onHookEvent(payload: Parameters<typeof turn.onHookEvent>[1]): void { turn.onHookEvent(this.core, payload); }
  private clearStopVerify(s: Session): void { turn.clearStopVerify(s); }
  isHooked(id: string): boolean { return turn.isHooked(this.core, id); } lastHook(id: string): unknown { return this.core.sessions.get(id)?.lastHook; } // ← its SHAPE only, for the fixture capture
  sawTurnHook(id: string): boolean { return turn.sawTurnHook(this.core, id); }
  inCopyMode(id: string): boolean { return turn.inCopyMode(this.core, id); }
  noteHookFallback(id: string, via: string): void { turn.noteHookFallback(this.core, id, via); }

  // ── health (sessions/health.ts): `healthScope` is public (`deliver.ts`).
  // `noteFor`, `noteContextHealth` and `noteLogHealth` take no core, so the facade
  // calls the slice's functions directly. The ONE direct `noteHealth` call is there.
  healthScope(id: string): boolean { return healthScope(this.core, id); }
  sendHold(id: string): SendHold | null { const s = this.sessions.get(id); return s ? this.channel.sendHold(s) : null; } // `deliver.ts`: wait for the side channel?

  stopCount(id: string): number { return turn.stopCount(this.core, id); }
  turnFromHook(id: string): boolean { return turn.turnFromHook(this.core, id); }
  turnFromScreen(id: string): boolean { return turn.turnFromScreen(this.core, id); }
  geometry(id: string): { cols: number; rows: number } | null { return turn.geometry(this.core, id); }
  lastSubmittedPrompt(id: string, since: number): string | null { return turn.lastSubmittedPrompt(this.core, id, since); }
  claimSubmittedPrompt(id: string, text: string, since: number): boolean { return turn.claimSubmittedPrompt(this.core, id, text, since); }

  // ── wall (sessions/wall.ts): the public limit switches, and the wall methods `create`
  // (`newLimitState`), `register` (`clearLimitTimer`) and the constructor's limit sweep
  // (`checkLimit`) call.
  getAutoContinue(): boolean { return this.wall.getAutoContinue(); }
  setAutoContinue(enabled: boolean): void { this.wall.setAutoContinue(enabled); }
  setSessionLimitOverride(id: string, override: boolean | null): void { this.wall.setSessionLimitOverride(id, override); }
  private newLimitState(): SessionLimit { return this.wall.newLimitState(); }
  private checkLimit(s: Session): void { this.wall.checkLimit(s); }
  private clearLimitTimer(s: Session): void { this.wall.clearLimitTimer(s); this.net.clear(s); } // …and a pending network retry (sessions/apiretry.ts) goes with the session
  netRetryCancel(id: string): void { this.net.cancelById(id); } netRetryNow(id: string): void { this.net.retryNow(id); } netRetrySwitched(on: boolean): void { this.net.switched(on); } // the phone's Cancel / Retry now on `SessionInfo.netRetry`; the switch

  // ── The resume queue: `sessions/resume.ts` ───────────────────────────

  resumeState(): { resumingId: string | null; resumingIds: string[]; holdUntil: number | null; mode: LimitResumeMode } { return this.resume.resumeState(); }
  getResumeMode(): LimitResumeMode { return this.resume.getResumeMode(); }
  setResumeMode(mode: LimitResumeMode): void { this.resume.setResumeMode(mode); }
  setResumeFirst(id: string, on: boolean): void { this.resume.setResumeFirst(id, on); }
  resumeNow(id?: string): void { this.resume.resumeNow(id); }

  // ── Resurrect a session that EXITED at the usage limit: `sessions/resume.ts` ──

  diedAtLimit(id: string): boolean { return this.resume.diedAtLimit(id); }

  // ── Recent (cross-restart): `sessions/roster.ts` ─────────────────────

  listRecent(): RecentRow[] { return this.roster.listRecent(); }
  listClosed(): ClosedRow[] { return this.roster.listClosed(); }
  clearClosed(): void { this.roster.clearClosed(); }
  clearRecent(): void { this.roster.clearRecent(); }

  // ── drive (sessions/drive.ts): typing into a session, readiness for automation, geometry.
  input(id: string, data: string): boolean { return drive.input(this.core, id, data); }
  write(id: string, data: string): boolean { return drive.write(this.core, id, data); } shellLineFacts(id: string): Promise<drive.ShellLineFacts> { return drive.shellLineFacts(this.core, id, this.core.sessions.get(id)?.backend.bin()); } // ← a shell's line, for deliver.ts
  // ── budget (sessions/budgetwatch.ts): set/clear a session's cap, a new calibration, the poll's reason; the live grid its Esc reads (drive.ts).
  setSessionBudget(id: string, cfg: SessionBudget | null): SessionInfo | null { return this.budget.set(id, cfg); }
  setBudgetCal(cal: SessionBudgetCal | null): void { this.budget.setCal(cal); } settleBudgetEsc(id: string, byPerson = false): void { this.budget.settleEsc(id, byPerson); } budgetTurnEnded(id: string): void { this.budget.turnEnded(id); }
  wantsBudgetUsage(): boolean { return this.budget.wantsUsage(); }
  liveGrid(id: string): string { return drive.liveGrid(this.core, id); } setMode(id: string, m: PermissionMode): Promise<mode.ModeReply> { return mode.setMode(this.core, id, m); } // ← session.mode (sessions/livemode.ts)
  submitPromptBox(id: string): Promise<{ ok: boolean; placed: boolean }> { return boxes.submitPromptBox(this.core, id); }

  waitReady(id: string, quietMs = 1000, timeoutMs = 30000): Promise<boolean> { return drive.waitReady(this.core, id, quietMs, timeoutMs); }
  readyForAutoFire(id: string, quietMs: number): boolean { return drive.readyForAutoFire(this.core, id, quietMs); }
  autoFireBlocker(id: string, quietMs: number): string | null { return drive.autoFireBlocker(this.core, id, quietMs); }
  resize(id: string, cols: number, rows: number): void { drive.resize(this.core, id, cols, rows); }
  setRemoteControl(id: string, enabled: boolean): SessionInfo | null { return drive.setRemoteControl(this.core, id, enabled); }

  // ── Stars, follow-up flags (by session or conversation id) and overview labels: `sessions/roster.ts` ──────────────────
  pin(id: string, entryId: string | null): void { this.roster.pin(id, entryId); }
  setStar(id: string, starred: boolean): void { this.roster.setStar(id, starred); } setFollowUp(id: string, f: FollowUp | null): boolean { return this.roster.setFollowUp(id, f); }

  // ── turn (sessions/turn.ts): the person's answer to a prose question, and a plugin's.
  ackAsking(id: string, text?: string): void { askwatch.ackAsking(this.core, id, text); }
  setSuggestion(id: string, s: import("@waterplane/shared").AnswerSuggestion | null): void { askwatch.setSuggestion(this.core, id, s); }

  // ── Per-session plugin state: `sessions/roster.ts` ────────

  setWatched(ids: Set<string>): void { this.roster.setWatched(ids); }
  isWatched(id: string): boolean { return this.roster.isWatched(id); }
  setPluginToggle(id: string, plugin: string, toggle: string, value: boolean | null): boolean { return this.roster.setPluginToggle(id, plugin, toggle, value); }
  setPluginAnswer(id: string, plugin: string, value: boolean): boolean { return this.roster.setPluginAnswer(id, plugin, value); }
  setPluginBadge(id: string, plugin: string, badge: import("@waterplane/shared").PluginBadge | null): void { this.roster.setPluginBadge(id, plugin, badge); }
  /** Any live session whose "let <plugin> answer" switch is on for `plugin`. */
  anyPluginAnswer(plugin: string): boolean { return this.roster.anyPluginAnswer(plugin); }

  // ── drive (sessions/drive.ts): ending or letting go of a session, and reading its screen back.
  kill(id: string, onShellsStopped?: (counts: drive.ShellStopCounts) => void, by?: ClosedBy): void { drive.kill(this.core, id, onShellsStopped, by); } haltAll(): ReturnType<typeof halt.haltSessions> { return halt.haltSessions(this.core, (id) => drive.kill(this.core, id, undefined, "you")); } ourPanes(): ReturnType<typeof halt.ourPanes> { return halt.ourPanes(); } // the emergency halt's kill; our tmux panes for `api.sessionOf` (`sessions/haltall.ts`)
  /** A resume of a conversation whose session is already closed carries the
   *  reopen stack's prompts and tab name (`record.carryOfClosed`). A fork is a
   *  different conversation and carries nothing. */
  private closedCarry(resumeSessionId: string | undefined, resumeMode: string | undefined): record.SessionCarry | null {
    if (!resumeSessionId || resumeMode === "fork") return null;
    const row = this.roster.closedRowOfConversation(resumeSessionId);
    return row ? record.carryOfClosed(row) : null;
  }
  /** What a relaunch of `id` carries over, if it resumes the same conversation (`record.carryOf`). */
  carryFor(id: string, resumeSessionId: string | undefined): record.SessionCarry | null { return record.carryOf(this.core, id, resumeSessionId); }
  detach(id: string): boolean { return drive.detach(this.core, id); }
  setItemLookup(fn: Parameters<RosterSlice["setItemLookup"]>[0]): void { this.roster.setItemLookup(fn); }
  reattachById(id: string): boolean { return drive.reattachById(this.core, id); }
  remove(id: string, onShellsStopped?: (counts: drive.ShellStopCounts) => void, by?: ClosedBy): boolean { return drive.remove(this.core, id, onShellsStopped, by); } repointCompanions(from: string, to: string): void { drive.repointCompanions(this.core, from, to); } // a replaced session's companion shells follow it
  killShell(id: string, pid: number, startedAt: number): Promise<{ ok: boolean; reason?: string }> { return drive.killOneShell(this.core, id, pid, startedAt); }
  shellDetail(id: string, pid: number): SessionShellDetail | null { return drive.shellDetail(this.core, id, pid); }
  scrollback(id: string): string { return drive.scrollback(this.core, id); }
  screenText(id: string, lines = 40): Promise<string> { return drive.screenText(this.core, id, lines); }
  screenLines(id: string, max = SCREENLOG_MAX_LINES): Promise<{ lines: string[]; cols: number; history: boolean; bounded: boolean } | null> { return drive.screenLines(this.core, id, max); }
  screenCells(id: string, lines = 60): Promise<RenderRow[]> { return drive.screenCells(this.core, id, lines); }
  screenTail(id: string, max: number, since?: number): { data: string; seq: number } | "unchanged" | null { return drive.screenTail(this.core, id, max, since); }
  attachReplay(id: string, resumeSeq?: number): { data: string; seq: number; full: boolean } | null { return drive.attachReplay(this.core, id, resumeSeq); }
  idleMs(id: string): number | null { return drive.idleMs(this.core, id); }

  // ── record (sessions/record.ts): the prompt history, the reader's transcript, search, and
  // the tab-name spend. `register`/`onExit` call `finalizeCapture`/`loadSummary`/
  // `loadHistory` through `record.*` directly; other slices reach them through `core`.
  recordPrompt(id: string, text: string, kind: HistoryEntry["kind"]): void { record.recordPrompt(this.core, id, text, kind); }

  /** Persist the per-model context-window marks now (SIGTERM). */
  flushContextWindows(): void { this.ctx.flushContextWindows(); }

  getHistory(id: string): HistoryEntry[] { return record.getHistory(this.core, id); }
  getTranscript(id: string, since = 0, detail: "lite" | "full" = "lite"): TranscriptDoc | "unchanged" | null { return record.getTranscript(this.core, id, since, detail); }

  // ── ctxseries (sessions/ctxseries.ts): the tool details and the context series.
  getToolDetails(id: string, turnId: string): Record<string, TranscriptToolDetail> | null { return this.ctx.getToolDetails(id, turnId); }
  getContextSeries(id: string, since = 0): ContextSeriesDoc | "unchanged" | null { return this.ctx.getContextSeries(id, since); }

  search(query: string, scope: SessionSearchScope, id?: string): Promise<SessionSearchResult[]> { return record.search(this.core, query, scope, id); }
  /** The once-ever automatic tab name, off the first prompt (`record.nameTab`). */
  nameTab(id: string): Promise<void> { return record.nameTab(this.core, id); }
  nameNow(id: string): Promise<{ name?: string; reason?: string }> { return record.nameNow(this.core, id); }
  /** A name a person typed (`record.renameTab`); `setPeerFacts`: `peerWait`/`peerJobs`/`peerJob` (`peers/jobs.ts`; a key given as null/[] clears it) — memory only, a restart re-sets them. */
  rename(id: string, title: string): void { record.renameTab(this.core, id, title); }
  setPeerFacts(id: string, f: { [K in "peerWait" | "peerJobs" | "peerJob"]?: SessionInfo[K] | null }): void { const s = this.sessions.get(id); if (!s) return; for (const k of ["peerWait", "peerJobs", "peerJob"] as const) if (k in f) { const v = f[k]; if (v && (!Array.isArray(v) || v.length)) (s.info as unknown as Record<string, unknown>)[k] = v; else delete s.info[k]; } this.core.emit("updated", s.info); }

  get(id: string): SessionInfo | null { return this.sessions.get(id)?.info ?? null; } originOf(id: string): SessionOrigin | undefined { return this.sessions.get(id)?.origin; } // ← how it was OPENED (hand vs queued work): the serial rung's `automatic`

  // ── links (sessions/links.ts): a shell session's links — `$BROWSER`'s (`/api/shell/open`) and the screen's.
  addBrowserLink(id: string, url: unknown): boolean { return links.addBrowserLink(this.core, id, url); }
  setScreenLinks(id: string, found: readonly ShellLink[] | null, awaitingCode?: boolean): boolean { return links.setScreenLinks(this.core, id, found, awaitingCode); }
  /** Is this session's conversation record claude's jsonl? (`RosterSlice.keepsClaudeLog`) */
  keepsClaudeLog(id: string): boolean { return this.roster.keepsClaudeLog(id); }

  revivedSessionFor(deadSessionId: string): string | null { return this.resume.revivedSessionFor(deadSessionId); }

  /**
   * The newest still-running session whose cwd is exactly `dir`, or null. Used by
   * the backlog to fire into an already-open session for a repo (it never spawns
   * one itself anymore — a session must be open for an item to fire).
   */
  runningSessionFor(dir: string): string | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (!s.info.running || s.info.cwd !== dir) continue;
      if (!best || s.info.createdAt > best.info.createdAt) best = s;
    }
    return best?.info.id ?? null;
  }

  list(): SessionInfo[] { return [...this.sessions.values()].map((s) => s.info); }

  /** PIDs of the `claude` processes waterplane spawned — so discovery can exclude them. */
  managedPids(): Set<number> {
    const pids = new Set<number>();
    for (const s of this.sessions.values()) if (s.proc.pid) pids.add(s.proc.pid);
    return pids;
  }
}
