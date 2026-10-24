/**
 * The turn: whether a session is working, and how the host knows.
 *
 * `setTurn`/`markIdle`/`checkIdle`, the claude hook SINK (`onHookEvent`,
 * `routeHook`), every channel's turn edges (`sourceTurn`), the turn watch and
 * the Stop verify, the prose question and the
 * agents running underneath (`checkAsking`/`checkAgents`/`setAsking`,
 * `ackAsking`), the ring of prompts the CLI said it submitted, and the turn
 * queries the facade answers with (`isHooked`, `stopCount`, `turnFromHook`, …).
 *
 * Stateless: every fact lives on the `Session` record, so these are plain
 * functions taking `core` first (docs/notes/host-architecture.md). Moved
 * verbatim from `sessions.ts`; `this.<another slice>` became `core.<hub>`.
 */
import { realpathSync } from "node:fs";
import type { SessionAgent, SessionAsk, SessionShell, SourceSession, TurnFacts } from "@waterplane/shared";
import { shellBucket, workingLine } from "@waterplane/shared";
import { agentsChanged, readAgents, readCliRecord, readRunningAgents } from "../agents.js";
import { claudeHookWatched, postClaudeHook, type ClaudeHookPayload } from "../backends/claude-sources.js";
import { derive } from "../backends/derive.js";
import { liveSourceFor } from "../livesources.js";
import { samePromptText } from "../echo.js";
import { stripAnsi } from "../prompt.js";
import { askLine, looksLikeQuestion, sameAsk } from "../question.js";
import { cliSuggestionOf, composerPlain } from "../clisuggest.js";
import { readPsTableAsync, readShellList, shellsEnabled } from "../shells.js";
import type { Session, SessionCore } from "./core.js";
import {
  AGENT_POLL_MS, HEALTH_SPAWN_GRACE_MS, QUESTION_TAIL_BYTES, STOP_VERIFY_BYTES, STOP_VERIFY_MS, SUBMIT_RING, tmuxName,
} from "./knobs.js";

/**
 * The `SourceSession` `agents.list()` is handed — the SAME one every other slot gets (review R7):
 * the live channel's own when one is attached (`sidechannel.ts`'s `sourceSession`), else built the
 * same way, `cwd` REALPATHED (`/var` -> `/private/var`), so a plugin keying its agent list by cwd sees
 * one string on every call. `backendSessionId` absent rather than `undefined`. Exported for the test.
 */
export function agentsSourceSession(s: Pick<Session, "spawnedAt"> & { info: Pick<Session["info"], "id" | "cwd" | "backendSessionId"> }): SourceSession {
  const live = liveSourceFor(s.info.id)?.session;
  if (live) return live;
  let cwd = s.info.cwd;
  try { cwd = realpathSync(cwd); } catch { /* the record's own path */ }
  return { id: s.info.id, cwd, spawnedAt: s.spawnedAt, ...(s.info.backendSessionId ? { backendSessionId: s.info.backendSessionId } : {}) };
}

/**
 * Did this turn end on a question to the person, asked in prose?
 *
 * Run on the turn-end transition, before the ping. Deliberately NOT a
 * detector of "is the CLI blocked" — it is not; the composer is right there.
 * It is a detector of WORK being blocked, which is the state the phone had no
 * word for: a finished turn whose next step is a decision only the user can
 * make. It used to be computed only when the Gemini oracle was on duty, so
 * without an API key nothing ever asked the tail this question.
 *
 * A parsed `prompt` outranks it (that is the same question with buttons), and
 * a limit-blocked session is not waiting on an answer, it is waiting on a
 * clock.
 */
function checkAsking(core: SessionCore, s: Session): void {
  // "Did the turn end on a question with no box" is a rule about how THIS CLI
  // signs off a turn. A backend it was not written against records nothing:
  // `SessionInfo.asking` stays absent, and the phone's "asked you" badge can
  // never be raised by a paragraph that merely ends in a question mark.
  if (derive(s.backend).screen("asking") !== "question-ts") { setAsking(core, s, null); return; }
  if (s.info.prompt || s.info.limit?.blocked) { setAsking(core, s, null); return; }
  // A turn still IN FLIGHT is not a turn that ended on a question. The
  // silence timer re-enters `markIdle` four seconds after any output, so on a
  // hooked session a long quiet tool run would otherwise read the agent's
  // mid-turn "should I also…?" as a handover and badge a working session
  // "asked you" until someone typed. Only a turn that is over may raise it;
  // by this point `markIdle`/the Stop hook have already cleared the flag for
  // the sessions that legitimately finished.
  if (s.turnActive) return;
  // The rendered grid, not the byte tail: the CLI lays words out with cursor
  // moves, and the stripped bytes read "TheUIisstillwronghere" on the card.
  const tail = s.screenLog?.gridText() || stripAnsi(s.scrollback.slice(-QUESTION_TAIL_BYTES));
  if (!looksLikeQuestion(tail)) { setAsking(core, s, null); return; }
  const text = askLine(tail);
  if (!text) { setAsking(core, s, null); return; }
  // Already dealt with — outside this session, which is the only place it
  // COULD have been dealt with without a turn starting. The tail still ends
  // on the question and always will, so without this the badge re-raises on
  // the next repaint and the acknowledgement lasts about a second.
  const d = s.askDismissed;
  if (d && ((s.hooksActive && d.stop === s.stopCount) || sameAsk(text, d.text))) { setAsking(core, s, null); return; }
  // Keep the original `at`: idle re-enters here on every repaint, and a
  // question whose clock restarted twice a second would read "asked 0s ago"
  // for as long as it went unanswered.
  setAsking(core, s, { text, at: s.info.asking?.at ?? Date.now() });
}

/**
 * Is the composer showing the CLI's own proposal for the next prompt?
 * (`clisuggest.ts` holds the rule and the measurement.)
 *
 * Re-entered on every quiet repaint, like `checkAsking` — the proposal is a
 * model call of the CLI's own and lands a moment AFTER the Stop, so one read on
 * the transition would miss it. The plain grid is the cheap gate; the render
 * with attributes is paid once per distinct composer text.
 */
