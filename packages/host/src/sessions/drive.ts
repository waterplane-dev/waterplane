/**
 * Drive: the verbs that act on a live session from outside — typing into it
 * (`input`, `write`), readiness for automation (`waitReady`,
 * `readyForAutoFire`, `autoFireBlocker`), geometry and remote control
 * (`resize`, `setRemoteControl`), ending or letting go of it (`kill`,
 * `detach`, `reattachById`, `remove`) and reading its screen back
 * (`scrollback` … `idleMs`).
 *
 * A stateless slice (docs/notes/host-architecture.md): plain functions taking
 * `core` first. The facade keeps each public method as a one-line delegation;
 * every other slice reaches `input`/`write`/`screenText`/`screenCells` through
 * `SessionCore` by their public names.
 */
import { execFileSync } from "node:child_process";
import { execFileP } from "../proc.js";
import { rmSync } from "node:fs";
import type { ClosedBy, SessionInfo, SessionShell, SessionShellDetail } from "@waterplane/shared";
import { ptySize, SCREENLOG_MAX_LINES, sessionWall } from "@waterplane/shared";
import { namesStoreReader } from "../backends/index.js";
import { readCliRecord } from "../agents.js";
import { renderCapture, renderCells, type RenderRow } from "../render.js";
import { foregroundWrapperPids, killShellGroup, readPsTable, readShellDetail, readShellList, shellsUnder, type PsRow } from "../shells.js";
import { exitCopyMode as tmuxExitCopyMode, paneWantsMouse, parseWheel, scroll as tmuxScroll } from "../tmuxscroll.js";
import type { Session, SessionCore } from "./core.js";
import { TMUX_SERVER, tmuxName } from "./knobs.js";

/** What a shell-stopping pass settled on — `kill()`/`remove()`'s
 *  `onShellsStopped` and `killOneShell`'s reason for `shell.killed`. */
export interface ShellStopCounts { shellsStopped: number; shellsLeft: number; }

/**
 * Stop every BACKGROUND shell group running under this session's CLI —
 * CLAUDE.md's decision that closing a session stops its shells, fully. A
 * wrapper that is the running turn's OWN foreground command is left alone:
 * the `tmux kill-session` right after this call ends the turn (and it)
 * anyway, so there is nothing here that needs to signal it separately, and
 * counting it would claim a "background shell" was stopped that never was one.
 *
 * The CLI's own pid comes from `readCliRecord` (`agents.ts`), never guessed:
 * no record ⇒ nothing is stopped and nothing counted, rather than acting on a
 * pid that might belong to something else entirely. `ps` is read exactly
 * ONCE for the whole pass and handed to every `killShellGroup` call as its
 * precondition table (`deps.rows`) — an `N`-group close used to take `N + 1`
 * fresh reads (one shared here, one more inside each group's own call) for a
 * fact that does not change between them; the reads AFTER each group's own
 * SIGTERM stay genuinely fresh, per group, because those happen at a
 * different real moment for each one. Every group's `killShellGroup` call is
 * started in the SAME synchronous pass — `.map()` runs each call up to its
 * own first `await`, which in `killShellGroup` comes AFTER its
 * `kill(-pid, "SIGTERM")` — so by the time this function hits its own first
 * `await` (and yields back to a caller that did not await it), every group
 * has already been sent SIGTERM. That is what lets `kill()`/`remove()` call
 * this WITHOUT awaiting it and still have every shell's SIGTERM land before
 * the `tmux kill-session` line right below it. The 3s SIGKILL grace and the
 * final tally are only available to a caller that awaits the promise (or
 * passes `onShellsStopped`).
 */
