/**
 * The types every `sessions/` slice is written against: the per-session record
 * (`Session`), the persisted shapes beside it, and `SessionCore` — the ONE way a
 * slice reaches shared state or another slice (docs/notes/host-architecture.md,
 * "How a slice reaches shared state").
 *
 * TYPES ONLY (`tools/hostshape.test.mjs` refuses a function, a class, a `new` or
 * a timer here). The facade builds the one object that implements
 * `SessionCore`, privately, in its constructor; every member is an arrow that
 * delegates at CALL time to the slice that owns the method (the literal is
 * grouped by owning slice), so moving a method between slices retargets one
 * arrow.
 */
import type { IPty } from "node-pty";
import type {
  ClosedBy, ClosedSession, CliSignalId, DetectedPrompt, HealthOutcome, HistoryEntry, LaunchOpts, LimitResumeMode,
  RecentSession, SessionAsk, SessionBudget, SessionInfo, SessionLimit, SessionOrigin, SourceDialog, SourceHandle, TurnFacts,
} from "@waterplane/shared";
import type { AskQuestion } from "../askbox.js";
import type { PendingPlan } from "../planbox.js";
import type { BackendDescriptor } from "../backends/index.js";
import type { PluginStoreReader } from "@waterplane/shared";
import type { AgentUsage, SeriesCursor } from "../ctxlog.js";
import type { LimitLogVerdict } from "../limitlog.js";
import type { LimitRetry } from "../limitretry.js";
import type { RenderRow } from "../render.js";
import type { SessionScreenLog } from "../screenlog.js";

/** Persisted per-session record so boot can rebuild SessionInfo for a tmux
 *  session even if this process didn't start it (survives restart/crash).
 *
 *  WHICH backend it runs rides inside `launch` (`LaunchOpts.backend`) rather
 *  than as a field of its own — the launch flags are already the thing this
 *  record keeps so a restart restores the session as it was asked for, and a
 *  second copy of the id here would be a second copy to disagree. The same is
 *  true of `RecentSession.launch` and `ClosedSession.launch`, which is why a
 *  reopen and a rediscover both land on the right binary with no new field. */
/**
 * A session whose record is a CONTRIBUTED store reader's (`backends/readers.ts`) — opencode's
 * database, for one — and which conversation in it, when known. `reader` is null when the backend
 * names a store whose plugin has since left: every answer is then absent, as for an unknown id.
 */
export interface StoreSession {
  convId?: string;
  backend: BackendDescriptor;
  reader: PluginStoreReader | null;
  live: Session | null;
}

export interface LiveMeta {
  id: string; cwd: string; title: string; launch: LaunchOpts; createdAt: number;
  claudeSessionId?: string;
  /** The BACKEND's own conversation id, for a backend that is not claude
   *  (`SessionInfo.backendSessionId`). Persisted for the same reason the
   *  claude one is: a restart re-attaches the pane, and a discovery that only
   *  lived in this process would have to be made again — and could come back
   *  ambiguous, because by then several conversations in the directory are
   *  newer than the (re-)spawn. A re-attach cannot re-derive it at all: the
   *  structural rung is not offered to one (`createdRecord`), so this record is
   *  the only thing that carries the id across a restart. */
  backendSessionId?: string;
  /** How the session was opened (`SessionOrigin`) — persisted so a session
   *  re-attached after a restart still says so on its closed row. */
  origin?: SessionOrigin;
  /** The session's own budget (`sessions/budgetwatch.ts`), so a restart keeps
   *  the cap a person set. `persistLive` takes it off the LIVE session when
   *  there is one, so a writer that rebuilds this record field by field cannot
   *  drop it. */
  budget?: SessionBudget;
  /** The interrupt-once latch beside it: a restart must not re-notify, or
   *  re-interrupt, a session already told it is over. */
  budgetTripped?: boolean;
  /** The crossing's one Esc, not yet sent (`Session.budgetEscOwed`). */
  budgetEscOwed?: boolean;
  /** The prose question a person marked handled (`Session.askDismissed`'s
   *  text). The screen tail still ends on it after a restart, so without this
   *  every restart re-raised every acknowledged question with a fresh clock. */
  askDismissed?: string;
  /** The tmux server the pane lives on (`knobs.ts`'s `TMUX_SOCKET_ID`), stamped
   *  by `persistLive` on every write. The boot reclaim (`staleLiveIds`) judges a
   *  record only against a listing of THIS server; absent on records written
   *  before the stamp existed. */
  tmuxSocket?: string;
}

