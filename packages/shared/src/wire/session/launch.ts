/**
 * Which screen the person was looking at when they sent a prompt.
 *
 * A fact only the phone has, and it is here because the host cannot infer it:
 * `read` unmounts the xterm, so nothing about the socket, the PTY or the
 * rendered screen distinguishes a send composed over the reader from one
 * composed over the live grid. It rides the send purely so the sent log can be
 * ASKED whether the two differ — deliveries composed in the reader came back
 * unconfirmable at a rate this app had no way to measure, and a hunch about
 * which view was open is not something `deliver.ts` may act on.
 *
 * Absent is normal and means nobody said (every automatic send, and any client
 * one version behind). It is never read as `term`.
 */
export type SendView = "term" | "read";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";

/** Launch options for a `claude` session. Empty fields use Claude Code defaults. */
export interface LaunchOpts {
  model?: string;            // alias (opus/sonnet/haiku/fable) or full id
  effort?: Effort;
  permissionMode?: PermissionMode;
  /** Start with --remote-control so the session is also steerable from claude.ai. */
  remoteControlled?: boolean;
  /**
   * Which `BackendInfo.id` to launch (see `wire/backend.ts`). Absent means
   * `claude` — the only backend that existed before this field did, and the
   * one every launch defaulted to. Additive: an old phone never sends this,
   * so an old launch is indistinguishable from launching claude explicitly.
   */
  backend?: string;
}

/** A `claude` process running on the host outside waterplane (started in a terminal). */
export interface ExternalSession {
  pid: number;
  cwd: string;
  /** Process start time (epoch ms) if resolvable. */
  startedAt?: number;
}

/**
 * Usage-limit state + auto-continue for one session. Rides on SessionInfo so the
 * overview can show, per session, that it's blocked on a Claude usage limit and
 * whether/when waterplane will send "continue" by itself.
 */
/**
 * How the resume queue releases sessions once a usage limit lifts.
 *
 * The queue exists because a limit is an ACCOUNT fact: every session working at
 * that moment blocks on the same wall, so firing them all at once spends N
 * bounded attempts proving what one attempt proves. That argument covers the
 * FIRST resume of a wave — the probe — and nothing after it. Once one session
 * has provably started a turn again, the limit demonstrably has lifted, and
 * whether the rest should follow one at a time or together is a question about
 * the WORK, not about the account:
 *
 *   - `one`  — strictly serialized: the next resume waits for the previous
 *              session's verdict. The safe default, and the only mode that
 *              cannot spend the fresh window on five sessions at once.
 *   - `repo` — one at a time per repo DIRECTORY (`serialGroup`), different
 *              worktrees in parallel. The same rule the send queue's
 *              `waterplane.serialSessions` applies to queued opens: two agents must
 *              not edit one checkout, two worktrees are not each other's
 *              business.
 *   - `all`  — everything waiting resumes, paced only by the breath between two
 *              resumes. For a window worth spending broadly.
 *
 * A probe is always alone regardless of mode, and a resume that comes back
 * still blocked resets the wave: the next one probes again.
 */
export type LimitResumeMode = "one" | "repo" | "all";

export interface SessionLimit {
  /** True while the session appears blocked on a usage limit. */
  blocked: boolean;
  /** Epoch ms when the block started, or 0. */
  blockedSince: number;
  /** Epoch ms when the limit is expected to reset (parsed from the banner), or null when unknown. */
  resetAt: number | null;
  /** Epoch ms of the next scheduled auto-continue attempt, or null when none is scheduled. */
  nextAttemptAt: number | null;
  /** Continue attempts sent since this block started. */
  attempts: number;
  /** The block is a WEEKLY limit — its banner prints a bare time with no date,
   *  so the reset lands days off; auto-continue attempts promptly instead of
   *  parking on the unreliable parsed reset (an upgraded plan continues now). */
  weekly: boolean;
  /**
   * The wall is a SPEND wall (API-key / cloud account out of credit, or a spend
   * limit), not a plan window. `resetAt` is then the active dollar calendar
   * period's computed reset (or an instant the message printed), and null means
   * NOBODY knows when it lifts: the host holds the session's automatic work and
   * does not retry - it needs the person. Absent = a plan window, as ever.
   */
  spend?: boolean;
  /** Effective auto-continue for THIS session (override ?? global switch). */
  autoContinue: boolean;
  /** Per-session override; null = inherit the global switch. */
  autoContinueOverride: boolean | null;
  /**
   * 1-based place in the host's RESUME QUEUE, or null when this session isn't in
   * it (not blocked, or auto-continue off for it). Several sessions routinely
   * hit the same limit and therefore carry the SAME reset time, so without a
   * queue every one of them types "continue" at the same instant: they race for
   * a window that only one can have, all re-block, and each burns one of its
   * bounded attempts proving it. The host resumes them one at a time; this says
   * where in that line a session stands, and the order is steerable.
   */
  queuePos: number | null;
  /** True for the ONE session currently being resumed (its continue was typed;
   *  the queue is waiting to see whether it took). */
  resuming: boolean;
  /** True when the user pushed this session to the front of the resume queue. */
  first: boolean;
}

