/**
 * The CLI's own proposal for the next prompt, read off the rendered grid.
 *
 * After a turn, claude draws a suggested next prompt in its EMPTY composer, in
 * DIM (SGR 2) — the text Tab accepts at the desk. Measured on 2.1.x across
 * ~40 live panes: `❯ \e[2mwatch CI and report when it finishes\e[0m`, the whole
 * proposal dim, nothing else on the row. The phone has no Tab-and-look, so the
 * host publishes it (`SessionInfo.cliSuggestion`) and the phone offers it as
 * one tap.
 *
 * Two reads of the same composer decide it, the way `deliverscreen.ts` tells a
 * typed word from a hint: the PLAIN render holds the words, the render with dim
 * cells blanked (`RenderRow.undimmed`) holds nothing. Words that survive the
 * blanking were typed by somebody, and are never a proposal.
 *
 * claude's other dim text in that box is its generic first-run placeholder,
 * `Try "how does <filepath> work?"` — an example, not a proposal about THIS
 * conversation — so it is refused by shape.
 *
 * A repaint can leave letters on the box's closing rule (`─────ing`, live on a
 * phone 2026-11-07). That row is no longer a rule, so the box runs on into the
 * footer and the plain read holds `─────ing ⏵⏵ auto mode on · 1 shell`. So the
 * box must be CLOSED by a rule, and what it holds must carry no run of rule.
 *
 * Degrades to null: no box in either read, an unclosed box, a box holding typed
 * words, a placeholder, rule glyphs. Never a guess.
 */
import { CLAUDE_COMPOSER, COMPOSER_RULE_RE, composerHeld, composerSpans } from "./composer.js";

/** Longer than any proposal measured (they are one short line); a cap so a
 *  misread screen can never publish a paragraph as one tap. */
export const CLI_SUGGESTION_MAX = 300;

/** claude's generic empty-composer example, not a proposal. */
const PLACEHOLDER_RE = /^Try "/;

/** A piece of the box's own border inside what it holds: a torn frame, not words. */
const RULE_RUN_RE = /[\u2500\u2501\u2504\u2505\u2508\u2509]{4,}/;

/** Does a rule sit straight after the live box's rows? A span stops at its
 *  closing rule, or at the end of the rows when nothing closed it. */
function boxClosed(rows: readonly string[]): boolean {
  const live = composerSpans(rows).at(-1);
  if (!live) return false;
  return COMPOSER_RULE_RE.test((rows[live.at + live.rows.length] ?? "").trim());
}

/**
 * The proposal the composer is showing, or null.
 *
 * `plainRows` is the rendered grid as text; `undimmedRows` is the same grid
 * with dim cells blanked, from the SAME frame: a later frame's clean box would
 * vouch for an earlier torn one. Both are read with claude's composer anchors.
 */
export function cliSuggestionOf(plainRows: readonly string[], undimmedRows: readonly string[]): string | null {
  const plain = composerHeld(plainRows, CLAUDE_COMPOSER);
  if (!plain) return null;
  if (!boxClosed(plainRows) || RULE_RUN_RE.test(plain)) return null;
  // "" = the same box, empty once the dim cells are gone. null = no box in
  // that read at all (a torn frame), which proves nothing either way.
  if (composerHeld(undimmedRows, CLAUDE_COMPOSER) !== "") return null;
  if (PLACEHOLDER_RE.test(plain)) return null;
  if (plain.length > CLI_SUGGESTION_MAX) return null;
  return plain;
}

/** The cheap gate: what the plain grid's composer holds, before paying for a
 *  render with attributes. Null = empty box or no box. */
export function composerPlain(plainRows: readonly string[]): string | null {
  return composerHeld(plainRows, CLAUDE_COMPOSER) || null;
}
