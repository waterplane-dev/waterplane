import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "@waterplane/shared";
import { claudeProjectDir } from "./transcript.js";

/**
 * Which live session made each agent worktree — so the launcher can draw a
 * worktree under the session it belongs to instead of in a pile above them all.
 *
 * The CLI records it for us: an Agent spawned with `isolation: "worktree"`
 * leaves `<project dir>/<conversation>/subagents/agent-<id>.meta.json` holding
 * the `worktreePath` it was given. So the answer is a directory listing per
 * live conversation, read off the CLI's own files — no guessing from branch
 * names or mtimes.
 *
 * The worktree's git lock names a pid too, but under tmux the session's own
 * pid is the tmux server's child, not `claude`, so that would be a second,
 * weaker join. A worktree whose conversation is gone (a `/clear`, a closed
 * session) simply has no owner and stays where it was drawn before.
 */
export function worktreeOwners(sessions: Pick<SessionInfo, "id" | "cwd" | "claudeSessionId">[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sessions) {
    if (!s.claudeSessionId) continue;
    const dir = join(claudeProjectDir(s.cwd), s.claudeSessionId, "subagents");
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(dir, n), "utf8")) as { worktreePath?: unknown };
        if (typeof meta.worktreePath === "string" && !out.has(meta.worktreePath)) out.set(meta.worktreePath, s.id);
      } catch { /* a half-written meta is not an owner */ }
    }
  }
  return out;
}
