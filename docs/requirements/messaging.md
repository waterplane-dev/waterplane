# messaging

### R-messaging-001 · shipped
Sending screen closes during an async send; user continues typing in the inbox.
- shipped: 469c983

### R-messaging-002 · shipped
Inbox and outbox items are clickable and show thumbnails; all image displays show thumbnails the user can click. New outbox images, including GIFs, are displayed correctly.
- asked: 2026-09-11
- shipped: 542d758

### R-messaging-003 · shipped
Synced/sent items show a clear confirmation (e.g. a checkmark) that they reached the server, consistently across queues and lists.
- shipped: c74402fe
- note: Green-check SyncMark on pad, snippets, schedule, fan-out, settings; queue sheet has its own delivered marks. Not every list audited.

### R-messaging-004 · shipped
User can send or suppress the next prompt while a progress indicator is still showing for the previous one.
- shipped: c74402f

### R-messaging-005 · shipped
Message delivery does not show 'undelivered' for at least one minute, and continues auto-retrying without displaying fatal errors.
- asked: 2026-09-12
- shipped: c15250e

### R-messaging-006 · shipped
Editing and resending a message opens the CLI session it was originally sent to.
- asked: 2026-09-12
- shipped: 469c983

### R-messaging-007 · shipped
Slash commands are correctly detected and don't remain in the sent message list.
- asked: 2026-09-12
- shipped: 00aa463

### R-messaging-008 · shipped
Quoting dialog auto-scrolls to show the bottom by default, and each line has a checkbox to select it for quoting.
- asked: 2026-09-24, 2026-09-24
- shipped: 9fd1c04

### R-messaging-009 · shipped
The Send sheet and the pad offer the saved-snippet (quote) button like the compose bar does.
- asked: 2026-09-24
- shipped: 7f118baa

### R-messaging-010 · requested
Typed compose words are kept until the user deletes them, and deleting them asks for confirmation once with an in-app confirm button, never a browser confirm dialog.
- asked: 2026-10-04

### R-messaging-011 · requested
A promo that was sent successfully is reported as sent.
- asked: 2026-10-06

### R-messaging-012 · shipped
A sent message waits a moment for the CLI's full composer frame to show the echoed text before it counts as delivered, instead of trusting a lone bare row; if no frame ever draws it is still accepted.
- asked: 2026-10-20
- shipped: 616671df

### R-messaging-013 · shipped
Sending a message from the phone finishes and does not hang on "Sending… desktop hasn't answered yet; retrying".
- asked: 2026-10-25
- shipped: 9b5b9862

### R-messaging-014 · shipped
A prompt sends from the app as it does in CLI mode when the CLI labels the composer's top border (ultracode on), instead of falling to degraded sending.
- asked: 2026-11-06
- shipped: d10eceb4

### R-messaging-015 · requested
The send queue decides each message's fate correctly from each acknowledgement or verdict it receives.
- asked: 2026-11-10


### R-messaging-016 · shipped
The snippet picker (compose bar, Send sheet, pad) inserts a tapped snippet at once (one snippet stays one tap) and lets the person tick several with the circle on each row, each showing its tap-order number; an Insert button above the list appends them, in tap order and one per line, to the draft. Typed words are never overwritten, and closing the picker drops the ticks.
- asked: 2026-11-12 (owner)
- shipped: 2026-11-12

### R-messaging-017 · shipped
A person who has no snippet list at all is shown shipped starter snippets (marked by one line above the list), which are written to the synced list only when they save an edit in the manage sheet. An existing list, an adopted copy from another device and an emptied list never show or receive starters; the manage sheet can append the starters that are missing, never replace.
- asked: 2026-11-12 (owner)
- shipped: 2026-11-12