function checkCliSuggestion(core: SessionCore, s: Session): void {
  // Measured on claude's TUI only (`clisuggest.ts`); another TUI's dim hint is a placeholder. The
  // claude TUI is the one whose dialogs `prompt.ts` reads — so every backend that runs it.
  if (derive(s.backend).screen("dialogs") !== "claude-numbered" || s.turnActive || s.info.prompt || s.info.limit?.blocked) {
    s.hintRead = null;
    setCliSuggestion(core, s, null);
    return;
  }
  const grid = s.screenLog?.gridText();
  if (!grid) return;
  const rows = grid.split("\n");
  const plain = composerPlain(rows);
  if (!plain) { s.hintRead = null; setCliSuggestion(core, s, null); return; }
  if (plain === s.hintRead) return;
  s.hintRead = plain;
  void core.screenCells(s.info.id, rows.length).then((cells) => {
    if (s.hintRead !== plain || s.turnActive) return; // the screen moved on while this rendered
    setCliSuggestion(core, s, cliSuggestionOf(rows, cells.map((r) => r.undimmed)));
  }).catch(() => { /* no reading — leave what is published */ });
}

export function setCliSuggestion(core: SessionCore, s: Session, text: string | null): void {
  if ((s.info.cliSuggestion ?? null) === text) return;
  s.info.cliSuggestion = text;
  core.emit("updated", s.info);
}

/**
 * Publish which agents are running UNDER this session, and keep polling while
 * any are.
 *
 * The turn flag answers for the MAIN loop only. A background agent survives
 * its Stop hook by design — the CLI prints "Waiting for 2 background agents
 * to finish" and hands the composer back — so a session with two reviewers in
 * flight published `turnActive: false, idle: true` and the reader, which has
 * no terminal to check that against, said "idle — nothing running" for six
 * minutes of real work. `agents.ts` reads the fact off the CLI's own logs.
 *
 * Polled rather than evented because there is no event: the parent's log is
 * not written while a background agent runs, and no hook fires for an agent.
 * The poll is a `readdir` plus a `stat` per agent, armed ONLY while agents
 * exist, so a desktop full of quiet sessions pays for nothing. Elapsed is
 * counted on the phone off `startedAt`, so a broadcast happens on a CHANGE
 * (an agent appearing, finishing, or moving to a different tool) and not once
 * a tick per attached client.
 */
export function checkAgents(core: SessionCore, s: Session): void {
  if (s.agentTimer) { clearTimeout(s.agentTimer); s.agentTimer = null; }
  // Any call supersedes a still-pending `ps` read from an earlier one: that one
  // must not publish an older picture over this one, nor arm a second timer.
  const gen = (agentGen.get(s) ?? 0) + 1;
  agentGen.set(s, gen);
  if (!s.info.running) {
    if (s.info.agents || s.info.shells || s.info.shellList) {
      s.info.agents = undefined; s.info.shells = undefined; s.info.shellList = undefined; s.shellsFp = undefined;
      core.emit("updated", s.info);
    }
    return;
  }
  // What is running under a session is read off the CLI's OWN logs
  // (`subagents/agent-*.jsonl`). A backend that writes none has no such file
  // to read, so the list stays ABSENT — which is what "this app cannot tell
  // you" looks like, as against an empty list, which would claim nothing is
  // running.
  // claude keeps its own reader and its own error rule (a throw reads as "none running");
  // another backend asks its `agents` providers, and no answer keeps the list ABSENT.
  let rows: SessionAgent[] = [];
  if (derive(s.backend).keepsClaudeLog) {
    try { rows = readRunningAgents(s.info.cwd, s.info.claudeSessionId); } catch { rows = []; }
  } else {
    let read: SessionAgent[] | null = null;
    try { read = readAgents(s.backend, agentsSourceSession(s)); } catch { read = null; }
    if (read === null) return;
    rows = read;
  }
  // Background SHELLS are the same fact by another route (a `run_in_background`
  // Bash or a Monitor outlives its turn too), and no log records them — the
  // CLI's own session record does (`agents.ts`'s `readCliRecord`).
  let record: { status: string; pid: number } | null = null;
  try { record = readCliRecord(s.info.id, tmuxName(s.info.id), s.info.claudeSessionId); } catch { record = null; }
  const cli = record?.status ?? null;
  const shells = cli === "shell" ? true : undefined;
  // The RICH list, read only while the CLI's own record says there is
  // something under it worth asking about — a `busy` main loop still gets
  // asked, for the same edge `shells` itself is asked through: the Stop hook
  // can land before the record catches up to `shell`.
  if (record && (cli === "shell" || cli === "busy") && shellsEnabled()) {
    // The process table is read ASYNC: this runs per shell/busy session every
    // `AGENT_POLL_MS`, on the one loop that pumps every PTY, and the blocking
    // `ps` it replaced cost ~50 ms a time. The rest of the tick is unchanged
    // and picks up when the table is in (`publishAgents`).
    const pid = record.pid;
    void readPsTableAsync()
      .then((psRows) => readShellList(pid, s.info.cwd, s.info.claudeSessionId, cli, Date.now(), psRows))
      .catch((): SessionShell[] | undefined => undefined)
      .then((shellList) => {
        if (agentGen.get(s) !== gen) return;               // a newer tick owns the result and the timer
        if (!s.info.running) { checkAgents(core, s); return; } // ended meanwhile: the early branch retires the fields
        publishAgents(core, s, rows, shells, cli, shellList);
      });
    return;
  }
  publishAgents(core, s, rows, shells, cli, undefined);
}

/** Per-session generation of the latest `checkAgents` call — see there. */
const agentGen = new WeakMap<Session, number>();

