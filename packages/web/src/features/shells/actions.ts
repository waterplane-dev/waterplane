/**
 * Every writer of the shells feature's store, and the two things it sends.
 */
import { companionToggle, type SessionInfo, type SessionShell } from "@waterplane/shared";
import { copyText } from "../../api";
import { core } from "../../sdk";
import { notePendingClose, sessionClosedShellsToast, shellKilledToast, takePendingClose, toShellToast } from "./logic";
import { shellsSid } from "./store";

/** Open the shells sheet for ONE session — a row's own chip, or the launcher's
 *  "shells" filter opening a row that then opens this. Deliberately no
 *  `attach`: the sheet reads `shellList` off the `SessionInfo` it is already
 *  handed, so the numbers open with no PTY spawned or switched to. */
export function openShellsFor(s: SessionInfo): void {
  const c = core();
  c.say.track("action:session.shells");
  shellsSid.set(s.id);
  c.nav.open("shells");
}

/** Open the shells sheet on the ATTACHED session — the reader's status strip. */
export function openShells(): void {
  shellsSid.set(null);
  core().nav.open("shells");
}

/**
 * A command the agent asked the person to run (`! gh pr close 11 …`, `bangLine.ts`) into `s`'s
 * companion shell — the header's `Shell` tab: the live one when there is one, else a new one
 * opened the burger's way (`openCompanionShell`). SEEDED into that shell's box on its own line
 * (`seedDraft` `ownLine`), never sent: the person reads it and taps Send. No shell on this
 * desktop ⇒ the line is copied instead. Every outcome is a toast.
 */
export function lineToShell(s: SessionInfo, line: string): void {
  const c = core();
  c.say.track("action:shell.fromReader");
  const cant = c.launch.shellCant();
  if (cant) { void copyText(line); c.say.toast(`${cant} — the line is copied instead`); return; }
  const pair = companionToggle(s, c.world.sessions);
  let sid: string | null;
  if (pair?.to === "shell" && pair.target.running) { c.nav.attach(pair.target); sid = pair.target.id; }
  else sid = c.launch.openCompanionShell(s);
  if (!sid) return; // openCompanionShell toasted why
  c.say.toast(toShellToast(c.compose.seedDraft(sid, line, { ownLine: true })));
}

export function closeShells(): void {
  shellsSid.set(null);
  core().nav.close("shells");
}

/**
 * Stop ONE background shell — its whole process group (host `killShellGroup`).
 *
 * `shell.kill` carries no ackId and is never queued offline (CLAUDE.md: a kill
 * delivered an hour late hits whatever now holds that pid, not the shell the
 * person tapped stop on) — `liveSend` is the receipt for the TAP itself
 * ("stopping…", or the offline refusal), and the definitive outcome — did it
 * actually die — is a second, later toast off the `shell.killed` reply
 * (`onShellKilled`), because only that message knows.
 */
export function killShell(s: SessionInfo, sh: SessionShell): void {
  const c = core();
  c.say.track("action:shell.kill");
  c.conn.liveSend(
    { t: "shell.kill", id: s.id, pid: sh.pid, startedAt: sh.startedAt },
    "stopping…",
    "no connection — the desktop didn't get that, the shell is still running",
  );
}

/** The host's answer to `killShell` — the outcome `liveSend`'s own toast
 *  cannot know at tap time. */
export function onShellKilled(msg: { ok: boolean; reason?: string }): void {
  core().say.toast(shellKilledToast(msg.ok, msg.reason));
}

/**
 * Mark that THIS phone just sent `session.remove` for a session — the two
 * callers are `CloseSheet.tsx`'s foot (one call per row in its send list) and
 * `useSessionVerbs.ts`'s per-row × (`closeSession`, `onCloseCheck`). Call it
 * right beside the `send`/`liveSend` that ships `session.remove`, so the mark
 * exists before the host's `session.closed` can possibly come back for it.
 */
export function noteSessionClosing(id: string): void {
  notePendingClose(id);
}

/** `session.closed` — CLAUDE.md's "closing a session stops its shells, fully"
 *  said as a toast, when there was something to say.
 *
 * `session.closed` is a BROADCAST: every open phone gets it, not only the one
 * that asked. `takePendingClose` is the gate — a toast fires here ONLY on the
 * phone that sent `session.remove` for this id (`logic.ts`'s `notePendingClose`,
 * set by `CloseSheet.tsx` and `useSessionVerbs.ts`); every other phone stays
 * quiet about a close it never asked for. */
export function onSessionClosed(id: string, shellsStopped: number, shellsLeft: number): void {
  if (!takePendingClose(id)) return;
  const text = sessionClosedShellsToast(shellsStopped, shellsLeft);
  if (text) core().say.toast(text);
}