/**
 * A closed/recent row as this host keeps it — which is now exactly the wire
 * shape, `backendSessionId` included.
 *
 * These were host-local aliases carrying an extra key the DTOs did not have,
 * with a comment saying the phone had no use for it. That was half true and it
 * argued with the comment three hundred lines down in `rememberRecent`, which
 * promised the opposite: that the id is kept "so a reopen of an opencode row
 * resumes THAT conversation". Both could not be right. The reopen is the half
 * worth having — `--session <id>` is the only way back into one particular
 * opencode conversation, and `--continue` lands on whichever one the directory
 * saw last — so the field is on the wire now (`shared/wire/session.ts`, on both
 * `RecentSession` and `ClosedSession`) and the aliases are kept only as names
 * this file already used.
 */
export type ClosedRow = ClosedSession;
export type RecentRow = RecentSession;

export interface Session {
  info: SessionInfo;
  proc: IPty;
  scrollback: string;
  /**
   * What this session's terminal has SHOWN, recorded as it happens
   * (`screenlog.ts`).
   *
   * Beside `scrollback` and not derived from it, because it cannot be: the CLI
   * draws in the ALTERNATE screen, which keeps no scrollback, so replaying the
   * ring answers with ONE SCREEN however long the session has run (measured on
   * 2.1.267: `history_size=0 alternate_on=1` on every pane, and a live session
   * of hours replayed to 31 lines). A line that scrolled off was only ever
   * visible while it was on the grid, so it is written down then or not at all.
   */
  screenLog: SessionScreenLog | null;
  /**
   * Cumulative count of output chars ever emitted for this session (monotonic,
   * never reset — unlike `scrollback`, which is a capped ring). A client records
   * the seq carried on each PTY frame; on a reconnect it passes the last one back
   * as `resumeSeq` and attachReplay() streams only the delta after it. `base =
   * seq - scrollback.length` is the oldest offset still replayable.
   */
  seq: number;
  /** Live PTY dimensions — kept current on resize so capture replay wraps right. */
  cols: number;
  rows: number;
  lastDataAt: number;
  sawData: boolean;
  promptTimer: NodeJS.Timeout | null;
  /** When the armed prompt check is due (epoch ms) — the debounce keeps the
   *  EARLIEST armed check rather than pushing it out on every chunk. */
  promptDueAt: number;
  /** When the last prompt check actually ran — the staleness ceiling is measured
   *  from here, so a repaint storm can't defer verification for ever. */
  lastPromptCheckAt: number;
  /** True while a prompt candidate is being confirmed against the rendered screen
   *  — the VT replay is slow enough that overlapping checks could stack up. */
  promptRendering: boolean;
  /** Consecutive strict re-detects that failed while a dialog was still on the
   *  screen — a half-drawn repaint, not a box that went away. */
  promptMisses: number;
  /** The previous strict pass's read when it was a box not yet published (or
   *  a change to the published one): published only when the NEXT pass reads
   *  the same (`boxes.ts`'s `readTwice`). Cleared by any pass that reads
   *  nothing new. Absent until first set. */
  promptPending?: DetectedPrompt | null;
  /** A SHELL session's screen-links check (`sessions/links.ts`), armed on the
   *  quiet tick like the prompt check: the timer, when it is due, when one last
   *  ran (the ceiling), and a render in flight. Absent until first armed. */
  linksTimer?: NodeJS.Timeout | null;
  linksDueAt?: number;
  lastLinksCheckAt?: number;
  linksRendering?: boolean;
  /** Pane height (`rows`) when each published screen link was last read on
   *  screen — what `setScreenLinks` holds a link against when the pane has
   *  since shrunk (the links bar's own height). Memory only, never on the wire. */
  linkRows?: Map<string, number>;
  /**
   * When this session's PTY was last resized.
   *
   * A resize is a SIGWINCH, and a SIGWINCH makes this TUI clear and repaint the
   * WHOLE screen — so for a moment afterwards every capture is half-drawn by
   * construction, not by accident. `checkPrompt` needs to know that, or the
   * repaint spends the miss budget that exists for exactly this kind of
   * half-read screen and retires a box that never went anywhere.
   */
  lastResizeAt: number;
  /** Last `AskUserQuestion` tail-read, keyed on the conversation log's mtime —
   *  the strict prompt pass runs about twice a second while a box is up and the
   *  log does not move in that window. See `enrichPrompt`. */
  askCache?: { mtime: number; asks: AskQuestion[] };
  /** Last plan-file read for a plan-approval box (`planbox.ts`), keyed on the
   *  log's mtime AND the plan file's — the plan can be edited while its box is
   *  up (ctrl+g), and the log does not move when it is. */
  planCache?: { logMtime: number; path: string | null; fileMtime: number; plan: PendingPlan | null };
  /** Bumped whenever the cheap stage sees NO candidate. An in-flight render that
   *  started before that carries a screen we already know is gone, so its result
   *  is dropped instead of flashing a prompt back on after it disappeared. */
  promptGen: number;
  idleTimer: NodeJS.Timeout | null;
  /** Poll while agents are running under this session (see `checkAgents`).
   *  Null whenever there are none — an idle session arms nothing. */
  agentTimer: NodeJS.Timeout | null;
  /**
   * The last published `shellList`'s fingerprint (`pid:cpuMovedAt:outputAt:
   * workers` per row) — so a CPU tick that changes `cpuMs` without moving
   * `cpuMovedAt` costs nothing, and a broadcast fires only on a change a
   * person would actually see. Undefined before the first read.
   */
  shellsFp?: string;
  /**
   * True once a "turn finished" (idle) has been emitted for the CURRENT turn.
   * Cosmetic TUI redraws (blinking cursor, footer animation) emit tiny output
   * that flips idle back off and then on again — without this latch each redraw
   * would fire another "Turn finished". Cleared only when real input starts a
   * new turn (input()/write()).
   */
  idleNotified: boolean;
  /** Launch flags this session ran with — remembered so a reopen restores them. */
  launch: LaunchOpts;
  /**
   * Which backend this session is driving (`backends/`).
   *
   * **Consulted before every claude-shaped reader is armed.** `caps` decides
   * whether a reader RUNS — never what it answers — so a backend that declares
   * fewer capabilities publishes fewer FACTS and can never publish a wrong one:
   * no context figure rather than 0%, no limit state rather than an unblocked
   * one, no transcript rather than an empty reader. `healthScope` is the same
   * rule applied to the health record (`noteFor`).
   *
   * Restored on re-attach from the persisted launch flags, so a `npm run
   * restart` hands a session back to the same descriptor it was spawned with —
   * and a session whose descriptor is unknown refuses to come back rather than
   * coming back as something else.
   */
  backend: BackendDescriptor;
  /** Prompt+output history for this session (persisted to .waterplane/history/<id>.json). */
  history: HistoryEntry[];
  /** Id of the history entry whose output we're capturing this turn, if any. */
  capturing: string | null;
  /** Raw (still-ANSI) PTY bytes accumulated since the pending prompt was sent. */
  captureBuf: string;
  /** The ≤3-word tab name is derived ONCE; this stops a second call racing it. */
  naming: boolean;
  /** The automatic naming pass has already been bought for this session (this process). */
  nameAsked?: boolean;
  /** The tail of this session's `session.mode` presses (`livemode.ts`): a second
   *  tap waits for the first, so two walks never interleave their shift+tabs. */
  modeChain?: Promise<unknown>;
  /** This session's composer has worn the `ultracode` label at least once, so
   *  a bare rule is the CLI saying "off" (`permmode.ts`'s `ultracodeVerdict`). */
  ultracodeLabelSeen?: boolean;
  /**
   * DECSET private modes currently active (alt-screen, mouse tracking, bracketed
   * paste, …). Tracked because the enabling sequences are emitted once at claude
   * startup and fall out of the capped scrollback — without re-emitting them on
   * replay, a refreshed xterm renders in the normal buffer with mouse off, which
   * breaks alt-screen scroll routing on the phone.
   */
  privateModes: Set<number>;
  /** True while we're intentionally dropping our tmux client (close-keep-alive)
   *  — tells onExit the session isn't really dead, just detached. */
  detaching: boolean;
  /** The tmux pane is in copy-mode (the user panned back through its history).
   *  A pane in a mode does NOT pass keystrokes to claude — it reads them as
   *  copy-mode commands — so everything that types leaves it first. Believed,
   *  not assumed: `copy-mode -e` exits by itself at the bottom, so the flag is
   *  re-read from tmux after every scroll (`tmuxscroll.ts`). */
  copyMode: boolean;
  /** Serialises the tmux scroll calls for this session: a flick is one write,
   *  but two flicks must not interleave their copy-mode/send-keys pairs. */
  scrollChain: Promise<unknown>;
  /** Poller looking up info.claudeSessionId when it wasn't knowable at spawn
   *  (--continue / pick / fork / tmux re-attach). Null once found or given up. */
  claudeIdTimer: NodeJS.Timeout | null;
  /** The same job for a backend whose record is a contributed store reader's
   *  (`backends/readers.ts`): poller looking up `info.backendSessionId`. A separate timer from `claudeIdTimer` because
   *  the two never coexist on one session and sharing the field would make
   *  "which watcher is running" a thing to derive rather than read. */
  storeIdTimer: NodeJS.Timeout | null;
  /**
   * The last prompt CONFIRMED to have been typed into this session, kept only
   * while its backend's conversation id is still unknown — WITH the instant it
   * was sent.
   *
   * The second rung of that discovery (`watchBackendId`): a text that was seen
   * on screen will be written into the store as a user message, and an exact
   * match on it names the conversation where the structural rung could not.
   * Cleared on adoption, and never set for a backend that mints or is handed its
   * own id.
   *
   * The stamp is not bookkeeping: it is the rung's FLOOR. Matching from the
   * spawn instead meant any conversation in the repo that had been sent the same
   * words at any point in this session's life was a match, and "continue" is a
   * shipped header chip five characters long.
   */
  storePromptProbe?: { text: string; at: number };
  /**
   * What the store reader's last discovery pass handed back to be handed in on
   * the next (`PluginStoreLook.carry`) — opencode's: a rung-2 match seen on an
   * EARLIER pass, waiting to be seen again, because a sole match found before
   * OUR row exists can only be somebody else's. Opaque here. Reset by a new
   * prompt and by an adoption.
   */
  storeIdCarry?: unknown;
  /**
   * Did OUR OWN SPAWN create this backend's conversation row?
   *
   * `LaunchPlan.createsRecord`, carried onto the session because the discovery
   * runs long after the launch mode was decided. It is what entitles a session
   * to the structural rung: for a bare `--continue` and for a tmux re-attach the
   * "one fresh conversation in this directory" is, by construction, a stranger's.
   */
  createdRecord: boolean;
  /** Only conversation files modified after this instant can be ours. */
  spawnedAt: number;
  /** Pending auto-continue attempt for a usage-limit block, if scheduled. */
  limitTimer: NodeJS.Timeout | null;
  /**
   * The `gaveup` notification has been sent for the block this session is in.
   *
   * `scheduleLimitAttempt` is re-asked by the minute sweep for as long as a
   * session stays blocked, so without this the end of the waiting would push a
   * notification once a minute, for ever. Cleared where a block BEGINS and
   * where one is lifted — a new wall is a new wait, and is owed its own word.
   */
  limitGaveUp: boolean;
  /**
   * **The block this session was BORN into**, when it was opened by
   * `doResurrect` to replace one that exited at a wall.
   *
   * A reopened conversation hits the same wall seconds later and marks itself
   * blocked — and `markLimitBlocked` treats a block BEGINNING as a fresh one,
   * zeroing `attempts` and stamping `blockedSince` now. Across a resurrection
   * that is a lie about which wall this is: every reopen started the count
   * again, so the backoff restarted at its shortest rung and the patience clock
   * restarted at zero. A weekly wall therefore reopened the conversation every
   * few minutes for days — hundreds of processes, each one dying on the same
   * wall, and neither bound ever reached.
   *
   * `at` is when it was carried, because a session that comes back and runs for
   * a week before hitting a NEW wall must not adopt the old one's clock: past
   * `LIMIT_CARRY_MS` the carry is stale and dropped.
   */
  limitCarried?: { attempts: number; blockedSince: number; at: number };
  /** Armed while a `Stop` hook is still being settled against the screen — see
   *  `STOP_VERIFY_MS`. Null when no Stop is in question. */
  stopVerifyTimer: NodeJS.Timeout | null;
  /** A `Stop` hook has arrived and its consequences (turn ended, the ping, the
   *  `turnEnded` event) have not been applied yet. The flag, not the timer, is
   *  what says a Stop is owed an answer: the timer is null in the moment
   *  between two settle passes. */
  stopPending: boolean;
  /** The turn in flight was inferred from the SCREEN, not announced by a hook —
   *  `/compact` and friends work for minutes and fire nothing. It ends when the
   *  working line stops printing, and it ends QUIETLY: no `stopCount`, no
   *  turn-finished push, no `turnEnded`. There was no turn to finish. */
  turnFromScreen: boolean;
  /** True once ANY claude hook has reported for this session — the hook pipe is
   *  live, so turn boundaries come from Stop/UserPromptSubmit (exact) instead of
   *  the PTY-silence heuristics. */
  hooksActive: boolean;
  /** True once a TURN-shaped hook (`SessionStart`/`UserPromptSubmit`/`Stop`)
   *  has reported since THIS process attached. `hooksActive` flips on any hook,
   *  `Notification` included — and after a restart the first one is often the
   *  `idle_prompt` a minute after a turn that ended while the host was down,
   *  whose Stop went nowhere. The intent store asks this so such a session is
   *  not waited on for a Stop that will never come (`sawTurnHook`). Nothing
   *  else reads it: `hooksActive` keeps its meaning everywhere it gates. */
  turnHookSeen: boolean;
  /** True between a UserPromptSubmit hook and its matching Stop hook — the turn is
   *  in flight. When hooksActive, this (not silence) gates auto-fire readiness. */
  turnActive: boolean;
  /** Monotonic count of finished turns (Stop hooks). The backlog snapshots this
   *  when it delivers an item and completes the item on the next increment. */
  stopCount: number;
  /**
   * The wording of a prose question the PERSON has said they have dealt with
   * (`session.ackAsking`), so `checkAsking` stops re-raising it.
   *
   * Clearing `info.asking` alone would not hold: the fact is recomputed from
   * the rendered tail on every re-idle, and the tail does not change because
   * the decision was acted on somewhere else. So the acknowledgement is held
   * against the WORDS — a different question raises the badge normally, and a
   * turn starting drops the memory, because the next turn may legitimately ask
   * the same thing again.
   *
   * `stop` is the `stopCount` of the turn end it was said about. The words are
   * read off raw bytes and a repaint re-glues them (see `sameAsk`), so on a
   * hooked session — where a new turn end is KNOWN — the acknowledgement holds
   * for that turn end whatever the tail reads back as. An unhooked session has
   * no such count, and falls back to the words alone.
   */
  askDismissed: { text: string; stop: number } | null;
  /**
   * The plain composer text the last `checkCliSuggestion` paid a render for,
   * so a repaint of the same screen costs one string compare, not a replay.
   */
  hintRead?: string | null;
  /**
   * The prompts this session's CLI said it SUBMITTED, newest last, bounded.
   *
   * `UserPromptSubmit` carries the submitted text and the host threw it away,
   * keeping only "a turn started". Those are not the same fact: a turn starting
   * is evidence the session is busy, and this is the CLI naming the words it
   * took — the only proof about a Return that survives an interjection (where
   * `turnActive` was already true) and the only one that survives an echo the
   * screen could not be read for. See `claimSubmittedPrompt`.
   */
  submits: { prompt: string; at: number; claimed: boolean }[];
  /** Pending resurrect timer for a session that exited while usage-limited —
   *  reopens it (`--continue`) at the reset time. Null when none scheduled. */
  resurrectTimer: NodeJS.Timeout | null;
  /** True once the user KILLED/removed this session — suppresses limit-resurrect
   *  (an intentional close must never be auto-reopened). */
  killed: boolean;
  /** How it was opened (create's `origin`, or the `live/` record on re-attach).
   *  Absent = nobody said — the closed row then carries no `kind`. */
  origin?: SessionOrigin;
  /** WHO is closing it, set by the caller of `remove`/`kill`/`detach` right
   *  before the PTY goes, read by the exit path's `closedRowOf`. Absent ⇒ the
   *  process ended on its own (or by a path that named no reason). */
  closeBy?: ClosedBy;
  /** Last CLI update-nag we forwarded (dedupe key: version, or "" if unversioned).
   *  Undefined until the banner is first seen for this session. */
  updateBannerSeen?: string;
  /** Small rolling tail of RECENT PTY output, scanned for the update nag. Only
   *  holds fresh post-attach output (never seeded from scrollback) so a nag left
   *  behind in history can't re-fire after the binary is upgraded. */
  updateTail?: string;

