/**
 * The folder's agent-instruction inventory, read off this disk. The rules — who reads which file,
 * when, and what repeats — are `@waterplane/shared`'s `agentfiles.ts`, the same ones the desktop
 * app's `context-weight` row uses; this is only the filesystem under them.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { instructionInventory } from "@waterplane/shared";
import type { AgentFilesFs, CopilotSwitches, InstructionInventory } from "@waterplane/shared";

/** A folder as `AgentFilesFs`: a file that cannot be read is absent, never empty. */
export function folderFs(folder: string): AgentFilesFs {
  return {
    read: (rel) => { try { return readFileSync(join(folder, rel), "utf8"); } catch { return null; } },
    list: (rel) => {
      try { return readdirSync(join(folder, rel), { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })); } catch { return []; }
    },
  };
}

export function inventory(folder: string, sw: CopilotSwitches = {}): InstructionInventory {
  return instructionInventory(folderFs(folder), sw);
}
