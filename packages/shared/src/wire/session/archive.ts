import type { LaunchOpts } from "./launch.js";

/** An image that appeared in a session's worktree during the turn. */
export interface NewImage {
  name: string;
  /** Worktree-relative path (forward slashes). */
  relPath: string;
  mtime: number;
}

/** A session descriptor persisted across host restarts (for resume). One entry
 *  PER CONVERSATION (keyed by claudeSessionId), not per directory — several
 *  sessions in the same repo each stay individually resumable after a restart. */
export interface RecentSession {
  cwd: string;
  title: string;
  lastActive: number;
  /** Claude conversation UUID → resume THIS conversation (`--resume <id>`).
   *  Absent on legacy entries; those fall back to per-directory `--continue`. */
  claudeSessionId?: string;
  /**
   * The BACKEND'S OWN conversation id, for a row that is not claude's
   * (opencode's `ses_…`) — so reopening this row carries on THIS conversation
   * (`--session <id>`) instead of whichever one the directory's `--continue`
   * happens to land on.
   *
   * A second field rather than a second meaning for `claudeSessionId`: every
   * log reader in the daemon turns that one into a path under
   * `~/.claude/projects`, and an opencode id there is a reader pointed at a file
   * that will never exist. Absent whenever the host never discovered an id, in
   * which case the reopen degrades to `--continue` exactly as it did before.
   */
  backendSessionId?: string;
  /** Launch flags the session ran with, so a resume restores model/effort/etc. */
  launch?: LaunchOpts;
}

/** A session that was closed (killed/exited) — kept in a short stack so a
 *  mis-tap on the close button can be undone, newest-first. */
/**
 * One conversation the `claude` CLI wrote for a directory — the ARCHIVE row.
 *
 * Not a session: there is no PTY, no boot id and no live state. The only thing
 * it needs to be resumable is `id`, which is the conversation uuid the log file
 * is named after (`--resume <id>`).
 */
export interface ArchivedConversation {
  /** Claude conversation uuid = the jsonl basename. */
  id: string;
  cwd: string;
  /** First user prompt, one line. Empty when the conversation holds no prompt —
   *  a session opened and closed without being typed into. */
  title: string;
  /** Log mtime = when the conversation was last active. */
  mtime: number;
  size: number;
}

export interface ArchiveListing {
  cwd: string;
  /** Rows matching the query (or all of them), across every page. */
  total: number;
  offset: number;
  rows: ArchivedConversation[];
  /** Conversations on disk for this directory, before any query. */
  scanned: number;
}

export interface ClosedSession {
  id: string;
  cwd: string;
  title: string;
  closedAt: number;
  /** Launch flags the session ran with, so a reopen restores model/effort/etc. */
  launch?: LaunchOpts;
  /** Claude conversation UUID → reopen resumes THIS conversation (`--resume <id>`),
   *  not just the directory's most recent (`--continue`). */
  claudeSessionId?: string;
  /**
   * The BACKEND'S OWN conversation id, for a row that is not claude's
   * (opencode's `ses_…`) — so reopening this row carries on THIS conversation
   * (`--session <id>`) instead of whichever one the directory's `--continue`
   * happens to land on.
   *
   * A second field rather than a second meaning for `claudeSessionId`: every
   * log reader in the daemon turns that one into a path under
   * `~/.claude/projects`, and an opencode id there is a reader pointed at a file
   * that will never exist. Absent whenever the host never discovered an id, in
   * which case the reopen degrades to `--continue` exactly as it did before.
   */
  backendSessionId?: string;
  /** True when the session is only BACKGROUNDED — still running live in tmux, so a
   *  reopen re-attaches the same process (in-flight turn intact) instead of a fresh
   *  `--continue`. False/absent ⇒ genuinely ended. */
  alive?: boolean;
  /**
   * With `alive`: why this host did not take the still-running session back
   * after a restart — its backend comes from a plugin that is not running
   * ("…runs on "stubcli", which the plugin Stub CLI registers; switch it on…").
   * The session is adopted as soon as that backend registers. Absent otherwise.
   */
  unadopted?: string;
  // ── What it WAS and why it ENDED (all optional; absent = the host did not
  //    know — an older row, or a close no code path names — never a guess).
  //    Built by `sessions/roster.ts`'s `closedRowOf`; strings clipped to
  //    `CLOSED_TEXT_CAP` (`shared/closed.ts`) so the persisted stack stays small.
  /** Why the session ended. See `ClosedBy`. */
  closedBy?: ClosedBy;
  /** `closedBy` "exited"/"limit": the process's own exit code, when node-pty
   *  reported one. */
  exitCode?: number;
  /** `closedBy` "exited"/"limit": the signal number it died of, when it did. */
  exitSignal?: number;
  /** `closedBy` "limit": the session the host reopened this conversation as
   *  (`doResurrect`) — written onto the row when that reopen happens. */
  resumedAs?: string;
  /** How the session was OPENED. See `SessionOriginKind`. */
  kind?: SessionOriginKind;
  /** The intent/backlog row that opened it (`kind` backlog/schedule/agent/fanout,
   *  or a `resurrect` of one of those). */
  itemId?: string;
  /** That row's display name at open time (`itemHeadline`, else its first step). */
  itemLabel?: string;
  /** That row's lifecycle at close time — ONLY a settled one (done/failed/
   *  canceled); a row still running when its session ended says nothing here. */
  itemState?: "done" | "failed" | "canceled";
  /** With `itemState`: the row's own `result.ok` / one-line `result.detail`. */
  itemOk?: boolean;
  itemDetail?: string;
  /** `kind` resurrect/fork: the session id this one continued. */
  fromSession?: string;
  /** `SessionInfo.createdAt` — so a duration is `closedAt - openedAt`. */
  openedAt?: number;
  /** The last turn this session is known to have taken: the CLI log's last
   *  turn (`lastTurnAt`), else the last recorded prompt's capture. */
  lastActiveAt?: number;
  /** Prompts this host recorded into it (`HistoryEntry`s — phone, queue,
   *  automation). A FLOOR: words typed at the desktop keyboard are not counted,
   *  and the history keeps at most 200. Absent when none were recorded. */
  turns?: number;
  /** First / last recorded prompt, one line, clipped. */
  firstPrompt?: string;
  lastPrompt?: string;
  /** The ≤4-word tab name, when one was derived. */
  tabTitle?: string;
  /** The model it was running (`SessionInfo.model` — the running one once a
   *  turn named it, else the launch flag). */
  model?: string;
}

