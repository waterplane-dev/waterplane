// Host → client: the session stream and its acks, and the app's own state. Member list of `HostMessage` in `../messages.ts`. 

import type { BackendInfo } from "../backend.js";
import type { AutoSlotFacts } from "../../intent.js";
import type { LaunchIntent } from "../../launch.js";
import type { SentCommand } from "../sent.js";
import type { DecisionLogEntry, PluginView } from "../../plugin.js";
import type { UpdateInfo } from "../repo.js";
import type { ClosedSession, HistoryEntry, NewImage, OpenDelivery, PermissionMode, RecentSession, SessionInfo, SessionSearchResult, SessionSearchScope, SessionShell } from "../session.js";
import type { StreamEndCause } from "../../stream.js";
import type { UsageInfo, UsageReading } from "../telemetry.js";
import type { BacklogItem } from "../work.js";

/** Trust tier of a socket's remote address (see host `net.peerKind`). */
export type PeerKind = "loopback" | "tailscale" | "lan" | "public" | "unknown";

/** LAN-password gate state, tailored to the asking socket. */
export interface AuthState {
  /** A password is configured. */
  enabled: boolean;
  /** Also gating Tailscale peers (defense-in-depth toggle). */
  gateTailscale: boolean;
  /** This socket may set/change/clear the password (trusted path only). */
  canManage: boolean;
}