/**
 * The `/login` flow, as far as the phone can act on it.
 *
 * The CLI prints a 300-character OAuth URL and then waits for the code that
 * link hands back. On a phone the terminal GRID breaks that URL across six rows
 * with nothing marking them as one string, so it is untappable, un-copyable and
 * far too long to retype — the session reads as `awaitingInput` for ever and
 * the only honest advice is "go to the desk". The host rejoins it
 * (`@waterplane/shared`'s `findUrls`, host `login.ts`) and publishes it here, which
 * is what makes it a button.
 *
 * Two fields because they are two different next actions, and they do not
 * always both apply: a link with no input yet is "open this", an input with no
 * fresh link is "paste what you already have".
 */
export interface SessionLogin {
  /** The sign-in URL, reassembled across however many rows it was wrapped into. */
  url: string;
  /** True while the CLI sits on its paste-the-code input. */
  awaitingCode: boolean;
  /** Epoch ms the link was first seen — a login link is short-lived, and a stale
   *  one opens a page that refuses. */
  at: number;
}

/**
 * A link a SHELL session wants opened — a CLI login (`gcloud auth login`, `gh
 * auth login --web`, `firebase login --no-localhost`, a device-flow code page)
 * that would otherwise sit on the desktop's terminal as a URL nobody can tap.
 *
 * Two sources, one list (host `sessions/links.ts` merges them):
 *  - `"browser"` — the CLI called `$BROWSER` (every shell session's points at a
 *    shim that POSTs the URL to the host on loopback). Exact, and kept 10 min
 *    whether or not it is still on screen.
 *  - `"screen"` — the URL was read off the rendered grid. Retired when it
 *    scrolls off or the session exits.
 *
 * Every field but `url`/`source`/`at` is ABSENT when the host could not say —
 * a code is only ever a property of a link seen beside it, never guessed.
 */
export interface ShellLink {
  /** The URL, rejoined across however many grid rows it was wrapped into. */
  url: string;
  /** Grid row it was read from (screen-sourced only). */
  line?: number;
  /** A one-time / device code printed beside the link, when one was. */
  code?: string;
  /** An `http://localhost` / 127.0.0.1 link — it points at the DESKTOP, so the
   *  phone says so in words instead of offering to open it. */
  local?: boolean;
  source: "screen" | "browser";
  /** Epoch ms the link was first seen (kept across repaints). */
  at: number;
}

/**
 * One agent running UNDER a session — the CLI's Task/Agent tool.
 *
 * A background agent outlives the turn that launched it: the main loop's Stop
 * hook fires, `turnActive` goes false, and two agents keep working for another
 * six minutes. The terminal says so in its footer; the reader, which has no
 * terminal, said "idle — nothing running". Host `agents.ts` reads these off the
 * CLI's own logs so a view with no grid in it can still say what is happening.
 */
export interface SessionAgent {
  /** The CLI's agent id (`subagents/agent-<id>.jsonl`). */
  id: string;
  /** The Agent call's `description` — "Fable review: design and API". */
  what: string;
  /** `subagent_type`, for a row with the width for it. */
  type?: string;
  /** The model the agent was launched on ("fable"), when the meta file says. */
  model?: string;
  /** Epoch ms the agent was launched. The phone counts elapsed off this, so a
   *  ticking clock costs no broadcasts. */
  startedAt: number;
  /** Epoch ms of the agent log's last write — what freshness is judged on. */
  lastWriteAt: number;
  /** The tool it last called, or the last thing it said. Absent when the log
   *  held nothing we recognised — never a filler word. */
  doing?: string;
}

/**
 * A question the agent ended its turn on, in prose. Text only: there is nothing
 * to tap, the answer is whatever you would have typed.
 */
export interface SessionAsk {
  /** The asking line, as the agent wrote it (capped for a row / a push body). */
  text: string;
  /** Epoch ms of the turn end that raised it. */
  at: number;
}

/**
 * One background shell running under a session — a `run_in_background` Bash
 * call or a Monitor, read off the process table plus (best-effort) the CLI's
 * own conversation log.
 *
 * `SessionInfo.shells` already says a session HAS these (the CLI's own
 * `~/.claude/sessions/<pid>.json` status, `agents.ts`'s `readCliStatus`); this
 * is what each one actually IS, which that record does not say at all — no
 * count, no command, no age. The wrapper process the CLI launches
 * (`/bin/zsh -c source …/shell-snapshots/snapshot-… && eval '<CMD>' </dev/null
 * && pwd -P >| …`) is its own process group, a direct child of the CLI's pid,
 * with no tty — the one shape host `shells.ts` reads off `ps` — and everything
 * below `< /dev/null` in it is the CLI's own book-keeping, never the words a
 * person typed.
 *
 * Every field but `pid`/`startedAt`/`command`/`cpuMs`/`workers` degrades to
 * ABSENT rather than a guess: the transcript join that supplies
 * `description`/`taskId`/`launch` may simply fail to match (a command edited
 * before it ran, a log truncated past the tail this reads), and `outputAt`
 * is only ever set once the file it names has bytes in it — a `0`-byte output
 * file is the command redirecting itself, never "read and empty".
 */
