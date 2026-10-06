/**
 * Structured conversation transcript — the reader view behind the CLI.
 *
 * The terminal is a grid of ANSI cells: fine to drive, miserable to scroll,
 * search or tap a link in on a phone. The claude CLI already keeps a lossless
 * structured log of every conversation at
 * `~/.claude/projects/<slug>/<conversation-uuid>.jsonl` (one JSON record per
 * line), so we parse THAT into turns/blocks and let the phone render normal
 * DOM. Exact message boundaries, real tool names + inputs + results, no
 * re-wrapping, no escape codes.
 *
 * Everything here is read-only and best-effort: an unparseable line is skipped,
 * a missing file yields null, and the caller falls back to the PTY-capture
 * history. Record shapes are the CLI's internal format — treat them as
 * heuristics like prompt.ts/limit.ts, not a contract.
 *
 * The code is cut by subject into `transcript/` (this file is the barrel every
 * importer keeps using): `transcriptlog.ts` (where the log is, record
 * predicates), `transcriptparse.ts` (the log as turns and blocks),
 * `transcriptscreen.ts` (TUI chrome trimming) and `transcriptturns.ts` (turns
 * the log does not hold, merged in).
 */
// The caps, `promptLabel` and `summarize` are shared with every store reader a
// plugin contributes (`shared/transcriptfold.ts`), so a second backend's reader
// view is capped by the same rule; re-exported so every caller here is unchanged.
export { MAX_TURNS, TOOL_INPUT_CAP, TOOL_RESULT_CAP, TEXT_CAP, promptLabel, summarize } from "@waterplane/shared";

// The CLI's private dir and the cwd -> project folder rule live in
// `claudeconfig.ts` (one definition); re-exported for readers that import them here.
export { claudeConfigDir, claudeProjectDir } from "./claudeconfig.js";

export { lastTurnAt, localCommandOf, localOutputOf, logMtime, opensTurn, promptOf, queuedPromptOf, transcriptPath } from "./transcript/transcriptlog.js";
export { parseTranscript, toolDetails } from "./transcript/transcriptparse.js";
export { foldRepaints, scrollHintTrimmed, sliceToCommand, trimTuiChrome } from "./transcript/transcriptscreen.js";
export { absorbedOpeners, boxAnswersOf, mergeLocalTurns, queuedTurns, screenCommandTurns, transcriptFromHistory } from "./transcript/transcriptturns.js";
