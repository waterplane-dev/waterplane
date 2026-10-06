/**
 * Where the claude CLI keeps its private state (`projects/`, `sessions/`,
 * `settings.json`, `commands/`, …) — ONE definition, so no reader hard-codes
 * `~/.claude`.
 *
 * The CLI honours `CLAUDE_CONFIG_DIR`, which REPLACES the whole `~/.claude`
 * directory (not its parent). Order here: `CLAUDE_CONFIG_DIR` (what the CLI
 * itself would use, and what a spawned `claude` inherits unchanged), else the
 * test knob `<PREFIX>CLAUDE_HOME` (a HOME-like root, `.claude` joined on), else
 * `<home>/.claude`. An empty string is unset, like the CLI's own truthiness
 * test. Pure: the caller hands over the environment and the home directory.
 */
import { envName, legacyEnvNames } from "./brand.js";

const stripSlash = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);

export function claudeConfigDirOf(o: { configDir?: string | undefined; testHome?: string | undefined; home: string }): string {
  if (o.configDir) return o.configDir;
  return `${stripSlash(o.testHome || o.home)}/.claude`;
}

/** `claudeConfigDirOf` over a process environment (the test knob under the
 *  current brand's prefix, then each legacy one). For callers with no host `env()`. */
export function claudeConfigDirFromEnv(e: Record<string, string | undefined>, home: string): string {
  let testHome: string | undefined;
  for (const n of [envName("CLAUDE_HOME"), ...legacyEnvNames("CLAUDE_HOME")]) {
    if (e[n]) { testHome = e[n]; break; }
  }
  return claudeConfigDirOf({ configDir: e.CLAUDE_CONFIG_DIR, testHome, home });
}

/**
 * The longest folder name the CLI writes under `projects/` before it truncates
 * (read out of the 2.x bundle: `slug.length <= 200 ? slug : slug.slice(0,200) +
 * "-" + abs(hash(path)).toString(36)`). The hash is NOT re-derived here.
 * `transcriptDirName` (requirements.ts) is the untruncated slug.
 */
export const PROJECT_SLUG_MAX = 200;

/** For a slug the CLI would have truncated: the surviving head plus its `-`, to
 *  match directory names against. null when the slug is short enough to be exact. */
export function truncatedSlugPrefix(slug: string): string | null {
  return slug.length > PROJECT_SLUG_MAX ? slug.slice(0, PROJECT_SLUG_MAX) + "-" : null;
}
