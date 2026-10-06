/**
 * Per-session store for the reconstructed alt-screen scrollback.
 *
 * The rule that decides what scrolled off lives in `@waterplane/shared`
 * (`screenlog.ts`, with the reasoning); this file is the client half: it holds
 * one log per session in memory, and persists the ARCHIVE to IndexedDB so a
 * reload with the tunnel down still has something to scroll.
 *
 * Only `archived` is stored. The live grid is whatever xterm is showing — a
 * cold start paints the persisted PTY tail (App.tsx) and the first snapshot
 * after that re-establishes `screen` on its own. Storing it too would put the
 * same rows on disk twice and let them come back doubled.
 *
 * Best-effort in every direction, like the rest of the offline caches: a failed
 * read or write costs history, never the app.
 */
import { absorbScreen, newScreenLog, screenLogLines, type ScreenLogState } from "@waterplane/shared";
import { idbClear, idbDel, idbGetAll, idbSet } from "./idb";

const STORE = "screenlog";
/** Newest N sessions kept, matching the PTY-tail cache: falling out means that
 *  session's history starts again from what this tab renders next. */
const MAX_SESSIONS = 12;

interface StoredLog { sessionId: string; archived: string[]; savedAt: number }

const logs = new Map<string, ScreenLogState>();
/** Sessions whose archive changed since the last save — a save that writes
 *  nothing new would only move `savedAt` and churn the prune order. */
const dirty = new Set<string>();

function readScreenLog(sessionId: string): ScreenLogState {
  return logs.get(sessionId) ?? newScreenLog();
}

/** Lines a reader should show: what scrolled away, then what is on screen. */
export function screenLogFor(sessionId: string): string[] {
  return screenLogLines(readScreenLog(sessionId));
}

/** True once there is more history than the grid already shows — i.e. once
 *  offering a local scrollback would actually give the user something. */
export function hasScrollback(sessionId: string): boolean {
  return (logs.get(sessionId)?.archived.length ?? 0) > 0;
}

/** Fold one settled screen snapshot in. Returns true when the archive grew. */
export function absorb(sessionId: string, lines: string[]): boolean {
  const before = logs.get(sessionId) ?? newScreenLog();
  const after = absorbScreen(before, lines);
  if (after === before) return false;
  logs.set(sessionId, after);
  if (after.archived === before.archived) return false;
  dirty.add(sessionId);
  return true;
}

/** Seed from disk at boot. Never overwrites a log this tab already grew. */
export async function hydrateScreenLogs(): Promise<void> {
  const all = (await idbGetAll<StoredLog>(STORE)) ?? [];
  for (const e of all) {
    if (!e?.sessionId || logs.has(e.sessionId)) continue;
    logs.set(e.sessionId, newScreenLog(e.archived ?? []));
  }
}

/** Persist one session's archive. Called on the same beats as the PTY tail
 *  (interval, `pagehide`/`freeze`, leaving the session). */
export async function saveScreenLog(sessionId: string): Promise<void> {
  if (!dirty.has(sessionId)) return;
  const state = logs.get(sessionId);
  if (!state || state.archived.length === 0) return;
  dirty.delete(sessionId);
  await idbSet(STORE, sessionId, { sessionId, archived: state.archived, savedAt: Date.now() } satisfies StoredLog);
  const all = (await idbGetAll<StoredLog>(STORE)) ?? [];
  if (all.length <= MAX_SESSIONS) return;
  for (const stale of [...all].sort((a, b) => b.savedAt - a.savedAt).slice(MAX_SESSIONS)) {
    await idbDel(STORE, stale.sessionId);
  }
}

/**
 * Throw away every reconstructed scrollback — disk AND this tab's memory.
 *
 * The storage screen's button (`storageAudit.ts`). Clearing the store alone
 * would be a lie with a delay: `logs` still holds every line, `dirty` still
 * names the sessions that changed, and the next save beat writes the same
 * megabytes back. The memory copy is also the one the reader is drawing from,
 * so leaving it would show scrollback that a person has just been told is
 * gone.
 *
 * This is the one cache here that CANNOT be re-fetched (the TUI's scrollback is
 * not on the wire) — which is why it is a `keep` row on that screen and needs a
 * second tap, not why it needs a different implementation.
 */
export async function forgetScreenLogs(): Promise<boolean> {
  logs.clear();
  dirty.clear();
  return idbClear(STORE);
}
