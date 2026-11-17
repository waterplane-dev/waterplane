/**
 * What the rules read: one plain object of facts, every part optional. A rule whose fact is absent
 * yields no finding and one `notChecked` entry, never a pass. The collectors (H1) fill it; the rules
 * are pure functions from it to a `FindingsResult`.
 */
import type { InstructionOverlap } from "../../agentfiles.js";
import type { SeriesPoint } from "../../agentseries/types.js";
import type { ComplianceCheck } from "../../wire/repo.js";
import type { BillingProfile } from "../../billing.js";
import type { FindingBackends, FindingsResult, FindingScope, FindingSaving, Finding, PassedCheck, NotChecked } from "../types.js";
import type { InsightInput } from "./insights.js";

export interface PermRuleFact { source: "user" | "project" | "local"; list: string; rule: string; notes: string[] }
export interface SkillFact { id: string; level: "user" | "project" | "plugin"; listingChars?: number; usesEverywhere?: { d30: number } }

export interface FindingFacts {
  now: number;
  /** The repo a repo-scope pass is about (its `repoOfWorktree` key). */
  repo?: string;
  billing?: BillingProfile;
  /** Which backends' logs and stores were understood. Absent = claude only. */
  backends?: FindingBackends;
  /** This repo's setup checklist (`inspectRepo`). */
  checks?: ComplianceCheck[];
  /** This desktop's checklist (`hostChecks`). */
  hostChecks?: ComplianceCheck[];
  instructions?: { overlaps: InstructionOverlap[]; warnChars: number; warnSource?: "repo" | "env" | "default" };
  /** The repo's own efficiency-rules block: present or not, and which file would take it. */
  efficiency?: { present: boolean; target: "CLAUDE.md" | "AGENTS.md" };
  /** Session series points (repo filter applies for repo rules; all repos for machine rules). */
  points?: SeriesPoint[];
  /** All-time ledger as insight input, plus the trend's two spans. */
  ledger?: InsightInput;
  trend?: { cur: { usd: number; turns: number }; prev: { usd: number; turns: number } };
  /** Skill inventory with use counts over every repo. */
  skills?: SkillFact[];
  permissions?: PermRuleFact[];
  /** Where auto-compact is decided and how the check judged it. */
  autoCompact?: { source: string; status: "pass" | "warn"; /** The window as this DESKTOP decides it (env, then the user-level file), whatever a repo overrides. Absent = the repo reading stands in. */ machine?: { source: string; status: "pass" | "warn" } };
  /** Health index alerts for this repo, severe ones are findings. */
  health?: { alerts: { entry: string; level: "warn" | "severe"; text: string }[] };
  /** Desktop-wide always-on files (user CLAUDE.md, user skills' descriptions). */
  globalInstructions?: { chars: number; warnChars: number };
  usage?: {
    /** The week's burn: would it run out before it resets? null = no reading. */
    week?: { runsOut: boolean; text: string } | null;
    period?: { firing: boolean; text: string } | null;
    copilot?: { usedPct: number; text: string } | null;
  };
  /** Ids a person waived (ignore / accept), by finding id. */
  waived?: Record<string, { reason?: string; at: string }>;
}

export const claudeOnly: FindingBackends = { understood: ["claude"], unread: [] };
/** A rule that reads only files or settings, never an agent's conversations: it carries no backends line,
 *  since "which agents' records were read" says nothing about it. */
export const FILES_ONLY: FindingBackends = { understood: [], unread: [] };

/** Collects one pass of rules. */
export class Acc {
  readonly out: FindingsResult = { findings: [], passed: [], notChecked: [] };
  constructor(readonly f: FindingFacts, readonly scope: FindingScope) {}
  get backends(): FindingBackends { return this.f.backends ?? claudeOnly; }
  get repoField(): { repo?: string } { return this.scope === "repo" && this.f.repo !== undefined ? { repo: this.f.repo } : {}; }
  /** True when no backend is understood: the rule is not checked, and says why. */
  blind(rule: string): boolean {
    if (this.backends.understood.length) return false;
    this.skip(rule, this.backends.unread.map((u) => `${u.id}: ${u.why}`).join("; ") || "no backend's records were understood");
    return true;
  }
  find(f: Omit<Finding, "scope" | "backends" | "waive" | "repo"> & { backends?: FindingBackends; waveVia: "ignore" | "accept" | "none"; waiveHint?: { reason?: string; at: string } }): void {
    const { waveVia, waiveHint, backends, ...rest } = f;
    const w = waiveHint ?? this.f.waived?.[rest.id];
    this.out.findings.push({ ...rest, scope: this.scope, ...this.repoField, backends: backends ?? this.backends, waive: { via: waveVia, ...(w ? { waived: w } : {}) } });
  }
  pass(id: string, rule: string, what: string, backends: FindingBackends = this.backends): void {
    const p: PassedCheck = { id, rule, scope: this.scope, ...this.repoField, what, backends, at: this.f.now };
    this.out.passed.push(p);
  }
  skip(rule: string, why: string): void {
    const n: NotChecked = { rule, scope: this.scope, ...this.repoField, why };
    this.out.notChecked.push(n);
  }
}

export type { FindingSaving };