/** The second half of `checkAgents`: compare, broadcast on a change, re-arm. */
function publishAgents(
  core: SessionCore, s: Session, rows: SessionAgent[], shells: true | undefined, cli: string | null,
  shellList: SessionShell[] | undefined,
): void {
  const shellsFp = shellsFingerprint(shellList, Date.now());
  const changed = agentsChanged(s.info.agents, rows) || shells !== s.info.shells || shellsFp !== s.shellsFp;
  if (changed) {
    s.info.agents = rows.length ? rows : undefined;
    s.info.shells = shells;
    s.info.shellList = shellList;
    s.shellsFp = shellsFp;
    core.emit("updated", s.info);
  }
  // Keep polling while something runs underneath — and while the CLI still
  // says `busy` after our turn flag dropped: the Stop hook can land before the
  // CLI rewrites its record to `shell`, and reading once at that edge would
  // miss every shell the turn left behind. And while a TURN runs: a turn that
  // starts with nothing under it and then fans out to N agents was read once at
  // its start and never again, so the phone's parallel-agent count missed every
  // agent launched mid-turn. The poll is a readdir per busy session plus the
  // shared, memoised `ps`.
  if (!rows.length && !shells && !(shellList && shellList.length) && cli !== "busy" && !s.turnActive) return;
  s.agentTimer = setTimeout(() => { s.agentTimer = null; checkAgents(core, s); }, AGENT_POLL_MS);
  s.agentTimer.unref?.();
}

/**
 * `pid:bucket:workers:fg` per row, joined — the STATE a person would see,
 * never a raw timestamp. Keying on `cpuMovedAt` directly (the old key) meant
 * a genuinely WORKING shell rebroadcast on nearly every poll: its CPU is, by
 * definition, moving, so `cpuMovedAt` ticks to `now` almost every time this
 * function is asked, and "only broadcast on a change a person would see" was
 * defeated for the one bucket that polls most often. `shellBucket` only
 * changes when the shell actually crosses working/waiting/quiet/unknown —
 * that IS a change worth a broadcast — and `workers`/`foreground` cover the
 * two other facts a person's view of the row depends on.
 */
function shellsFingerprint(list: SessionShell[] | undefined, now: number): string {
  if (!list) return "";
  return list.map((sh) => `${sh.pid}:${shellBucket(sh, now)}:${sh.workers}:${sh.foreground ? "fg" : "bg"}`).join("|");
}

/** Publish/retire the prose-question fact, on a CHANGE of wording only. */
export function setAsking(core: SessionCore, s: Session, ask: SessionAsk | null): void {
  const had = s.info.asking?.text ?? null;
  if ((ask?.text ?? null) === had) return;
  s.info.asking = ask;
  core.emit("updated", s.info);
}

export function checkIdle(core: SessionCore, s: Session): void {
  if (!s.info.running || !s.sawData) return;
  // Hook-driven sessions get their turn-finished PING from the Stop hook (exact),
  // so the silence timer here must NOT re-ping — it only keeps the cosmetic idle
  // flag + limit scan fresh (e.g. after a post-Stop redraw flips idle back off).
  markIdle(core, s, !s.hooksActive);
}

/**
 * Flip the "a turn is in flight" flag and mirror it onto the wire, so clients
 * that show no terminal (the reader view) can still tell working from waiting.
 * Hook-driven when the pipe is live; otherwise set on real input and cleared
 * by markIdle's silence guess.
 */
export function setTurn(core: SessionCore, s: Session, active: boolean, opts: { fromScreen?: boolean } = {}): void {
  // A shell has no turns (`caps.turns`): output after a command is not work
  // starting, and silence after it is not work finishing.
  if (active && s.backend?.caps.turns === false) return;
  // Provenance first: a turn the SCREEN reported is not a turn a hook did, and
  // the difference decides what its END is allowed to claim. Recorded even
  // when the flag itself does not move (a hook overtaking a screen-inferred
  // turn hands ownership back to the pipe).
  s.turnFromScreen = active ? !!opts.fromScreen : false;
  // A turn running is the end of idle — the one place that says so for every
  // route a turn starts by, now that raw output no longer does (`noteOutput`).
  if (active) core.clearIdle(s);
  if (s.turnActive === active && s.info.turnActive === active) return;
  s.turnActive = active;
  s.info.turnActive = active;
  if (active) s.info.turnStartedAt = Date.now();
  // A turn STARTING is where a FOREGROUND agent comes from (the Task tool
  // inside the turn), and a turn ENDING is handled by `markIdle`. Both edges
  // ask, because either can change what is running underneath.
  if (active) checkAgents(core, s);
  // A turn running is the answer to "is this session still waiting on you":
  // whatever it asked at the end of the last one has been answered, or
  // overtaken. Cleared here rather than only on our own write, so a reply
  // typed at the DESK retires the phone's badge too.
  if (active && s.info.asking) s.info.asking = null;
  // …and the memory of an acknowledged one goes with it: the next turn may
  // end on the same words for a new reason, and that is a fresh question.
  if (active && s.askDismissed) { s.askDismissed = null; persistAsk(core, s); }
  // The CLI's proposal was for the composer this turn just took.
  if (active) { s.hintRead = null; if (s.info.cliSuggestion) s.info.cliSuggestion = null; }
  // A turn STARTING on a session we believe is blocked is the earliest moment
  // that belief can be shown to be wrong, and `checkLimit`'s third branch
  // already accepts `turnStartedAt > blockedSince` as proof. Ask now rather
  // than waiting for the session to fall quiet — a turn is exactly what makes
  // it not quiet, and a long one held the stale badge for its whole length.
  // Cheap and self-limiting: only on the blocked flag, and the log read is
  // memoised on the file's mtime. A resume in flight is left to the verdict
  // paths below for the reason the sweep states.
  if (active && s.info.limit?.blocked && !core.isResuming(s.info.id)) {
    try { core.checkLimit(s); } catch { /* not the point of this call */ }
  }
  core.emit("updated", s.info);
  // A turn STARTING is the exact proof a resume took — but only from a HOOK.
  // On a session with no hook pipe this flag is set by markSubmitted from our
  // OWN write, so releasing on it would treat typing "continue" as proof that
  // the continue worked and wave the next session through instantly, which is
  // the pile-on the queue exists to stop. Those sessions are released by the
  // banner-gone scan, by re-blocking, or by the watchdog.
  // …and only from a hook. A spinner painting is not the CLI accepting a
  // `continue`: a session that came back blocked repaints too, and releasing
  // the wave on that would be the pile-on the queue exists to stop.
  if (active && !opts.fromScreen && s.hooksActive && core.isResuming(s.info.id)) core.releaseResume(s.info.id, "resumed");
}

