# reliability

### R-reliability-001 · shipped
Typed text, annotated images, and prompts are not lost during errors, timeouts, or send/connectivity failures.
- shipped: 664187d, f479df9

### R-reliability-002 · requested
Timeout errors do not navigate to white or blank pages; app remains usable.

### R-reliability-003 · shipped
UI (question box, answer box) remains stable without flickering during send attempts and reconnection; stale dialogs/question cards no longer redraw or block console visibility.
- shipped: 4b18afc

### R-reliability-004 · shipped
Commands can be submitted consistently without the system resetting, blocking, or becoming unresponsive.
- shipped: fe18ee6

### R-reliability-005 · shipped
Sends are delivered to the server immediately, with the server handling retries for failed sends.
- shipped: fe18ee6, 469c983

### R-reliability-006 · shipped
Error screen displays a retry button.
- asked: 2026-09-24
- shipped: 664187d

### R-reliability-007 · shipped
PTY processes are freed when a preflight check completes, without being kept open.
- asked: 2026-09-25
- shipped: 071595d

### R-reliability-008 · shipped
CLI sessions do not exit unexpectedly.
- asked: 2026-09-30
- shipped: 305e0fc

### R-reliability-009 · requested
Waterplane works robustly and reliably for other open source users who clone and run it.
- asked: 2026-10-04, 2026-10-05

### R-reliability-010 · shipped
Messages between phone and host are delivered at most once, tracked in an ack ledger so nothing is applied twice.
- asked: 2026-10-04
- shipped: 664187d

### R-reliability-011 · requested
The app holds up under load and the full test suite passes.
- asked: 2026-10-08

### R-reliability-012 · requested
The project passes a security review with no unaddressed high-impact issues.
- asked: 2026-10-08

### R-reliability-013 · shipped
waterplane keeps running on the Mac and comes back up on its own after a crash.
- asked: 2026-10-15
- shipped: 009dff3

