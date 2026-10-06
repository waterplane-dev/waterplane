/**
 * The CLI integration's own health (Decision 8, `shared/clihealth.ts`).
 *
 * Only the ROLLUP is held in a store, and that is deliberate: the launcher's
 * mark is the one thing that has to be live, and the full board is a ten-row
 * record that would re-render the whole launcher every time the host's ~5 s
 * debounce fires. The sheet reads the board back out of the snapshot every
 * arriving frame writes (`saveCliHealthSnap`), which is also what makes it
 * paint with the tunnel down.
 *
 * Seeded from that snapshot at load rather than starting null, for the reason
 * every other boot snapshot exists: a degraded CLI is degraded before the
 * socket comes up, and a mark that waits for `hello` is missing from exactly
 * the cold start where the app is slowest to connect.
 *
 * Writers: `rollup` — the `clihealth` handler only; `filter` — `openCliHealth`,
 * the sheet's clear and `onLeave` (all in this folder). The page-lifetime
 * bookkeeping that is not rendered (`seen`, `waiters`) is `actions.ts`'s own.
 */
import type { HealthRollup, HealthVerdict } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import { loadCliHealthSnap } from "../../localState";

export const rollup = createStore<HealthRollup | null>(loadCliHealthSnap()?.value.rollup ?? null);

/** The topbar chip counts broken/degraded signals — a count on a control is
 *  a filter, so the tap opens exactly those, never the whole ten-row board.
 *  Cleared when the sheet closes, same as every other focus here. */
export const filter = createStore<HealthVerdict[] | null>(null);

/** The rollup as last pushed (or snapshotted), for App's own reads — Settings'
 *  "CLI health" door takes its tone from it. */
export function useCliRollup(): HealthRollup | null {
  return useStore(rollup);
}