  // ── CLI-health bookkeeping (see `clihealth.ts`) ───────────────────────
  // Four fields, and all four exist for one reason: every observation this app
  // records must be EDGE-TRIGGERED. `enrichPrompt`, the context scan and the
  // transcript read all run on a poll, and a `good` per poll fills the rate
  // window with successes in seconds — which makes the misses arithmetically
  // invisible, i.e. the exact failure the readout exists to catch. These hold
  // "what was last true here", so only a change is recorded.
  /**
   * What the last `enrichPrompt` found, read by `applyPrompt` on the edge where
   * a box actually becomes published. Set on the poll, recorded on the edge.
   */
  enrich?: { asks: number; matched: boolean; labels: string } | null;
  /** True once this session's missing hook pipe has been recorded. Once per
   *  session: a session with no hooks takes the fallback on every single turn,
   *  and twenty rows saying so is one fact told twenty times. */
  hookFallbackNoted?: boolean;
  /** Last context-meter outcome recorded for this session. */
  ctxHealth?: "good" | "miss" | null;
  /** Last conversation-log outcome recorded for this session. */
  logHealth?: "good" | "miss" | "fallback" | null;
  /** Cached `readLimitLog` answer, valid only while the log has not moved.
   *  The idle sweep asks once a minute per blocked session; the file is
   *  megabytes and the answer changes only when it is written to. */
  limitLog?: { path: string; mtime: number; verdict: LimitLogVerdict } | null;
  /** How far the context-window reader has got through this session's log
   *  (`ctxlog.ts`). Kept so a per-turn refresh reads what was APPENDED rather
   *  than re-walking tens of MB. */
  ctxCursor?: SeriesCursor | null;
  /** What this session's subagents have spent, and how far each of their logs
   *  has been read (`ctxlog.ts`'s `agentUsage`). Same trade as `ctxCursor`: a
   *  running agent's log grows, and this is asked once a minute. */
  agentUse?: AgentUsage | null;
  /** What `info.contextSpark` was last BUILT from — the log's path and mtime
   *  and the agents' token total. `ctxCursor` and `agentUse` are shared with
   *  the graph's read (`getContextSeries`), which advances both without
   *  rebuilding the spark, so they cannot say whether the spark is current. */
  sparkFrom?: { path: string; mtime: number; agentTok: number | null } | null;
  /** The budget's interrupt-once latch (`sessions/budgetwatch.ts`): set on the
   *  crossing into `over`, cleared only by a verdict of `ok` or a new cap — an
   *  `unknown` in between (a reading gone stale) is not a second crossing. The
   *  cap itself lives on `info.budget.cfg`, the one copy. */
  budgetTripped?: boolean;
  /** The crossing's one Esc, OWED: set on the crossing when the budget
   *  interrupts, retried on every judge while still over (`budgetEscDue`), and
   *  cleared by the Esc going out, a person's own send, a new cap, `interrupt`
   *  switched off, or a verdict of `ok`. A turn that could not be interrupted at
   *  the crossing instant used to be left spending for good. */
  budgetEscOwed?: boolean;
  /** HARD budget only: the `stopCount` at which the turn a person sent into
   *  past the cap has ended (`BudgetSlice.settleEsc`). Turn ends below it are
   *  that person's turn (or one still closing out ahead of it) and re-arm no
   *  Esc. Memory only — a restart forgets the grant, and the next turn end
   *  re-arms. */
  budgetGrantStop?: number;
  /** The backend's side channel for this session (`sessions/sidechannel.ts`),
   *  present only when the descriptor has `sources`. Absent = today's session. */
  channel?: SessionChannel;
}

