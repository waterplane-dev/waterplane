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

