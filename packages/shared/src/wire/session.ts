/**
 * A drivable session, and everything that describes ONE of them.
 *
 * The split is by what a field is ABOUT, not by which message carries it:
 * `SessionInfo` is quoted wholesale into `session.list`, into a boot snapshot
 * the launcher paints from offline, and into the questions sheet — so it cannot
 * live next to the union that happens to send it.
 */

// The cut is by what a field is ABOUT, one file each under `./session/`; this module is the one
// door, so no importer names a slice (docs/notes/shared-architecture.md).
export type { PromptOption, StandingRule, DetectedPrompt } from "./session/promptbox.js";
export type { SendView, Effort, PermissionMode, LaunchOpts, ExternalSession, LimitResumeMode, SessionLimit, SessionNetRetry, SessionLogin, ShellLink, SessionAgent, SessionAsk, SessionShell, SessionShellDetail } from "./session/launch.js";
export type { SessionInfo, FollowUp, FollowUpBy } from "./session/info.js";
export type { NewImage, RecentSession, ArchivedConversation, ArchiveListing, Bookmark, ClosedSession, ClosedBy, SessionOriginKind, SessionOrigin, HistoryEntry, SessionSearchScope, SessionSearchMatch, SessionSearchResult } from "./session/archive.js";
export type { OpenDelivery } from "./session/delivery.js";
export type { ContextSample, SampleKinds, AgentRun, SkillLoad, ContextEvent, CompactionCost, CompactionLedger } from "./session/context.js";
export { AGENT_CTX_POINTS, AGENT_CUM_POINTS } from "./session/context.js";
export type { ContextSpark, ContextWindowSource, ContextSeriesDoc } from "./session/contextspark.js";