/**
 * One session's side channel: the handle `sources.attach()` returned and what
 * the channel currently owns. Written ONLY by `sessions/sidechannel.ts`; read by
 * `boxes.ts` (the screen reader stands down while `dialogsLive`; `answerBox`
 * answers a source dialog by its own channel; the screen turn watch stands down
 * while `turnsLive`).
 */
export interface SessionChannel {
  handle: SourceHandle | null;
  /** `sources.attach()` has not settled yet — the channel is connecting, not failed. */
  attaching: boolean;
  /** The unsubscribes of every `watch()` this channel opened. */
  unwatch: (() => void)[];
  /** `sources.turns` is live: `hooksActive`/`hooked` were set BY the channel,
   *  and are taken back when it goes down. */
  turnsLive: boolean;
  /** `sources.dialogs` is live AND has reconciled: the screen reader is off. */
  dialogsLive: boolean;
  /** A `pending()` reconcile is in flight. */
  reconciling: boolean;
  /** Dialogs the CLI has posed and not resolved, oldest first, by the CLI's id. */
  dialogs: Map<string, SourceDialog>;
  /** `askId` of the source dialog currently published as `info.prompt`, if any. */
  published: string | null;
  /** Set by `detach()`: a late callback from a closed channel changes nothing. */
  closed: boolean;
  /** `detach()` was a tmux DETACH (the pane runs on): a handle that arrives after it is
   *  suspended, never closed — closing would kill a child the pane still depends on. */
  suspendOnClose: boolean;
  /** The channel has reported `up` at least once: a `down` now is an outage the backend
   *  recovers from, not a channel that never started. */
  everUp: boolean;
  /** The source said this session has no channel at all (`SourceHandle.screenOnly`):
   *  screen-only, its sends never held. The sentence, or null. */
  screenOnly: string | null;
  /** Dialogs the source can see but cannot pose (`DialogSource` `unposed`): while above 0
   *  the screen reader keeps its duty even though the channel owns the dialogs. */
  unposed: number;
}

