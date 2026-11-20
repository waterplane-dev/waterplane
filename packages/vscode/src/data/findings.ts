/**
 * The Findings view's data: the Setup check run standalone, over THIS folder and THIS desktop's own
 * files, with no waterplane daemon. It is the host's `runSetupCheck` (so the rules, the ranking and the
 * checked-off list are the phone's) with every source handed in from what the extension already reads:
 * the weight doc, the folded log corpus, the auto-compact settings and the bundled permissions engine.
 *
 * What it cannot read is `absent`, and the rule that needed it says "not checked" — never passed:
 * the session history (savings), the skill use counts, this desktop's own checklist, and the account
 * scope unless a desktop answered (`desktopUrl`). Nothing here sends, writes or applies anything.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ADVISORY_CHECKS, BRAND, DEFAULT_CONTEXT_LIMITS, autoCompactVerdict, efficiencyBlock, efficiencyTargetOf, frontmatterYamlProblem,
  planEfficiencyWrite, remedyPrompt,
} from "@waterplane/shared";
import type { ComplianceCheck, Finding, UsageNowDoc } from "@waterplane/shared";
import { permissionsContribution } from "permissions-engine";
import { runSetupCheck } from "../../../host/src/setupcheck/collect.js";
import type { CollectDeps } from "../../../host/src/setupcheck/collect.js";
import { autoCompactFor, autoCompactMachineFor } from "../../../host/src/setupcheck/readers.js";
import type { CorpusDoc, FindingsDoc, WeightDoc } from "../protocol.js";

export type { FindingsDoc };

import { claudeConfigDir } from "./logs.js";

export interface FindingsInput {
  folder: string;
  weight: WeightDoc | null;
  corpus: CorpusDoc | null;
  now: number;
  /** The desktop's `usagenow`, when `desktopUrl` is set and it answered; null = no account facts. */
  live?: UsageNowDoc | null;
  configDir?: string;
  /** Injected for tests: a file's text, or null when there is no such file. */
  read?: (path: string) => string | null;
}

const diskRead = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };

