/**
 * What a folder's agent instructions cost on EVERY turn, before anyone types:
 * `CLAUDE.md` (plus `.claude/CLAUDE.md`) and each skill's `description:`
 * frontmatter — the always-loaded part — against the skill bodies, which load
 * on demand and are reported as context, never counted against.
 *
 * The reading is `@waterplane/shared`'s `weighContext` with its shipped limits;
 * the skill walk is `compliance.ts`'s `readSkills`, copied (it is ten lines and
 * not exported). A folder with none of these files reads as lean at zero chars,
 * which is true: it carries nothing.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillWeight } from "@waterplane/shared";
import { DEFAULT_CONTEXT_LIMITS, skillDescChars, weighContext } from "@waterplane/shared";
import type { WeightDoc } from "../protocol.js";

const readOr0 = async (p: string): Promise<number> => {
  try { return (await readFile(p, "utf8")).length; } catch { return 0; }
};

/** `.claude/skills/<name>/SKILL.md`, measured; a skill without the file is not a skill. */
async function readSkills(folder: string): Promise<SkillWeight[]> {
  const dir = join(folder, ".claude", "skills");
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const out: SkillWeight[] = [];
  for (const name of names.sort()) {
    let text: string;
    try { text = await readFile(join(dir, name, "SKILL.md"), "utf8"); } catch { continue; }
    out.push({ name, descChars: skillDescChars(text), bodyChars: text.length });
  }
  return out;
}

/** The always-on weight of one workspace folder's agent instructions. */
export async function weighFolder(folderFsPath: string): Promise<WeightDoc> {
  const claudeMdChars = await readOr0(join(folderFsPath, "CLAUDE.md")) + await readOr0(join(folderFsPath, ".claude", "CLAUDE.md"));
  const skills = await readSkills(folderFsPath);
  return {
    folder: folderFsPath,
    claudeMdChars,
    skills,
    reading: weighContext({ claudeMdChars, skills }, DEFAULT_CONTEXT_LIMITS),
  };
}