export type HostCoreMsg =
  // `httpsUrl` is the URL `tailscale serve` actually fronts us with, port and
  // all — NOT `https://<tailscaleDns>`, which assumes the listener is on 443 and
  // points at whatever else is served there when it isn't. null = not fronted.
  // `hostId`/`hostName` (optional, additive): which desktop this is, so a
  // multi-host phone can tell a socket landed on the host it meant; `deviceId`
  // is the paired-device ledger row this socket authenticated as. Absent on
  // an older host — never inferred. `startedAt`/`readyAt` (optional): see
  // `host.restarting` below.
  | { t: "welcome"; protocol: number; bootId: string; tailscaleIp: string | null; tailscaleBin: string | null; tailscaleDns: string | null; httpsUrl: string | null; lanIps: string[]; port: number; root: string; tmux: boolean; clientKind: PeerKind; auth: AuthState; hostId?: string; hostName?: string; deviceId?: string; startedAt?: number; readyAt?: number }
  /**
   * The daemon is going down (SIGTERM/SIGINT — `npm run restart` is one),
   * broadcast before the flush. Additive: an old phone ignores it. With
   * `welcome`'s `startedAt` (process start) and `readyAt` (sessions
   * re-attached, the moment it can answer) the phone can say "the desktop is
   * restarting", for how long, and when it was back — a restart is otherwise
   * a few missed pings in a graph that has no time axis.
   */
  | { t: "host.restarting"; at: number }
  /** Sent to a gated socket that presented no valid token, right before close. */
  | { t: "authRequired"; enabled: boolean; kind: PeerKind }
  /** Current auth state (after a management change, or on request). */
  | { t: "auth.state"; auth: AuthState }
  | { t: "session.list"; sessions: SessionInfo[] }
  /**
   * Every backend this host can launch (`wire/backend.ts`), sent on hello.
   *
   * Additive — an unknown `t` is ignored and never thrown on either end, on
   * BOTH the phone and the host, which is exactly why this needs no
   * `PROTOCOL_VERSION` bump: an old phone that has never heard of "backends"
   * drops the frame and stays on the claude-only picker it already had; a new
   * phone talking to an old host simply never receives it, and the picker it
   * would have driven must not render at all in that case (not greyed —
   * absent), because a host that never sent this list never agreed to honor
   * a backend id the phone might otherwise send back on `LaunchOpts.backend`.
   */
  | { t: "backends"; list: BackendInfo[] }
  | { t: "session.created"; session: SessionInfo }
  | { t: "session.updated"; session: SessionInfo }
  // Raw PTY output (base64 of the utf-8/binary chunk).
  // `seq` (when present): the session's cumulative output offset AFTER this chunk.
  //   The client records it per session so a later attach can pass it as
  //   `resumeSeq` and get only the delta. Monotonic; survives the scrollback ring
  //   dropping its front (it counts total bytes ever emitted, not buffer length).
  // `full` (when true): this frame is a full scrollback replay (fresh/first attach
  //   or a resume point the host no longer retains) — the client resets its
  //   terminal before writing it. Absent/false ⇒ append (live output or a delta).
  | { t: "pty"; id: string; dataB64: string; seq?: number; full?: boolean }
  | { t: "session.exit"; id: string; code: number | null }
  /** Answer to `shell.kill`: did the group actually stop? `reason` is the
   *  refusal in words (`killShellGroup`'s wording) — never a code, there is no
   *  vocabulary to translate one into that would say more. */
  | { t: "shell.killed"; id: string; pid: number; ok: boolean; reason?: string }
  /**
   * A session closed, and how many of its background shells stopped with it —
   * CLAUDE.md's decision that closing a session stops them fully, no "leave
   * running" option. Sent once, right after the session itself is gone
   * (`sessions/drive.ts`'s `remove()`/`kill()`), so a client that asked for the
   * close does not have to guess whether an orphan survived it.
   *
   * `shellsLeft` is never expected to be nonzero — every group is stopped
   * BEFORE the tmux session is killed — but it is counted rather than assumed,
   * because a group that refused to die (`killShellGroup`'s own SIGKILL
   * already spent) is exactly the case a silent 0 would hide.
   */
  | { t: "session.closed"; id: string; shellsStopped: number; shellsLeft: number }
  /** Delivery receipt for a session.input that carried an ackId. `ok` is true
   *  only when the bytes reached a live, running PTY; false means the session was
   *  gone/not-running so the client must recover the text (it wasn't delivered).
   *
   *  For a `submit` send the bar is higher and `state` says exactly where it got
   *  to, because "not delivered" covers three very different situations and the
   *  client must act differently in each:
   *    ok           — typed, echoed, and the turn started. Nothing to recover.
   *    notready     — the session never reached its prompt; provably NOTHING was
   *                   typed, so this is the one failure that is safe to retry
   *                   automatically (`retryable`, and the host does not remember
   *                   the verdict, so a re-send gets a real second attempt).
   *    unconfirmed  — written but never seen on screen. MUST NOT be auto-retried:
   *                   retrying what may already be there is how the same prompt
   *                   ends up stacked five times.
   *    unsubmitted  — provably in the composer, but every Return was swallowed.
   *                   The text is there, one keypress from running: say so, never
   *                   retype.
   *    stale        — an ANSWER (`expectPrompt`) whose question is no longer the
   *                   one on screen. Nothing was written, and nothing should be:
   *                   the keystroke meant something specific about a box that is
   *                   gone. Never retryable — a retry can only get staler. The
   *                   client surfaces it so the answer isn't silently dropped.
   *    rescued      — the session was gone, and the host KEPT the words: they are
   *                   a work item in that repo now, on disk, and will run when
   *                   the repo next has a session. `ok: false` because the
   *                   delivery this ack answers did not happen — but the client
   *                   must drop the row rather than retry it, because retrying
   *                   would post the same prose a second time. Only produced
   *                   when `session.input` carried a `cwd`.
   *    forked       — the words were a bare `/fork [title]` to a claude session,
   *                   and the host did NOT type them: it opened a new tab forked
   *                   from that conversation instead (`shared/slash.ts`'s
   *                   `slashForkTitle` says why). `ok: true`, nothing to recover;
   *                   `reason` carries the sentence saying so, and the asking
   *                   socket is sent `session.focus` for the new tab. Additive:
   *                   an older client reads it as an ordinary `ok`. */
  | { t: "input.ack"; id: string; ackId: string; ok: boolean; reason?: string;

      state?: "ok" | "notready" | "unconfirmed" | "unsubmitted" | "stale" | "rescued" | "forked"; retryable?: boolean }
  /**
   * Answer to `input.settle`, one result per requested ackId (unknown ackIds
   * are answered too, as `unknown` — a client waiting on a reply must never be
   * left hanging by a row the host has no opinion about).
   *
   *   landed    — the CLI's own conversation log has this prompt. It RAN; the
   *               queue row is stale and can go.
   *   composer  — the text is on the rendered screen right now, unsent. Still
   *               one keypress from running, so still the user's call.
   *   absent    — the log is readable, and neither it nor the screen has the
   *               text: it never ran and nothing is holding it, so re-sending
   *               is now provably safe (which the original verdict could not
   *               say). `alive` decides whether there is anywhere to send it.
   *   unknown   — still unreadable (no conversation log, no live screen). Must
   *               never be turned into an action.
   *
   * `handled` means the HOST has already acted on this row (it proved the
   * prompt never ran and re-sent it itself). A client must not act on the
   * verdict then — only display it: a second re-send from this side would be a
   * second copy of a prompt that is already on its way. It rides here because
   * the alternative is two independent re-senders agreeing by luck; the host's
   * own `delivery.list` row carries the full story.
   */
  | { t: "input.settled"; results: { ackId: string; verdict: "landed" | "composer" | "absent" | "unknown"; alive: boolean; handled?: boolean }[] }
  /**
   * Every delivery this host could not confirm, open or resolved (newest
   * first). Sent on hello, on `delivery.list`, and broadcast on every change.
   *
   * `input.settled` above is the same question asked BY THE PHONE, and that is
   * the difference that matters: it needs a client that is awake, connected,
   * and still holding the row — on the link this app exists for, exactly the
   * conditions that fail. These rows are the host's own copy of the question,
   * re-asked on a sweep with nobody attached, so the answer exists before
   * anyone comes back to collect it.
   */
  | { t: "delivery.list"; items: OpenDelivery[] }
  /**
   * One open delivery reached a terminal verdict. Pushed the moment it does, so
   * an attached client can retire or restate its row without waiting for the
   * next list — the `pull.new` / `sent.new` shape, and for the same reason.
   *
   * The item is the whole row: a client that has never seen it (it was opened
   * and resolved while the phone was off) can render it from this alone.
   */
  | { t: "delivery.settled"; item: OpenDelivery }
  /** Receipt for a `backlog.add` that carried an ackId — the durable-queue twin
   *  of `input.ack`. Idempotent: a repeat of a known ackId is re-acked and the
   *  item is NOT added a second time. */
  | { t: "backlog.ack"; ackId: string; ok: boolean; itemId?: string; reason?: string }
  /** Receipt for a durable OP that carried an ackId — `session.create`
   *  (including its `replaceSessionId` relaunch form), `fanout.run`,
   *  `fanout.followup`, `build.run`. Same
   *  idempotence contract as `input.ack`/`backlog.ack`: the host remembers the
   *  verdict per ackId, so a client that never saw this receipt can re-send the
   *  message and get the ORIGINAL answer back instead of a second session /
   *  second 12-repo sweep / second build.
   *
   *  `ok` means ACCEPTED AND STARTED, not finished — the thing it started
   *  reports its own progress (`session.created`, `fanout.run`, `build.run`).
   *  `sessionId` / `runId` name what it produced, so a retry can be reconciled
   *  with state the client may already be showing.
   *
   *  Deliberately NOT extended to `session.kill` or the backlog mutations: a
   *  destructive command delivered an hour late is wrong, not merely duplicated. */
  //  `launchId` names a create that was ACCEPTED but PARKED: it carries `needs`
  //  and the host is holding it until those files land (`launch.ts`). `ok` is
  //  still true — the host has taken ownership, which is the whole point — and
  //  `sessionId` is absent because nothing was spawned. A client must not read
  //  that absence as "the session was never named".
  //  `intentId` names the durable row the op produced or found. It rides beside
  //  `launchId` rather than replacing it: a parked create IS an intent now, and
  //  the two identifiers are the same string, so a client pinned to the old
  //  bundle keeps binding its queued prompts exactly as it did.
  //  `filed` is `assess.apply`'s alone: the ids of the PAD NOTES whose backlog
  //  row actually landed (`AssessNew.fromNote`). It exists because clearing a
  //  note is the one pad delete this app makes on a REMOTE receipt rather than
  //  on a durable local copy, so it is the one that can lose words: `intents.post`
  //  can refuse a row (`PENDING_MAX`, an unrunnable draft) while the apply as a
  //  whole still answers `ok`, and a phone that cleared every ticked offer on
  //  that `ok` tombstoned notes with no row anywhere to show for them.
  //
  //  **ABSENT MEANS THIS HOST CANNOT TELL YOU, SO ASSUME NOTHING WAS FILED** —
  //  an older daemon, or any op that is not an assess apply. An EMPTY ARRAY is
  //  the opposite and much stronger claim: this host filed nothing. A client
  //  clears exactly `ticked ∩ filed` and, with the field absent, clears nothing
  //  and says the notes were left on the pad.
  | { t: "op.ack"; ackId: string; ok: boolean; reason?: string; sessionId?: string; runId?: string; launchId?: string; intentId?: string; filed?: string[] }
  /** Every launch this host is holding or has settled (newest first). Sent on
   *  request and broadcast on every transition, so a phone that was asleep
   *  while the gate opened still learns what happened. */
  | { t: "launch.list"; launches: LaunchIntent[] }
  /** One launch's gate opened and the session exists. The client binds the
   *  prompts it queued behind that create (`bindPendingSession`) to `sessionId`
   *  — the ack that named it could not, because at ack time nothing was open. */
  | { t: "launch.opened"; id: string; sessionId: string; cwd: string }
  /** Tell the requesting client to navigate to this session (new OR existing). */
  | { t: "session.focus"; id: string }
  /** Reply to session.closecheck: uncommitted / un-merged-to-main state of a
   *  session's worktree, plus its background shells (the same `shellList` a
   *  status poll would publish) — a close sheet asking "what's at stake here"
   *  needs both facts in the one reply, not a second round trip. Absent means
   *  the same as `SessionInfo.shellList` absent: could not read, not "none". */
  | { t: "session.closecheck"; id: string; isRepo: boolean; branch: string; dirty: boolean; unmerged: number; isMain: boolean; mainBranch: string; shells?: SessionShell[] }
  | { t: "recent.list"; recent: RecentSession[] }
  | { t: "closed.list"; closed: ClosedSession[] }
  /** New images detected in a session's worktree this turn. */
  | { t: "session.images"; id: string; repoId: string; images: NewImage[] }
  /** Full prompt+output history for a session (sent on request and on each update). */
  | { t: "session.history"; id: string; entries: HistoryEntry[] }
  /**
   * Reply to `session.name`: the name that was written, or the sentence saying
   * why none was. Exactly one of the two, never both and never neither — the
   * phone shows whichever it gets, and a silent tap is the thing this message
   * exists to prevent. The name itself also arrives on the session list, which
   * is what actually redraws the tab.
   */
  | { t: "session.named"; id: string; name?: string; reason?: string }
  /**
   * Reply to `session.mode`: `mode` is what the footer shows AFTER the host
   * stopped pressing — the target on success, else wherever the cycle left it
   * (normally where it started) — and `reason` is set exactly when that is not
   * the mode asked for, as a sentence. `mode` absent = the footer could not be
   * read at all. The new mode also arrives as `liveMode` on the session list.
   */
  | { t: "session.moded"; id: string; mode?: PermissionMode; reason?: string }
  /** Results for a session.search request (echoes query/scope/id). */
  | { t: "session.searchResults"; query: string; scope: SessionSearchScope; id?: string; results: SessionSearchResult[] }
  | {
      t: "backlog.list";
      items: BacklogItem[];
      auto: boolean;
      idleMs: number;
      /**
       * Why each QUEUED item isn't running yet, keyed by item id (host-computed,
       * see `BacklogManager.waiting()`). Transient state about right now, which
       * is why it rides beside the items rather than on one: it is never
       * persisted, and a copy of it read from an offline snapshot is a guess the
       * client must not present as fact.
       */
      waiting?: Record<string, string>;
      /**
       * The automatic-session cap as facts (`AutoSlotFacts`): the ceiling and
       * every automatic session open right now, with whether it closes itself.
       * What the phone needs to offer "close one to make room" on a row held
       * on `noSlot` — a FACT, never an action: closing stays the ordinary
       * session close, a person's tap. A snapshot like `waiting`; intersect
       * `open` with the live session list before drawing it. Absent on a host
       * that predates it.
       */
      autoSlots?: AutoSlotFacts;
      /**
       * The rows a naming pass is working on RIGHT NOW, by id.
       *
       * Transient, exactly like `waiting`: it is a fact about this second, never
       * persisted, and an offline snapshot carrying it would claim a pass is
       * running that finished an hour ago. Absent (or empty) means nothing is
       * being named, which is also what a host predating the feature sends.
       */
      naming?: string[];
    }
  | { t: "update.status"; info: UpdateInfo }
  /**
   * `readings` is one entry per usage SOURCE that has something to say, claude
   * first (derived from `usage`, never a second scrape). Additive: absent means
   * an older host, and the phone derives `[claudeReading(usage)]` itself.
   */
  | { t: "usage.status"; usage: UsageInfo; readings?: UsageReading[] }
  /** Every installed plugin, on connect and after any change. */
  | { t: "plugin.list"; plugins: PluginView[] }
  /** The answer to one `plugin.action` tap, by its `reqId`. */
  | { t: "plugin.actionResult"; id: string; action: string; reqId: string; ok: boolean; message: string }
  /** A `plugin.set` / `plugin.enable` that was refused, in words. */
  | { t: "plugin.error"; id: string; error: string }
  /** The answer to one `plugin.call`, only to the asking socket. */
  | { t: "plugin.reply"; ackId: string; plugin: string; method: string; ok: boolean; result?: unknown; error?: string }
  /** A plugin's `api.push` — broadcast. */
  | { t: "plugin.push"; plugin: string; event: string; data: unknown }
  /** `stream.open` accepted. Binary frames for `streamId` follow on this socket only. */
  | { t: "stream.opened"; reqId: string; streamId: number; plugin: string; name: string }
  /** `stream.open` refused, in words (no such plugin or stream, the plugin said no, too many open). */
  | { t: "stream.refused"; reqId: string; reason: string }
  /** The plugin's own JSON about one stream (`sub.status`): what it picked, a permission it lacks. */
  | { t: "stream.status"; streamId: number; data: unknown }
  /** The stream is over. Nothing more arrives for `streamId`. `reason` is the sentence. */
  | { t: "stream.ended"; streamId: number; cause: StreamEndCause; reason: string }
  /** The decision log, newest first. `sessionId` set when filtered to one session. */
  | { t: "decisions.log"; entries: DecisionLogEntry[]; sessionId?: string }
  /** The sent-command log, newest first. `sessionId` echoes the filter asked for. */
  | { t: "sent.log"; entries: SentCommand[]; sessionId?: string }
  /** One command was just sent — appended live so an open log stays current. */
  | { t: "sent.new"; entry: SentCommand };