/**
 * Apply the "turn finished" transition: scan for a usage-limit banner, mark the
 * session idle, seal the captured output, and — when `emitPing` — fire the
 * once-per-turn turn-finished event (push / plugin question event). Driven by the Stop
 * hook when the hook pipe is live (exact), else by the silence timer (checkIdle).
 * The ping is gated on `idleNotified` (not on the idle flag) so a Stop can still
 * ping even if a silence tick set the idle flag first.
 */
function markIdle(core: SessionCore, s: Session, emitPing: boolean): void {
  if (!s.info.running) return;
  // A shell (`caps.turns === false`): a quiet prompt is not a finished turn, so
  // no idle flag, no "Turn finished" ping, no turn end — nothing to say at all.
  if (s.backend.caps.turns === false) return;
  // Without hooks, silence is all we have — so idle also ends the turn. A hooked
  // session keeps turnActive until its Stop: a long, quiet tool run is still work.
  if (!s.hooksActive) {
    // This line IS the fallback the health record names: a turn boundary
    // guessed from a quiet PTY rather than reported by the CLI. Recorded once
    // per session (see `noteHookFallback`), because a session with no pipe
    // takes it on every turn it will ever run.
    //
    // …but only when there was a turn to guess the end OF. `markIdle` runs
    // four seconds after ANY output, and a repaint is not a turn boundary: on
    // the live host that made every re-attached tmux session log a `hook.pipe`
    // miss for a pipe that was perfectly alive, because `hooksActive` means
    // "a hook has reached THIS host process", and a `npm run restart` hands
    // thirty sessions back with that flag false and a fresh `spawnedAt` that
    // makes the spawn grace measure the wrong clock. 27 of 30 live sessions
    // read unhooked that way; the record read 36 good / 42 miss and none of
    // the 42 was a statement about the CLI.
    //
    // `turnActive` on an unhooked session is set by `markSubmitted` — our own
    // Return — so this is exactly "we started a turn, the CLI should have
    // reported its end, and instead we guessed". A turn started at the DESK
    // is invisible to us either way, which is not evidence of a broken pipe;
    // it is no evidence at all, and no evidence records nothing.
    const guessedATurnEnd = s.turnActive;
    setTurn(core, s, false);
    if (guessedATurnEnd) noteHookFallback(core, s.info.id, "silence heuristics");
  }
  core.checkLimit(s);
  core.checkContext(s);
  // The footer's mode and ultracode (`livemode.ts`): a shift+tab typed at the desk
  // is output, and this is the quiet tick after it. A source session's mode is re-read here too.
  core.checkMode(s);
  // Cheap (one statSync) and correct on a repaint: the log's mtime only moves
  // when the CLI writes a turn, so re-reading it here cannot manufacture
  // activity the way stamping a clock does.
  // `lastTurnAt` is read from the CLI's OWN log, never from a clock we stamp.
  // A backend that writes no log therefore has no last-turn instant, and the
  // field stays ABSENT — stamping `now` here would be the wrong number the
  // rule exists to refuse (it would say "a turn just ended" every time a
  // screen repainted).
  const turnAt = derive(s.backend).keepsClaudeLog ? core.lastTurnOf(s.info.cwd, s.info.claudeSessionId) : null;
  if (turnAt && turnAt !== s.info.lastTurnAt) s.info.lastTurnAt = turnAt;
  if (!s.info.idle) {
    s.info.idle = true;
    s.info.idleSince = Date.now();
    // A turn finished while nobody's viewing ⇒ "new since you left". Cleared on
    // the next attach (setWatched). Drives the starred-row "new" annotation.
    if (!core.isWatched(s.info.id)) s.info.newActivity = true;
    core.finalizeCapture(s);
    core.emit("updated", s.info);
  }
  // Did the turn END ON A QUESTION? Read before the ping, so the notification
  // below can say what is being asked instead of "Turn finished".
  checkAsking(core, s);
  // …and has the CLI proposed what to type next? (Tab at the desk; a tap here.)
  checkCliSuggestion(core, s);
  // …and is anything still running under it? A turn that ended by launching
  // background agents has not ended the work, and this is the transition the
  // reader reads as idle without it.
  checkAgents(core, s);
  // Only ping for a finished turn, not for a prompt (prompt has its own ping),
  // and only ONCE per turn — cosmetic redraws re-enter here but mustn't re-notify
  // until real input begins a new turn (see input()/write()/UserPromptSubmit).
  if (emitPing && !s.info.prompt && !s.idleNotified) {
    s.idleNotified = true;
    core.emit("idle", s.info.id, s.info);
  }
}

// ── claude hook sink (positive turn-boundary signal) ────────────────
// Sessions we spawn carry injected hooks (`backends/claude.ts`'s
// `hookSettingsArg`) that POST every lifecycle event to /api/hook → here. This
// is the exact turn-started / turn-finished / conversation-id signal the
// silence heuristics only approximated. Everything degrades to those
// heuristics if no hook arrives (stub binary, curl missing, hooks disabled).
//
// Only the SINK lives here, because routing a hook to its session needs this
// host's session table. What a hook MEANS is claude's source
// (`backends/claude-sources.ts`), consumed like every other backend's channel:
// `sidechannel.ts` → `sourceTurn` below, the one end-of-turn path
// (docs/analysis/backends-design.md §10).

/** Route a hook payload to its session and hand it to claude's source.
 *  Tolerant of an unknown event or an unmatched session (no-op). */
