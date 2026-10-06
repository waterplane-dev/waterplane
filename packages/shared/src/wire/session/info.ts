import type { PeerJobLocalState, PeerJobOrigin, PeerJobSummary } from "../../peer.js";
import type { AnswerSuggestion, PluginBadge } from "../../plugin.js";
import type { SessionBudgetInfo } from "../../sessionbudget.js";
import type { ChannelHealth } from "../../backendsources.js";
import type { StandingRule, DetectedPrompt } from "./promptbox.js";
import type { Effort, PermissionMode, SessionLimit, SessionLogin, ShellLink, SessionAgent, SessionAsk, SessionShell } from "./launch.js";
import type { ContextSpark } from "./contextspark.js";

/** A drivable Claude Code session, bound to a working directory. */
export interface SessionInfo {
  id: string;
  /** Absolute cwd the `claude` process runs in (a repo or worktree). */
  cwd: string;
  /** Human label — usually "<repo> · <branch>". */
  title: string;
  /** Whether the phone is allowed to send input (remote control toggle). */
  remoteControl: boolean;
  /** PTY alive? */
  running: boolean;
  /**
   * Which backend this session runs (`BackendInfo.id`, `wire/backend.ts`).
   *
   * ABSENT MEANS CLAUDE. This is the field that keeps an old phone reading a
   * new host's claude sessions seeing exactly today's document: every session
   * before this field existed was a claude session, so a host that has never
   * heard of another backend — and a session record persisted before this
   * shipped — must read the same as one that explicitly says "claude" would.
   * A client MUST NOT treat the absence as "unknown backend"; it is a known
   * one, spelled by leaving the field out.
   */
  backend?: string;
  /** Launch settings this session was started with (for display). */
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  /** True if launched with --remote-control (mirrored to claude.ai). */
  remoteControlled?: boolean;
  /** claude.ai/code session URL, parsed from the Remote Control banner. */
  remoteUrl?: string;
  /** Set when the session appears to be waiting on a choice prompt. */
  prompt?: DetectedPrompt | null;
  /** A sign-in link the CLI printed, and whether it is waiting for the code. */
  login?: SessionLogin | null;
  /**
   * Links a SHELL session wants opened (`ShellLink`), newest last. Absent/null
   * on every claude-shaped session and whenever none is live — never an empty
   * placeholder the phone has to tell apart from "nothing".
   */
  links?: ShellLink[] | null;
  /**
   * A shell session's CLI is sitting on a "paste the authorization code" input
   * (the line the screen ends on asks for a code). Absent = no / cannot tell.
   * The claude login flow's own flag is `login.awaitingCode`, not this one.
   */
  awaitingCode?: boolean;
  /**
   * The screen carries an interactive box ("Enter to confirm · Esc to cancel")
   * that `prompt.ts` could NOT parse into options. The reader view has no
   * terminal to look at, so without this a session blocked on an unrecognised
   * dialog just reads as "working" forever — the honest answer is "it wants an
   * answer, open the CLI".
   */
  awaitingInput?: boolean;
  /**
   * The turn ENDED on a question to you, asked in prose — no box, no options.
   *
   * The commonest way work stops here is not a dialog: the agent finishes a
   * turn with "Want 2 implemented, or leave it at 1?" and sits at its composer.
   * The CLI is not blocked, so `prompt`/`awaitingInput` are both empty and the
   * session reads `done` — a finished turn, nothing owed. It was detected only
   * when the Gemini oracle was configured, because the heuristic lived inside
   * the oracle's gate; with no key the phone was told "Turn finished" and the
   * decision sat there unasked.
   *
   * Set on the turn-end transition (host `question.ts`), cleared the moment a
   * turn starts or anything is typed. A parsed `prompt` outranks it — that box
   * is the same question with buttons.
   */
  asking?: SessionAsk | null;
  /** A plugin's suggested answer for the current question (`plugin.ts`). */
  suggestion?: AnswerSuggestion | null;
  /** Per-plugin per-session switches the person flipped (plugin id → toggle
   *  id → value). Absent = every toggle at its manifest default. */
  pluginToggles?: Record<string, Record<string, boolean>>;
  /** The core's "let <plugin> answer" switch per plugin id; absent = off. */
  pluginAnswer?: Record<string, boolean>;
  /** Labels plugins put on this session (plugin id → badge). */
  pluginBadges?: Record<string, PluginBadge>;
  /**
   * The standing rules a person made on this session (plugin id → rules, oldest first), as
   * the HOST holds them (`answergate.ts`) — never a plugin's own account. Absent = none.
   */
  pluginRules?: Record<string, StandingRule[]>;
  /** Usage-limit state + auto-continue setting for this session. */
  limit?: SessionLimit;
  /** True when the session has been quiet (likely finished its turn). */
  idle?: boolean;
  /** Epoch ms when the session last went idle (turn finished). */
  idleSince?: number;
  /**
   * True once the session's injected claude hooks have reported at least once —
   * i.e. the hook pipe is live, so turn boundaries come from the Stop hook
   * (exact) rather than the PTY-silence heuristic. Backlog readiness/auto-fire
   * trusts this. Absent/false ⇒ the session falls back to silence timing.
   */
  hooked?: boolean;
  /**
   * What this session's SIDE CHANNEL is doing — the backend's own structured
   * channel (a local server's event stream, a plugin's hook sink) that turns and
   * dialogs come from in preference to the screen (`BackendSources`,
   * host `sessions/sidechannel.ts`).
   *
   * Absent = this backend has no side channel, which is every session today
   * that is not on one; never "down". While `up` (and the backend supplies
   * turns) `hooked` means what it always meant — exact turn boundaries are
   * live; while `down` the host has gone back to the screen readers and to
   * silence, and `note` is the sentence saying why, for the phone to print as
   * words rather than a greyed control. Additive; `PROTOCOL_VERSION` unchanged.
   */
  sideChannel?: ChannelHealth;
  /**
   * True while a turn is IN FLIGHT — the CLI is working, not waiting on you.
   * Exact when `hooked` (UserPromptSubmit → Stop), so it stays true through a
   * long, silent tool run; with no hook pipe it's set on real input and cleared
   * by the same silence guess `idle` makes. The reader view (plain DOM — it has
   * no spinner of its own) badges this so a scrollable transcript still tells
   * you whether the agent is busy.
   */
  turnActive?: boolean;
  /** Epoch ms when the current (or most recent) turn started. */
  turnStartedAt?: number;
  /**
   * Agents running under this session right now (host `agents.ts`), newest
   * write first. Absent/empty when none.
   *
   * Separate from `turnActive` because they are separate facts: a BACKGROUND
   * agent keeps working after the main loop's Stop, and a session with two of
   * them in flight is not idle no matter what the turn flag says. Read off the
   * CLI's logs, retired by the parent's own task-notification, so it degrades
   * to an empty list and never to a count nobody can see.
   */
  agents?: SessionAgent[];
  /**
   * True while the CLI reports background SHELLS still running under an idle
   * main loop (a `run_in_background` Bash, a Monitor) — host `agents.ts`'s
   * `readCliStatus`, off the CLI's own `~/.claude/sessions/<pid>.json`. The
   * same "not done yet" as `agents`, without a count: the CLI's record holds
   * none. Absent when none, or when no record could be matched.
   *
   * Kept even now that `shellList` exists: an older phone bundle reads only
   * this, and a host reading a CLI version whose record predates the `pid`
   * needed for `shellList`'s own read still has a true/false fact to publish.
   */
  shells?: boolean;
  /**
   * What is actually running in each of those shells — host `shells.ts`,
   * read off the process table under the CLI's own pid.
   *
   * ABSENT means the host could not read the process table at all (disabled
   * by `WATERPLANE_SHELLS=0`, or the read threw) — a DIFFERENT claim from an empty
   * array, which means the read succeeded and found none. A client must not
   * fold the two together: the first says nothing about this session, the
   * second says it has no background shells right now.
   */
  shellList?: SessionShell[];
  /**
   * A ≤3-word name for this conversation — what the session-tab strip puts on
   * the tab (`web/SessionTabsBar.tsx`).
   *
   * Written ONCE per session by the cheapest call this daemon makes (host
   * `sessions/record.ts` `nameTab`; its whole input is the session's FIRST
   * PROMPT — never the screen, never later prompts), then persisted and never re-derived
   * while it holds one: a tab whose name changes under your thumb is a tab you
   * cannot learn the position of, which is the only thing a tab strip is for.
   *
   * ABSENT until there is something to name, and absent on any refusal — the
   * tab then wears the repo and branch out of `title`, which is what every
   * other surface in this app already calls the session. A wrong title is the
   * version of "a heuristic degrading to a wrong number" that a person taps.
   */
  tabTitle?: string;
  /**
   * Overview label, derived from the session's own prompt history (not AI):
   * the FIRST prompt sent to the session and the LAST one — the phone shows
   * "first … last" so a glance tells you where the session started and where it
   * is now. Truncated. Absent until at least one prompt is recorded.
   */
  firstPrompt?: string;
  lastPrompt?: string;
  /**
   * When the user pins a specific history entry, its text is shown in the
   * "last" slot instead of lastPrompt — because the actual last prompt is often
   * a bare "yes"/"go" that says nothing. `pinnedEntryId` is the pinned
   * HistoryEntry id (so the history view can mark it). Both absent = no pin.
   */
  pinnedPrompt?: string;
  pinnedEntryId?: string;
  /**
   * Percent of the context window still free, parsed from the claude TUI's
   * auto-compact / "context left" indicator (heuristic, like prompt/limit
   * detection). Absent until the CLI has printed a context figure; a stub
   * binary or a version that renders it differently just leaves it unset.
   */
  contextLeft?: number;
  /**
   * Absolute context-window figures in tokens, when the TUI prints them (e.g. a
   * "128k/200k tokens" gauge or a `/context` breakdown): tokens used and the
   * window total. Both absent when only a percentage is available.
   */
  contextUsedTok?: number;
  contextTotalTok?: number;
  /**
   * The same fact as a SHAPE: sixteen readings of how full the window has been,
   * with a tick per compaction and per usage wall (`ContextSpark`).
   *
   * Read off the CLI's own conversation log rather than accumulated from the
   * screen — the screen carries no clock, so a series built from it could not
   * say when anything happened. Recomputed once per turn from an incremental
   * cursor (host `ctxlog.ts`), absent until the CLI has written a turn.
   */
  contextSpark?: ContextSpark;
  /**
   * This session's own budget and where it stands (`sessionbudget.ts`). Absent
   * means none was set. `verdict.state === "unknown"` is a reading that cannot
   * say, never a pass or a trip — `sessionBudgetHeld` is the one predicate.
   */
  budget?: SessionBudgetInfo;
  /**
   * Claude CLI's own conversation UUID (`~/.claude/projects/<dir>/<uuid>.jsonl`).
   * Known up front for fresh sessions (we pass --session-id) and exact resumes;
   * detected lazily for --continue/pick/fork. This is what makes a conversation
   * individually restorable after a restart — `claude --resume <uuid>` — instead
   * of the one-per-directory `--continue`.
   */
  claudeSessionId?: string;
  /**
   * The `claude` version this session's PROCESS runs — `--version` of the
   * binary at spawn, then the `version` its own log records carry from this
   * process on. Compared against `UpdateInfo.current` to offer a restart onto
   * a newer install (`clirestart.ts`). Absent for other backends and until read.
   */
  cliVersion?: string;
  /**
   * The backend's OWN conversation id, for a backend that is not claude —
   * opencode's `ses_…`.
   *
   * **A separate field, and that is the whole point.** Every log reader in this
   * daemon turns `claudeSessionId` into a path under `~/.claude/projects`, so
   * an opencode id placed there is a reader pointed at a file that will never
   * exist — a plausible wrong answer of exactly the kind this repo refuses.
   * `backends/opencode.ts` declined to carry an id at all rather than put one
   * in that field; this is the field it was waiting for.
   *
   * Absent until DISCOVERED: an id is adopted only when exactly one candidate
   * matches, and stays absent when zero or several do.
   */
  backendSessionId?: string;
  createdAt: number;
  /**
   * When the CLI last wrote a turn for this conversation — the mtime of its own
   * conversation log.
   *
   * The field behind "how long has this session been untouched", and separate
   * from `idleSince` on purpose. `idleSince` is stamped when the daemon decides
   * a turn ended, four seconds after any output, so a tmux re-attach repainting
   * every pane resets it on every session at once: after a host restart it means
   * "since the restart", and "close everything quiet for over 2h" answered zero
   * across sixty-five sessions nobody had opened since the day before.
   *
   * This comes from a clock we do not own — the CLI writes the log when it does
   * work — so it survives a restart and cannot be moved by anything cosmetic.
   * Absent until the conversation id is known and the log exists.
   */
  lastTurnAt?: number;
  /**
   * Manual "prima interest" flag — the user pins a session to come back to.
   * Set/cleared only by the user (session.star); persisted durably (keyed by
   * conversation id) so it survives host restarts and session resumes.
   */
  starred?: boolean;
  /**
   * True when a turn finished (coding done) while no client was viewing this
   * session — i.e. "something new happened since you left". Set server-side on
   * turn-end when unwatched, cleared automatically the next time a client
   * attaches. Surfaces as the "new" annotation on a starred row.
   */
  newActivity?: boolean;
  /**
   * This session handed a job to a peer desktop and is waiting for its report
   * (`peer.ts`). Additive: an older phone draws no tag. Absent = not waiting.
   */
  peerWait?: {
    peer: string;
    jobId: string;
    state: PeerJobLocalState;
    since: number;
    peerSessionId?: string;
    /** The peer's address base, so the phone can find the matching saved host. */
    peerBase?: string;
  };
  /**
   * Every job this session handed to a peer, open or settled (the asker's ledger, `peers/jobs.ts`),
   * oldest first — the session's facts list one line each (`peerJobLine`) and its cost is shown
   * SPLIT by desktop (`peerSpendSplit`). `peerWait` is only the one it is waiting on. Additive;
   * absent = this session never delegated.
   */
  peerJobs?: PeerJobSummary[];
  /**
   * On the PEER: this session exists because another desktop handed it a job
   * (`peerJobOriginText` — "job from mac · <asking session> · <label>"). Read off the job
   * worktree's marker, so it is true of any session opened there. Absent = not a job's session.
   */
  peerJob?: PeerJobOrigin;
}
