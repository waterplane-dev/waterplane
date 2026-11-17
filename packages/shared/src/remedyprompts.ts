// THE wording of the always-on remedies, one copy: the phone's preset, VS Code's prompt and any
// later door (the Setup check) all say the same rules, measured against the repo's own warn line.

export type RemedyId = "groom" | "groom-global" | "shrink-skill-descs" | "other-agents" | "dedupe-instructions";

export interface RemedyFacts {
  /** The always-on size (CLAUDE.md + every skill description, chars) this repo is warned at. Never a literal in a caller. */
  warnChars: number;
  /** "repo" / "env" is somebody's decision; "default" is what shipped. Absent = default. */
  warnSource?: "repo" | "env" | "default";
  /** Where a report is written, when the run is unattended (the phone's outbox). */
  out?: string;
  /** What was measured, when it already was (VS Code has the reading; a fan-out preset has not). */
  claudeMdChars?: number;
  alwaysOnChars?: number;
  alwaysOnTokens?: number;
  skillCount?: number;
  /** shrink-skill-descs: the longest descriptions, name already scrubbed by the caller. */
  skills?: { name: string; descChars: number }[];
  /** dedupe-instructions: one sentence per repeat (`overlapWords`). */
  overlaps?: string[];
}

const nf = (n: number): string => Math.round(n).toLocaleString("en-US");
const PROPOSE = "Propose and do not commit: show the diff and apply nothing until I say so.";

function line(f: RemedyFacts): string {
  const own = f.warnSource === "repo" ? "the line this repo set for itself" : f.warnSource === "env" ? "the line this desktop was asked to warn at" : "the shipped default line (a repo's own line, if it has one, wins)";
  return `${nf(f.warnChars)} characters, ${own}`;
}

function report(f: RemedyFacts, file: string): string {
  return f.out ? `Write the result to ${f.out}/${file}.` : "Say the result in text.";
}

function groom(f: RemedyFacts, scope: "repo" | "global"): string[] {
  const what = scope === "global" ? "the user-level instructions in ~/.claude/CLAUDE.md (and the user-level skills they sit beside), which every session on this desktop re-reads" : "this repo's always-on context (CLAUDE.md, what it imports, and every skill description), which every turn of every session and subagent re-reads";
  const measured = f.alwaysOnChars != null
    ? [`Already measured: ${nf(f.alwaysOnChars)} characters always on${f.alwaysOnTokens != null ? ` (about ${nf(f.alwaysOnTokens)} tokens at roughly 4 characters per token)` : ""}${f.claudeMdChars != null ? `, of which CLAUDE.md is ${nf(f.claudeMdChars)}` : ""}${f.skillCount != null ? ` and ${f.skillCount} skill descriptions make up the rest` : ""}.`]
    : [];
  return [
    `Get ${what} down to what has to be always-on. Measure first, and stop when it is already fine.`,
    ...measured,
    `MEASURE: count the characters of CLAUDE.md plus every skill description. If the total is under ${line(f)}, change nothing: ${report(f, "claudemd.md").replace(/\.$/, "")} with the size and that no change was needed, and stop. Most repos are fine and must not be churned.`,
    "CLASSIFY every section: a RULE is dangerous not to know before acting (the security boundary, never-do rules, mandatory commands, what the project is) and stays. REFERENCE is only needed while editing that area (module indexes, per-area conventions, test maps, protocol detail) and moves. REASONING (measurements, past failures, rejected designs) moves to the long-form docs, using the existing convention or docs/notes/.",
    "MOVE in this order and never lose a rule. Reasoning to the docs first: when a module's only description is its CLAUDE.md entry, write the doc section before trimming the entry. Then reference into .claude/skills/<name>/SKILL.md, one skill per area, with frontmatter whose name matches the directory and a description of at least ~120 characters saying both what it covers and when to load it, because a skill is chosen from its description alone. Leave CLAUDE.md with what the project is, the mandatory commands, the security model in full, a short never-do list and a table from area to skill.",
    "THE ONE HARD RULE: a skill that is not invoked is a rule that does not exist. Anything that could cause harm, data loss or a security problem stays in CLAUDE.md. Delete nothing.",
    "CHECK .gitignore: if .claude/ is ignored the skills do not survive a fresh clone; git cannot re-include below an excluded directory, so it needs `.claude/*` followed by `!.claude/skills/`. Verify with `git check-ignore` that the SKILL.md files are tracked and that inbox, outbox and local-settings paths stay ignored.",
    `VERIFY that every rule that was there before is still somewhere (file, skill or docs), then ${report(f, "claudemd.md").charAt(0).toLowerCase()}${report(f, "claudemd.md").slice(1)} Give the sizes before and after, what moved where, and what you deliberately left. ${PROPOSE}`,
  ];
}

