import { fmtTok, fmtUsd, turnTokensText, type TranscriptTurn } from "@waterplane/shared";
import { turnModels } from "./turnMix.ts";

/**
 * Which turn the terminal's cost strip speaks for, and the words that say so.
 *
 * Pure, because the strip under the terminal is the one place this card is
 * drawn WITHOUT the turn beside it: in the reader the card sits under its own
 * prompt, so "this prompt" needs no qualifier; under a live grid it must say
 * WHICH prompt — the one that just ended, the one still running (as far as the
 * log has got), or the previous one while a new one runs.
 */

/** Subagents a turn started: the host's sidechain count plus the Task/Agent
 *  tool calls in its blocks — the reader's count, moved here so both surfaces
 *  share it. */
export const turnAgents = (t: TranscriptTurn): number =>
  t.sidechains + t.blocks.filter((b) => b.kind === "tool" && (b.name === "Task" || b.name === "Agent")).length;

const pos = (n: number | undefined): n is number => n != null && Number.isFinite(n) && n > 0;

/**
 * A turn has FIGURES when there is a measured number to draw: a price, a
 * context reading, a token split or a model that ran. A backend that records
 * none (or a `/btw` screen turn, a compaction divider, a queued prompt) has
 * none — and the strip is then absent, never a row of zeros.
 */
export function hasFigures(t: TranscriptTurn): boolean {
  if (t.marker || t.queued) return false;
  return pos(t.costUsd) || pos(t.ctxTok) || pos(t.cumCostUsd) || pos(t.agentCostUsd)
    || turnTokensText(t.tokens) != null
    || turnModels(t).some((m) => m.tok > 0);
}

/** The newest turn with figures, or null. Not always the LAST turn: a newer
 *  one may be a screen turn the CLI never logged, or still queued. */
export function lastCostTurn(turns: readonly TranscriptTurn[]): TranscriptTurn | null {
  for (let i = turns.length - 1; i >= 0; i--) if (hasFigures(turns[i])) return turns[i];
  return null;
}

/** Whether any turn up to and including `id` started a subagent — the
 *  reader's `agentsSoFar`, for one turn. */
export function agentsSoFarAt(turns: readonly TranscriptTurn[], id: string): boolean {
  for (const t of turns) {
    if (turnAgents(t) > 0) return true;
    if (t.id === id) return false;
  }
  return false;
}

/** Turn start (hook clock) vs. the logged prompt time — both the host's clock,
 *  but written by two processes a moment apart. */
const START_SLACK_MS = 10_000;

/** `earlier`: a finished turn that is not the newest — the reader draws the
 *  same fold under every turn, and only the newest is "the last". */
export type LastTurnWhich = "last" | "running" | "previous" | "earlier";

/**
 * Which prompt the figures are about, given the session's live state.
 *
 * - `last`: nothing is running — the newest prompt, finished.
 * - `running`: a turn is in flight and the log already holds it — PARTIAL.
 * - `previous`: a turn is in flight the fetched log does not hold yet — the
 *   figures are the one before it, and the strip refreshes when it ends.
 */
export function lastTurnWhich(t: TranscriptTurn, busy: boolean, turnStartedAt?: number): LastTurnWhich {
  if (!busy) return "last";
  if (turnStartedAt != null && t.sentAt != null && t.sentAt >= turnStartedAt - START_SLACK_MS) return "running";
  return "previous";
}

/** The label in front of the figures, in words. */
export function lastTurnLabel(t: TranscriptTurn, which: LastTurnWhich): string {
  const n = `#${t.n}`;
  if (which === "running") return `prompt ${n} so far · running`;
  if (which === "previous") return `prompt ${n} · a newer one is running`;
  if (which === "earlier") return `prompt ${n}`;
  return `last prompt ${n}`;
}

/** The sentence the one-line label has no room for, drawn at the top of the
 *  expanded card; null when the label already says everything. */
export function lastTurnNote(which: LastTurnWhich): string | null {
  if (which === "running") return "Figures for the prompt still running, as far as its log has got; they are re-read when it ends.";
  if (which === "previous") return "The prompt now running is not in the log yet — its figures replace these when it ends.";
  return null;
}

/**
 * The collapsed chip: the dollar figure and the context, one line —
 * `$21.47 · 306k ctx`. Falls back to the token total when the turn has no
 * price (an unpriced model), and to null when it has neither, in which case
 * the chip shows the label alone. Never a `$0`.
 */
export function lastTurnChip(t: TranscriptTurn): string | null {
  const usd = pos(t.costUsd) ? t.costUsd + (pos(t.agentCostUsd) ? t.agentCostUsd : 0) : null;
  const tok = t.tokens
    ? [t.tokens.input, t.tokens.output, t.tokens.cacheRead, t.tokens.cacheWrite].reduce((a, v) => a + (pos(v) ? v : 0), 0)
    : 0;
  const head = usd != null ? fmtUsd(usd) : tok > 0 ? `${fmtTok(tok)} tokens` : null;
  const ctx = pos(t.ctxTok) ? `${fmtTok(t.ctxTok)} ctx` : null;
  const parts = [head, ctx].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
