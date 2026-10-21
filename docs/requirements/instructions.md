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
