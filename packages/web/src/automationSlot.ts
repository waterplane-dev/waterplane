/**
 * Where the Automation sheet (`features/schedule`) finds a repo's auto-download
 * rule. Features never import each other (`local/feature-boundary`), so
 * `features/pull` hands its rule store and its two verbs to this top-level slot
 * at boot — `peersSlot.ts`'s shape. Empty (a build without the feature) ⇒ the
 * foot draws no auto-download line.
 */
import type { AutoPullConfig } from "@waterplane/shared";
import { createStore, useStore, type Store } from "./sdk/store.ts";

export interface PullRuleSource {
  /** Per-repo rules as the host last said them (`pull.config`), by worktree path. */
  configs: Store<Map<string, AutoPullConfig>>;
  /** Ask the host for one repo's rule (a read, never a tap — nothing is toasted). */
  ask(repoDir: string): void;
  /** The Downloads sheet on that repo's rule — where it is managed. */
  open(repoDir: string): void;
}

const slot = createStore<PullRuleSource | null>(null);
const none = createStore<Map<string, AutoPullConfig>>(new Map());

export function setPullRuleSource(src: PullRuleSource | null): void {
  slot.set(src);
}

/** The source and its rules, read reactively; null without the feature. */
export function usePullRules(): { configs: ReadonlyMap<string, AutoPullConfig>; ask(d: string): void; open(d: string): void } | null {
  const src = useStore(slot);
  const configs = useStore(src?.configs ?? none);
  return src ? { configs, ask: src.ask, open: src.open } : null;
}