/** The three checklist rows this view can say for a folder (the daemon's `inspectRepo` is the rest). */
function checksOf(i: FindingsInput, read: (p: string) => string | null, configDir: string): ComplianceCheck[] {
  const out: ComplianceCheck[] = [];
  const w = i.weight;
  // The daemon marks ADVISORY_CHECKS in one pass (`compliance.ts`): the same rows are "consider" here.
  const done = (rows: ComplianceCheck[]): ComplianceCheck[] => rows.map((c) => (ADVISORY_CHECKS.includes(c.id) ? { ...c, advisory: true } : c));
  if (w && w.files.length) {
    const r = w.reading;
    const overlap = w.overlaps.length > 0;
    out.push({
      id: "context-weight", label: "Agent context weight", fix: null,
      status: r.verdict !== "lean" || overlap ? "warn" : "pass",
      detail: `${r.advice ? `${r.note} ${r.advice}` : r.note}`,
      ...(w.agents.claude.files ? { alwaysOnChars: r.alwaysOnChars } : {}),
      ...(overlap && r.verdict === "lean" ? { overlapOnly: true } : {}),
    });
  }
  // Skill frontmatter, as the daemon's check reads it (Copilot CLI parses it as strict YAML).
  const bad: string[] = [];
  let total = 0;
  for (const dir of [".claude/skills", ".github/skills", ".agents/skills"]) {
    for (const name of skillDirs(i.folder, dir)) {
      const text = read(join(i.folder, dir, name, "SKILL.md"));
      if (text == null) continue;
      total++;
      if (frontmatterYamlProblem(text)) bad.push(name);
    }
  }
  if (total) {
    out.push(bad.length
      ? { id: "skill-frontmatter", label: "Skills other agents can load", status: "warn", fix: null, detail: `Copilot CLI skips ${bad.length === 1 ? "1 skill" : `${bad.length} skills`} whose frontmatter is not strict YAML: ${bad.slice(0, 5).join(", ")}. Claude Code reads them anyway.` }
      : { id: "skill-frontmatter", label: "Skills other agents can load", status: "pass", fix: null, detail: `${total === 1 ? "The skill's frontmatter is" : `All ${total} skills' frontmatter is`} strict YAML, so Copilot CLI can load ${total === 1 ? "it" : "them"} too.` });
  }
  const ac = autoCompactFor(i.folder, { userDir: configDir, read });
  const v = autoCompactVerdict(ac);
  out.push({ id: "auto-compact", label: "Auto-compact window", status: v.status, detail: v.detail, fix: null });
  return done(out);
}

function skillDirs(folder: string, dir: string): string[] {
  try { return readdirSync(join(folder, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}

/** Which instruction file would carry the efficiency rules, and whether a block is already there. */
function efficiencyOf(folder: string, read: (p: string) => string | null): { present: boolean; target: "CLAUDE.md" | "AGENTS.md" } {
  const texts = { "CLAUDE.md": read(join(folder, "CLAUDE.md")), "AGENTS.md": read(join(folder, "AGENTS.md")) };
  const target = efficiencyTargetOf({ "CLAUDE.md": texts["CLAUDE.md"] !== null, "AGENTS.md": texts["AGENTS.md"] !== null });
  return { present: planEfficiencyWrite(texts[target]).kind !== "append", target };
}

const unread = (why: string) => (): never => { throw new Error(why); };

/** The ranked findings for one folder. Never throws: a source that fails is an `absent` entry. */
export async function findingsFor(i: FindingsInput): Promise<FindingsDoc> {
  const read = i.read ?? diskRead;
  const configDir = i.configDir ?? claudeConfigDir();
  const w = i.weight;
  const live = i.live ?? null;
  const deps: CollectDeps = {
    now: () => i.now,
    repoKey: () => i.folder,
    inspect: async () => {
      const rows = checksOf(i, read, configDir);
      if (!rows.length) throw new Error("this folder has no instruction files or skills to check");
      return rows;
    },
    hostChecks: unread(`this desktop's own checklist is the ${BRAND.displayName} desktop app's`),
    claudeCli: async () => null,
    instructions: () => {
      if (!w) throw new Error("this folder's instruction files were not read");
      return { files: w.files, overlaps: w.overlaps, desktop: w.desktop ?? null };
    },
    warn: () => ({ warnChars: DEFAULT_CONTEXT_LIMITS.maxChars, warnSource: "default", globalWarnChars: DEFAULT_CONTEXT_LIMITS.maxChars }),
    points: async () => { throw new Error(`the session history is the ${BRAND.displayName} desktop app's, so no saving is priced here`); },
    ledger: async () => { if (!i.corpus) throw new Error("the log scan has not run yet: open All sessions to read the logs"); return i.corpus; },
    skills: async () => { throw new Error(`how often each skill is used needs the ${BRAND.displayName} desktop app`); },
    autoCompact: () => autoCompactFor(i.folder, { userDir: configDir, read }),
    autoCompactMachine: () => autoCompactMachineFor({ userDir: configDir, read }),
    usage: () => live?.usage ?? null,
    billing: () => "unknown",
    backends: () => [{ id: "claude", label: "Claude Code" }],
    waived: () => ({}),
    efficiency: () => efficiencyOf(i.folder, read),
    contributed: async () => permissionsContribution({ worktree: i.folder, userDir: configDir, read, now: i.now }),
  };
  const r = await runSetupCheck(deps, i.folder);
  const account = live !== null;
  // The account scope is the desktop's: without an answer it is not drawn at all, not listed as unread.
  const keep = <T extends { scope: string }>(x: T): boolean => account || x.scope !== "account";
  return {
    findings: r.findings.filter(keep), passed: r.passed.filter(keep),
    notChecked: r.notChecked.filter(keep).filter((n) => n.rule !== "install.claude-cli"),
    absent: r.absent, at: r.at, folder: i.folder, account,
  };
}

/** The paragraphs a finding's remedy offers to copy or type, or null where it is not text (a door, a desktop fix). */
export function remedyCopy(f: Finding, weight: WeightDoc | null): string[] | null {
  const r = f.remedy;
  if (r.kind === "seed") {
    const facts = r.facts as Record<string, string | number>;
    return remedyPrompt(r.prompt, {
      warnChars: Number(facts.warnChars) || DEFAULT_CONTEXT_LIMITS.maxChars,
      ...(facts.warnSource === "repo" || facts.warnSource === "env" || facts.warnSource === "default" ? { warnSource: facts.warnSource } : {}),
      ...(weight ? { claudeMdChars: weight.claudeMdChars, alwaysOnChars: weight.reading.alwaysOnChars, alwaysOnTokens: weight.reading.alwaysOnTokens, skillCount: weight.reading.skillCount } : {}),
    });
  }
  if (r.kind === "write") return [`Add this block to ${r.target}, keeping the markers:`, efficiencyBlock()];
  if (r.kind === "howto") return [r.text];
  if (r.kind === "agent") return [`${r.label}: ${r.detail}`];
  return null;
}
