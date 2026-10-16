import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RepoTarget } from "@waterplane/shared";
import { RUNNING_IN_WSL, wslMountPath } from "./branddirs.js";
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
        // A worktree Windows git made (Claude Code's `.claude/worktrees/…` on a `/mnt/c` checkout)
        // is recorded as `C:/dev/…`; under WSL that is its `/mnt/c` mount, not a relative path.
        const p = line.slice("worktree ".length).trim();
        cur = { path: RUNNING_IN_WSL ? wslMountPath(p) : p };
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
 * A repo's worktrees without spawning git when there is only the main one — the
 * common case, and the expensive one: `git worktree list` is a process per repo
 * per scan, ~1.6 s each from WSL on a `/mnt/c` checkout (36 repos took 57 s).
 * A `.git` DIRECTORY with no `worktrees/` inside has exactly one worktree: the
 * repo dir (realpath'd, as git prints it — the target id is a hash of it) on the
 * branch `HEAD` names. Anything else (linked worktrees, a `.git` FILE of a
 * worktree or submodule, an unreadable HEAD) asks git, as before.
 */
async function repoWorktrees(repoDir: string): Promise<{ path: string; branch: string }[]> {
  const gitDir = join(repoDir, ".git");
  try {
    if ((await stat(gitDir)).isDirectory()) {
      const linked = await readdir(join(gitDir, "worktrees")).catch(() => [] as string[]);
      if (linked.length === 0) {
        const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        const branch = ref ? ref[1] : /^[0-9a-f]{40,64}$/.test(head) ? "(detached)" : null;
        if (branch) return [{ path: await realpath(repoDir), branch }];
      }
    }
  } catch { /* fall through to git */ }
  return gitWorktrees(repoDir);
}

/** One scan per root at a time: the launcher, the setup sweep and the transport survey ask at
 *  once, and on a slow disk each full walk is seconds. A caller arriving mid-scan shares it. */
const inflight = new Map<string, Promise<RepoTarget[]>>();

/**
 * Recursively scan `root` for directories containing a `.git` entry, then
 * enumerate every worktree of each. One target per worktree. Stops descending
 * once a repo is found (nested submodules are ignored). Comma-separated roots
 * are scanned independently and de-duplicated by worktree path.
 *
 * Async all the way down and one `readdir` per directory (entry types from the
 * listing, a `stat` only for a symlink): it used to be `readdirSync` plus a
 * `statSync` per entry, which over WSL's 9P bridge to `/mnt/c` was ~20 ms each
 * — minutes of a blocked event loop per scan, the host deaf to everything else.
 * Concurrent calls share one scan; each caller gets its own copies (callers
 * fill in counts on them).
 */
export async function discoverTargets(root: string): Promise<RepoTarget[]> {
  let p = inflight.get(root);
  if (!p) {
    p = scanTargets(root)
      .then((ts) => { lastScan.set(root, ts); return ts; })
      .finally(() => inflight.delete(root));
    inflight.set(root, p);
  }
  return (await p).map((t) => ({ ...t }));
}

/** The newest finished scan per root — `listTargets`' answer while the next one runs. */
const lastScan = new Map<string, RepoTarget[]>();

/**
 * For the launcher's listing ONLY: a fresh scan when it finishes within `budgetMs` (always, on a
 * local disk — a repo made a moment ago is listed), else the last finished scan, with the fresh one
 * carrying on for the next listing; the first call waits for a scan. A walk of `/mnt/c` from WSL
 * is seconds even done well, and the list is fetched on every launcher open. Anything that DECIDES
 * with the list — `containRepoDir`, a worktree just created — calls `discoverTargets`, never this.
 */
export async function listTargets(root: string, budgetMs = 1500): Promise<RepoTarget[]> {
  const fresh = discoverTargets(root);
  const last = lastScan.get(root);
  if (!last) return fresh;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), budgetMs); });
  const won = await Promise.race([fresh.catch(() => null), late]);
  clearTimeout(timer);
  return won ?? last.map((t) => ({ ...t }));
}

async function scanTargets(root: string): Promise<RepoTarget[]> {
  const maxDepth = Number(env("MAX_DEPTH") ?? DEFAULT_MAX_DEPTH);
  const roots = root.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const targets: RepoTarget[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.name === ".git")) {
      const name = dir.split("/").pop() || dir;
      const worktrees = await repoWorktrees(dir);
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
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const sub = join(dir, entry.name);
      if (!entry.isDirectory()) {
        // A symlink may point at a directory (statSync followed it); anything else is a file.
        if (!entry.isSymbolicLink()) continue;
        try {
          if (!(await stat(sub)).isDirectory()) continue;
        } catch {
          continue;
        }
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