async function stopShellsUnder(s: Session): Promise<ShellStopCounts> {
  let record: { status: string; pid: number } | null = null;
  try { record = readCliRecord(s.info.id, tmuxName(s.info.id), s.info.claudeSessionId); } catch { record = null; }
  if (!record) return { shellsStopped: 0, shellsLeft: 0 };
  let rows: PsRow[];
  try { rows = readPsTable(true); } catch { return { shellsStopped: 0, shellsLeft: 0 }; }
  const groups = shellsUnder(record.pid, rows);
  if (!groups.length) return { shellsStopped: 0, shellsLeft: 0 };
  const foreground = foregroundWrapperPids(record.pid, rows, s.info.cwd, s.info.claudeSessionId, record.status);
  const targets = groups.filter((g) => !foreground.has(g.wrapper.pid));
  if (!targets.length) return { shellsStopped: 0, shellsLeft: 0 };
  const cliPid = record.pid;
  const now = Date.now();
  const results = await Promise.all(
    targets.map((g) => killShellGroup(cliPid, g.wrapper.pid, now - g.wrapper.etimeSec * 1000, now, { rows })),
  );
  const stopped = results.filter((r) => r.ok).length;
  return { shellsStopped: stopped, shellsLeft: targets.length - stopped };
}

/**
 * Stop ONE named shell (`shell.kill`, bare — not durable, not queued offline:
 * a kill delivered late must hit whatever pid it names NOW, re-validated
 * fresh, or refuse). Re-runs `checkAgents` after, win or lose, so
 * `shellList` republishes what is actually still there rather than leaving a
 * stale row for a tap that already landed.
 *
 * A `foreground` pid is refused outright, before `killShellGroup` is even
 * asked: it is the running turn's own command wearing the same `ps` shape as
 * a background shell, not something a stop button may signal.
 */
export async function killOneShell(core: SessionCore, id: string, pid: number, startedAt: number): Promise<{ ok: boolean; reason?: string }> {
  const s = core.sessions.get(id);
  if (!s) return { ok: false, reason: "session not available" };
  let record: { status: string; pid: number } | null = null;
  try { record = readCliRecord(s.info.id, tmuxName(id), s.info.claudeSessionId); } catch { record = null; }
  if (!record) return { ok: false, reason: "no CLI record for this session — nothing to stop" };
  let list: SessionShell[] | undefined;
  try { list = readShellList(record.pid, s.info.cwd, s.info.claudeSessionId, record.status); } catch { list = undefined; }
  const target = list?.find((sh) => sh.pid === pid);
  if (target?.foreground) {
    return { ok: false, reason: "that is the running turn's own command — not a background shell" };
  }
  const verdict = await killShellGroup(record.pid, pid, startedAt);
  core.checkAgents(s);
  return verdict;
}

/** One background shell's whole command and output tail (`GET /api/shell`) —
 *  read-only. `null` when the session, its CLI record or that pid among its
 *  shells is not there right now. */
export function shellDetail(core: SessionCore, id: string, pid: number): SessionShellDetail | null {
  const s = core.sessions.get(id);
  if (!s) return null;
  let record: { status: string; pid: number } | null = null;
  try { record = readCliRecord(s.info.id, tmuxName(id), s.info.claudeSessionId); } catch { record = null; }
  if (!record) return null;
  try { return readShellDetail(record.pid, s.info.cwd, s.info.claudeSessionId, pid); } catch { return null; }
}

