/**
 * The host-wide half of the usage-limit resume queue, as `limit.config` says
 * it. ONE writer: the `limit.config` handler in `index.ts` (`onLimitConfig`).
 * Moved out of `App.tsx`, where it was three `useState`s.
 *
 * - `auto` — the global auto-continue switch (host-persisted). Starts `true`,
 *   as App's did, until the host has said.
 * - `mode` — how the queue releases sessions once the limit lifts: one at a
 *   time, one per repo, or all. Kept on the host, because which sessions may run at once
 *   is a fact about the desktop's work, not about the phone that set it.
 * - `hold` — after a resume came back still blocked, how long nothing else may
 *   spend an attempt. A fact about the ACCOUNT, belonging to no one session.
 */
import type { LimitResumeMode } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";

export interface LimitCfg { auto: boolean; mode: LimitResumeMode; hold: number | null }

export const limitCfg = createStore<LimitCfg>({ auto: true, mode: "one", hold: null });

/** The global auto-continue switch. The toolbar toggle, the session row's
 *  `auto`/`no auto` chip and the Settings row read this and nothing else. */
export function useLimitAuto(): boolean {
  return useStore(limitCfg).auto;
}

export function useLimitCfg(): LimitCfg {
  return useStore(limitCfg);
}
