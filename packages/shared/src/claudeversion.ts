
/**
 * The newest `claude` build the screen-reading heuristics were last checked
 * against by a person (what `claude --version` said on the dev desktop).
 * Bump it when you re-verify; the doctor warns for anything NEWER, never for
 * older: no minimum is claimed, because the launch flags (`--session-id`,
 * `--settings`, `--plugin-dir`, `--effort`, `--remote-control`,
 * `--permission-mode`) have no recorded first-supported version here.
 */
export const TESTED_CLAUDE_VERSION = "2.1.304";

/** `2.1.289 (Claude Code)` → [2,1,289]; anything else null (never a guess). */
export function parseClaudeVersion(raw: string | null | undefined): [number, number, number] | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(raw ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * A sentence when the installed `claude` is newer than {@link TESTED_CLAUDE_VERSION},
 * else null. Unparsable ⇒ null (absent, not a warning about nothing). A warning
 * only — it never refuses a session.
 */
export function claudeNewerThanTested(raw: string | null | undefined, tested: string = TESTED_CLAUDE_VERSION): string | null {
  const v = parseClaudeVersion(raw), t = parseClaudeVersion(tested);
  if (!v || !t) return null;
  for (let i = 0; i < 3; i++) {
    if (v[i]! === t[i]!) continue;
    return v[i]! > t[i]! ? `claude ${v.join(".")} is newer than ${t.join(".")}, the newest this build was tested with — heuristics may miss; clihealth will show it` : null;
  }
  return null;
}
