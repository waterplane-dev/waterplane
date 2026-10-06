/**
 * The *explain the cost* prompt — shared by the context sheet's door and the
 * all-sessions screen's costliest-conversations rows, which live in two
 * features that may not import each other.
 */

/** What the explain-the-cost prompt is told about its subject. */
export interface CostSubject {
  title: string;
  cwd: string;
  /** The CLI's own conversation id — what names its transcript on disk. */
  claudeSessionId?: string;
  model?: string;
}

/**
 * The prompt the *explain the cost* door starts a new session with.
 *
 * A READING, never a change: the new session diagnoses what made THIS
 * conversation expensive and proposes fixes, then stops and asks — nothing
 * applies itself. It is told to measure the transcript with a script rather
 * than read it, because the conversations worth asking about are exactly the
 * ones too large to put in a window, and a diagnosis that costs as much as the
 * session it diagnoses is the failure it exists to explain. Null when the
 * subject has no conversation id: there would be no transcript to point at, and
 * a prompt that tells an agent to go looking guesses at the wrong file.
 */
export function explainCostPrompt(s: CostSubject): string | null {
  const id = s.claudeSessionId?.trim();
  if (!id) return null;
  return [
    `Explain what made one Claude Code session expensive, and outline how it could have been cheaper. Do NOT implement anything — no edits, no commits, no settings changes. This is an analysis; at the end, list the ideas and ask me which (if any) to implement.`,
    ``,
    `The session: "${s.title}"`,
    `- working directory: ${s.cwd}`,
    `- conversation id: ${id}${s.model ? `\n- model: ${s.model}` : ""}`,
    `- transcript: find it with \`ls ~/.claude/projects/*/${id}.jsonl\` — its subagents' logs are under ${id}/subagents/ beside it, if that exists.`,
    ``,
    `The transcript may be very large. Measure it with a script (node or jq over the JSONL "usage" fields), never by reading it whole into this conversation.`,
    ``,
    `Find out:`,
    `1. The totals split by token kind (input, cache write, cache read, output) and by main conversation vs subagents, with a list-price estimate for the model(s) used.`,
    `2. How the context grew turn by turn: the turns where it jumped and what caused each jump (large tool results, file dumps, images, long outputs, pasted content, skill or CLAUDE.md loads).`,
    `3. Cache behaviour: cache writes after gaps long enough for the cache to expire, compactions, and what they cost.`,
    `4. The subagents: how many, what each was for, what each cost, and whether any duplicated work.`,
    `5. The always-on baseline: the size of the first turn's context (system prompt, CLAUDE.md, skill descriptions, tools, MCP servers) and how much of the total it accounts for across all turns.`,
    `6. Whether the work should have been split into separate sessions, and where.`,
    ``,
    `Then give concrete, actionable ideas ranked by estimated saving, each naming what to change (a CLAUDE.md or skill trim, a habit, a subagent instead of inline reading, an earlier /compact or fresh session, a setting) and roughly how much it would have saved on this session. Keep the answer short and lead with the three biggest causes.`,
  ].join("\n");
}
