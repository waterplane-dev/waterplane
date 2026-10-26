/**
 * A worktree's GitHub slug, read straight off its git config (no subprocess: the setup check is
 * synchronous and asked per repo). A linked worktree's `.git` is a FILE (`gitdir: <path>`) whose dir
 * holds a `commondir` file; the config (and the remotes) live in the common dir.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { slugFromConfig } from "../shared/logic.mjs";

const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };

/** The directory that holds `config` for this worktree, or null when it is not a git checkout. */
export function commonGitDir(worktree: string): string | null {
  const dotGit = join(worktree, ".git");
  let st;
  try { st = statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? "");
  if (!m) return null;
  const gitdir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(worktree, m[1]!.trim());
  const common = read(join(gitdir, "commondir"))?.trim();
  const dir = common ? (isAbsolute(common) ? common : resolve(gitdir, common)) : gitdir;
  return existsSync(dir) ? dir : null;
}

export function slugOfWorktree(worktree: string): string | null {
  const dir = commonGitDir(worktree);
  const cfg = dir ? read(join(dir, "config")) : null;
  return cfg ? slugFromConfig(cfg) : null;
}

/** The repo's name as the host names it: the primary checkout's folder (a linked worktree shares it). */
export function repoNameOfWorktree(worktree: string): string {
  const dir = commonGitDir(worktree);
  return dir && basename(dir) === ".git" ? basename(dirname(dir)) : basename(worktree);
}
