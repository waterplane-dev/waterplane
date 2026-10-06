/**
 * The Downloads feature's state, out of App.
 *
 * `records` MIRRORS `pull.ts`, which owns the transfers (retries, resume
 * offsets, the Background Fetch and native hand-offs) — this is only its latest
 * snapshot for rendering, written by the subscription `boot` opens. `cfgs` is
 * the per-repo auto-download rules as the host last said them (`pull.config`)
 * or as this phone just saved them. `rulesFor` is which repo's rules the sheet
 * should open on. Each is written only by `actions.ts`.
 */
import type { AutoPullConfig } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import type { PullRecord } from "../../pull";

export const records = createStore<PullRecord[]>([]);
/** Per-repo rules, keyed by worktree path (filled in as the host answers). */
export const cfgs = createStore<Map<string, AutoPullConfig>>(new Map());
/**
 * Repo whose auto-download RULES the Downloads sheet should open on — set by
 * the repo row's `⋯` menu, which is where "what does this repo fetch by
 * itself?" is actually asked. Cleared when the sheet stops being on top
 * (`onLeave`), so the next ordinary tap on *downloads* opens on the files where
 * it always did rather than on a repo somebody chose ten minutes ago.
 */
export const rulesFor = createStore<string | null>(null);

/** Every transfer on this phone, newest first — `pull.ts`'s list as of its last emit. */
export function usePullRecords(): PullRecord[] {
  return useStore(records);
}
