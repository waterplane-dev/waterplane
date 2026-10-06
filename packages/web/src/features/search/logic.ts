/**
 * The search feature's one decision, pure: whether a `session.searchResults`
 * frame belongs to what the sheet is showing now.
 */

/** Only results whose scope matches the sheet's current scope land — a stale
 *  reply from a just-closed session scope must not clobber the new one. An
 *  absent id is the all-sessions scope (null). */
export function acceptsResults(msgId: string | undefined, scope: string | null): boolean {
  return (msgId ?? null) === scope;
}