export interface SessionShell {
  /** The wrapper shell's own pid — also its pgid, and what a kill targets
   *  (`killShellGroup`, `shell.kill`). */
  pid: number;
  /** Epoch ms the wrapper started, derived from `ps`'s own `etime` column at
   *  read time (so it drifts by at most a poll interval, never truly exact). */
  startedAt: number;
  /** The eval'd command text — what a person actually asked to run — unescaped
   *  out of the wrapper's `ps` command line and capped at 240 characters. */
  command: string;
  /** The Bash tool call's own `description`, joined off the CLI's conversation
   *  log by matching this command's text. Absent when no record joins. */
  description?: string;
  /** The CLI's own background-task id (`Command running in background with
   *  ID: <taskId>` / `… was moved to the background (ID: <taskId>)`), from the
   *  same join. Names the `tasks/<taskId>.output` file `outputAt` reads. */
  taskId?: string;
  /**
   * Whether the CLI ran this in the background because it was ASKED to
   * (`run_in_background: true` on the Bash call) or because the command
   * overran its foreground timeout and the CLI moved it there on its own.
   * Absent when the join could not say.
   */
  launch?: "background" | "timeout";
  /** CPU time consumed so far, in ms — the wrapper plus every live descendant
   *  in its process group, at the moment of the read. */
  cpuMs: number;
  /** Epoch ms `cpuMs` last CHANGED, tracked across polls. Absent until a
   *  second reading of this pid has been taken — a shell seen only once has
   *  nothing to compare against, which is the honest "can't tell yet". */
  cpuMovedAt?: number;
  /** Epoch ms the task's output file was last seen to GROW, only ever set once
   *  its size is above zero — most background commands redirect their own
   *  output, so a 0-byte file is silence by design, never "read and empty". */
  outputAt?: number;
  /** That file's size in bytes, riding with `outputAt`. */
  outputBytes?: number;
  /** Live descendants in the wrapper's process group that are not the wrapper
   *  itself and not a sleep/pipeline utility (`sleep`, `tail`, `head`, `zsh`,
   *  `sh`, `bash`, `cat`, `grep`, `wc`, `cut`) — the REAL workers. Zero means
   *  this shell is, right now, only a shell waiting on something. */
  workers: number;
  /**
   * This command runs `pgrep -f "<literal pattern>"` (or single-quoted) as its
   * own exit condition, and that exact pattern is — by construction — part of
   * THIS process's own command line (`ps` renders the whole eval'd script as
   * one string), so the search can never come back empty and the loop can
   * never end on its own. Never set for a pattern using `$`/regex
   * metacharacters, since a real regex might legitimately not match its own
   * substring and claiming it would be a heuristic asserting a wrong number.
   */
  selfMatch?: true;
  /** The command names a long-running-by-design process (an emulator, a dev
   *  server, `--watch`, `tail -f`, …) — quiet is not a concern for these, and
   *  the words say so instead of reading as stuck. */
  serverLike?: true;
  /**
   * This wrapper is the CURRENT turn's own command, not a background shell —
   * a live FOREGROUND Bash call has the exact same `ps` shape as a
   * backgrounded one (`ppid` the CLI, its own pgid, the snapshot-zsh
   * wrapper), so the discriminator alone cannot tell them apart. Set when
   * the conversation-log join could not prove this was ever launched to the
   * background (`launch` present) AND the CLI's own record says the main
   * loop is not idle (status `"shell"`) — an idle main loop means every
   * wrapper left under it is, by construction, a background survivor.
   * `shellsSummary`/`shellCloseWords` never count a foreground shell, and a
   * kill on one is refused: it is the running turn itself, not something a
   * person can stop from here.
   */
  foreground?: true;
}

/**
 * ONE background shell, read on demand (`GET /api/shell?id=&pid=`) — what the
 * shells sheet shows when a row is opened. `SessionShell.command` rides every
 * `SessionInfo` and is capped at 240 chars for that reason; this is asked for
 * once, by a person, so it carries the whole command and the tail of what the
 * shell printed.
 */
export interface SessionShellDetail {
  pid: number;
  /** The eval'd command, uncapped. */
  command: string;
  description?: string;
  /** The tail of the CLI's own `tasks/<taskId>.output` for this shell, ANSI
   *  stripped. Absent when no transcript record joins (no taskId) or the file
   *  is missing — `outputWhy` then says which. `""` = the file is there and
   *  empty, which for a command that redirects its own output is the norm. */
  output?: string;
  /** Sentence for an absent `output`. */
  outputWhy?: string;
  /** The output file's whole size — more than `output` holds when `truncated`. */
  outputBytes?: number;
  /** Epoch ms the output file was last written. */
  outputAt?: number;
  /** `output` is only the last part of the file. */
  truncated?: true;
  /** Where the output file is on the desktop, for a person who wants the rest. */
  outputPath?: string;
}
