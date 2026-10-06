/**
 * The trust slice of `sidecar.ts` — see that file's header for the seam's rules.
 */
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ── Workspace trust ────────────────────────────────────────────────────────

/**
 * Where the CLI keeps its per-folder trust: `$CLAUDE_CONFIG_DIR/.claude.json`,
 * else `~/.claude.json`. Read at call time, so a test (or an e2e host) can
 * point it at a fixture through the same variable the CLI itself honours.
 */
export function claudeConfigPath(e: NodeJS.ProcessEnv = process.env): string {
  return join(e.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
}

/**
 * Whether the claude CLI trusts `cwd` — **read, never written**.
 *
 * Measured on claude 2.1.289, 2026-10-04: `claude -p` in a folder nobody ever
 * trusted SKIPS the workspace-trust dialog and still loads the repo's own
 * `.claude/settings.json` — its `SessionStart` and `UserPromptSubmit` hooks ran
 * — and records nothing. A hook is any shell command, so `assess` and the
 * reviewers, which keep project settings because they need the repo's
 * `CLAUDE.md`, would run a freshly cloned repo's code with nobody asked. The
 * interactive CLI asks; this is the same question, asked of the CLI's own
 * answer rather than of a second ledger that could disagree with it.
 *
 * The rule is the CLI's, measured the same day: a folder whose own entry says
 * `hasTrustDialogAccepted: false` opened with no dialog because a PARENT said
 * `true`, and a folder with no trusted ancestor got the dialog. So: trusted iff
 * the folder or any ancestor is `true`, an own `false` vetoes nothing. Both the
 * path as given and its realpath are walked (the CLI keys `/private/tmp`, a
 * caller may hold `/tmp`).
 *
 * `null` = the file could not be read or parsed: this cannot tell, and the gate
 * treats cannot-tell as not trusted — a refusal is a sentence, a wrong yes runs
 * a stranger's hook.
 */
export async function workspaceTrust(cwd: string, configPath = claudeConfigPath()): Promise<boolean | null> {
  let projects: Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as { projects?: unknown };
    projects = parsed && typeof parsed.projects === "object" && parsed.projects !== null
      ? parsed.projects as typeof projects
      : {};
  } catch {
    return null;
  }
  const starts = new Set([resolve(cwd)]);
  try { starts.add(await realpath(cwd)); } catch { /* a folder that is gone is checked as given */ }
  for (const start of starts) {
    for (let dir = start; ; dir = dirname(dir)) {
      if (projects[dir]?.hasTrustDialogAccepted === true) return true;
      if (dirname(dir) === dir) break;
    }
  }
  return false;
}

/** The sentence a refused run carries, or `undefined` when it may run. */
export function trustRefusal(cwd: string, trust: boolean | null): string | undefined {
  if (trust === true) return undefined;
  if (trust === null) {
    return `Could not read ${claudeConfigPath()} to tell whether Claude Code trusts ${cwd}, so nothing was run — a headless run there would load the repo's own hooks without asking.`;
  }
  return `Claude Code does not trust ${cwd} yet, so nothing was run — a headless run would load the repo's own hooks without asking. Open a session in this repo and answer Claude's trust question, then try again.`;
}