export function onHookEvent(core: SessionCore, payload: ClaudeHookPayload): void {
  const ev = String(payload?.hook_event_name || "");
  if (!ev) return;
  const s = routeHook(core, payload);
  if (!s) return;
  // A hook is a claim about a session that was LAUNCHED with a hook pipe. A
  // backend that has no such mechanism cannot have sent one, so an event that
  // routed to one of its sessions routed WRONG: believing it would mark an
  // opencode session `hooked`, publish an exact turn boundary it never had,
  // and file a health observation for a pipe that does not exist.
  //
  // `routeHook` no longer OFFERS such a session to the cwd fallback — and that
  // is where the damage was, because the event it stole was a claude session's
  // (see the note there). This gate stays as the backstop for the other door:
  // an exact `session_id` match, which is not a guess and is therefore not
  // something the router second-guesses.
  //
  // "Listening" is the claude source's own subscription (`claudeHookWatched`),
  // open only while a session of a backend whose `sources` ARE claude's hook
  // pipe has its channel attached — the `caps.hooks === "none"` gate this
  // replaced, stated as the fact it stood for.
  if (!claudeHookWatched(s.info.id)) return;
  // A fact about the SINK rather than an edge: a turn-shaped hook arrived since
  // this process attached (`Session.turnHookSeen`). `SessionEnd` never counted.
  if (ev === "SessionStart" || ev === "UserPromptSubmit" || ev === "Stop") s.turnHookSeen = true;
  // Before the source hears it: the first hook is what flips the pipe live,
  // and that edge's fixture capture reads this payload's shape.
  s.lastHook = payload;
  // The question a box is about to draw, before the log has it (2.1.304
  // writes the call only once it is answered). A turn boundary retires it.
  if (ev === "PreToolUse" && payload.tool_name === "AskUserQuestion" && typeof payload.tool_use_id === "string") {
    s.askHook = { id: payload.tool_use_id, input: payload.tool_input };
  } else if (ev === "UserPromptSubmit" || ev === "Stop" || ev === "SessionStart") {
    s.askHook = null;
  }
  // What the hook MEANS is the source's: the pipe going live (once), then the
  // edge — through the side channel slice into `sourceTurn` below.
  postClaudeHook(s.info.id, payload);
}

/**
 * Watch the screen for what the hooks cannot say.
 *
 * Two jobs, one loop, because they are one question — *is this CLI working
 * right now?*
 *
 *  - A `Stop` has arrived and is being held until the screen agrees
 *    (`stopPending`): a hook that blocked it means the turn carries on.
 *  - No turn is believed to be running, and the CLI is working anyway:
 *    `/compact` grinds for minutes ("Compacting conversation… (35s) 32%") and
 *    fires NO hook at all — no `UserPromptSubmit`, no `Stop` — so a session
 *    visibly at work published `turnActive: false` and the reader said "idle —
 *    nothing running" over it, same lie as the blocked-Stop case from the
 *    other direction.
 *
 * `seqAt` is the output offset the next window is measured from: each pass
 * looks ONLY at what the CLI printed since the last one, which is what makes
 * this cheap and what makes it decisive. A working CLI repaints its spinner
 * several times a second, so a window with nothing in it — or with nothing
 * that reads as the working line — is a session sitting at its composer.
 */
export function armTurnWatch(core: SessionCore, s: Session, seqAt = s.seq): void {
  if (s.stopVerifyTimer) { clearTimeout(s.stopVerifyTimer); s.stopVerifyTimer = null; }
  // The knob off, or a session with no PTY left to look at: believe the hook,
  // exactly as this code did before the check existed.
  if (!(STOP_VERIFY_MS > 0) || !s.info.running) { settleStop(core, s); return; }
  s.stopVerifyTimer = setTimeout(() => {
    s.stopVerifyTimer = null;
    checkTurnWatch(core, s, seqAt);
  }, STOP_VERIFY_MS);
  s.stopVerifyTimer.unref?.();
}

/**
 * Is this session working, and does that agree with what we published?
 *
 * The only thing allowed to contradict a `Stop` — or to report a turn no hook
 * announced — is the CLI's own working line (`shared/working.ts`, the same
 * matcher the phone's reader scrapes; not a second opinion about what
 * "working" looks like). Everything else settles the Stop, because the cost of
 * being wrong is asymmetric in a way that has already been paid: holding a
 * finished session "busy" stalls the queue silently, while releasing a live
 * one types a prompt into a running turn.
 *
 * **The hold lasts exactly as long as the evidence does.** Working or not is
 * re-asked window by window, so a turn that ends without a `Stop` — a
 * continuation killed, a compaction finishing, the spinner simply stopping —
 * falls out of the hold at the next pass rather than stranding the session as
 * permanently busy, which is the failure this rescue would otherwise trade for
 * the one it fixes.
 */
function checkTurnWatch(core: SessionCore, s: Session, seqAt: number): void {
  if (!s.info.running) { s.stopPending = false; return; } // the exit path ended the turn
  const fresh = s.seq - seqAt;
  /**
   * **Fresh BYTES say whether to look; the rendered GRID says what is there.**
   *
   * The byte delta is still the gate, and it is the cheap half: nothing
   * printed since the last pass means a session sitting at its composer, and
   * no grid read is worth paying for. But the bytes are not text. A TUI
   * repaint interleaves cursor moves and charset escapes with the characters,
   * and two overlapping repaints land spliced together — measured on claude
   * 2.1.267, a `/compact` whose screen read "Compacting conversation… 0%" for
   * two minutes arrived in the ring as `C\x1b(Bo\x1b(Bm\x1b(Bp…` woven
   * through the previous frame, matching nothing. The host published `idle`
   * over a live compaction and `deliver.ts` filed the delivery as a swallowed
   * Return — the exact failure this watch exists to prevent, surviving inside
   * it because the evidence was read in the wrong form.
   *
   * `screenLog.gridText()` is the live VT the recorder already feeds, so this
   * is a buffer read and not a replay: the same per-frame cost this pass was
   * designed around. The fallback is the old byte window, for a session whose
   * recorder is gone (disposed on exit) — it can only under-report.
   */
  const grid = s.screenLog?.gridText() ?? "";
  const working = fresh > 0 && !!workingLine(grid || s.scrollback.slice(-Math.min(fresh, STOP_VERIFY_BYTES)));
  if (working) {
    // A turn nobody announced: publish it, marked as read off the screen so
    // its end claims nothing a hook would have claimed.
    if (!s.turnActive) setTurn(core, s, true, { fromScreen: true });
    armTurnWatch(core, s, s.seq);
    return;
  }
  if (s.stopPending) { settleStop(core, s); return; }
  // A screen-inferred turn ends the way it began — quietly. No `stopCount` (the
  // backlog completes items on a real Stop), no turn-finished push (nothing
  // finished a turn), no `turnEnded`. `markIdle` still runs for its own work:
  // the limit and context scans, and the idle flag.
  if (s.turnFromScreen) { setTurn(core, s, false); markIdle(core, s, false); }
}

