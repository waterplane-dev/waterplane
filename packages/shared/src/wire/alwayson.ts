/**
 * Always-on context on the wire: what the first request of ONE conversation carried, as the CLI
 * logged it (`SessionCarried`, on `ContextSeriesDoc.carried`), and what a repo plus this desktop
 * will put in every turn (`RepoInstructionsDoc`, on `ComplianceReport.instructions`).
 *
 * Chars are the fact; tokens per part are an estimate (`~chars / CHARS_PER_TOKEN`) and only ever
 * worded as one. Everything here degrades to ABSENT, never to a wrong number: a truncated log has
 * no `carried`, an unsized row (an MCP server) has no chars.
 */
import type { InstructionFile } from "../agentfiles.js";

/**
 * One always-on source the first request of a conversation carried, as the CLI logged it.
 * The order of this union is the display order (`CARRIED_KINDS`).
 */
export type CarriedKind = "instructions" | "skill_listing" | "mcp_instructions" | "deferred_tools"
  | "agent_listing" | "hook_context" | "system_prompt" | "tool_schemas";

/** `CarriedKind` in display order. */
export const CARRIED_KINDS: readonly CarriedKind[] = [
  "instructions", "skill_listing", "mcp_instructions", "deferred_tools",
  "agent_listing", "hook_context", "system_prompt", "tool_schemas",
];

export interface CarriedPart {
  kind: CarriedKind;
  /** Characters of the text the CLI attached — the FACT. Tokens are an estimate (~chars/4) and only ever worded as one. */
  chars: number;
  /** How many items (files, skills, servers, tool names, agent types). Absent where the record has none. */
  count?: number;
  /** Names, capped at CARRIED_NAMES_CAP (64) — the skill listing's names, the MCP servers, the agent types. */
  names?: string[];
  /** `instructions` only: the files and the CLI's own type word (User | Project | AutoMem | …). */
  files?: { path: string; type: string; chars: number }[];
  /** True for the two parts read off `prompt_snapshot`, an UNDOCUMENTED record: present on this CLI, maybe not on the next. */
  undocumented?: true;
}

export interface SessionCarried {
  /** The whole first request in tokens: usage.input + cache_creation + cache_read of the first assistant record. Null before the first answer. */
  firstRequestTok: number | null;
  firstRequestAt: number | null;
  parts: CarriedPart[];
  /** Attachments of these kinds that arrived AFTER the first request (an MCP connecting late, a skill listing refresh) — counted, never folded in. */
  laterDeltas: number;
}

export const CARRIED_NAMES_CAP = 64;

/** What the Setup sheet / Always-on view list for one repo: the widened inventory plus this desktop's rows. */
export interface RepoInstructionsDoc {
  /** Repo rows (`scope` absent). */
  files: InstructionFile[];
  /** This desktop's rows (`scope: "desktop"`); null = could not be read, `desktopWhy` says why. */
  desktop: InstructionFile[] | null;
  desktopWhy?: string;
  /** The memory file this repo's sessions get (its slug), for the sentence. */
  memoryPath?: string;
}
