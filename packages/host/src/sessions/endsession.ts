/**
 * Ending a session: what a REAL exit of its PTY tears down, in order — the session stops
 * running, its recorder and capture are sealed, every timer is cleared, the agents/shells it
 * showed are retired, the reopen entry is written and a limit-exit is offered a resurrection.
 *
 * Separate from `SessionManager.register` (which wires the PTY) so the teardown can be run
 * against a fake `SessionCore` without a PTY. A tmux DETACH is not an end and never comes here.
 * Like every slice it reaches another slice only through `core` (`core.finalizeCapture`), and
 * the exit log line arrives as a fact — the facade formats it with `tmux.exitReport`.
 */
import { namesStoreReader } from "../backends/index.js";
import type { Session, SessionCore } from "./core.js";

/** What the PTY said on its way out, and the one resume-ladder fact the closed row needs. */
export interface EndFacts {
  /** `exitReport(...)` of the info as it stood at exit — logged first, before any teardown. */
  exitLine: string;
  exitCode: number | null | undefined;
  signal: number | null | undefined;
  /** `resume.diedAtLimit(id)` — asked at the end, after the ids are adopted. */
  diedAtLimit: (id: string) => boolean;
}

export function endSession(core: SessionCore, session: Session, facts: EndFacts): void {
  const id = session.info.id;
  console.log(facts.exitLine); // before teardown
  session.info.running = false;
  session.turnActive = false;
  session.info.turnActive = false; // a dead PTY is never mid-turn
  // …and never parked on a dialog. The verifier no longer clears these on
  // output, so the exit path has to.
  session.info.prompt = null;
  session.info.awaitingInput = undefined;
  session.info.asking = null; // nor waiting on an answer it can no longer read
  session.info.cliSuggestion = null; // nor proposing a prompt nobody can type
  session.info.login = null;
  delete session.info.links; // a shell's links (`sessions/links.ts`) die with it
  delete session.info.awaitingCode;
  // The recorder's VT is freed, not its archive: `lines()` still answers
  // from the state it has (what scrolled off, plus the last grid it read),
  // so the scrollback of a session that just exited is still readable.
  // Nothing will be added to it — the PTY is gone.
  session.screenLog?.dispose();
  core.finalizeCapture(session);
  if (session.promptTimer) clearTimeout(session.promptTimer);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  core.retireAgentPoll(session);
  core.checkAgents(session); // running is false: clears agents/shells/shellList, arms nothing
  core.clearStopVerify(session);
  core.clearLimitTimer(session);
  core.stopClaudeIdWatch(session);
  // Last chance to learn which conversation this was, so the reopen/recent
  // entries below can target it exactly.
  if (!session.info.claudeSessionId) core.adoptClaudeId(session, core.detectClaudeId(session));
  // …and the same last chance for the other backend's own id, so a reader
  // opened right after the session died still has a conversation to read.
  if (!session.info.backendSessionId && namesStoreReader(session.backend)) {
    core.adoptBackendId(session, core.detectBackendId(session));
  }
  // A real exit (claude quit / killed) ⇒ the tmux session is gone too; drop
  // its metadata so a later rediscover doesn't try to re-attach a corpse.
  core.deleteLive(id);
  // Remember it as reopenable (newest-first, deduped per session — each
  // conversation reopens individually via --resume <claudeSessionId>).
  // Restores the same launch flags.
  // No `exitCode`/`signal` on the row or the wire: the PTY we hold is the tmux
  // CLIENT, whose code is 0 whatever the CLI exited with — passing it on would
  // be a wrong number where the honest answer is "unknown" (absent). The
  // client's own code still goes into `exitReport`'s log line, labelled as such.
  core.pushClosed(core.closedRowOf(session, false, { by: session.closeBy ?? (session.killed ? undefined : facts.diedAtLimit(id) ? "limit" : "exited") }));
  core.emit("updated", session.info);
  core.emit("exit", id, null);
  // Newer `claude` EXITS on a usage limit (and quits) instead of parking at a
  // wait-menu — so there's no live PTY for auto-continue to type into.
  // Resurrect the conversation with `--continue` at the reset time so the
  // session (and any backlog work) comes back on its own. Gated by
  // auto-continue + the attempts cap; never for a user kill.
  core.maybeScheduleResurrect(session);
}
