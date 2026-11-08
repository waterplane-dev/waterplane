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
The backlog lists the most recently added entry at the top by default, with run order one tap away, and opens on the new entry whenever an item is added.
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

