/**
 * Where Claude Code keeps a workspace folder's conversations, and which one is
 * "the session".
 *
 * The CLI writes `<config dir>/projects/<slug>/<uuid>.jsonl`, slug = the cwd
 * with every non-alphanumeric replaced by `-`, truncated past 200 chars. The
 * slug rule (truncation included) is the host's `claudeProjectDir`, bundled
 * verbatim, never a second copy: a slug that disagrees with the CLI's by one
 * character is a folder that silently has no sessions.
 *
 * The config dir is a PARAMETER here rather than read off the environment, so
 * the tests can point it at `test/fixtures/` and the extension can honour a
 * setting.
 */
import { realpath, readdir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir as hostClaudeConfigDir, claudeProjectDir } from "../../../host/src/claudeconfig.js";
import type { SessionRow } from "../protocol.js";

/**
 * The claude CLI's private directory: `override` when one is given (a setting),
 * else the host's rule — `CLAUDE_CONFIG_DIR`, then the tests' fake-HOME knob,
 * then `~/.claude`.
 */
export function claudeConfigDir(override?: string): string {
  return override && override.trim() ? override.trim() : hostClaudeConfigDir();
}

/**
 * The host's `claudeProjectDir`, asked about `configDir` rather than the
 * process's own. That function reads `CLAUDE_CONFIG_DIR` at CALL time and is
 * synchronous, so the variable is swapped for exactly the length of the call
 * and restored in `finally` — nothing else can run in between.
 */
function projectDirIn(configDir: string, cwd: string): string {
  const had = Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_CONFIG_DIR");
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try { return claudeProjectDir(cwd); } finally {
    if (had) process.env.CLAUDE_CONFIG_DIR = was;
    else delete process.env.CLAUDE_CONFIG_DIR;
  }
}

const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

/**
 * The project directory holding `folderFsPath`'s conversations, or null with a
 * sentence saying why.
 *
 * Asked under the folder's path as VS Code gives it AND its realpath: the CLI
 * records the cwd it was started in, and on macOS a temp folder is `/var/…` to
 * one of them and `/private/var/…` to the other — two slugs for one folder.
 */
export async function projectDirFor(configDir: string, folderFsPath: string): Promise<{ dir: string | null; why?: string }> {
  const projects = join(configDir, "projects");
  if (!isDir(projects)) {
    return { dir: null, why: `No Claude Code logs on this machine yet: ${projects} does not exist. Run claude in this folder once and it will appear here.` };
  }
  const candidates = [folderFsPath];
  try {
    const real = await realpath(folderFsPath);
    if (real !== folderFsPath) candidates.push(real);
  } catch { /* a folder that does not resolve is asked under the name it was given */ }
  for (const cwd of candidates) {
    const dir = projectDirIn(configDir, cwd);
    if (isDir(dir)) return { dir };
  }
  return { dir: null, why: `Claude Code has not recorded a conversation in ${folderFsPath} yet. Run claude in this folder and its cost and context will appear here.` };
}

/**
 * The top-level conversation logs in a project directory, NEWEST first by
 * mtime. Subagent transcripts (`<uuid>/subagents/…`) are not sessions and are
 * not listed; an unreadable directory is an empty list.
 */
export async function listSessions(projectDir: string): Promise<SessionRow[]> {
  let names: string[];
  try { names = (await readdir(projectDir)).filter((n) => n.endsWith(".jsonl")); } catch { return []; }
  const rows = await Promise.all(names.map(async (n): Promise<SessionRow | null> => {
    const path = join(projectDir, n);
    try {
      const st = await stat(path);
      if (!st.isFile()) return null;
      return { id: n.slice(0, -".jsonl".length), path, mtime: st.mtimeMs, size: st.size };
    } catch { return null; }
  }));
  return rows
    .filter((r): r is SessionRow => r !== null)
    // Ties by id, so two logs written in the same millisecond do not swap places between polls.
    .sort((a, b) => (b.mtime - a.mtime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** "The session" for a folder: its most recently written top-level log, or null when it has none. */
export async function newestSession(projectDir: string): Promise<SessionRow | null> {
  return (await listSessions(projectDir))[0] ?? null;
}
