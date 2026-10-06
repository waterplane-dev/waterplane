/**
 * The context sheet's pure half — no React, no DOM — so `logic.test.mjs` runs
 * it under `node --test`.
 */

/**
 * WHICH session the sheet is about: `sid` when a launcher row's cost tile
 * opened it, the attached one otherwise. An id that no longer names a row (the
 * session was closed while the sheet was up, or a restored route carried a
 * stale one) falls back to the attached session rather than painting an empty
 * sheet about nothing; null when there is neither.
 */
export function contextSubject<S extends { id: string }>(sid: string | null, sessions: readonly S[], active: S | null): S | null {
  return (sid ? sessions.find((x) => x.id === sid) : null) ?? active;
}

/** The receipt for `/compact` sent from the cost panel. */
export function compactToast(online: boolean, title: string): string {
  return online ? `sent /compact to ${title}` : "queued /compact — sends when the link is back";
}

// The session's own budget, worded once (top-level) for this panel and the budget sheet.
export { budgetStateLine as budgetLine } from "../../budgetInput.ts";
