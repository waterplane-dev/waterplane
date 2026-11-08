# status

### R-status-001 · shipped
Busy indicators and status messages are aggregated and displayed per repository.
- shipped: 664187d

### R-status-002 · shipped
Failed items display the reason they failed, kept current as the underlying session state changes.
- shipped: 5f635f8, 0789f46

### R-status-003 · shipped
Questions that block progress are detected and flagged to the user.
- asked: 2026-09-11
- shipped: c74402f

### R-status-004 · shipped
Interface displays the currently active model when it is not Claude.
- asked: 2026-09-14
- shipped: 5782931

### R-status-005 · shipped
Status display shows local model resource usage (CPU, memory, GPU utilization, token generation rates) over time.
- asked: 2026-09-14, 2026-09-16
- shipped: 8fbe9f1

### R-status-006 · shipped
External actions (e.g. committing changes yourself) can be acknowledged to prevent duplicate notifications about them.
- asked: 2026-09-19
- shipped: efa7efb

### R-status-007 · shipped
Handled items stop showing as waiting and no longer display red 'ask you' markers once acknowledged.
- asked: 2026-09-24
- shipped: 539dc0d

### R-status-008 · shipped
The queue bar's icon names the cause: a no-connection cloud only when offline, a pause when the person holds the queue, an hourglass when it waits for the turn to end.
- asked: 2026-10-03
- shipped: c67f77e

### R-status-009 · shipped
The public-mirror verification shows each step's start, duration and result on screen while it runs, with a periodic latest-line heartbeat for slow steps.
- asked: 2026-10-07
- shipped: 1dd8f8e5
- note: Misread: the ask was about build output, not a status view.

### R-status-010 · shipped
A backlog item that already ran shows no 'next due now' clock chip; the next time shows only while the item is still waiting.
- asked: 2026-10-08
- shipped: 464ea31d
- note: The done status itself was correct; the chip beside it was wrong.

### R-status-011 · shipped
The red 'Ask you' status has a clearly pressable button right next to it that deactivates the status; it looks like a button, not a status.
- asked: 2026-10-15
- shipped: 844f71f8

### R-status-012 · requested
GitHub Copilot status is never detected covertly; it is determined openly.
- asked: 2026-10-15

### R-status-013 · shipped
The composer's backlog button shows waiting and failed as two numbers at once; done rows count nowhere.
- asked: 2026-10-24
- shipped: 2fb5b5a0


### R-status-014 · shipped
The launcher has two cross-session chips, "N waiting" (a question to answer) and "N blocked" (signed out, network retry, out of credit or at a usage limit — replacing "N at limit"), each with a per-repo twin; a tap opens exactly the N sessions counted, and a sheet that lists fewer than all of them says "n of N" with a way to show all. The blocked sheet groups its rows by reason — sign-in first, with one account-level sign-in action, then network, spend and the usage-limit resume queue.
- asked: 2026-11-02, 2026-11-02
- shipped: 181980cb

### R-status-015 · shipped
Everything outside a session that stops it (signed out, network retry, out of credit, a usage limit) is ONE "blocked" chip, never one chip per reason; the number on the chip is the number of rows in the list it opens, because both are cut by the same derivation. A reason a session shows in its own bar is the same reason the sheet groups it under.
- asked: 2026-11-02 (owner)
- shipped: 0b84920e, 181980cb, 2c16cc67
### R-status-016 · shipped
The waiting label appears only when a session is actually waiting for the user, never for the CLI's own proposed prompt, and shows the correct wording otherwise.
- asked: 2026-11-02
- shipped: b2981528

