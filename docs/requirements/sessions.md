# sessions

### R-sessions-001 · requested
Session timeout is customizable; default is 24 hours.
- asked: 0d633a46

### R-sessions-002 · requested
Default session-timeout setting is 4 hours.
- asked: e7781210

### R-sessions-003 · shipped
User can control automatic session continuation when multiple sessions have the same state.
- asked: d54922c3
- shipped: 3702412

### R-sessions-004 · shipped
Session creation logic is handled by the backend, not the client.
- asked: f3100a89
- shipped: 6b101ad

### R-sessions-005 · shipped
Sessions with auto-resume enabled automatically resume when a usage limit resets, and auto-fire of queued items halts around a configurable percentage threshold (default 90%) until then, showing a label when auto-resume occurs.
- asked: ddbdf8c5, b00811b4
- shipped: 6a63d3b, 13081a8, 49940fd, 8cc4f68

### R-sessions-006 · requested
Only one active session per repository can be enforced, as an option.
- asked: 536bc2b0

### R-sessions-007 · shipped
Inactive sessions do not remain incorrectly marked as active/running.
- asked: b28aabf2
- shipped: 358ebd4

### R-sessions-008 · shipped
Resume re-attaches a session and displays useful up-to-date information about it (e.g. the actually-running model).
- asked: d1db5624
- shipped: 37eb8cf

### R-sessions-009 · shipped
Session search results display the session title, first prompt, last prompt, and how long it has been open.
- asked: fd290227
- shipped: 5782931

### R-sessions-010 · shipped
Sessions can be marked as done to indicate successful completion when the CLI fails to properly detect success.
- asked: 2026-09-16 (session 8ecb593b)
- shipped: f7caebb

### R-sessions-011 · shipped
Sessions can be starred.
- asked: 2026-09-12 (session dcddb977)
- shipped: e99b908

### R-sessions-012 · shipped
User can scroll through past 5-hour and weekly sessions shown as a heatmap of boxes.
- asked: 2026-09-20 (session df670ad5)
- shipped: 8e79bd0

### R-sessions-013 · shipped
Session list and session detail views share consistent structure, minimal text, and uniform button behavior.
- asked: 2026-09-21 (session c42b4227)
- shipped: 8f710c1

### R-sessions-014 · shipped
Table/graph view toggle button is positioned consistently with other controls across screens.
- asked: 2026-09-21 (session c42b4227)
- shipped: 858a2fb

### R-sessions-015 · requested
Main view displays a visible session where the user can check agent answers.
- asked: 2026-09-21 (session 932e6b12)

### R-sessions-016 · shipped
Sending a prompt offers a choice of target: same session, a new session, or another open session, defaulting to the last choice used.
- asked: 2026-09-24 (session 1eb50b6b), 2026-09-24 (session 1eb50b6b)
- shipped: cb34e8e

### R-sessions-017 · requested
When targeting another open session, relevant keywords for that session's topic display alongside the session options.
- asked: 2026-09-24 (session 1eb50b6b)

### R-sessions-018 · shipped
A button in the session cost view opens a new session that analyzes the cost drivers and suggests improvements without implementing them.
- asked: 2026-09-26 (session 34366d9d)
- shipped: 3c4f0a2

### R-sessions-019 · requested
The session limit is consistent across the codebase.
- asked: 2026-09-30 (session e8f19d6e)

### R-sessions-020 · shipped
Fork and reset cut at the inspected point, before the tapped turn.
- asked: 2026-09-30 (session 87de1621)
- shipped: 7d81033

### R-sessions-021 · requested
When manually running a scheduled prompt, the user sees which session it ran in and its current status.
- asked: 2026-09-30 (session b5df86aa)

### R-sessions-022 · shipped
Sessions opened by fired backlog items and scheduled prompts stay open by default; closing when done is a setting plus a per-item override.
- asked: 2026-10-01 (session b5df86aa)
- shipped: cd04487, 0b398fa

### R-sessions-023 · shipped
Recently closed sessions mark the ones that closed automatically and say why they ended.
- asked: 2026-10-01 (session b5df86aa)
- shipped: 025f6de, e31a4c0

### R-sessions-024 · shipped
Closed sessions show enough to identify their content and purpose: headline, kind, outcome, summary or last prompt, and open time.
- asked: 2026-10-01 (session b5df86aa)
- shipped: 025f6de, e31a4c0

### R-sessions-025 · shipped
Main sessions view shows each session's first and latest prompt, visually separated.
- asked: 2026-10-01 (session df9a9c5b)
- shipped: 864fa9f

### R-sessions-026 · shipped
A live session can be given its own budget — in tokens, dollars, or a share of the 5-hour or weekly usage window — that counts its subagents' spend too; it can be raised or cleared at any time, and the session shows its spend against the cap with the subagent share.
- asked: 2026-10-01
- shipped: 6d43fde, e4c2815, e2d45d5

### R-sessions-027 · shipped
When a session hits its own budget, further sends to it are held until the budget is raised or cleared, a notification says so, and — unless that budget says not to — the running turn is interrupted once; the notification says why when it was not. Answers to a question on screen, uploads and explicit sends still go.
- asked: 2026-10-01
- shipped: e2d45d5

### R-sessions-028 · shipped
A session can be named by hand through a dedicated header button; the typed name persists across restarts and shows in rows, tabs and the header.
- asked: 2026-10-01 (session 9bb39524)
- shipped: b6f9684