/**
 * Everything one slice may ask of the rest of the session manager.
 *
 * Derived from the code, not sketched: every member is a method or a piece of
 * state that is OWNED by one slice (or the facade) and reached from ANOTHER
 * one, as the inventory in docs/notes/host-architecture.md assigns methods to
 * slices. Written whole in S1 so that the parallel builders of S2…S11 never
 * have to edit this file to find a member; one they still need is added here,
 * in review, and named in the commit.
 *
 * Grouped by the slice that OWNS the member — the one whose file the arrow
 * will point into once that package lands. Methods are typed exactly as the
 * private method is today (defaults become optional parameters). Another
 * slice's STATE is reached through a named accessor, read at call time, never
 * as a field: `resumeWaiting` and `recentlyClosed` are reassigned, and a field
 * captured once would go stale after the first reassignment.
 *
 * A slice's non-hub method is not here, and is therefore unreachable from any
 * other slice. That is the narrowness; never a second `xHooks()` beside this.
 */
export interface SessionCore {
  // ── the facade: shared state and the class's own verbs ──
  readonly root: string;
  readonly port: number;
  /** THE session map, shared by reference with the facade. */
  readonly sessions: Map<string, Session>;
  /** The facade's EventEmitter `emit`. */
  emit(event: string | symbol, ...args: any[]): boolean;
  create(
    cwd: string,
    opts?: { cols?: number; rows?: number; title?: string; resume?: boolean; resumeMode?: "continue" | "pick" | "fork"; resumeSessionId?: string; forkAtTurn?: string; launch?: LaunchOpts; origin?: SessionOrigin; budget?: SessionBudget },
  ): SessionInfo;
  /** PRIVATE on the facade and stays there — the one PTY wiring. A hub member
   *  because `tmux.ts`'s `reattach` wires a PTY it did not spawn. */
  register(
    id: string, proc: IPty, info: SessionInfo, launch: LaunchOpts, cols: number, rows: number,
    backend?: BackendDescriptor, createsRecord?: boolean,
  ): SessionInfo;
  /** The facade's module `backendField` (convid's once S3 lands): the wire
   *  `backend` field, absent for claude. `tmux.ts`'s `reattach` builds an info. */
  backendField(b: BackendDescriptor): { backend?: string };

