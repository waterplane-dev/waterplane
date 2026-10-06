/**
 * What the activity feature holds. One writer: `actions.ts`.
 *
 * `filed` and `confirmedDone` are this PHONE's own marks (`activityDismiss.ts`,
 * `activityDone.ts` own the storage), seeded at load rather than fetched —
 * this is the screen most often opened with the tunnel down. Every writer
 * stores the map the module returns, so the store is never a second read that
 * could disagree with what was written.
 */
import { createStore, useStore } from "../../sdk";
import { dismissedRows, type Dismissals } from "../../activityDismiss";
import { confirmedDoneRows, type ConfirmedDone } from "../../activityDone";
import type { PullRecord } from "../../pull";

/** Rows filed away ("dismissed") — row key → when. */
export const filed = createStore<Dismissals>(dismissedRows());
/** Rows a person marked "save as done" — reclassified, not hidden. */
export const confirmedDone = createStore<ConfirmedDone>(confirmedDoneRows());

export interface ActivityFocus { keys: readonly string[]; label: string }
/**
 * Which rows the sheet should open showing — the queue bar's Manage, a repo's
 * waiting chip, the schedule sheet's spent foot. A count is a filter, so the
 * sheet opens on exactly what was counted. Cleared by the sheet's close.
 */
export const focus = createStore<ActivityFocus | null>(null);

/** `pull.ts`'s transfers as of its last emit, for the Downloads rows. */
export const pullList = createStore<PullRecord[]>([]);

/** What this phone has filed away — App's badges exclude these. */
export function useActivityFiled(): Dismissals {
  return useStore(filed);
}

/** What this phone marked done — App's stuck counts exclude these. */
export function useActivityConfirmedDone(): ConfirmedDone {
  return useStore(confirmedDone);
}
