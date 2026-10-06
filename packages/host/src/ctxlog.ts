/**
 * How full the context window has been — asked of the CLI's own log, which is
 * DATED.
 *
 * `context.ts` reads a percentage off the terminal. That is the right thing for
 * a badge and it is the wrong thing for a graph, for the same reason
 * `limitlog.ts` exists: a screen carries no clock. The scraped meter is one
 * number, overwritten in place, with no record of what it was ten minutes ago
 * and nothing at all to say about the moment it dropped from 4% to 96%. A
 * series accumulated from it host-side would start empty on every restart, hold
 * only what one daemon lifetime saw, and — because the indicator is not always
 * on screen — be full of holes it could not describe.
 *
 * The CLI already writes every one of these facts down, timestamped, in the
 * conversation jsonl:
 *
 *  - every assistant turn carries `message.usage`, and
 *    `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` is
 *    what that request actually sent — the context the model saw. Output is
 *    excluded on purpose: it is not context until the turn after.
 *  - a compaction writes `{"type":"system","subtype":"compact_boundary",
 *    "compactMetadata":{"trigger":"auto"|"manual","preTokens":…,"postTokens":…}}`
 *    — which is both WHEN the drop happened and how far it fell.
 *  - a usage-limit rejection writes the `quotaLimits` row `limitlog.ts` already
 *    reads, so the walls land on the same time axis at no extra cost.
 *
 * Read-only and best-effort, like `transcript.ts`: an unparseable line is
 * skipped, and a missing file yields null. Every log is read WHOLE, forward in
 * `MAX_READ` chunks — a tail read printed a total that started in the middle
 * as if it were complete. `truncated` now means only that the chart's raw
 * samples passed `RAW_CAP`.
 *
 * **What the session SPENT is a second question, and it is answered here too.**
 * The series is the input side of THIS conversation — the right number for "what
 * does the next turn re-read" and the wrong one for "what has this cost me". So
 * `usageTok` adds each turn's output, and `agentUsage()` reads the Task tool's
 * own logs beside it (`<conversation>/subagents/agent-*.jsonl`), which is where
 * a fan-out session's tokens actually went: a 30k window over eight agents is
 * millions. Both are FLOORS and both are absent rather than approximate.
 *
 * **The window SIZE is not in the log.** Nothing here guesses it. `totalTok` is
 * whatever the TUI was seen to print and null otherwise, and the separate
 * `autoCompactTok` is a measurement — the tokens an auto-compact was last
 * observed to fire at — never relabelled as a window.
 *
 * The code is cut by subject into `ctxlog/` (this file is the barrel every
 * importer keeps using): `ctxcursor.ts` (the cursor and its accumulators),
 * `ctxupdate.ts` (the incremental pass), `ctxproject.ts` (the wire document and
 * the row miniature) and `ctxagents.ts` (what the subagents spent).
 */
// The cap and `downsample` are shared with every store reader a plugin
// contributes (`shared/transcriptfold.ts`); re-exported so callers here are unchanged.
export { MAX_SAMPLES, downsample } from "@waterplane/shared";
export type { ContextLog, SeriesCursor } from "./ctxlog/ctxcursor.js";
export { updateContextLog } from "./ctxlog/ctxupdate.js";
export { SPARK_MARKS, SPARK_POINTS, projectContextLog, readContextLog, sparkOf } from "./ctxlog/ctxproject.js";
export type { AgentFile, AgentRunRaw, AgentUsage } from "./ctxlog/ctxagents.js";
export { agentCumOf, agentEnvelope, agentUsage, liveAgentOf, thinMax, withAgentRuns } from "./ctxlog/ctxagents.js";
