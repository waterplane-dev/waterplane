/**
 * The ONE place a `pending:` screen id is made, recognised and taken apart.
 *
 *   pending:<createAck>   a queued `session.create` standing as a session screen
 *   pending:later:<cwd>   the repo header's `+ later` screen (no create behind it)
 *
 * Pure: no React, no storage. `logic.ts` re-exports these; nothing else spells the prefix.
 */
export const PENDING_PREFIX = "pending:";
export const LATER_PREFIX = `${PENDING_PREFIX}later:`;

/** Any synthetic screen id: a create's or a `+ later`'s. */
export const isPendingId = (id: string | null | undefined): boolean => !!id?.startsWith(PENDING_PREFIX);
export const isLaterId = (id: string | null | undefined): boolean => !!id?.startsWith(LATER_PREFIX);
/** The screen id of a create's pending session (also the draft key and the shell tab's remembered id). */
export const makePendingId = (createAck: string): string => `${PENDING_PREFIX}${createAck}`;
export const laterId = (cwd: string): string => `${LATER_PREFIX}${cwd}`;

/** The create's ackId behind a `pending:<createAck>` id; null for anything else, `+ later` included. */
export function parsePendingId(id: string | null | undefined): string | null {
  if (!id || !id.startsWith(PENDING_PREFIX) || isLaterId(id)) return null;
  return id.slice(PENDING_PREFIX.length) || null;
}
/** The repo behind a `pending:later:<cwd>` id; null for anything else. */
export function parseLaterId(id: string | null | undefined): string | null {
  if (!id || !id.startsWith(LATER_PREFIX)) return null;
  return id.slice(LATER_PREFIX.length) || null;
}
