# queue

### R-queue-001 · shipped
Scheduling option is available for operations.
- asked: afd0c960
- shipped: 2a9a286, 6b101ad, ff36455

### R-queue-002 · shipped
Queued operations run sequentially by default within the same repository (to conserve tokens and prevent concurrent edits), with an option to choose sequential vs parallel execution, and can be sent to the queue sequentially whether online or offline.
- asked: 2366fec9, f0d30974, ddbdf8c5
- shipped: 469c983

### R-queue-003 · shipped
A 'retry all' button is available for failed queued items, and failed items retry automatically where possible.
- asked: 12f1e81f
- shipped: 3702412

### R-queue-004 · shipped
Items can be added to a session's queue via an auto-fire button.
- asked: 390ca63b
- shipped: 664187d

### R-queue-005 · shipped
The prompt queue/send target remembers the user's last choice per repository.
- asked: 2026-09-21 (session 012bfa7a)
- shipped: 869f232

### R-queue-006 · shipped
A queued prompt clearly shows it is tied to a specific session, and what that means for closing it.
- asked: 2026-09-30 (session e8f19d6e)
- shipped: 412916b

