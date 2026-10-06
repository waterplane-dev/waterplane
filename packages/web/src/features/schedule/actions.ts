/**
 * Every writer of the schedule feature's stores, and every frame it sends.
 */
import type { HorizonBucket, ScheduleEntry } from "@waterplane/shared";
import { core } from "../../sdk";
import { scheduleRemovedToast } from "../../clockCuts";
import { saveSchedulesSnap } from "../../localState";
import { scheduleFocus, scheduleFocusIds, schedules, schedulesAt } from "./store";

/** `schedule.list`: the host's list, cached with the time it was confirmed. */
export function onScheduleList(entries: ScheduleEntry[]): void {
  schedules.set(entries);
  saveSchedulesSnap(entries);
  schedulesAt.set(Date.now());
}

/** The launcher chip's tap: the list, cut to the bucket the chip counted
 *  (null = whole — with nothing armed there is no number to check). */
export function openSchedules(focus: HorizonBucket | null): void {
  scheduleFocus.set(focus);
  core().nav.open("schedule");
}

/** Open Schedules cut to exactly these rules, under `label`. */
export function openScheduleCut(ids: string[], label: string): void {
  scheduleFocus.set(null);
  scheduleFocusIds.set({ ids, label });
  core().nav.open("schedule");
}

/** The filter bar's *clear*, and the sheet leaving: both cuts go. */
export function clearScheduleFocus(): void {
  scheduleFocus.set(null);
  scheduleFocusIds.set(null);
}

/** Firing one by hand spawns real sessions, so it goes through the same
 *  durable path as a tapped fan-out, sharing the fan-out lane: a sweep is a
 *  herd of claude processes either way. */
export function runScheduleNow(id: string): void {
  const c = core();
  const { queueOp } = c.queue;
  const e = schedules.get().find((x) => x.id === id);
  const offline = queueOp({ t: "schedule.run", id }, "fanout", e?.name || "scheduled run");
  c.say.toast(offline ? "queued — it runs when the link is back" : "running it now");
}

/** Same cascade as the Activity row's delete: a queued or failed
 *  `schedule.run` names a schedule that is about to stop existing. */
export function removeSchedule(id: string): void {
  const c = core();
  const rows = c.queue.verbs.scheduleQueueRows(id);
  const sent = c.conn.liveSend({ t: "schedule.remove", id }, scheduleRemovedToast(rows.length),
    "no connection — this one lives on the desktop and can only be deleted there");
  if (sent) c.queue.verbs.dropScheduleQueue(rows);
}
