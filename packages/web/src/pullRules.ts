/**
 * The per-repo auto-download rules, as the host last said them (`pull.config`)
 * or as this phone just saved them. Top-level, not in `features/pull`, because
 * two owners write them: the Downloads feature and (once it moves out) the
 * Android apps extension's "install by itself" card, and `sdk/` may not import a
 * feature. `features/pull/{store,actions}.ts` re-export these names.
 */
import type { AutoPullConfig } from "@waterplane/shared";
import { createStore } from "./sdk/store.ts";
import { mapWith } from "./sdk/hooks.ts";

/** Per-repo rules, keyed by worktree path (filled in as the host answers). */
export const cfgs = createStore<Map<string, AutoPullConfig>>(new Map());

export function putCfg(repoDir: string, config: AutoPullConfig): void {
  cfgs.set((prev) => mapWith(prev, repoDir, config));
}

/** The two socket verbs `enableBuildsRule` needs (core's `conn.liveAsk` / `conn.liveSend`). */
export interface RuleConn {
  liveAsk(frame: { t: "pull.get"; repoDir: string }, blocked?: string): boolean;
  liveSend(frame: { t: "pull.save"; repoDir: string; config: AutoPullConfig }, done: string, blocked?: string): boolean;
}

/**
 * Turn a repo's auto-download rule on for its builds, KEEPING what the person set (patterns, cap):
 * only `enabled` and `builds` flip. **Never write defaults over a rule nobody has read** — its
 * patterns are typed words — so a rule this phone has not been told yet is ASKED for and the tap
 * says to come back, instead of saving a fresh default. The one implementation: the Downloads
 * feature's apps card and the extension's (`sdk/downloads.ts` `enableBuilds`) both call it.
 * Returns what happened, for the caller's test: `asked` or `saved`.
 */
export function enableBuildsRule(repoDir: string, done: string, conn: RuleConn, toast: (m: string) => void): "asked" | "saved" {
  const cur = cfgs.get().get(repoDir);
  if (!cur) {
    conn.liveAsk({ t: "pull.get", repoDir }, "no connection — the rule lives on the desktop");
    toast("reading this repo's download rule — tap again in a moment");
    return "asked";
  }
  const config = { ...cur, enabled: true, builds: true };
  putCfg(repoDir, config);
  conn.liveSend({ t: "pull.save", repoDir, config }, done, "no connection — the rule lives on the desktop and was not saved");
  return "saved";
}
