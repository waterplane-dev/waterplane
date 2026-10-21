/**
 * The one line a CodeLens prints above an instruction file: what that file costs, read off the
 * SAME `InstructionFile` row the Always-on view lists (`weighFolder` → `WeightDoc.files`). The
 * row counts characters; the lens says tokens, as chars / CHARS_PER_TOKEN, the same division the
 * view's headline prints — so the two cannot disagree. A file the inventory does not hold (nested,
 * `CLAUDE.local.md`, user-level) has no row and so no lens.
 */
import { CHARS_PER_TOKEN, READER_NAME, fmtCount } from "@waterplane/shared";
import type { InstructionFile, InstructionReader } from "@waterplane/shared";

/** The files a lens is asked for: every kind the inventory reads (`agentfiles.ts`), as glob patterns. */
export const LENS_PATTERNS = [
  "**/{CLAUDE.md,AGENTS.md,copilot-instructions.md,SKILL.md,*.instructions.md}",
  "**/.claude/rules/**/*.md",
];
const NAMES = new Set(["CLAUDE.md", "AGENTS.md", "copilot-instructions.md", "SKILL.md"]);

/** Files the inventory reads: saving any of them changes a folder's reading. Either separator. */
export const isInstructionPath = (p: string): boolean =>
  NAMES.has(p.split(/[\\/]/).pop() ?? "") || /\.instructions\.md$/.test(p) || /[\\/]\.claude[\\/]rules[\\/].*\.md$/.test(p);

const tok = (chars: number): string => `~${fmtCount(Math.round(chars / CHARS_PER_TOKEN))}`;

/** `a, b, c` or `a, b +2 more`: a long glob list must not push the lens off the line. */
function globsOf(globs: string[]): string {
  return globs.length <= 2 ? globs.join(", ") : `${globs.slice(0, 2).join(", ")} +${globs.length - 2} more`;
}

export function lensWords(f: InstructionFile | undefined): string | null {
  if (!f || !f.parts.length) return null;
  const live = f.parts.filter((p) => p.readers.length > 0);
  if (!live.length) return f.off ? `nobody reads this: ${f.off} is off` : null;
  const readers = (["claude", "copilot"] as InstructionReader[]).filter((r) => live.some((p) => p.readers.includes(r)));
  const who = readers.map((r) => READER_NAME[r]).join(" + ");
  const sum = (kind: string) => live.filter((p) => p.when.kind === kind).reduce((n, p) => n + p.chars, 0);
  const always = sum("always");
  const onDemand = sum("on-demand");
  const scoped = live.filter((p) => p.when.kind === "scoped");
  const bits: string[] = [];
  if (always > 0) bits.push(onDemand > 0 ? `description ${tok(always)} tokens every request` : `${tok(always)} tokens every request`);
  for (const p of scoped) if (p.when.kind === "scoped") bits.push(`${tok(p.chars)} tokens when a file matches ${globsOf(p.when.globs)}`);
  if (onDemand > 0) bits.push(always > 0 ? `body ${tok(onDemand)} on demand` : `${tok(onDemand)} tokens on demand`);
  if (!bits.length) return null;
  return `${bits.join(" · ")} · ${who}`;
}