function shrink(f: RemedyFacts): string[] {
  const rows = (f.skills ?? []).map((s) => `${s.name}: ${nf(s.descChars)} characters in the description`);
  return [
    "A skill's description is loaded into every turn; its body only when the skill is used.",
    ...(rows.length ? ["These descriptions are the longest:", rows.join("; ")] : ["Measure every skill description first and start with the longest."]),
    `Rewrite each to say only when the skill applies, in as few words as keep it triggering correctly. Stop when the always-on total is under ${line(f)}. Leave the bodies alone.`,
    PROPOSE,
  ];
}

function otherAgents(f: RemedyFacts): string[] {
  return [
    "Make this repo work as well for GitHub Copilot CLI and local models (Ollama) as it does for Claude. Measure first and change only what is wrong.",
    "1. SKILLS COPILOT CAN LOAD. Copilot reads .claude/skills, .github/skills and .agents/skills but parses their frontmatter as strict YAML, and silently skips a skill whose unquoted description contains \": \". If `copilot` is installed, run `copilot skill list`: it names every skill it failed to load. Rewrite each failing description as ONE double-quoted line (escape \\\" and \\\\). Change no other word.",
    "2. ONE SET OF INSTRUCTIONS. Claude Code and Copilot both read CLAUDE.md on every request; Copilot also reads AGENTS.md and .github/copilot-instructions.md, and other agents read AGENTS.md (some fall back to CLAUDE.md only when there is no AGENTS.md). Never copy CLAUDE.md into a second file, because Copilot would carry both. If another agent needs an AGENTS.md, make it one line pointing at CLAUDE.md.",
    "3. A MAP FOR SMALL MODELS. A local model fails by guessing paths and by not knowing how to check its work. Make sure the TOP of CLAUDE.md says, in at most ~15 lines: what each top-level directory holds, the one command that runs the tests for a single file, and the build step a test needs first. Add only what is missing; move nothing else.",
    `4. SIZE. Count the characters of CLAUDE.md plus every skill description. If the total is over ${line(f)}, say which sections are reference that could move into a skill. Do not move them in this pass.`,
    `5. ${report(f, "agents.md")} Name which skills you fixed, what you added to CLAUDE.md, the always-on size before and after, and anything you deliberately left. Do not commit.`,
  ];
}

function dedupe(f: RemedyFacts): string[] {
  const ov = f.overlaps ?? [];
  return [
    "The same instructions are loaded twice, and a repeat is sent on every request.",
    ...(ov.length ? ov : ["Find files whose content repeats another instruction file (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, rules)."]),
    "For each repeat, decide which copy is the real one, and replace the other with one line pointing at it, or delete it when nothing reads it. Which copy to keep is a judgement: say why before changing anything. Keep every rule somewhere.",
    `Stop when nothing is repeated, or the always-on total is under ${line(f)} and the repeat is deliberate.`,
    PROPOSE,
  ];
}

/** The paragraphs of one remedy. Pure; join them with a blank line (copy) or a space (terminal). */
export function remedyPrompt(id: RemedyId, facts: RemedyFacts): string[] {
  switch (id) {
    case "groom": return groom(facts, "repo");
    case "groom-global": return groom(facts, "global");
    case "shrink-skill-descs": return shrink(facts);
    case "other-agents": return otherAgents(facts);
    case "dedupe-instructions": return dedupe(facts);
  }
}
