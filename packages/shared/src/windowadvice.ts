/**
 * **How much of a small model's window Claude Code itself takes, said in words.**
 *
 * Measured 2026-10-01 (`docs/analysis/spikes/2026-10-01-claude-local.md`): the
 * real `claude` CLI pointed at a local runner sends ~34k tokens of its own
 * system prompt, tool schemas and instructions with the very first message —
 * over half of a 64k Ollama window — before the person has typed a word worth
 * the name. Nobody choosing that model in the picker could have known.
 *
 * Both numbers are MEASUREMENTS and both must be present, or there is no
 * sentence at all:
 *
 *  - `windowTok` — what the runner is configured to hold (`num_ctx`, or the
 *    endpoint's configured window), never claude's 200k table;
 *  - `overheadTok` — the input of the FIRST request of the most recent
 *    conversation that ran this model, read off the CLI's own log. It includes
 *    that first message, which is why the sentence says "the first request" and
 *    never claims a number for the instructions alone.
 *
 * Silent below `ADVICE_SHARE`: a 200k window giving 34k to the CLI is the
 * normal shape of every claude session and saying so under every model would
 * be furniture. Absent beats borrowed — an unmeasured overhead is never
 * guessed from another model's.
 */
import { fmtCount } from "./tokens.js";

/** The share of the window the first request must take before it is worth a sentence. */
export const ADVICE_SHARE = 0.25;

/** A positive, finite whole number of tokens, or null. */
function tok(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * The sentence, or null when either number is unmeasured or the share is too
 * small to matter. Pure; both ends word it through here.
 */
export function windowAdviceText(windowTok: unknown, overheadTok: unknown): string | null {
  const w = tok(windowTok);
  const o = tok(overheadTok);
  if (w === null || o === null) return null;
  const share = o / w;
  if (share < ADVICE_SHARE) return null;
  const left = w - o;
  const whole = `${fmtCount(w)} window, ~${fmtCount(o)} of it used by the first request of the last session on this model (mostly Claude Code's own instructions and tools)`;
  if (left <= 0) return `${whole} — that is the whole window, so the runner will cut the prompt. Pick a model with a larger window.`;
  return `${whole} — ~${fmtCount(left)} is left for the conversation.`;
}
