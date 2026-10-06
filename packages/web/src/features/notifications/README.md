# notifications

The in-app notification feed: every alert the desktop raised (`notification` pushes, and the
`notification.list` re-statement on connect), the unread badge on the two bell buttons, and what a
tap on a row does. The feed's second half — this phone's own toasts — is `ToastLog.tsx`, shown here
but never counted into the badge.

**Owns**

- `store.ts` — `notifs` (newest first, capped at `FEED_CAP` = 100) and `seenTs`, the newest alert
  this phone has seen, and `useUnread()` over both. Writers (`actions.ts`): the socket handlers'
  `onNotification`/`onNotificationList` and `markAllSeen()`, which the sheet runs whenever the feed changes while it is on screen (opening the feed marks everything read,
  including what arrives while it is open). Components only read.
- Storage key: `LS.notifSeen` (`waterplane.notifSeen`) — per device, not synced.
- Sheet: overlay `notifications` (not in `PERSISTED_OVERLAYS` — a reload lands on the screen
  underneath).
- Wire frames: `notification`, `notification.list`, `notify.prefs` (in); `notify.prefs.set` (out); `notification.clear` (out, via
  `core().conn.liveSend`).
- `NOTIF_LABEL` (`logic.ts`) / `NOTIF_ICON` (`NotificationsSheet.tsx`, a lucide import is not
  pure), which the feed's rows and the mute switches read.
- `mutes` (`store.ts`): which kinds may fire, as `notify.prefs` last said or a switch just set
  (`setNotifyKind`, optimistic; the host echoes the merged set).
- Settings rows (`NotificationSettings.tsx`, Notifications, order 10): `notif-feed`, `notif-kinds`.

**Exports for App**: `useUnread()` (the bell badges and the settings row), `badgeText(n)`,
`openNotifs()`, `openNotif(n)`. A backlog alert opens the repo's backlog through
`core().nav.openBacklogCut`.

**Rules that apply**: a readable file gets two verbs — the row reads it (`openArtifact`, the one
viewer), the arrow downloads it (`downloadArtifact`, the one download path, never `<a download>`).
A *Backlog* alert lands on a repo only when exactly ONE worktree basename answers to its title
(`backlogRepoFor`), else the backlog opens unscoped. Push (Web Push / the APK link) is the host
tools' rows, drawn after these.

**Tests**: `logic.test.mjs` (cap, unread, badge, backlog repo match); e2e `notifyprefs`.
