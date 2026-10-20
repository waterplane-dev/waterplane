/**
 * What a folder's agent instructions cost on EVERY request, for each agent that reads them:
 * the inventory (`@waterplane/shared`'s `agentfiles.ts`, the desktop app's rules) plus Claude
 * Code's threshold reading, `weighContext` over what Claude carries every turn — CLAUDE.md with
 * its `@` imports and unscoped `.claude/rules`, and the skill descriptions (bodies load on demand
 * and are reported as context, never counted against). A folder with none of these files reads
 * as lean at zero chars, which is true: it carries nothing.
 */
import { DEFAULT_CONTEXT_LIMITS, claudeWeightInput, instructionTotals, weighContext } from "@waterplane/shared";
import type { CopilotSwitches } from "@waterplane/shared";
import type { WeightDoc } from "../protocol.js";
import { inventory } from "./instructions.js";

/** The always-on weight of one workspace folder's agent instructions. */
export async function weighFolder(folderFsPath: string, sw: CopilotSwitches = {}): Promise<WeightDoc> {
  const { files, overlaps } = inventory(folderFsPath, sw);
  const input = claudeWeightInput(files);
  const claudeMdChars = files.filter((f) => f.kind === "CLAUDE.md").reduce((n, f) => n + f.parts[0].chars, 0);
  return {
    folder: folderFsPath,
    claudeMdChars,
    skills: input.skills,
    reading: weighContext(input, DEFAULT_CONTEXT_LIMITS),
    files,
    agents: { claude: instructionTotals(files, "claude"), copilot: instructionTotals(files, "copilot") },
    overlaps,
  };
}
