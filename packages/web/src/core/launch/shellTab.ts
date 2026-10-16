/**
 * "Take me to a shell, and back" — the pure half of `launch.focusShell` (`CoreApi`), the seam a
 * sheet uses when its job is half on the phone and half at a prompt on the desktop (a setup that
 * prints a code to type, a command the sheet tells you to run). Without it the person flipped by
 * hand: close the sheet, find or open a shell tab, then dig the sheet back out of Settings.
 *
 * Two facts, both remembered per KEY (the caller's own name for "its" shell, memory-only):
 *  - which shell tab that key last went to — the next tap REUSES it rather than opening another,
 *    so going back and forth twenty times is still one shell;
 *  - where the person came FROM (`ReturnTo`): a one-tap way back drawn on exactly that shell's
 *    screen, never on any other session.
 *
 * Which tab a tap lands on (`pickShell`), in order: the remembered one while it is still alive (a
 * pending open still in the queue counts — it IS a session screen); else a running plain shell
 * already open in the same folder (not a companion, which belongs to another session); else a
 * fresh one. A pending open is re-keyed onto its real id when the host names it
 * (`adoptedShell`), or the remembered tab would be lost the moment it opened.
 *
 * Pure: no React, no store, no socket. The runtime half is `shellReturn.ts`.
 */
import type { SessionInfo } from "@waterplane/shared";
import type { ReturnTo } from "../../sdk/types.ts";

export type { ReturnTo };

const PENDING = "pending:";

/** A session as far as picking a shell needs it. */
export type ShellCandidate = Pick<SessionInfo, "id" | "cwd" | "running" | "backend" | "companionOf">;

export type ShellPick =
  | { do: "attach"; id: string }
  | { do: "enter"; ack: string }
  | { do: "open" };

/**
 * Which shell tab a tap goes to — see the file comment for the order.
 * `pendingAlive(ack)` says the create behind a pending id is still queued (not failed).
 */
export function pickShell(i: {
  remembered: string | null;
  sessions: readonly ShellCandidate[];
  isShell(backend: string | undefined): boolean;
  cwd: string;
  pendingAlive(ack: string): boolean;
}): ShellPick {
  const r = i.remembered;
  if (r?.startsWith(PENDING)) {
    const ack = r.slice(PENDING.length);
    if (i.pendingAlive(ack)) return { do: "enter", ack };
  } else if (r) {
    const s = i.sessions.find((x) => x.id === r);
    if (s && s.running) return { do: "attach", id: s.id };
  }
  const same = i.sessions.find((x) => x.running && !x.companionOf && x.cwd === i.cwd && i.isShell(x.backend));
  return same ? { do: "attach", id: same.id } : { do: "open" };
}

/** The remembered id after the host named pending `pending:<createAck>` as `sessionId`: moved
 *  when it was that open, unchanged otherwise. */
export function adoptedShell(remembered: string | null, createAck: string, sessionId: string): string | null {
  return remembered === `${PENDING}${createAck}` ? sessionId : remembered;
}

/** Re-key every remembered id at once (the per-key map and the return target share one rule). */
export function adoptAll(map: Readonly<Record<string, string>>, createAck: string, sessionId: string): Record<string, string> {
  let changed = false;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const n = adoptedShell(v, createAck, sessionId)!;
    if (n !== v) changed = true;
    out[k] = n;
  }
  return changed ? out : (map as Record<string, string>);
}

/** The chip's words: "back to <label>". */
export function returnWords(label: string): string {
  return `back to ${label}`;
}

/** Whether the return chip belongs on the session screen showing `activeId`. */
export function returnShownOn(ret: { sessionId: string } | null, activeId: string | null | undefined): boolean {
  return !!ret && !!activeId && ret.sessionId === activeId;
}
