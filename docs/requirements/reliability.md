# reliability

### R-reliability-001 · shipped
Typed text, annotated images, and prompts are not lost during errors, timeouts, or send/connectivity failures.
- asked: 4a28d82d, b373d48e, aafb5a18
- shipped: 664187d, f479df9

### R-reliability-002 · requested
Timeout errors do not navigate to white or blank pages; app remains usable.
- asked: 4a28d82d

### R-reliability-003 · shipped
UI (question box, answer box) remains stable without flickering during send attempts and reconnection; stale dialogs/question cards no longer redraw or block console visibility.
- asked: 7462c103, 94e10ba0, e4ea914f
- shipped: 4b18afc

### R-reliability-004 · shipped
Commands can be submitted consistently without the system resetting, blocking, or becoming unresponsive.
- asked: 7462c103
- shipped: fe18ee6

### R-reliability-005 · shipped
Sends are delivered to the server immediately, with the server handling retries for failed sends.
- asked: 2d7d390c
- shipped: fe18ee6, 469c983

### R-reliability-006 · shipped
Error screen displays a retry button.
- asked: 2026-09-24 (session a4714d61)
- shipped: 664187d

### R-reliability-007 · shipped
PTY processes are freed when a preflight check completes, without being kept open.
- asked: 2026-09-25 (session cc4b7b46)
- shipped: 071595d

### R-reliability-008 · shipped
CLI sessions do not exit unexpectedly.
- asked: 2026-09-30 (session 5fa91aac)
- shipped: 305e0fc

