import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RepoTarget } from "@waterplane/shared";
import { env } from "./env.js";
import { execFileP as pexec } from "./proc.js";


export function targetId(worktreePath: string): string {
  return createHash("sha1").update(worktreePath).digest("hex").slice(0, 10);
}

async function gitWorktrees(repoDir: string): Promise<{ path: string; branch: string }[]> {
  try {
    const { stdout } = await pexec("git", ["worktree", "list", "--porcelain"], { cwd: repoDir });
    const out: { path: string; branch: string }[] = [];
    let cur: { path?: string; branch?: string } = {};
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? "(detached)" });
        cur = { path: line.slice("worktree ".length).trim() };
      } else if (line.startsWith("branch ")) {
        cur.branch = line.slice("branch ".length).replace("refs/heads/", "").trim();
      } else if (line.startsWith("detached")) {
        cur.branch = "(detached)";
      }
    }
    if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? "(detached)" });
    return out;
  } catch {
    return [{ path: repoDir, branch: "(unknown)" }];
  }
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target",
  ".next", ".turbo", ".cache", "vendor", "venv", ".venv", "__pycache__",
]);

const DEFAULT_MAX_DEPTH = 4;

/**
 * Recursively scan `root` for directories containing a `.git` entry, then
 * enumerate every worktree of each. One target per worktree. Stops descending
 * once a repo is found (nested submodules are ignored). Comma-separated roots
 * are scanned independently and de-duplicated by worktree path.
 */
export async function discoverTargets(root: string): Promise<RepoTarget[]> {
  const maxDepth = Number(env("MAX_DEPTH") ?? DEFAULT_MAX_DEPTH);
  const roots = root.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const targets: RepoTarget[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    if (entries.includes(".git")) {
      const name = dir.split("/").pop() || dir;
      const worktrees = await gitWorktrees(dir);
      for (let i = 0; i < worktrees.length; i++) {
        const wt = worktrees[i];
        if (seen.has(wt.path)) continue;
        seen.add(wt.path);
        targets.push({
          id: targetId(wt.path),
          repoName: name,
          branch: wt.branch,
          isPrimary: i === 0,
          worktreePath: wt.path,
          outboxCount: 0,
          changedCount: 0,
        });
      }
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry)) continue;
      const sub = join(dir, entry);
      try {
        if (!statSync(sub).isDirectory()) continue;
      } catch {
        continue;
      }
      await visit(sub, depth + 1);
    }
  };

  for (const r of roots) {
    await visit(r, 0);
  }
  return targets;
}

export async function findTarget(root: string, id: string): Promise<RepoTarget | null> {
  const all = await discoverTargets(root);
  return all.find((t) => t.id === id) ?? null;
}
