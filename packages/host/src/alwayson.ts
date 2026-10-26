/**
 * What a repo — and this desktop — will put in every Claude Code turn, for the Setup sheet's
 * always-on list (`ComplianceReport.instructions`). The per-repo half is `@waterplane/shared`'s
 * `instructionInventory` over the worktree; the per-desktop half is its `desktopInventory` over the
 * CLI config dir (`claudeconfig.ts`, so `CLAUDE_CONFIG_DIR` and the test home are honoured).
 *
 * Reads only, never writes, never throws: every read is try/catch, and a file that is THERE but
 * cannot be read or parsed becomes a row that says so (`desktopInventory`'s null inputs), never a
 * silent nothing and never a 0. A file that does not exist is a measured empty — no plugins
 * installed, no `~/.claude.json` — not an unreadable one.
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { AgentFilesFs, DesktopSources, InstructionFile, RepoInstructionsDoc } from "@waterplane/shared";
import { DESKTOP_KINDS, desktopInventory, desktopSources, instructionInventory, repoRowsOnThisDesktop } from "@waterplane/shared";
import { claudeConfigDir, claudeProjectDir } from "./claudeconfig.js";
import { contained } from "./paths.js";

/** A directory as `AgentFilesFs`, every path through `contained`: an unreadable file is absent. */
export function worktreeFs(worktree: string): AgentFilesFs {
  return {
    read: (rel) => {
      const abs = contained(worktree, rel);
      if (!abs) return null;
      try { return readFileSync(abs, "utf8"); } catch { return null; }
    },
    list: (rel) => {
      const abs = contained(worktree, rel);
      if (!abs) return [];
      try { return readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })); } catch { return []; }
    },
  };
}

/** The JSON at `path`: `missing` when there is no file, null when it is there but unreadable or not JSON. */
function readJson(path: string): unknown | "missing" | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : null;
  }
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

/**
 * `~/.claude.json` sits in the home dir BESIDE the default config dir; under `CLAUDE_CONFIG_DIR`
 * the CLI keeps it inside that dir instead.
 */
function userClaudeJson(configDir: string): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(configDir, ".claude.json") : join(dirname(configDir), ".claude.json");
}

/** An install path relative to the config dir, or null when it lies outside it. */
const relToConfig = (configDir: string) => (abs: string): string | null => {
  const rel = relative(configDir, abs).split("\\").join("/");
  return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
};

/** The session cwd's realpath — `.claude.json` keys `projects` by it. */
function realOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** The config dir as words: `~/…` when under the home dir, else the path itself. */
function configDirWords(configDir: string): string {
  const home = homedir();
  const rel = relative(home, configDir);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `~/${rel.split("\\").join("/")}` : configDir;
}

/** The files that decide which plugins and MCP servers a session in `cwd` gets, read once (`desktopSources`). */
function sourcesOf(configDir: string, cwd: string): DesktopSources {
  return desktopSources({
    installed: readJson(join(configDir, "plugins", "installed_plugins.json")),
    userSettings: readJson(join(configDir, "settings.json")),
    projectSettings: [".claude/settings.json", ".claude/settings.local.json"].map((path) => ({ path, json: readJson(join(cwd, path)) })),
    claudeJson: readJson(userClaudeJson(configDir)),
    projectKey: realOr(cwd),
    relToConfig: relToConfig(configDir),
  });
}

/** The auto-memory file this cwd's sessions get, relative to the config dir (the CLI's realpath slug rule). */
function memoryRelOf(configDir: string, cwd: string): string | null {
  try {
    const rel = relative(configDir, claudeProjectDir(cwd)).split("\\").join("/");
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `${rel}/memory/MEMORY.md` : null;
  } catch { return null; }
}

/** This desktop's always-on rows for a session started in `cwd` (`scope: "desktop"`). Never throws. */
export function desktopInstructionRows(cwd: string, src?: DesktopSources): { rows: InstructionFile[] | null; why?: string; memoryPath?: string; configDir?: string } {
  try {
    const configDir = claudeConfigDir();
    const memoryRel = memoryRelOf(configDir, cwd);
    const s = src ?? sourcesOf(configDir, cwd);
    const rows = desktopInventory({
      fs: worktreeFs(configDir), memoryRel, plugins: s.plugins, userMcp: s.userMcp,
      disabledPlugins: s.disabledPlugins, userOnlyPlugins: s.userOnlyPlugins, localMcp: s.localMcp,
    });
    // A plugin installed outside the config dir is not read through the config-dir reader: listed, unsized.
    for (const p of s.outside) {
      rows.push({ path: p.path, kind: `${DESKTOP_KINDS.pluginSkills} (${p.name})`, parts: [], unsized: "installed outside the config dir; not read", scope: "desktop" });
    }
    return { rows, ...(memoryRel ? { memoryPath: memoryRel } : {}), configDir: configDirWords(configDir) };
  } catch (e) {
    return { rows: null, why: `this desktop's files could not be read: ${(e as Error)?.message ?? String(e)}` };
  }
}

/**
 * The repo's widened inventory plus this desktop's rows — what `ComplianceReport.instructions` carries.
 * Repo rows are as THIS desktop loads them (`repoRowsOnThisDesktop`: declined `.mcp.json` servers,
 * plugins the repo's settings turn on).
 */
export function repoInstructionsDoc(worktree: string): RepoInstructionsDoc {
  const { files } = instructionInventory(worktreeFs(worktree));
  let src: DesktopSources | undefined;
  try { src = sourcesOf(claudeConfigDir(), worktree); } catch { /* desktopInstructionRows says why */ }
  const d = desktopInstructionRows(worktree, src);
  return {
    files: src ? repoRowsOnThisDesktop(files, src) : files,
    desktop: d.rows,
    ...(d.why ? { desktopWhy: d.why } : {}),
    ...(d.memoryPath ? { memoryPath: d.memoryPath } : {}),
    ...(d.configDir ? { configDir: d.configDir } : {}),
  };
}

/** `repoInstructionsDoc`, or — when building it threw — an empty doc that says so (never an omitted field read as "older host"). */
export function repoInstructionsDocOrWhy(worktree: string): RepoInstructionsDoc {
  try { return repoInstructionsDoc(worktree); } catch (e) {
    return { files: [], desktop: null, why: `the per-file list could not be built on this desktop: ${(e as Error)?.message ?? String(e)}` };
  }
}
