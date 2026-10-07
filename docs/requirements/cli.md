# cli

### R-cli-001 · shipped
CLI view supports upward scrolling even with poor connection, and across all sessions.
- asked: 2026-09-19
- shipped: f479df9

### R-cli-002 · shipped
CLI input mode can be toggled — via a button at the end of the special-keys row — to allow direct interaction without the text box; in this mode keystrokes go directly to the PTY without text-box queueing.
- shipped: f479df9

### R-cli-003 · shipped
CLI integration reports its own health and surfaces failures immediately and visibly, rather than degrading silently. Send detection includes a fallback delivery detector based on CLI reaction.
- asked: 2026-09-17
- shipped: d3e34dd, fc9f913, 95ce6d4

### R-cli-004 · shipped
Long messages are fully sent to the CLI including the final return, ensuring they are properly accepted.
- asked: 2026-09-17
- shipped: c15250e

### R-cli-005 · shipped
Read mode captures and displays final CLI output correctly, not missing it.
- asked: 2026-09-18
- shipped: 7122b77

### R-cli-006 · requested
CLI mode can operate using only command-line arguments with no button interface.
- asked: 2026-09-21

### R-cli-007 · shipped
Update notification for the Claude CLI ceases once the CLI is actually updated, regardless of install method (brew or npm).
- asked: 2026-09-24
- shipped: 1955883

### R-cli-008 · requested
waterplane works with both Claude CLI variants and supports fallback between them.
- asked: 2026-09-24

### R-cli-009 · shipped
The CLI closes its background shells when it exits.
- asked: 2026-09-28
- shipped: a1a9283