// Terminal-emitted, non-typing input: SGR mouse (wheel/click), legacy X10 mouse,
// and focus in/out reports. Sent while you scroll the TUI — not a new turn.
const PASSIVE_INPUT_RE = /\x1b\[(?:<\d+;\d+;\d+[Mm]|M[\s\S]{3}|[IO])/g;
function isPassiveInput(data: string): boolean {
  return data.length > 0 && data.replace(PASSIVE_INPUT_RE, "") === "";
}

/** Buffer-switch modes must be re-emitted before the rest so content lands in the right buffer. */
const ALT_MODES = new Set([1049, 1047, 47]);
function modePrefix(modes: Set<number>): string {
  if (!modes.size) return "";
  const ordered = [...modes].sort((a, b) => Number(ALT_MODES.has(b)) - Number(ALT_MODES.has(a)));
  return ordered.map((m) => `\x1b[?${m}h`).join("");
}

/** Returns true iff the bytes reached a live, remote-controlled PTY. The
 *  compose path uses this (via an ack) to know a send actually landed rather
 *  than vanishing into a stale/zombie socket. */
export function input(core: SessionCore, id: string, data: string): boolean {
  const s = core.sessions.get(id);
  if (!s || !s.info.running || !s.info.remoteControl) return false;
  // A pan on the phone. Where it goes depends on the pane, not on us — a
  // program that asked for the mouse gets the bytes, one that did not gets
  // tmux's copy-mode scroll instead (`tmuxscroll.ts`). Exactly one of the
  // two: writing both would scroll twice on a CLI that handles the wheel.
  const wheel = parseWheel(data);
  if (wheel) { panHistory(s, data, wheel.dir, wheel.n); return true; }
  // Scrolling the xterm sends mouse-wheel/focus escape bytes through here.
  // Those are NOT a new turn — clearing the sticky reply suggestion on them
  // made the approve bar vanish on scroll, then idle re-queried Gemini to
  // rebuild it (flicker + wasted calls). Only real keystrokes start a turn.
  if (!isPassiveInput(data)) {
    leaveCopyMode(s);
    clearReplySuggestion(core, s);
    core.setAsking(s, null); // the prose question just got its answer typed
    s.idleNotified = false; // real input → new turn → re-arm the turn-finished ping
    markSubmitted(core, s, data);
    // The box may have just been answered away. Nothing else clears it now, so
    // re-verify sooner than the ordinary cadence — a stale box is a tap that
    // types a digit into a running turn.
    core.armPromptCheck(s, 250);
  }
  s.proc.write(data);
  return true;
}

/**
 * Pan a tmux-hosted session: hand the wheel to the pane's own program where
 * it asked for the mouse, otherwise translate it into tmux's copy-mode
 * scroll.
 *
 * The routing is READ PER PAN and not remembered: a pane enters and leaves
 * the alternate screen (and its mouse modes with it) as the program inside it
 * decides, and a cached answer would send the wheel to whichever half is no
 * longer listening — the failure being a pan that silently does nothing,
 * which is the whole bug this path keeps having.
 *
 * Serialised per session: a flick arrives as one write, but two flicks in
 * quick succession must not interleave their `copy-mode` and `send-keys`
 * pairs. The copy-mode flag is what the typing path reads, so it is refreshed
 * from tmux itself rather than inferred — `copy-mode -e` leaves the mode on
 * its own once the scroll reaches the bottom.
 */
function panHistory(s: Session, data: string, dir: "up" | "down", n: number): void {
  const target = tmuxName(s.info.id);
  s.scrollChain = s.scrollChain
    .then(async () => {
      if (paneWantsMouse(TMUX_SERVER, target)) {
        // A pane left in copy-mode would read the wheel as pager input and
        // the program behind it would never see the pan, so the mode goes
        // first — the same rule the typing path has.
        leaveCopyMode(s);
        s.proc.write(data);
        return;
      }
      s.copyMode = await tmuxScroll(TMUX_SERVER, target, dir, n);
    })
    .catch(() => { /* a scroll that failed is a screen that did not move */ });
}

/**
 * Leave copy-mode before anything types.
 *
 * A pane in copy-mode reads keystrokes as pager commands, so a prompt
 * delivered onto a scrolled-back pane would be swallowed silently — the exact
 * failure `deliver.ts` exists to make impossible. Costs nothing on the common
 * path: it runs only while we believe the pane IS in a mode.
 */
function leaveCopyMode(s: Session): void {
  if (!s.copyMode) return;
  s.copyMode = false;
  tmuxExitCopyMode(TMUX_SERVER, tmuxName(s.info.id));
}

/** Automation write — bypasses remoteControl (for backlog firing). */
export function write(core: SessionCore, id: string, data: string): boolean {
  const s = core.sessions.get(id);
  if (!s || !s.info.running) return false;
  leaveCopyMode(s);
  clearReplySuggestion(core, s);
  core.setAsking(s, null); // the prose question just got its answer typed
  s.idleNotified = false; // real input → new turn → re-arm the turn-finished ping
  markSubmitted(core, s, data);
  core.armPromptCheck(s, 250); // same as input(): the write may have answered a box
  s.proc.write(data);
  return true;
}

/**
 * A submit (input carrying Return) starts a turn — but only claim that for a
 * session with NO hook pipe. Where hooks are live they own the flag: they know
 * a bare keystroke from a prompt, and nothing here could ever clear a wrong
 * guess (Stop only fires for a turn that really started).
 */
function markSubmitted(core: SessionCore, s: Session, data: string): void {
  if (!s.hooksActive && /[\r\n]/.test(data)) core.setTurn(s, true);
}

/** Drop a sticky free-text reply suggestion once real input is sent. */
function clearReplySuggestion(core: SessionCore, s: { info: SessionInfo }): void {
  const sug = s.info.suggestion;
  if (sug && sug.choice == null && sug.reply != null) {
    s.info.suggestion = null;
    core.emit("updated", s.info);
  }
}

/**
 * Resolve once the session has produced output AND been idle for `quietMs`
 * — i.e. has likely finished printing its current screen and is awaiting
 * input. Used by the backlog to feed text reliably into a fresh `claude`.
 */
export async function waitReady(core: SessionCore, id: string, quietMs = 1000, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = core.sessions.get(id);
    if (!s || !s.info.running) return false;
    // Hook-driven when the pipe is live: "no turn in flight" is the exact
    // readiness fact, and it doesn't care how noisy the TUI is. Pure silence
    // is a bad proxy on a loaded machine — a booting claude repaints its
    // spinner every ~150 ms, so a 1.2 s quiet window may never open and a
    // perfectly ready session times out un-fed (whole repos skipped in a
    // fan-out). A short settle is still required so we don't type into a TUI
    // that is mid-draw.
    const quiet = Date.now() - s.lastDataAt;
    if (s.sawData && s.hooksActive && !s.turnActive && quiet >= Math.min(quietMs, 400)) return true;
    if (s.sawData && quiet >= quietMs) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * Safe to auto-fire a backlog item into this session right now: it's running,
 * has settled (idle ≥ quietMs so the previous turn finished printing), and
 * isn't waiting on a tool/plan/select prompt. (A trust prompt is fine — feed()
 * auto-accepts it.) Firing into a busy or prompt-blocked session was the cause
 * of "instruction not delivered" failures while the user wasn't watching.
 */
export function readyForAutoFire(core: SessionCore, id: string, quietMs: number): boolean {
  return autoFireBlocker(core, id, quietMs) === null;
}

/**
 * The SAME decision as `readyForAutoFire`, in the user's words: null when the
 * session is ready, otherwise the one thing standing in the way.
 *
 * It is one function rather than two for the reason the collapsed-group status
 * chips are computed from the same precedence as the row badges — a second
 * ladder written to explain the first drifts from it, and an explanation that
 * disagrees with the behaviour is worse than none. "Waiting for the session"
 * is exactly the state the backlog leaves an item in without saying so, and
 * the phone cannot see any of these facts: the session may be mid-turn, parked
 * on a question, blocked on a usage limit, or simply gone.
 */
export function autoFireBlocker(core: SessionCore, id: string, quietMs: number): string | null {
  const s = core.sessions.get(id);
  if (!s || !s.info.running) return "its session has ended";
  // The two walls that are pure session state, asked ONCE for the whole repo
  // (`shared/queue.ts`'s `sessionWall`) instead of a fourth hand-written
  // ladder. This copy had already drifted: it tested the PARSED prompt box
  // and never `awaitingInput`, so an unparsable dialog — the same trap minus
  // the options — did not stop auto-fire, and a work item could be typed
  // into an open dialog on exactly the sessions the detector could not read.
  //
  // `turnActive` is deliberately NOT delegated: the rung below is not "is a
  // turn running" but "how do we KNOW", and the answer differs per session.
  const wall = sessionWall({
    limitBlocked: s.info.limit?.blocked,
    awaitingInput: s.info.awaitingInput,
    promptKind: s.info.prompt?.kind,   // trust is fine — feed() accepts it
  });
  if (wall === "limit") return "the session is blocked on a usage limit";  // the item would bounce
  if (wall === "awaitingAnswer") return "the session is waiting for an answer";
  // Hook-driven: the Stop hook is the authoritative "turn finished, at the
  // prompt, ready for input" signal — no silence guessing, no fixed threshold,
  // and it never reads a mid-task pause (long bash, thinking) as ready.
  if (s.hooksActive) return s.turnActive ? "the session is working" : null;
  // Fallback (stub binary / curl missing / hooks disabled): the old heuristic —
  // "no PTY output for quietMs" ≈ the turn finished. Said out loud as a guess,
  // because that is what it is on a session with no hook pipe.
  if (!s.sawData) return "the session hasn't printed anything yet";
  return Date.now() - s.lastDataAt >= quietMs ? null : "the session looks busy (no hook signal — going by silence)";
}

/**
 * A resize is a SIGWINCH, and a SIGWINCH makes the claude TUI clear and
 * repaint the whole screen — the visible flicker. A client sends its geometry
 * on every fit (a keyboard opening, a status bar mounting, a reattach), and
 * most of those report the SAME cols/rows, so the repaint bought nothing. Skip
 * an unchanged size; the client guards too, but this is the one place every
 * client and every reattach passes through.
 */
export function resize(core: SessionCore, id: string, cols: number, rows: number): void {
  const s = core.sessions.get(id);
  if (!s || !s.info.running) return;
  // Floored, not taken as given. A client reports the grid it is showing, and
  // a container laid out with no height reports a full-width, no-height one —
  // `54x3`, which the CLI cannot draw a composer in, which makes every
  // delivery into that session unreadable and therefore unconfirmable.
  // `@waterplane/shared`'s `ptysize.ts` carries the argument in full.
  const { cols: c, rows: r } = ptySize(cols, rows);
  if (s.cols === c && s.rows === r) return;
  s.cols = c;
  s.rows = r;
  // Stamped BEFORE the syscall, so the quiet window covers the repaint the
  // syscall is about to cause rather than starting after it.
  s.lastResizeAt = Date.now();
  // The recorder's VT has to follow the grid or every line wraps at the wrong
  // column and nothing anchors against what came before it.
  s.screenLog?.resize(s.cols, s.rows);
  try { s.proc.resize(s.cols, s.rows); } catch { /* exited */ }
}

export function setRemoteControl(core: SessionCore, id: string, enabled: boolean): SessionInfo | null {
  const s = core.sessions.get(id);
  if (!s) return null;
  s.info.remoteControl = enabled;
  core.emit("updated", s.info);
  return s.info;
}

/**
 * Real teardown: end the claude session for good (kills the tmux session
 * too) — and, first, every background shell running under it (see
 * `stopShellsUnder`). `onShellsStopped` is optional and changes nothing about
 * this function's own synchronous behaviour: it exists so a caller that DOES
 * want the final tally (the `shell.kill`-adjacent wire routes) can have it,
 * without every other caller of `kill()` needing to become async.
 */
export function kill(core: SessionCore, id: string, onShellsStopped?: (counts: ShellStopCounts) => void, by?: ClosedBy): void {
  const s = core.sessions.get(id);
  if (!s) { onShellsStopped?.({ shellsStopped: 0, shellsLeft: 0 }); return; }
  if (by) s.closeBy = by; // read by the exit path's closed row
  s.killed = true; // intentional close → never auto-resurrect on the limit exit
  core.clearResurrectTimer(s);
  // If the resume queue was waiting on THIS session, it never will get a
  // verdict — let the next one go now instead of at the watchdog.
  core.releaseResume(id, "gone");
  // Kicked off here, not awaited: see stopShellsUnder's own note for why
  // every group's SIGTERM is already sent by the time kill-session runs.
  const shellsDone = stopShellsUnder(s);
  if (onShellsStopped) void shellsDone.then(onShellsStopped);
  try { execFileSync("tmux", ["-L", TMUX_SERVER, "kill-session", "-t", tmuxName(id)], { stdio: "ignore" }); } catch { /* already gone */ }
  core.deleteLive(id);
  try { s.proc.kill(); } catch { /* dead */ }
}

/**
 * Close the phone's view but KEEP the session running in tmux (survives,
 * re-attachable on reopen or next boot). Returns false if the session is
 * unknown.
 */
export function detach(core: SessionCore, id: string): boolean {
  const s = core.sessions.get(id);
  if (!s) return false;
  s.detaching = true; // suppress the onExit "closed" (this isn't a death)
  core.stopClaudeIdWatch(s);
  if (!s.info.claudeSessionId) core.adoptClaudeId(s, core.detectClaudeId(s));
  if (!s.info.backendSessionId && namesStoreReader(s.backend.caps)) {
    core.adoptBackendId(s, core.detectBackendId(s));
  }
  try { execFileSync("tmux", ["-L", TMUX_SERVER, "detach-client", "-s", tmuxName(id)], { stdio: "ignore" }); } catch { /* no client */ }
  try { s.proc.kill(); } catch { /* already gone */ }
  if (s.promptTimer) clearTimeout(s.promptTimer);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  if (s.agentTimer) clearTimeout(s.agentTimer);
  core.clearLimitTimer(s);
  core.sessions.delete(id);
  // Session stays alive in tmux (LiveMeta persists). List it as reopenable with
  // alive:true so the phone offers "resume" (re-attach) rather than --continue.
  // Detach is only ever a person's close-but-keep-running.
  core.pushClosed(core.closedRowOf(s, true, { by: "you" }));
  return true;
}

/**
 * Re-attach a backgrounded session by id if it's still alive in tmux (same live
 * process, in-flight turn intact). Returns false if there's nothing to attach —
 * caller then falls back to a fresh `--continue`. Also clears it from the
 * recently-closed list since it's live again.
 */
export function reattachById(core: SessionCore, id: string): boolean {
  if (core.sessions.has(id)) return true; // already open
  if (!core.hasLiveTmux(id)) return false;
  const meta = core.loadLive(id) ?? { id, cwd: core.root, title: id, launch: {}, createdAt: Date.now() };
  try { core.reattach(meta); } catch { return false; }
  core.dropClosed(id);
  core.publishClosed();
  return true;
}

/**
 * Forget a session: kill it if still alive (its background shells too —
 * `stopShellsUnder`), then drop it from the map. `onShellsStopped` is the
 * same optional late tally `kill()` takes; `session.remove`'s route uses it
 * to send `session.closed`.
 */
export function remove(core: SessionCore, id: string, onShellsStopped?: (counts: ShellStopCounts) => void, by?: ClosedBy): boolean {
  const s = core.sessions.get(id);
  if (!s) { onShellsStopped?.({ shellsStopped: 0, shellsLeft: 0 }); return false; }
  if (by) s.closeBy = by; // read by the exit path's closed row (`closedRowOf`)
  s.killed = true; // intentional close → never auto-resurrect
  core.clearResurrectTimer(s);
  core.releaseResume(id, "gone");   // don't make the queue wait out a killed session
  // Kicked off here, not awaited — see stopShellsUnder / kill()'s note.
  const shellsDone = stopShellsUnder(s);
  if (onShellsStopped) void shellsDone.then(onShellsStopped);
  try { execFileSync("tmux", ["-L", TMUX_SERVER, "kill-session", "-t", tmuxName(id)], { stdio: "ignore" }); } catch { /* already gone */ }
  core.deleteLive(id);
  if (s.info.running) { try { s.proc.kill(); } catch { /* dead */ } }
  if (s.promptTimer) clearTimeout(s.promptTimer);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  if (s.agentTimer) clearTimeout(s.agentTimer);
  core.clearLimitTimer(s);
  core.stopClaudeIdWatch(s);
  s.screenLog?.dispose();  // the row is going; so is what it showed
  core.sessions.delete(id);
  try { rmSync(core.historyPath(id), { force: true }); } catch { /* non-fatal */ }
  // The summary is per-session state exactly like the history is, and forgetting
  // it here is what made `.waterplane/summaries/` grow-only: it was added after this
  // line and the matching delete was never written.
  try { rmSync(core.summaryPath(id), { force: true }); } catch { /* non-fatal */ }
  return true;
}

export function scrollback(core: SessionCore, id: string): string {
  // Replay from a line boundary so we don't start mid-escape-sequence.
  const s = core.sessions.get(id);
  const sb = s?.scrollback ?? "";
  const nl = sb.indexOf("\n");
  const body = nl > 0 && nl < 512 ? sb.slice(nl + 1) : sb;
  // Re-emit active private modes (alt-screen, mouse, …) first: the originals
  // were evicted from the capped buffer, so a fresh xterm needs them to land
  // content in the right buffer and keep mouse-driven scroll working.
  return s ? modePrefix(s.privateModes) + body : body;
}

/**
 * The session's CURRENT SCREEN as plain text: the raw capture replayed through
 * a headless VT at the live width, then the last `lines` rows.
 *
 * Why not just ANSI-strip a byte window: the claude TUI repaints with absolute
 * cursor moves, and ONE repaint of a busy screen is tens of KB. Any byte window
 * small enough to mean "the tail" can therefore miss text that is plainly
 * visible on screen (it landed earlier in the repaint), while a window big
 * enough to contain it also drags in stale scrollback. Rendering removes the
 * guess — what comes back is what a user would see.
 *
 * Cost is a full VT replay, so this is for rare paths (backlog delivery), not
 * per-frame checks.
 */
export async function screenText(core: SessionCore, id: string, lines = 40): Promise<string> {
  const s = core.sessions.get(id);
  if (!s) return "";
  const text = await renderCapture(s.scrollback, s.cols);
  return text.split("\n").slice(-lines).join("\n");
}

/**
 * The live grid as it stands THIS instant — the recorder's own VT
 * (`screenlog.ts`'s `gridText()`), a buffer read rather than `screenText`'s
 * replay, and synchronous, so a caller can read it and write in the same
 * tick with nothing painted in between (the budget's one Esc). `""` when the
 * session or its recorder is gone, which a caller must read as "unknown".
 */
export function liveGrid(core: SessionCore, id: string): string {
  return core.sessions.get(id)?.screenLog?.gridText() ?? "";
}

/**
 * What this session's terminal has SHOWN — the desktop's own scrollback.
 *
 * Served from the RECORDING (`screenlog.ts`), which is the only place it can
 * come from: measured on claude 2.1.267, every live pane reads
 * `history_size=0 alternate_on=1`, i.e. the CLI draws in the alternate screen
 * buffer, which by definition keeps no scrollback. A session running for
 * hours replays to one screen — 31 lines — whether the replay is our own VT
 * over the byte ring or tmux's `capture-pane -S -`. A line that scrolled away
 * was only ever visible while it was on the grid.
 *
 * The phone records the same thing from its own vantage point
 * (`web/screenlog.ts`), and the report is what that costs: "a copy-paste
 * result of random moments that duplicate lines and misses some as well."
 * Both halves are the vantage point, not the rule (which is shared, and
 * pure): the phone only sees a session while it is on screen and the app is
 * awake, so whole stretches were never captured — and a gap makes the next
 * sample unanchorable, which archives the outgoing screen WHOLE and lands the
 * same block twice on the way back. The daemon has neither problem.
 *
 * `history` is the honest half of the answer: false means nothing beyond the
 * current grid has been recorded yet (a session that just started, or one the
 * daemon only began watching at its last restart), and the phone must then
 * keep an archive of its own rather than throw it away for one screen.
 * `bounded` says the record itself has already dropped its oldest lines.
 */
export async function screenLines(core: SessionCore, id: string, max = SCREENLOG_MAX_LINES): Promise<{ lines: string[]; cols: number; history: boolean; bounded: boolean } | null> {
  const s = core.sessions.get(id);
  if (!s) return null;
  // The RECORDING, not a replay. This cannot be derived from the bytes after
  // the fact: the CLI draws in the alternate screen, which keeps no
  // scrollback, so replaying the whole ring answers with one screen however
  // long the session has run — measured on 2.1.267, `history_size=0
  // alternate_on=1` on every pane, and a session of hours coming back as 31
  // lines, from tmux's `capture-pane -S -` as readily as from our own VT.
  // `screenlog.ts` is what watches it happen instead.
  const log = s.screenLog?.lines() ?? [];
  if (log.length) {
    const lines = log.length > max ? log.slice(log.length - max) : log;
    return { lines, cols: s.cols, history: s.screenLog!.hasHistory(), bounded: log.length > max };
  }
  // Nothing recorded yet — a session that has just started, or one rebuilt
  // after a restart whose recording began then. The current screen is still
  // worth answering with, and `history: false` is what stops the phone
  // throwing away an archive of its own that is longer than this.
  const text = await renderCapture(s.scrollback, s.cols);
  const all = text ? text.split("\n") : [];
  const lines = all.length > max ? all.slice(all.length - max) : all;
  return { lines, cols: s.cols, history: false, bounded: s.seq > s.scrollback.length || all.length > max };
}

/**
 * The same replay, read back WITH the attributes (`render.ts`'s `renderCells`).
 *
 * One caller: `ocprompt.ts`, whose whole reason for existing is that opencode
 * marks the armed option of a permission dialog with a background colour and
 * nothing else. Everything in this daemon that reads a screen still reads
 * `screenText()`; this is not a better `screenText()` and must not become the
 * default one, because the per-cell walk is the expensive half of it.
 */
export async function screenCells(core: SessionCore, id: string, lines = 60): Promise<RenderRow[]> {
  const s = core.sessions.get(id);
  if (!s) return [];
  return renderCells(s.scrollback, s.cols, lines);
}

/**
 * Replay for a (re)attaching client. When `resumeSeq` is a point we still
 * retain (the client's terminal already holds everything up to it — a mobile
 * wake where the xterm survived), return ONLY the delta after it, so a
 * reconnect doesn't re-stream the whole scrollback (the reconnect-cost that
 * made every background/foreground feel like a reload). Otherwise — fresh
 * attach, session switch, or a resume point evicted from the capped buffer —
 * return the full scrollback (mode prefix + line-trimmed) and flag `full` so
 * the client resets its terminal first. `seq` is the client's new high-water
 * mark to send back next time.
 */
export function attachReplay(core: SessionCore, id: string, resumeSeq?: number): { data: string; seq: number; full: boolean } | null {
  const s = core.sessions.get(id);
  if (!s) return null;
  const sb = s.scrollback;
  const base = s.seq - sb.length; // oldest offset still in the buffer
  if (resumeSeq != null && resumeSeq >= base && resumeSeq <= s.seq) {
    return { data: sb.slice(resumeSeq - base), seq: s.seq, full: false };
  }
  return { data: scrollback(core, id), seq: s.seq, full: true };
}

export function idleMs(core: SessionCore, id: string): number | null {
  const s = core.sessions.get(id);
  if (!s || !s.info.running || !s.sawData) return null;
  return Date.now() - s.lastDataAt;
}

// ── a SHELL's input line (`caps.turns === false`), asked by `deliver.ts` ──

/** A process's command name as a person would say it: basename, no login `-`. */
const commName = (c: string): string => c.trim().replace(/^.*\//, "").replace(/^-/, "");

/** Programs that ARE a shell: a line sent to any of them is a command line,
 *  whether it is the pane's own shell or one started inside it (`bash` in zsh). */
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "mksh", "yash", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh"]);
/**
 * The shells whose line editor turns bracketed paste ON by default: zsh (5.1+,
 * `zle_bracketed_paste`) and fish (3.0+). Asked by NAME because the pane's
 * DECSET 2004 cannot be read: tmux 3.6 enables bracketed paste on its OWN
 * terminal at attach whatever the pane asked for (measured — a bash 3.2 pane
 * still shows `?2004h` on the client), and has no format for the pane's mode.
 * bash is left out on purpose: 5.1+ has it on, 3.2 (macOS's `/bin/sh`) has not,
 * and the name cannot tell them apart — so a multi-line send to bash is refused.
 */
const BRACKETED_SHELLS = new Set(["zsh", "fish"]);

export interface ShellLineFacts {
  /** The program in front of the shell (`vim`, `sleep`), or null when a shell has the terminal. */
  front: string | null;
  /** The shell in front takes a bracketed paste as ONE edit, held until Return. */
  bracketed: boolean;
}

/**
 * What a send into a shell session would be typed INTO, off tmux's
 * `pane_current_command` (the foreground process group's name). Asked by name,
 * not by pid: macOS's `/bin/sh` runs bash as its child, so the pane's own
 * process is not the shell the person is typing at. `bin` is the session's
 * configured shell. Unreadable (no pane) ⇒ nothing in front and no bracketed
 * paste: a single line goes as today, a multi-line one is refused.
 */
export async function shellLineFacts(_core: SessionCore, id: string, bin?: string): Promise<ShellLineFacts> {
  try {
    const { stdout } = await execFileP("tmux", ["-L", TMUX_SERVER, "display-message", "-p", "-t", tmuxName(id), "#{pane_current_command}"], { timeout: 1500 });
    const now = commName(stdout);
    if (!now) return { front: null, bracketed: false };
    const shell = SHELL_NAMES.has(now) || (!!bin && now === commName(bin));
    return { front: shell ? null : now, bracketed: shell && BRACKETED_SHELLS.has(now) };
  } catch { return { front: null, bracketed: false }; }
}
