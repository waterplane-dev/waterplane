# sync

### R-sync-001 · shipped
App keeps syncing and running, including session information updates, even when not in the foreground or after closing, via a background service.
- asked: 2026-09-25
- shipped: c0a8666, 21e97b0

### R-sync-002 · shipped
A refused push from the app says why in words, naming the pre-push check step that failed, and the full error opens from the failure notice.
- asked: 2026-10-08
- shipped: 1595748c, 52910130

### R-sync-003 · shipped
A running git push or pull shows a busy indicator on the repo's git button.
- asked: 2026-10-17
- shipped: 596b7482

### R-sync-004 · requested
The phone's push gives the same verdict as a terminal push: the pre-push tests run with the service's environment, a test that fails only under load is retried before it blocks, and two sessions do not run the same checks twice for identical code.
- asked: 2026-10-20
- note: Locale part shipped in run-e2e; retry and dedupe not found.

### R-sync-005 · shipped
The tab order is the same on every device, on by default; when data saver or power saving comes on, the user is offered to stop sharing it.
- asked: 2026-10-21, 2026-10-21
- shipped: 771b06a2, 4f7ffe5d

### R-sync-006 · shipped
A sync button in the launcher header pulls, pushes or syncs every repo at once.
- asked: 2026-10-24
- shipped: daefc36d

### R-sync-007 · shipped
A repo's push-failed label and its bell item clear by themselves once the commits are upstream, however they got there, instead of staying stale until a later push from the host.
- asked: 2026-10-25
- shipped: 37d3d302