  // ── tmux.ts (S2) ──
  spawnBackend(id: string, cwd: string, cols: number, rows: number, args: string[], backend: BackendDescriptor, launchEnv?: Readonly<Record<string, string>>, dropEnv?: readonly string[]): IPty;
  reattach(m: LiveMeta): void;
  persistLive(m: LiveMeta): void;
  loadLive(id: string): LiveMeta | null;
  deleteLive(id: string): void;
  /** drive.ts: a parent's companion shells follow it to a new id. */
  repointCompanions(from: string, to: string): void;
  hasLiveTmux(id: string): boolean;
  armOrphanSweep(): void;

  // ── convid.ts (S3) ──
  detectClaudeId(s: Session): string | null;
  adoptClaudeId(s: Session, cid: string | null): void;
  watchClaudeId(s: Session): void;
  stopClaudeIdWatch(s: Session): void;
  detectBackendId(s: Session): string | null;
  adoptBackendId(s: Session, id: string | null): void;
  watchBackendId(s: Session): void;
  refreshModel(s: Session, transcriptPath?: string): void;

  // ── health.ts (S3) ──
  noteFor(s: Session | null | undefined, id: CliSignalId, outcome: HealthOutcome, opts?: { raw?: string; via?: string }): void;
  noteContextHealth(s: Session, cleaned: string, pct: number | null): void;
  noteLogHealth(s: Session | null, outcome: "good" | "miss" | "fallback" | null, raw: string): void;

