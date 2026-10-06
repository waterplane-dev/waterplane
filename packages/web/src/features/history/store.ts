/**
 * Each session's prompt history (`session.history`), moved out of `App.tsx`.
 * ONE writer: `noteHistory` in `actions.ts`, which App's `session.history`
 * case calls (the case stays in App: the same frame is the terminal feed's
 * proof that the host answered an attach).
 *
 * Seeded from the offline history cache (output stripped — see
 * `offlineCache.ts`), so the sheet has something to show before a reply lands
 * and with no link at all.
 */
import type { HistoryEntry } from "@waterplane/shared";
import { createStore } from "../../sdk";
import { loadHistorySnap } from "../../offlineCache";

export const history = createStore<ReadonlyMap<string, HistoryEntry[]>>(loadHistorySnap());
