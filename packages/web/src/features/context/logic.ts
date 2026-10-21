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

/** The receipt for "interrupt and re-plan": the Esc went and the prompt is queued (one sentence, one toast). */
export function replanDoneToast(title: string): string {
  return `sent Esc to ${title} and queued the re-plan prompt`;
}

/** Said when the socket is not open: Esc is a live key, so it is never queued and the prompt is not either. */
export function replanBlockedToast(title: string): string {
  return `no connection — Esc did not reach ${title}, and the re-plan prompt was not queued. Try again when the link is back.`;
}

/** The line under the button: what Esc does, and what it costs. */
export const REPLAN_NOTE =
  "Sends Esc, which stops the agent the session is waiting on, then queues a prompt asking the main agent to re-plan it narrower. Work that agent has not reported back is lost. An agent running in the background keeps going; the prompt asks the main agent to stop it.";

// The session's own budget, worded once (top-level) for this panel and the budget sheet.
export { budgetStateLine as budgetLine } from "../../budgetInput.ts";