/**
 * Believe the Stop: the turn is over, with everything that hangs off that —
 * the flag, the count the backlog completes items on, the seal on the capture,
 * the turn-finished ping, the `turnEnded` event.
 *
 * Idempotent and gated on `stopPending`, because three paths call it for the
 * same Stop (the settle pass, a `UserPromptSubmit` that overtakes it, a
 * session start/end) and a turn must end once.
 */
function settleStop(core: SessionCore, s: Session): void {
  if (s.stopVerifyTimer) { clearTimeout(s.stopVerifyTimer); s.stopVerifyTimer = null; }
  if (!s.stopPending) return;
  s.stopPending = false;
  setTurn(core, s, false);
  s.stopCount += 1;
  markIdle(core, s, true);   // seal capture + turn-finished ping
  core.emit("turnEnded", s.info.id, s.stopCount);
}

/**
 * A turn edge reported by a backend's OWN channel (`sources.turns`, wired by
 * `sidechannel.ts`) — claude's hook pipe (`backends/claude-sources.ts`),
 * opencode's server, a plugin's sink — so a turn has ONE end-of-turn path
 * whoever reports it.
 *
 * `started`: whatever was under settlement, the turn it belonged to is over —
 * closed out now, in ORDER (the end of the old turn before the start of the new
 * one), rather than letting a timer fire into the middle of the new one. The
 * words the CLI says it took (`facts.prompt`, claude's `UserPromptSubmit`) are
 * kept BEFORE anything else this edge does, so a delivery racing it cannot miss
 * the one event that names its own text (`claimSubmittedPrompt`). And a
 * submitted prompt is proof no dialog is up — said only where the SCREEN reader
 * owns the dialogs: a dialog a channel posed (`sources.dialogs`) is retired by
 * the channel's `resolved`, never by an edge that can arrive in either order
 * with it.
 *
 * `ended`, for a source that `verifyEnds` (claude): NOT `setTurn(s, false)`. It
 * is the CLI ASKING to end the turn, and a hook may answer no — see
 * `STOP_VERIFY_MS` and `checkTurnWatch`; it is owed an answer until the screen
 * gives one, whether or not a turn was believed. Otherwise it is believed
 * outright (opencode: `session.status idle`, never a `step-finish`). Either way
 * it reaches `settleStop`, idempotent on `stopPending` — a source that repeats
 * itself ends a turn ONCE: one `stopCount`, one ping, one `turnEnded`.
 *
 * `facts.reread` re-reads the model off the log (a mid-turn `/model`) — on an
 * `ended` before anything else, on a `ready` after the turn is closed out, the
 * order the hook switch always had.
 */
export function sourceTurn(core: SessionCore, s: Session, edge: "started" | "ended" | "ready", facts?: TurnFacts): void {
  if (!s.info.running) return;
  if (edge === "started") {
    settleStop(core, s); // close out a turn still owed its end, in ORDER
    setTurn(core, s, true); // a turn just started → not ready for a new item
    if (facts?.prompt !== undefined) noteSubmittedPrompt(s, facts.prompt);
    if (!s.backend.sources?.dialogs) core.applyPrompt(s, null);
    s.idleNotified = false; // re-arm the turn-finished ping for this turn
    if (s.info.idle) { s.info.idle = false; s.info.idleSince = undefined; core.emit("updated", s.info); }
    return;
  }
  if (edge === "ended") {
    if (facts?.reread) core.refreshModel(s, facts.reread.logPath);
    if (s.backend.sources?.turns?.verifyEnds) {
      s.stopPending = true; // owed an answer until the screen gives one
      armTurnWatch(core, s);
      return;
    }
    s.stopPending = s.stopPending || s.turnActive; // no turn believed ⇒ nothing to end, nothing to count
    settleStop(core, s);
    return;
  }
  settleStop(core, s); // ready: at its prompt, no turn
  setTurn(core, s, false);
  if (facts?.reread) core.refreshModel(s, facts.reread.logPath);
}

/**
 * The backend's channel named the CLI's own conversation id after attach
 * (claude's `SessionStart`). A claude log id retires the project-dir polling;
 * any other backend's id is adopted once, as `backendSessionId`.
 */
export function sourceIdentified(core: SessionCore, s: Session, id: string): void {
  if (!id) return;
  if (derive(s.backend).keepsClaudeLog) { core.adoptClaudeId(s, id); core.stopClaudeIdWatch(s); return; }
  if (!s.info.backendSessionId) core.adoptBackendId(s, id);
}

/** Drop a Stop under settlement without applying it — for the PTY exit paths,
 *  where `running` is already false and the turn has been ended by hand. */
export function clearStopVerify(s: Session): void {
  if (s.stopVerifyTimer) { clearTimeout(s.stopVerifyTimer); s.stopVerifyTimer = null; }
  if (s.idleWatchTimer) { clearTimeout(s.idleWatchTimer); s.idleWatchTimer = null; }
  s.stopPending = false;
}

