/**
 * The notification feed's state, out of App. Two stores, and `actions.ts` holds
 * their ONLY writers: `onNotification`/`onNotificationList` (the socket
 * handlers) feed `notifs`. `mutes` — which kinds may fire, as the host
 * last said (`notify.prefs`, `onNotifyPrefs`) or as a switch just set it
 * (`setNotifyKind`, optimistic: the host echoes the merged set back).
 */
import type { NotificationItem, NotifyPrefs } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import { needsYouCount } from "./logic";

/** The desktop's alerts, newest first — `notification.list` replaces, a live
 *  `notification` prepends. */
export const notifs = createStore<NotificationItem[]>([]);
/** The bell's number: alerts that still need the person (`needsYou`).
 *  Information never counts; zero draws no number. */
export function useUnread(): number {
  return needsYouCount(useStore(notifs));
}

/** Ids a count opened the sheet on ("3 of 41"); null = the whole feed.
 *  Written only by `openNotifs`/`openNotifCut`/`showAllNotifs`. */
export const notifCut = createStore<string[] | null>(null);

/** Push information too (`notify.prefs.pushInfo`), as the host last said. */
export const pushInfo = createStore<boolean>(false);

/** Which notification kinds may fire (host-persisted). `{}` until the host has
 *  said — every kind reads as on (`notifyEnabled`). */
export const mutes = createStore<NotifyPrefs>({});

export function useNotifyPrefs(): NotifyPrefs {
  return useStore(mutes);
}

/** The feed row a tap asked to see — scrolled to and flashed once by the
 *  sheet, then cleared. Written only by `openNotif`. */
export const notifFocus = createStore<string | null>(null);
