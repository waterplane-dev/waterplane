/** The rules a claude composer frame is drawn between — `composer.ts` reads the frame. */

/**
 * The composer's own full-width rules, above and below its input row.
 *
 * Shared with `prompt.ts` — the CONSTANT, deliberately not the semantics. That
 * file asks "has this dialog been ANSWERED", so its notion of a composer row is
 * and should be loose; this file asks "is this the box the user is typing
 * into", where the same looseness is the bug (see `COMPOSER_CURSOR_RE`).
 *
 * The opening rule may wear a label at its right end: `──────── ultracode ─`,
 * for as long as ultracode is on. Refusing that shape placed no box at all, so
 * every read of the composer answered "no opinion" — and a dim proposal equal
 * to the words being sent read as "already typed": nothing typed, five Returns
 * into an empty box, `unsubmitted` (live, 2026-11-06).
 */
export const COMPOSER_RULE_RE = /^(?:[\u2500\u2501\u2504\u2505\u2508\u2509]{20,}(?:\s+\S(?:.*\S)?\s+[\u2500\u2501\u2504\u2505\u2508\u2509]{1,4})?|[\u2500\u2501\u2504\u2505\u2508\u2509]{1,4}\s+[\u2191\u2193]\s*\d+\s+more\s+[\u2500\u2501\u2504\u2505\u2508\u2509]{20,})$/;

/** A box scrolled past its first line opens `─── ↑ 75 more ───…` with NO `❯` in the frame
 *  (live 2026-11-21: unread, a 69-line prompt came back `unconfirmed` 5×; `echo.test.mjs`). */
export const COMPOSER_SCROLLED_RULE_RE = /^[\u2500\u2501\u2504\u2505\u2508\u2509]{1,4}\s+\u2191\s*\d+\s+more\s+[\u2500\u2501\u2504\u2505\u2508\u2509]{20,}$/;