  // ── ctxseries.ts (S8) ──
  refreshSpark(s: Session): boolean;
  checkContext(s: Session): void;
  // ── budgetwatch.ts ──
  /** Re-derive `info.budget.verdict`; emits `budgetTripped` on the crossing.
   *  Returns whether the caller should emit `updated`. */
  judgeBudget(s: Session): boolean;
  storeFor(id: string): StoreSession | null;
  logFor(id: string): { cwd: string; cid?: string; live: Session | null } | null;

  // ── roster.ts (S9) ──
  rememberRecent(s: Session): void;
  applyStar(info: SessionInfo): void;
  applyPromptLabels(s: Session): void;
  pushClosed(entry: ClosedRow): void;
  /** The closed row for `s` as it is NOW (`roster.ts`): what it was, why it
   *  ended (`by`, else `s.closeBy`), and the exit code/signal for an own exit. */
  closedRowOf(s: Session, alive: boolean, exit?: { by?: ClosedBy; exitCode?: number; signal?: number }): ClosedRow;
  publishClosed(): void;
  /** `recentlyClosed.find((c) => c.id === id)` — the row, read at call time. */
  closedRow(id: string): ClosedRow | undefined;
  /** `recentlyClosed = recentlyClosed.filter((c) => c.id !== id)` — publishing is the caller's. */
  dropClosed(id: string): void;
  /** `watched.has(id)` — a client is attached to this session. */
  isWatched(id: string): boolean;

