/**
 * The Finding type (PLAN §3): one claim about a repo, this machine or the account, with its number,
 * which backends were read, where its evidence is, what it might save and what a person can do.
 * Beside the findings go the CHECKED-OFF list (`passed`) and what could not be checked
 * (`notChecked`): a findings view is never empty, "nothing to fix" still lists what was checked.
 */
import type { RemedyId } from "../remedyprompts.js";

export type FindingScope = "repo" | "machine" | "account";
export type FindingKind = "cost" | "quality" | "watch" | "install";

export type EvidenceRoute =
  | { screen: "alwayson"; repoId?: string; path?: string }
  | { screen: "readings"; repoId: string; region: "series" | "agents" | "watch"; rowId?: string }
  | { screen: "tokens"; span?: "week" | "30" | "90" | "all"; box: "cold" | "writes" | "agents" | "top" | "models" | "requests" | "limits" | "hostspend"; ids?: string[] }
  | { screen: "skills"; repoId?: string; ids: string[] }
  | { screen: "permissions"; repoId?: string; ruleKeys: string[] }
  | { screen: "context"; sessionId: string }
  | { screen: "file"; repoId: string; path: string };

export type RemedyPromptId = RemedyId;

export type FindingRemedy =
  | { kind: "seed"; prompt: RemedyPromptId; facts: Record<string, string | number> }
  | { kind: "fix"; fixId: string }
  /** A checklist row no patch closes: its own words go to the repo's agent (the phone's `remedyPrompt` over the check). */
  | { kind: "agent"; checkId: string; label: string; detail: string }
  | { kind: "write"; target: "CLAUDE.md" | "AGENTS.md" }
  | { kind: "door"; route: EvidenceRoute }
  | { kind: "howto"; text: string };

/** Which backends a rule read. Never "fine" for one it could not read. */
export interface FindingBackends {
  understood: string[];
  unread: { id: string; why: string }[];
}

export interface FindingSaving {
  /** List price; absent for claude-local, opencode and unpriced models. */
  usd?: number;
  tokens?: number;
  per: "week";
  /** estimate = characters / CHARS_PER_TOKEN, printed with an approximately sign. */
  basis: "measured" | "estimate";
  errs: "low" | "high" | null;
  sessions?: number;
  repos?: number;
  unpricedSessions?: number;
}

export interface FindingWaive {
  via: "ignore" | "accept" | "none";
  waived?: { reason?: string; at: string };
}

export interface Finding {
  /** Stable: "<scope>.<rule>" plus ":<subject>" where a rule yields several. */
  id: string;
  rule: string;
  scope: FindingScope;
  /** Scope repo only: the repo key. */
  repo?: string;
  kind: FindingKind;
  /** "finding" counts in the badge; "consider" is listed and never counted. */
  weight: "finding" | "consider";
  /** One sentence, the claim, with its number. */
  what: string;
  backends: FindingBackends;
  /** Null = the sentence is the evidence. */
  evidence: EvidenceRoute | null;
  /** Absent where it cannot be priced or counted. Never zero for "unknown". */
  saving?: FindingSaving;
  remedy: FindingRemedy;
  waive: FindingWaive;
}

/** A rule that ran and passed (or whose finding was waived): the checked-off list. */
export interface PassedCheck {
  /** Same id scheme as a finding's, so a waived finding keeps its id. */
  id: string;
  rule: string;
  scope: FindingScope;
  repo?: string;
  /** What was checked, one sentence. */
  what: string;
  backends: FindingBackends;
  /** Epoch ms the check ran. */
  at: number;
  /** Set when this row is a waived finding: "waived: <reason>". */
  waived?: string;
}

/** A rule that could not run: never counted as passed. */
export interface NotChecked {
  rule: string;
  scope: FindingScope;
  repo?: string;
  /** Why: backend not understood, data absent. */
  why: string;
}

/** What the engine returns for a view: findings, the checked-off list and what could not run. */
export interface FindingsResult {
  findings: Finding[];
  passed: PassedCheck[];
  notChecked: NotChecked[];
}
