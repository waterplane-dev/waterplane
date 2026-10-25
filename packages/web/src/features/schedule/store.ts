/**
 * What the schedule feature holds. One writer per store — `actions.ts`, called
 * by the `schedule.list` handler in `index.ts`, the open verbs App and the
 * other sheets call, and the sheet's `onLeave`.
 *
 * Schedules are host state (it owns the clock): the client never derives
 * `nextAt` for an ARMED row, it renders what the host armed. Cached all the
 * same, with its age — "what runs tonight" is a question asked away from the
 * desk, and the sheet answering "nothing is scheduled" offline was a lie.
 * **Seeded from the device cache, never from `[]`** — `scripts/e2e-offlinelists.mjs`
 * holds that line.
 */
import { useMemo } from "react";
import type { HorizonBucket, Intent, ScheduleEntry } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import { clockCuts, type ClockCuts } from "../../clockCuts";
import type { OutboxEntry } from "../../outbox";
import { loadSchedulesSnap } from "../../localState";
import { pendingSchedulesOf } from "./logic";

export const schedules = createStore<ScheduleEntry[]>(loadSchedulesSnap().v);
/** When the host last confirmed the list — the sheet's age line offline. */
export const schedulesAt = createStore<number>(loadSchedulesSnap().at);

/**
 * The bucket the launcher chip's leading number counts — what its tap filters
 * the list to. **A count on a control is a filter**; a filter is what the TAP
 * asked for, never a setting, so leaving the sheet drops it (`onLeave`).
 */
export const scheduleFocus = createStore<HorizonBucket | null>(null);
/** …and the rules cut the sheet was opened on by ids (a backlog row's
 *  *from the schedule “x”*, a repo row's clock chip). Same lifetime. */
export const scheduleFocusIds = createStore<{ ids: string[]; label: string; repoDir?: string } | null>(null);

/** The rule list as the host last said it (or as the cache remembers it). */
export function useSchedules(): ScheduleEntry[] {
  return useStore(schedules);
}

/**
 * **What the schedules button is holding, and how soon — ONE cut, shared with
 * the sheet it opens.** `clockCuts`, the same call the sheet makes over the
 * same two lists, so the number on the chip, the sentence in its title and the
 * header of the sheet are one reading of one pool and cannot be three (they
 * were: 13 · 8 · 2 on one set of rows).
 *
 * The pool is the durable rows AND the rule list AND this phone's queued
 * saves. `nowTick` is App's 30 s tick, so the horizon moves with the clock.
 * Called from `core/launcher/useLauncherModel` (below `bindCore`), with the
 * intents, queue entries and tick the launcher is handed as props.
 */
export function useClocks(intents: readonly Intent[], outbox: readonly OutboxEntry[], nowTick: number): ClockCuts {
  const entries = useStore(schedules);
  const pending = useMemo(() => pendingSchedulesOf(outbox), [outbox]);
  return useMemo(
    () => clockCuts({ intents, entries, pending, focus: null, focusIds: null, now: Date.now() }),
    [intents, entries, pending, nowTick], // eslint-disable-line react-hooks/exhaustive-deps -- `nowTick` is listed in place of the `Date.now()` it stands for, so the horizon moves with the clock
  );
}
