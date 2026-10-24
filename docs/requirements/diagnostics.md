# diagnostics

### R-diagnostics-001 · shipped
Repo health checks run with configurable alerts for config bloat and skill-file usage, config-grooming prompt templates are offered in fan-out, the main view shows warnings for repos with health/quality issues, and a navigation button leads directly to where an issue can be fixed. A button can automatically fix all validation findings at once, and thresholds are configurable per repo through the UI.
- asked: 2026-09-12, 2026-09-12
- shipped: 9dc4fed, aa20495, d620752, 44fc0b0, 540fa52

### R-diagnostics-002 · shipped
The /api/health endpoint reports ptys.masters equal to the number of active sessions.
- asked: 2026-09-25
- shipped: 071595d

### R-diagnostics-003 · requested
Setup checklist communicates waterplane capabilities (build tools, auto-download, frame conditions) to the repo and detects outdated skill files with a fix button.
- asked: 2026-09-27

### R-diagnostics-004 · shipped
Setup checklist inspects and verifies that APK files are present in the repo.
- asked: 2026-09-28
- shipped: 0151a4c

### R-diagnostics-005 · shipped
Each diagnostic view has a clear title with the total cost chart at the top.
- asked: 2026-10-03
- shipped: 9d0747e

### R-diagnostics-006 · shipped
The doctor reports the WSL idle state correctly by asking Windows for the keep-alive task.
- asked: 2026-10-09
- shipped: aeae7b6e

### R-diagnostics-007 · requested
The log view has a Copy Log button and a button sending the log to a CLI session for fixing; the log opens directly below the clicked row.
- asked: 2026-10-14

### R-diagnostics-008 · shipped
A checkbox dialog with the cursor on Submit is still recorded as an open dialog in the health record, even when the footer wraps and includes 'ctrl+g to edit in Vim'.
- asked: 2026-10-17, 2026-10-17
- shipped: 5cb8f255

### R-diagnostics-009 · requested
The doctor command checks for the nom package and reports on it.
- asked: 2026-10-19

### R-diagnostics-010 · shipped
Each CLI health signal has a fixture current for the installed CLI version, harvested from the live host once per version as one redacted sample (chrome verbatim, prose and secrets masked), and written into the repo only on explicit request.
- asked: 2026-10-20
- shipped: d1d922d1, f69cd06b

### R-diagnostics-011 · shipped
A failing CLI health row has an "inspect in a session" button that sends its facts and fixture paths to a new session in the checkout; it shows only on a developer's git-checkout install, never for regular users.
- asked: 2026-10-21
- shipped: aee461a2

### R-diagnostics-012 · shipped
The deliver.submit signal reports a prompt's turn start correctly on current CLI versions, so rule misses are not false alarms.
- asked: 2026-10-21
- shipped: 01fca91a

### R-diagnostics-013 · requested
Each screen-reading signal (prompt.box, prompt.submit, askbox.enrich, context.meter, limit.reset) has at least one real captured match fixture from a current Claude CLI release; harvested captures are checked for paths, names and secrets before commit.
- asked: 2026-10-21

### R-diagnostics-014 · shipped
The app shows which skills are loaded into context and when each was used, per conversation and per subagent.
- asked: 2026-10-21
- shipped: ad8ac0e0

