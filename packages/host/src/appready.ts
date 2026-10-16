/**
 * `GET /api/apps/readiness` — the repo half of every app's quiet install, across every
 * PRIMARY checkout (an agent worktree is the same app twice). `apkcheck.ts` reads one repo;
 * this walks them, one at a time: each is a bounded async walk on the loop that pumps every
 * PTY. The build list and the auto-download rule are their managers' — passed in as readers.
 */
import type { AppReadinessReport, AutoPullConfig, BuildConfig } from "@waterplane/shared";
import { listTargets } from "./repos.js";
import { apkRepoFacts } from "./apkcheck.js";
import { matches } from "./autopull.js";

export async function appReadinessReport(
  root: string,
  builds: (repoDir: string) => BuildConfig[],
  pull: (repoDir: string) => AutoPullConfig,
): Promise<AppReadinessReport> {
  const apps: AppReadinessReport["apps"] = [];
  for (const t of await listTargets(root)) {
    if (!t.isPrimary) continue;
    try {
      apps.push(...await apkRepoFacts(t, builds(t.worktreePath), pull(t.worktreePath), matches));
    } catch { /* one unreadable repo is an absent row, never a failed report */ }
  }
  return { at: Date.now(), apps };
}
