# instructions

### R-instructions-001 · shipped
Users can optionally apply an instruction set with best practices to prevent image context pollution.
- asked: 2026-09-13
- shipped: 8fbe9f1

### R-instructions-002 · shipped
Documentation clearly states the app is primarily for use with Claude.
- asked: 2026-09-30
- shipped: bcd117d

### R-instructions-003 · requested
Help text explains how cost display differs between CLI and GUI modes.
- asked: 2026-10-04

### R-instructions-004 · requested
CLAUDE.md and the skill files are kept current, accurate and complete, judged by content rather than size thresholds. The context-weight warning uses a threshold that matches real content, not an arbitrary limit.
- asked: 2026-10-17


### R-instructions-005 · shipped
Opening an instruction file (`CLAUDE.md`, `AGENTS.md`, `copilot-instructions.md`, a `*.instructions.md`, a `.claude/rules` file, a skill's `SKILL.md`) in VS Code shows a line above its first row with what that file costs on every request and who reads it. The figure is the same reading as that file's row in the Always-on view, in tokens (the row's characters ÷ CHARS_PER_TOKEN) as the view's headline prints them; a file the view does not count has no line. Saving the file updates it, and a click opens Always-on.
- asked: 2026-10-21
- shipped: 65bbbc25, f41b5db5
### R-instructions-006 · shipped
Skills, instructions and CLAUDE.md views show both token count and character count.
- asked: 2026-10-23
- shipped: bdbf97ce

### R-instructions-007 · shipped
The repo readings sheet keeps what the outside world reports about a repo (exposure watch, Scorecard) in a fourth region, watch, separate from the repo's set-up checklist.
- asked: 2026-10-26
- shipped: fcf473d4


### R-instructions-008 · shipped
The repo's always-on list also names its subagents, its personal CLAUDE.local.md and its MCP servers; a server is listed by name with no size (its tools arrive when it connects), and the context-weight threshold still counts only what it counted before.
- asked: 2026-10-26
- shipped: 11aa6d54, 5addc8e8, e5abc64a

### R-instructions-009 · shipped
The same list has a "this desktop" block: user CLAUDE.md, auto-memory, user and plugin skills and user MCP server names that every session here carries whatever the repo.
- asked: 2026-10-26
- shipped: 11aa6d54, e5abc64a, 5addc8e8

### R-instructions-010 · shipped
VS Code's Always-on view shows the same repo rows and the "this desktop" block as the phone, with links to the session and all-sessions views.
- asked: 2026-10-26
- shipped: c6991a62, 8e6bee2a
