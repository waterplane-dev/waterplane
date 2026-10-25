# notifications

### R-notifications-001 · shipped
User receives a proactive notification when new items arrive.
- shipped: dbcd2aa

### R-notifications-002 · shipped
Markdown files open directly from notifications with one click.
- shipped: c74402f

### R-notifications-003 · shipped
Toast notifications display long enough to read and also appear in the notification list.
- asked: 2026-09-12
- shipped: 3702412

### R-notifications-004 · shipped
When a downloaded app is ready for one-tap installation, the user gets a notification with Install and Later actions.
- asked: 2026-09-25
- shipped: 7bc8c78

### R-notifications-005 · requested
Users can view a list of snoozed or dismissed installation notifications.
- asked: 2026-09-25

### R-notifications-006 · shipped
Toast notifications dismiss on tap, and dismissed toasts still appear in full in the notifications list.
- asked: 2026-09-30
- shipped: 8b08b68

### R-notifications-007 · shipped
Tapping a notification opens the related session or artifact, including a toasted desktop alert after host restart.
- asked: 2026-10-03
- shipped: 0074357

### R-notifications-008 · shipped
A fingerprint approval request shows as a prominent, audible Android notification, and tapping it opens the exact approval page.
- asked: 2026-10-13
- shipped: 1dc5db4

### R-notifications-009 · shipped
A clear button removes the CLI health warnings once the user has read them; a later miss brings them back.
- asked: 2026-10-19
- shipped: 2570087b

### R-notifications-010 · shipped
When the backend restarts, the UI shows a notification so the user knows the connection was interrupted.
- asked: 2026-10-19
- shipped: 8d69613a


### R-notifications-011 · shipped
Every notification is either *needs you* or *information*. Only unhandled *needs you* items count on the bell's red badge; with none, the bell shows no number.
- asked: 2026-10-25 — "Owner wants the red marker ONLY for things that need them; information stays readable but quiet."
- shipped: 52910130

### R-notifications-012 · shipped
Only *needs you* items buzz the phone (OS push and the Android background notification). Information is pushed only when Settings › Notifications › "Push information too" is on, off by default; auto-download keeps working.
- asked: 2026-10-25
- shipped: 52910130

### R-notifications-013 · shipped
Information stays readable in the notification sheet under its own heading and opens its target on tap; it never colours the bell and carries no count.
- asked: 2026-10-25
- shipped: 52910130

### R-notifications-014 · shipped
A tap on the bell's count opens exactly those *needs you* items, saying "n of N" with a show all button.
- asked: 2026-10-25
- shipped: 52910130

### R-notifications-015 · shipped
A *needs you* item stays until the person taps done on it or its cause goes away (the build or push later succeeded, the box was answered), and the row then says which. Opening the sheet or the item's target does not clear it. It survives a desktop restart and is the same on every device.
- asked: 2026-10-25
- shipped: 52910130

### R-notifications-016 · shipped
A failed build, a failed scheduled run, a backlog item that was not delivered, a failed peer job, auto-continue giving up, a session budget stop, an undelivered prompt, low disk and broken CLI health are *needs you*; the same sources' successes are information.
- asked: 2026-10-25
- shipped: 52910130

### R-notifications-017 · shipped
A session's own agent flagging it for follow up is *needs you*; the "flag for follow up when done" launch option's flag is information.
- asked: 2026-10-25
- shipped: 52910130

### R-notifications-018 · shipped
Agents in driven repos are told to flag only when the person must act (new crashes, a failing check or push, a broken environment such as the API being unreachable), never for routine success.
- asked: 2026-10-25
- shipped: 52910130

### R-notifications-019 · shipped
While a repo's newest failed build is unhandled, its build button carries a red worded "build failed" chip; a tap on the notification opens that repo's build sheet on the failure. The next successful run of that build, or done, clears it and says so.
- asked: 2026-10-25
- shipped: 52910130
