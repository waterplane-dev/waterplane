# diagnostics

### R-diagnostics-001 · shipped
Repo health checks run with configurable alerts for config bloat and skill-file usage, config-grooming prompt templates are offered in fan-out, the main view shows warnings for repos with health/quality issues, and a navigation button leads directly to where an issue can be fixed. A button can automatically fix all validation findings at once, and thresholds are configurable per repo through the UI.
- asked: b28aabf2, 2026-09-12 (session 4de42100), 2026-09-12 (session f434b83b)
- shipped: 9dc4fed, aa20495, d620752, 44fc0b0, 540fa52

### R-diagnostics-002 · shipped
The /api/health endpoint reports ptys.masters equal to the number of active sessions.
- asked: 2026-09-25 (session 23732bb1)
- shipped: 071595d

### R-diagnostics-003 · requested
Setup checklist communicates waterplane capabilities (build tools, auto-download, frame conditions) to the repo and detects outdated skill files with a fix button.
- asked: 2026-09-27 (session 95102cd7)

### R-diagnostics-004 · shipped
Setup checklist inspects and verifies that APK files are present in the repo.
- asked: 2026-09-28 (session 5797470b)
- shipped: 0151a4c

