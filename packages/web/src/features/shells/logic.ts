/**
 * The shells sheet's pure half — no React, no DOM — so `logic.test.mjs` runs
 * it under `node --test`.
 */
import type { SessionInfo } from "@waterplane/shared";

/**
 * WHICH session the sheet is about: `sid` when a row's own chip opened it,
 * the attached one otherwise. An id that no longer names a row (the session
 * closed while the sheet was up, or a restored route carried a stale one)
 * falls back to the attached session rather than painting an empty sheet
 * about nothing; null when there is neither — `context`'s `contextSubject`,
 * one copy.
 */
export function shellsSubject(sid: string | null, sessions: readonly SessionInfo[], active: SessionInfo | null): SessionInfo | null {
  return (sid ? sessions.find((s) => s.id === sid) : null) ?? active;
}

/** The receipt for a `shell.kill` once the host answers `shell.killed` —
 *  never the wording `liveSend`'s own optimistic "stopping…" toast carries,
 *  because only this one knows whether it actually worked. */
export function shellKilledToast(ok: boolean, reason?: string): string {
  if (ok) return "stopped";
  return reason ? `not stopped — ${reason}` : "not stopped";
}

/**
 * The follow-up toast off `session.closed` — CLAUDE.md's decision that
 * closing a session stops its shells, fully, said out loud, now that it has
 * actually happened (the close verb's own toast, at the tap, only ever says
 * it is STARTING to).
 *
 * Null when there is nothing to report either way: the ordinary "archived …"
 * toast the close verb already raised at the tap says everything there is to
 * say, and a second toast reading "stopped 0 background shells" would be the
 * token spelling of "nothing happened" dressed up as news.
 *
 * `shellsLeft` — a group that refused to die — is named too, when it is
 * nonzero: silently dropping it would hide the one case this whole receipt
 * exists to catch.
 */
export function sessionClosedShellsToast(shellsStopped: number, shellsLeft = 0): string | null {
  if (!shellsStopped && !shellsLeft) return null;
  const stopped = `stopped ${shellsStopped} background shell${shellsStopped === 1 ? "" : "s"} when the session closed`;
  return shellsLeft > 0 ? `${stopped} · ${shellsLeft} did not stop` : stopped;
}

/**
 * Session ids THIS PHONE asked to close, held in memory only until the
 * host's `session.closed` answers back for them.
 *
 * `session.closed` is a BROADCAST — every open phone gets it, not only the
 * one that asked — so without this, one phone's close toasted "stopped N
 * background shells" on every OTHER open phone too, restating a receipt
 * nobody there asked for. `notePendingClose` is called at the moment THIS
 * phone SENDS `session.remove` (`CloseSheet.tsx`'s foot and the per-row × in
 * `useSessionVerbs.ts`, both via `actions.ts`'s `noteSessionClosing`);
 * `takePendingClose` is `onSessionClosed`'s gate, consuming the mark either
 * way — a `session.closed` for one id is only ever answered once. A plain
 * module `Set`, not a `createStore`: nothing here is ever rendered.
 */
const pendingClose = new Set<string>();

/** Mark that this phone just sent `session.remove` for `id`. */
export function notePendingClose(id: string): void {
  pendingClose.add(id);
}

/** Was this phone the one that asked to close `id`? */
export function takePendingClose(id: string): boolean {
  return pendingClose.delete(id);
}

/** The receipt for `lineToShell`: where the line went and that it has NOT run. */
export function toShellToast(o: { leftCli: boolean; already: boolean; joined: boolean }): string {
  const cli = o.leftCli ? " CLI mode is off so you can see it." : "";
  if (o.already) return `already in the shell's box — tap Send to run it.${cli}`;
  if (o.joined) return `in the shell's box, under words that were already there — send only what you mean to run.${cli}`;
  return `in the shell's box — tap Send to run it.${cli}`;
}
