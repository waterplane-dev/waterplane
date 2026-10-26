/**
 * What a folder's agent instructions cost on EVERY request, for each agent that reads them:
 * the inventory (`@waterplane/shared`'s `agentfiles.ts`, the desktop app's rules) plus Claude
 * Code's threshold reading, `weighContext` over what Claude carries every turn — CLAUDE.md with
 * its `@` imports and unscoped `.claude/rules`, and the skill descriptions (bodies load on demand
 * and are reported as context, never counted against). A folder with none of these files reads
 * as lean at zero chars, which is true: it carries nothing.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DEFAULT_CONTEXT_LIMITS, DESKTOP_KINDS, claudeWeightInput, desktopInventory, desktopSources, instructionTotals, repoRowsOnThisDesktop, transcriptDirName, weighContext } from "@waterplane/shared";
import type { CopilotSwitches, DesktopSources, InstructionFile } from "@waterplane/shared";
import type { WeightDoc } from "../protocol.js";
import { configFs, inventory } from "./instructions.js";
import { claudeConfigDir } from "./logs.js";

/** The JSON at `path`: "missing" when there is no file, null when it is there but unreadable or not JSON. */
function readJson(path: string): unknown {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : null; }
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

/** The config dir as words: `~/…` when under the home dir, else the path itself. */
function configDirWords(configDir: string): string {
  const rel = relative(homedir(), configDir);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `~/${rel.split("\\").join("/")}` : configDir;
}

/** The host's reading (`host/alwayson.ts`): the same files through `desktopSources`, `~/.claude.json` beside the default config dir. */
function sourcesOf(folder: string, real: string, configDir: string): DesktopSources {
  return desktopSources({
    installed: readJson(join(configDir, "plugins", "installed_plugins.json")),
    userSettings: readJson(join(configDir, "settings.json")),
    projectSettings: [".claude/settings.json", ".claude/settings.local.json"].map((path) => ({ path, json: readJson(join(folder, path)) })),
    claudeJson: readJson(process.env.CLAUDE_CONFIG_DIR ? join(configDir, ".claude.json") : join(dirname(configDir), ".claude.json")),
    projectKey: real,
    relToConfig: (abs) => {
      const rel = relative(configDir, abs).split("\\").join("/");
      return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
    },
  });
}

/** This desktop's always-on rows for a session started in `folder`; never throws (rows null + why). */
function desktopRows(folder: string, configDir: string): { rows: InstructionFile[] | null; why?: string; memoryPath?: string; src?: DesktopSources } {
  try {
    let real = folder;
    try { real = realpathSync(folder); } catch { /* the name it was given */ }
    const memoryRel = `projects/${transcriptDirName(real)}/memory/MEMORY.md`;
    const s = sourcesOf(folder, real, configDir);
    const rows = desktopInventory({
      fs: configFs(configDir), memoryRel, plugins: s.plugins, userMcp: s.userMcp,
      disabledPlugins: s.disabledPlugins, userOnlyPlugins: s.userOnlyPlugins, localMcp: s.localMcp,
    });
    for (const p of s.outside) {
      rows.push({ path: p.path, kind: `${DESKTOP_KINDS.pluginSkills} (${p.name})`, parts: [], unsized: "installed outside the config dir; not read", scope: "desktop" });
    }
    return { rows, memoryPath: memoryRel, src: s };
  } catch (e) {
    return { rows: null, why: `this desktop's files could not be read: ${(e as Error)?.message ?? String(e)}` };
  }
}

/** The always-on weight of one workspace folder's agent instructions. */
export async function weighFolder(folderFsPath: string, sw: CopilotSwitches = {}, configDir: string = claudeConfigDir()): Promise<WeightDoc> {
  const inv = inventory(folderFsPath, sw);
  const input = claudeWeightInput(inv.files);
  const claudeMdChars = inv.files.filter((f) => f.kind === "CLAUDE.md").reduce((n, f) => n + f.parts[0].chars, 0);
  const d = desktopRows(folderFsPath, configDir);
  // Repo rows as THIS desktop loads them; added rows are unsized, so the threshold input above is unchanged.
  const files = d.src ? repoRowsOnThisDesktop(inv.files, d.src) : inv.files;
  const overlaps = inv.overlaps;
  return {
    folder: folderFsPath,
    claudeMdChars,
    skills: input.skills,
    reading: weighContext(input, DEFAULT_CONTEXT_LIMITS),
    files,
    agents: { claude: instructionTotals(files, "claude"), copilot: instructionTotals(files, "copilot") },
    overlaps,
    desktop: d.rows,
    ...(d.why ? { desktopWhy: d.why } : {}),
    ...(d.memoryPath ? { memoryPath: d.memoryPath } : {}),
    configDir: configDirWords(configDir),
  };
}
