/**
 * The notification feed's state, out of App. Two stores, and `actions.ts` holds
 * their ONLY writers: `onNotification`/`onNotificationList` (the socket
 * handlers) feed `notifs`, and `markAllSeen` (run by the sheet while it is on
 * screen) advances `seenTs`. `mutes` — which kinds may fire, as the host
 * last said (`notify.prefs`, `onNotifyPrefs`) or as a switch just set it
 * (`setNotifyKind`, optimistic: the host echoes the merged set back).
 */
import type { NotificationItem, NotifyPrefs } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import { LS, lsNum } from "../../storage";
import { unreadCount } from "./logic";

/** The desktop's alerts, newest first — `notification.list` replaces, a live
 *  `notification` prepends. */
export const notifs = createStore<NotificationItem[]>([]);
/** ts of the newest alert this phone has seen (persisted) → the unread badge. */
export const seenTs = createStore<number>(lsNum(LS.notifSeen, 0));

/** The unread count the bell badges and the settings row read. */
export function useUnread(): number {
  const items = useStore(notifs);
  const seen = useStore(seenTs);
  return unreadCount(items, seen);
}

/** Which notification kinds may fire (host-persisted). `{}` until the host has
 *  said — every kind reads as on (`notifyEnabled`). */
export const mutes = createStore<NotifyPrefs>({});

export function useNotifyPrefs(): NotifyPrefs {
  return useStore(mutes);
}
