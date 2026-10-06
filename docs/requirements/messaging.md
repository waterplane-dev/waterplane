# messaging

### R-messaging-001 · shipped
Sending screen closes during an async send; user continues typing in the inbox.
- asked: 8ef060c9
- shipped: 469c983

### R-messaging-002 · shipped
Inbox and outbox items are clickable and show thumbnails; all image displays show thumbnails the user can click. New outbox images, including GIFs, are displayed correctly.
- asked: 6bf8f3d9, 1648279e, 2026-09-11 (session 205ffa7f)
- shipped: 542d758

### R-messaging-003 · requested
Synced/sent items show a clear confirmation (e.g. a checkmark) that they reached the server, consistently across queues and lists.
- asked: 48be8bda, 390ca63b

### R-messaging-004 · shipped
User can send or suppress the next prompt while a progress indicator is still showing for the previous one.
- asked: 390ca63b
- shipped: c74402f

### R-messaging-005 · shipped
Message delivery does not show 'undelivered' for at least one minute, and continues auto-retrying without displaying fatal errors.
- asked: 2026-09-12 (session 8c417efe, eb25ef1f)
- shipped: c15250e

### R-messaging-006 · shipped
Editing and resending a message opens the CLI session it was originally sent to.
- asked: 2026-09-12 (session 66d28f27)
- shipped: 469c983

### R-messaging-007 · shipped
Slash commands are correctly detected and don't remain in the sent message list.
- asked: 2026-09-12 (session 66d28f27)
- shipped: 00aa463

### R-messaging-008 · shipped
Quoting dialog auto-scrolls to show the bottom by default, and each line has a checkbox to select it for quoting.
- asked: 2026-09-24 (session 7810f5e8), 2026-09-24 (session 7810f5e8)
- shipped: 9fd1c04

### R-messaging-009 · requested
User can quote marked content from a second screen while remaining on the first screen.
- asked: 2026-09-24 (session da53b148)