/**
 * Find the session a hook belongs to: exact claudeSessionId match first, else
 * the newest running session in the payload's cwd — preferring one whose id is
 * still unknown, since adopting it there is how a --continue/pick/fork session
 * learns its conversation id.
 *
 * **A session whose channel is not listening for claude hooks (`claudeHookWatched`:
 * a hookless backend, or a plugin backend with its own sink) is not a candidate
 * for the cwd fallback.**
 * It cannot have sent this event — it was launched with no pipe — so it can
 * never be the right route, and leaving it in the pool does real damage rather
 * than merely wasting a lookup. An opencode session NEVER has a
 * `claudeSessionId` (by design: opencode mints none and `LaunchPlan` claims
 * none), so in a repo running both binaries it is permanently the freshest
 * `bestNoId` and captures every claude hook that arrives without a matching
 * `session_id` — notably the `SessionStart` of a `--continue`/pick/fork claude
 * session, which is the one payload that hands that session its conversation
 * id. `onHookEvent`'s listening gate then correctly DROPS the
 * event, and the victim is the CLAUDE session: no id adopted, `hooked` false
 * for longer or for ever, silence heuristics standing in, and
 * `noteHookFallback` filing a `hook.pipe` fallback about a pipe that is working
 * perfectly. A false amber on the claude path, caused by a backend that was
 * supposed to be incapable of making anything worse.
 *
 * The exact-id match is evidence, not a guess, and a backend that somehow owns
 * one has earned the route — **but only a session that is still listening.**
 * A relaunch onto the same conversation (`replaceSessionId`, `--resume <id>`)
 * kills the old session and opens the new one with the SAME
 * `claudeSessionId`; the dead one stays in the map (exited, channel detached)
 * and, inserted first, won this loop for every hook the new one sent. The
 * listening gate in `onHookEvent` then dropped each of them: the replacement
 * was never `hooked` for its whole life, and every delivery into it was filed
 * as a `deliver.submit` fallback (2.1.306, 2026-10-21: 5 of 20, all `ok`).
 */
function routeHook(core: SessionCore, payload: { session_id?: string; cwd?: string }): Session | null {
  const sid = payload.session_id;
  if (sid) {
    for (const s of core.sessions.values()) if (s.info.claudeSessionId === sid && claudeHookWatched(s.info.id)) return s;
  }
  const cwd = payload.cwd;
  if (!cwd) return null;
  let best: Session | null = null;
  let bestNoId: Session | null = null;
  for (const s of core.sessions.values()) {
    if (!s.info.running || s.info.cwd !== cwd) continue;
    if (!claudeHookWatched(s.info.id)) continue;
    if (!best || s.spawnedAt > best.spawnedAt) best = s;
    if (!s.info.claudeSessionId && (!bestNoId || s.spawnedAt > bestNoId.spawnedAt)) bestNoId = s;
  }
  return bestNoId ?? best;
}

/** True once the hook pipe is confirmed live for this session (turn boundaries
 *  come from hooks, not silence). Used by the backlog to pick its completion path. */
export function isHooked(core: SessionCore, id: string): boolean { return !!core.sessions.get(id)?.hooksActive; }

/** A turn-shaped hook has reported since this process attached — see
 *  `Session.turnHookSeen`. */
export function sawTurnHook(core: SessionCore, id: string): boolean { return !!core.sessions.get(id)?.turnHookSeen; }

/** The pane is in tmux copy-mode: the client shows history and no live bytes
 *  arrive, so PTY silence says nothing about the turn underneath. Read back
 *  on re-attach (a pane can outlive the daemon in copy-mode). */
export function inCopyMode(core: SessionCore, id: string): boolean { return !!core.sessions.get(id)?.copyMode; }

/**
 * Something just used a silence guess where the hook pipe should have
 * answered — record it, at most once for this session.
 *
 * Public because `deliver.ts` takes the same fallback from the other side (it
 * reports `ok` for a Return it could not prove landed), and the two must
 * agree on the once-per-session rule: this is not a per-turn event, it is one
 * fact about one session's pipe, and recording it per turn would put a
 * hundred identical misses in a twenty-slot window shared with nine other
 * signals.
 *
 * The spawn grace is the other half. `SessionStart` is a curl that has to run,
 * so a session two seconds old legitimately has no pipe yet — without the
 * grace every fresh session would log one fallback before its first hook
 * arrived, and the signal would report `broken` on a host where hooks work
 * perfectly.
 *
 * Neither guard is enough on its own, and the reason is that `hooksActive`
 * answers "has a hook reached THIS host process", not "does this session have
 * a pipe". A tmux session re-attached by `rediscover()` is a claude that
 * started days ago and whose next hook arrives at its next turn boundary; it
 * gets a fresh `spawnedAt`, so the grace times a clock that has nothing to do
 * with the pipe. Callers therefore owe this one more thing: **call it only
 * where the fallback was actually taken instead of a hook that was owed** —
 * `markIdle` guesses the end of a turn it saw start, `deliver.ts` re-checks
 * `isHooked` after its press-and-look loop. Calling it wherever the flag is
 * merely false is what turned "hooks work" into 42 misses.
 */
export function noteHookFallback(core: SessionCore, id: string, via: string): void {
  const s = core.sessions.get(id);
  if (!s || s.hooksActive || s.hookFallbackNoted) return;
  if (Date.now() - s.spawnedAt < HEALTH_SPAWN_GRACE_MS) return;
  s.hookFallbackNoted = true;
  core.noteFor(s, "hook.pipe", "fallback", { via });
}

/** Monotonic finished-turn count (Stop hooks). Backlog snapshots it at delivery
 *  and completes the item on the next increment. */
export function stopCount(core: SessionCore, id: string): number { return core.sessions.get(id)?.stopCount ?? 0; }

/**
 * Is a turn running that a HOOK announced — as against one read off the
 * screen?
 *
 * The two are the same fact to a reader ("this session is working") and must
 * not be the same fact to `deliver.ts`, whose whole submit ladder asks a
 * narrower question: did THIS keystroke start a turn. A spinner the host
 * inferred is evidence that the CLI is busy and no evidence at all about a
 * Return — a `/compact` started before the delivery paints exactly the same
 * line — so the proof stays on the pipe that can actually answer it.
 */
