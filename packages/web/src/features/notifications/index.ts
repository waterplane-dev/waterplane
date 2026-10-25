/**
 * The notification feed — the desktop's alerts on this phone, the unread badge,
 * and what a tap on one does. README.md says what it owns and why.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { NotificationsSheet } from "./NotificationsSheet";
import { onNotification, onNotificationList, onNotifyPrefs } from "./actions";
import { NotificationSettings } from "./NotificationSettings";

export { useUnread } from "./store";
export { NOTIF_LABEL, badgeText } from "./logic";
export { NOTIF_ICON } from "./NotificationsSheet";
export { openNotif, openNotifFromOutside, openNotifs } from "./actions";

export const manifest: FeatureManifest = {
  id: "notifications",
  sheets: [{ id: "notifications", persisted: false, render: () => createElement(NotificationsSheet) }],
  messages: {
    notification: (msg, core) => onNotification(msg.item, core),
    "notification.list": (msg) => onNotificationList(msg.items),
    "notify.prefs": (msg) => onNotifyPrefs(msg.prefs),
  },
  settings: [
    // The head of Notifications: the feed, and which kinds may fire.
    { group: "notifications", order: 10, render: () => createElement(NotificationSettings) },
  ],
};