/**
 * Why a session ended, as far as the host can tell them apart:
 *
 * - `you`       — a person closed it (× / close / kill / background-detach).
 * - `replaced`  — a person's relaunch (`replaceSessionId`) closed it to open
 *                 its replacement.
 * - `auto-done` — the backlog's linger sweep: its item said close-when-done
 *                 and it sat idle past the linger after the work finished.
 * - `auto-slot` — reaped early to free an automatic-session slot for a waiting
 *                 item (also only close-when-done sessions).
 * - `exited`    — the CLI process ended on its own (/exit, crash, signal);
 *                 `exitCode`/`exitSignal` say how when known.
 * - `limit`     — it exited at a usage limit; the host reopens it at the reset
 *                 when auto-continue is on (`resumedAs` once it has).
 *
 * There is no "host shutdown" value: a daemon restart leaves tmux sessions
 * running (re-attached on boot).
 */
export type ClosedBy = "you" | "replaced" | "auto-done" | "auto-slot" | "exited" | "limit";

/**
 * How a session was opened:
 * `hand` (a person's create on the wire), `fork` (a person's fork of another
 * session), `backlog` (a backlog item's own session, or the repo's backlog
 * session), `schedule` (a scheduled/timed row), `agent` (a prompt an agent
 * posted for later), `fanout` (one repo of a fan-out), `resurrect` (the host
 * reopening a session that exited at a usage limit).
 */
export type SessionOriginKind = "hand" | "fork" | "backlog" | "schedule" | "agent" | "fanout" | "resurrect";

/** What the HOST remembers about how one live session was opened — carried
 *  onto its closed row. Host-side (and in the tmux `live/` record), not on
 *  `SessionInfo`. */
export interface SessionOrigin {
  kind: SessionOriginKind;
  itemId?: string;
  itemLabel?: string;
  fromSession?: string;
}

/**
 * One recorded prompt sent to a session, plus the (ANSI-stripped) terminal
 * output captured for that turn. Built by the host as prompts are submitted and
 * the turn goes idle; surfaced in the per-session History view.
 */
export interface HistoryEntry {
  /** Stable id for this entry. */
  id: string;
  /** prompt = compose-bar message, command = slash command, backlog = auto-fed item. */
  kind: "prompt" | "command" | "backlog";
  /** The text sent (composer body / slash command / backlog instruction). */
  text: string;
  /** ms epoch when the prompt was sent. */
  sentAt: number;
  /** ANSI-stripped output captured between submit and turn-idle (set once idle). */
  output?: string;
  /** ms epoch when output capture finalized. */
  outputAt?: number;
}

/**
 * Which store a session search reads.
 *
 * Three, because "what did I ask for" is a different question from "what came
 * back", and only one of the three answers it. `history` scans the prompt AND
 * the output of every turn, so a common word matches the CLI's own reply
 * hundreds of times and buries the handful of lines a person actually typed.
 *
 *   recent  = the current rendered terminal text (what is on screen now).
 *   history = the persisted prompt + output of every recorded turn.
 *   prompts = the persisted prompts ALONE — what was sent INTO the session
 *             (composer message, slash command, filed backlog item), never the
 *             CLI's output.
 */
export type SessionSearchScope = "recent" | "history" | "prompts";

/** One matched line plus a couple of context lines each side, for the search sheet. */
export interface SessionSearchMatch {
  /** Context lines immediately above the hit (oldest first). */
  before: string[];
  /** The line containing the match. */
  hit: string;
  /** Context lines immediately below the hit. */
  after: string[];
  /** For a "history"/"prompts"-scope hit: the turn it came from (label + when). */
  turn?: { kind: HistoryEntry["kind"]; text: string; sentAt: number };
}

/** Per-session search results: which session matched, plus its (capped) hits. */
export interface SessionSearchResult {
  id: string;
  title: string;
  /** Repo/worktree the session runs in (basename of cwd) — a grouping label. */
  repoLabel: string;
  cwd: string;
  running: boolean;
  matches: SessionSearchMatch[];
  /** Total hits found before per-session truncation (matches.length may be smaller). */
  total: number;
}