export function turnFromHook(core: SessionCore, id: string): boolean {
  const s = core.sessions.get(id);
  return !!s && s.turnActive && !s.turnFromScreen;
}

/**
 * The other half of the same fact: a turn running that NOTHING announced,
 * inferred from the CLI's own working line (`checkTurnWatch`).
 *
 * Deliberately not offered as a general submit proof — `turnFromHook`'s doc
 * says why, and `deliver.ts` keeps refusing it for an ordinary prompt. It is
 * exposed for the one class of command that CANNOT be proved any other way:
 * `/compact` submits, works for minutes and fires no hook at all, so the
 * spinner appearing on a session that was idle before the keystroke is the
 * only evidence there is (`shared/slash.ts`'s `worksUnannounced`).
 */
export function turnFromScreen(core: SessionCore, id: string): boolean {
  const s = core.sessions.get(id);
  return !!s && s.turnActive && s.turnFromScreen;
}

/** The PTY grid this session is drawing in, or null for an unknown id. The
 *  composer is drawn inside it, so it is half of why a delivery was readable. */
export function geometry(core: SessionCore, id: string): { cols: number; rows: number } | null {
  const s = core.sessions.get(id);
  return s ? { cols: s.cols, rows: s.rows } : null;
}

/** Remember one `UserPromptSubmit` payload. Bounded, and a payload with no
 *  `prompt` field is simply not remembered — an older CLI that sends the event
 *  without the text must not look like a session that submitted nothing. */
function noteSubmittedPrompt(s: Session, prompt: unknown): void {
  if (typeof prompt !== "string" || !prompt.trim()) return;
  s.submits.push({ prompt, at: Date.now(), claimed: false });
  if (s.submits.length > SUBMIT_RING) s.submits.splice(0, s.submits.length - SUBMIT_RING);
}

/**
 * The newest prompt this session's CLI said it submitted since `since`, or
 * null — a PEEK, claiming nothing.
 *
 * Exists for one sentence: a delivery that pressed Return into a composer it
 * could not read needs to be able to say *something else went in*. Reading
 * that off `claimSubmittedPrompt` returning false would be a guess; reading
 * it here is the CLI's own answer, and it is worth saying out loud because it
 * is the one outcome in this app where a person's words were mixed with
 * somebody else's before running.
 */
export function lastSubmittedPrompt(core: SessionCore, id: string, since: number): string | null {
  const s = core.sessions.get(id);
  if (!s) return null;
  for (let i = s.submits.length - 1; i >= 0; i--) if (s.submits[i].at >= since) return s.submits[i].prompt;
  return null;
}

/**
 * **Did the CLI tell us it submitted THIS text, after `since`?**
 *
 * The one submit proof that is about a delivery rather than about a session:
 * `UserPromptSubmit` carries the prompt, so a match is the CLI naming the
 * words it took, not the host inferring a Return from a screen that repaints
 * on its own.
 *
 * **A match is CLAIMED, exactly once.** Two deliveries of identical text — a
 * `continue`, a re-send of a prompt the sweep proved never ran — would
 * otherwise both read one hook event as their own, and the second would be
 * reported `ok` having never run. Same rule, same reason, as `settle.ts`'s
 * `spendTurn`, and it is why this is not a plain predicate.
 *
 * Absent is not a verdict: a session with no pipe, a backend with no hooks and
 * a CLI that sends the event without its text all return false, and every
 * caller falls through to the proof it had before this existed.
 */
export function claimSubmittedPrompt(core: SessionCore, id: string, text: string, since: number): boolean {
  const s = core.sessions.get(id);
  if (!s || !derive(s.backend).hooksInBand) return false;
  const hit = s.submits.find((e) => !e.claimed && e.at >= since && samePromptText(e.prompt, text));
  if (!hit) return false;
  hit.claimed = true;
  return true;
}

/**
 * "I have dealt with that" — retire the prose-question badge without typing.
 *
 * The only two things that retire `asking` on their own are a turn starting
 * and a keystroke, both of which mean the question was answered HERE. A
 * question answered anywhere else — the change committed at the desk, the
 * decision taken and no longer worth a reply — has neither, so the badge, the
 * waiting count and the push stood over a decision already made.
 *
 * `text` is checked for the reason `expectPrompt` exists: the tap happened
 * against a badge that may since have been replaced by a different question,
 * and silencing THAT one is the failure this guard is here to prevent. A
 * client that cannot say (absent) acknowledges whatever is standing.
 *
 * Types nothing, runs nothing, and is not remembered past the next turn.
 */
export function ackAsking(core: SessionCore, id: string, text?: string): void {
  const s = core.sessions.get(id);
  if (!s?.info.asking) return;
  const cur = s.info.asking.text;
  if (text != null && !sameAsk(text, cur)) return;
  s.askDismissed = { text: cur, stop: s.stopCount };
  s.info.asking = null;
  persistAsk(core, s);
  core.emit("updated", s.info);
}

/** Rewrite the `live/` record so "handled" survives a restart — `persistLive`
 *  takes `askDismissed` off the live session. */
function persistAsk(core: SessionCore, s: Session): void {
  const m = core.loadLive(s.info.id);
  if (m) core.persistLive(m);
}

/**
 * Attach a plugin's suggestion to a session. A numbered-CHOICE suggestion is
 * tied to a live prompt, so it's dropped if the prompt already changed (stale)
 * — we never show a choice for a gone prompt. A free-text REPLY suggestion
 * (choice == null) has no prompt to bind to, so it's always allowed; this is
 * what surfaces the turn-end reply bar.
 */
export function setSuggestion(core: SessionCore, id: string, s: import("@waterplane/shared").AnswerSuggestion | null): void {
  const sess = core.sessions.get(id);
  if (!sess) return;
  if (s && s.choice != null && !sess.info.prompt) return; // stale numbered choice
  sess.info.suggestion = s;
  core.emit("updated", sess.info);
}
