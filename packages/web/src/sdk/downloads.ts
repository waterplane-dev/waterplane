/**
 * The phone's downloads and the per-repo auto-download rules, for an extension's web half
 * (`@waterplane/sdk`). Read-only over the download records (the extension never writes one); the
 * rules are the top-level `pullRules.ts` store — `sdk/` may not import `features/pull` — and the one
 * write, `enableBuilds`, is `pullRules.ts`'s `enableBuildsRule`, the same body the Downloads
 * feature's own card calls.
 */
import { useEffect, useState } from "react";
import type { AutoPullConfig } from "@waterplane/shared";
import { pulls, type PullRecord } from "../pull.ts";
import { cfgs, enableBuildsRule } from "../pullRules.ts";
import { core } from "../core/api.ts";
import { useStore } from "./store.ts";

export type { PullRecord };

/** Every download record on this phone, newest first, re-rendering as they change. */
export function usePullRecords(): PullRecord[] {
  const [records, setRecords] = useState<PullRecord[]>(() => pulls.list());
  useEffect(() => pulls.subscribe(setRecords), []);
  return records;
}

/** The same records outside React — for a `boot` that must hear every change with no sheet mounted
 *  (`App.tsx` returns early once per overlay). Called with the current list at once, then on every
 *  change; returns the unsubscribe. */
export function watchPullRecords(fn: (records: PullRecord[]) => void): () => void {
  return pulls.subscribe(fn);
}

/** The repos' auto-download rules as the host last said them (or this phone just saved them). */
export const pullRules = {
  /** One repo's rule (keyed by worktree path); undefined until the host has answered `pull.get`. */
  use(repoDir: string): AutoPullConfig | undefined {
    // A hook: called at a component's top level, like any other.
    return useStore(cfgs).get(repoDir);
  },
  /** Ask the host for a repo's rule (an answer lands in the store); false with no connection. */
  ask(repoDir: string): boolean {
    return core().conn.trySend({ t: "pull.get", repoDir });
  },
};

/** Turn a repo's auto-download on for its builds, keeping the rest of the rule; `done` is the receipt.
 *  A rule this phone has not read yet is asked for and the tap says to come back — never a default
 *  written over typed patterns. */
export function enableBuilds(repoDir: string, done: string): void {
  const c = core();
  enableBuildsRule(repoDir, done, c.conn, c.say.toast);
}
