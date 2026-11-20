# queue

### R-queue-001 · shipped
Scheduling option is available for operations.
- shipped: 2a9a286, 6b101ad, ff36455

### R-queue-002 · shipped
Queued operations run sequentially by default within the same repository (to conserve tokens and prevent concurrent edits), with an option to choose sequential vs parallel execution, and can be sent to the queue sequentially whether online or offline.
- shipped: 469c983

### R-queue-003 · shipped
A 'retry all' button is available for failed queued items, and failed items retry automatically where possible.
- shipped: 3702412

### R-queue-004 · shipped
Items can be added to a session's queue via an auto-fire button.
- shipped: 664187d

### R-queue-005 · shipped
The prompt queue/send target remembers the user's last choice per repository.
- asked: 2026-09-21
- shipped: 869f232
- note: Since 2026-11-15 only HOW (now / when it's free) is remembered; WHERE is not — "a new session" is a one-shot and the next plain Send goes into the session on screen (R-queue-024).

### R-queue-006 · shipped
A queued prompt clearly shows it is tied to a specific session, and what that means for closing it.
- asked: 2026-09-30
- shipped: 412916b

### R-queue-007 · shipped
Queued sessions run one at a time: the next starts only once the previous one has finished coding and is idle; an open question from a running session blocks it, clearly shown in the UI; the manual fire action starts it immediately, overriding both checks.
- asked: 2026-10-06
- shipped: 5ed143c9, 5ef5e1d7

### R-queue-008 · shipped
Sending a prompt while the session is busy asks whether to send it now or queue it until the session is idle; a remembered answer is kept per device.
- asked: 2026-10-12
- shipped: d112079a

### R-queue-009 · requested
The backlog view clearly shows each scheduled prompt, and its Manage action shows that prompt and its schedule.
- asked: 2026-10-15

### R-queue-010 · shipped
The backlog has a text search that works together with active filters, so items can be found by text while filters stay on.
- asked: 2026-10-15
- shipped: c74402f

### R-queue-011 · shipped
Each waiting backlog row states in words which model it will open on.
- asked: 2026-10-15
- shipped: dbc3ab7

### R-queue-012 · shipped
Backlog and scheduled items deliver their prompt into the session they open exactly once, and a delivery is reported as not confirmed only when the prompt did not actually run in the session.
- asked: 2026-10-16
- shipped: dad1b64a, 1314b947, 5eff24ea

### R-queue-013 · requested
Delivered backlog items show their delivered status and never carry a false failed label.
- asked: 2026-10-15

### R-queue-014 · shipped
The send/queue choice shown before sending matches what actually happens; if Claude queues a message itself, the UI says so instead of offering an unreal option.
- asked: 2026-10-24
- shipped: 8cefeaad

### R-queue-015 · requested
The repo backlog is never lost; backlog items persist.
- asked: 2026-10-24, 2026-10-24

### R-queue-016 · shipped
The backlog lists the most recently added entry at the top by default, with run order one tap away, so in that default order a newly added item is the first row.
- asked: 2026-10-27, 2026-10-29
- shipped: 12680a47, 8aecff3b

### R-queue-017 · shipped
A draft withdrawn by its agent or a row called off shows as settled, not failed, and offers no verb the host refuses.
- asked: 2026-10-28
- shipped: 77e292f3, 2f5bc2aa

### R-queue-018 · requested
Backlog items for a public OSS repo are filed in its lead repository, never in its public mirror.
- asked: 2026-10-29
- note: The original ask was a one-off posting task; the lasting rule is placement.

### R-queue-019 · shipped
The queued-messages notice (e.g. "2 queued, will send when the connection is back") folds away behind the corner button like the other strips above the prompt bar.
- asked: 2026-11-03
- shipped: e1193320

### R-queue-020 · shipped
Typed words in the retired pad rescue store and give-ups ledger survive the upgrade: they come back once, onto the pad or queue, with their original id and time at any age; the old store is kept and nothing appears twice.
- asked: 2026-11-04
- shipped: 4ea4a5ba


### R-queue-021 · shipped
A prompt sent on a "+ new" screen, online or offline, runs in the session that screen opens, exactly once, even when the repo remembers "a new session" as its send aim; the same holds when the session opened while the phone was away.
- asked: 2026-11-12, 2026-11-14
- shipped: 336dda3d6

### R-queue-022 · shipped
On the Android app, when the desktop's link comes back while the app is in the background, the prompts the page would have sent by itself are sent from the background, once each; a prompt that waits on the reconnect question stays put until the person taps "Send N" on the notification. The notification says what was sent and what waits ("Sent 2 to studio. 1 waits for you — open to review"). Nothing is added, edited or deleted in the queue by this; what was sent shows as sent when the app is opened. An older app or desktop keeps the plain "open to send" notice.
- asked: 2026-11-14 (owner)
- shipped: 337cfe90d, ba23c6b4e
- note: not yet tried on a phone.

### R-queue-023 · shipped
In the browser app, queued prompts the page would send by itself go out from the background too: on Android Chrome when the browser wakes the app after the link returns, and on any browser when the "Desktop back online" push arrives (one notification says what was sent and what waits). On iPhone only that push can start it; an outage on the phone's own side waits until the app is opened. Prompts held for a tap wait for it, as in R-queue-022.
- asked: 2026-11-14 (owner)
- shipped: 337cfe90d, 9e918b2bc
- note: not yet run in a real browser; how long iOS lets the push's work run is unmeasured.

### R-queue-024 · shipped
A deliberately set "when it's free" stays remembered per repo, but "a new session" is a one-shot: after it, and on every screen opened later, the plain Send goes into the session on screen.
- asked: 2026-11-15
- shipped: e78486f6d
### R-queue-025 · shipped
Prompts written offline are never lost: send-now while offline, including on a '+ new' screen, fires once the connection is back (in the session that screen opens, or a new one) and never ends up in the pad.
- asked: 2026-11-12, 2026-11-14, 2026-11-15
- shipped: 0a0c641f3, a2e0fbf07

### R-queue-026 · shipped
Every backlog row may carry an estimate (agent cost and time, e.g. "~$3 · 20 min") and a value (high, medium or low), shown in front of its title; agents that file rows fill both, and the backlog sorts by value or cheapest and filters by value and cost bucket.
- asked: 2026-11-20
- shipped: 518564401