  // ── wall.ts (S6) ──
  newLimitState(): SessionLimit;
  limitAuto(s: Session): boolean;
  limitRetry(s: Session, now: number, resetAt?: number | null): LimitRetry;
  limitLog(s: Session): LimitLogVerdict;
  checkLimit(s: Session): void;
  markLimitBlocked(s: Session, resetAt: number | null, weekly?: boolean, sample?: string, dated?: boolean): void;
  scheduleLimitAttempt(s: Session, atOverride?: number): void;
  doLimitContinue(s: Session): Promise<void>;
  clearLimitTimer(s: Session): void;
  noteGaveUp(s: Session, why: string): void;
  writeLimitCfg(): void;
  /** The release mode is WALL's field — `writeLimitCfg` persists it beside the
   *  switch — read and written by the resume queue through these two. */
  resumeMode(): LimitResumeMode;
  assignResumeMode(mode: LimitResumeMode): void;

  // ── resume.ts (S7) ──
  /** `resumingIds.has(id)`. */
  isResuming(id: string): boolean;
  /** `resumeWaiting` — the ids whose resume is due, in order. Reassigned, so asked each time. */
  resumeQueue(): readonly string[];
  resumeHoldUntil(): number;
  resumeProven(): boolean;
  setResumeProven(proven: boolean): void;
  /** `resumeFirst.get(id)` — when this session was pushed to the front, if it was. */
  resumeFirstAt(id: string): number | undefined;
  /** `resumeFirst.delete(id)`. */
  dropResumeFirst(id: string): boolean;
  releaseResume(id: string, why: "resumed" | "blocked" | "gone" | "timeout"): void;
  publishQueue(): void;
  pumpResume(): void;
  requestResume(s: Session): void;
  clearResurrectTimer(s: Session): void;
  maybeScheduleResurrect(s: Session): void;

  // ── turn.ts (S5) ──
  setTurn(s: Session, active: boolean, opts?: { fromScreen?: boolean }): void;
  checkIdle(s: Session): void;
  armTurnWatch(s: Session, seqAt?: number): void;
  setAsking(s: Session, ask: SessionAsk | null): void;
  setCliSuggestion(s: Session, text: string | null): void;
  checkAgents(s: Session): void;
  clearStopVerify(s: Session): void;
  /** A turn edge a backend's `sources.turns` reported (`sidechannel.ts`). */
  sourceTurn(s: Session, edge: "started" | "ended" | "ready", facts?: TurnFacts): void;
  /** The backend's channel named the CLI's own conversation id (`sources.turns`' `identified`). */
  sourceIdentified(s: Session, id: string): void;

  // ── boxes.ts (S4) ──
  scheduleChecks(s: Session): void;
  armPromptCheck(s: Session, delayMs: number): void;
  applyPrompt(s: Session, prompt: DetectedPrompt | null): void;
  /** Raise or lower `awaitingInput` (the "blocked on you, no box to tap" flag). */
  setAwaiting(s: Session, on: boolean): void;

  // ── livemode.ts ──
  /** Re-read the footer's permission mode and ultracode off the live grid
   *  (`permmode.ts`); emits `updated` on a change. Claude's TUI only. */
  checkMode(s: Session): void;
  // ── links.ts ──
  /** Arm the shell-links read (`shelllinks.ts`) on the quiet tick — a no-op unless `caps.turns === false`. */
  armLinksCheck(s: Session): void;

  // ── drive.ts (S10): public verbs, by their public names ──
  input(id: string, data: string): boolean;
  write(id: string, data: string): boolean;
  screenText(id: string, lines?: number): Promise<string>;
  screenCells(id: string, lines?: number): Promise<RenderRow[]>;

  // ── record.ts (S11) ──
  /** The newest real turn off the claude log. `tmux.ts`'s `reattach` and
   *  `turn.ts`'s `markIdle` stamp `lastTurnAt` with it. */
  lastTurnOf(cwd: string, claudeSessionId: string | undefined): number | null;
  recordPrompt(id: string, text: string, kind: HistoryEntry["kind"]): void;
  finalizeCapture(s: Session): void;
  loadSummary(id: string): { tab?: string } | null;
  loadHistory(id: string): HistoryEntry[];
  historyPath(id: string): string;
  summaryPath(id: string): string;
}
