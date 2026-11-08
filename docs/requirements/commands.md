# commands

### R-commands-001 · requested
User can define and configure sequences of prompts (prompt trains) for CLI sessions.

### R-commands-002 · shipped
App includes a default list of typical routine commands and prompts that the user can fully customize and extend.
- shipped: 664187d

### R-commands-003 · shipped
User can specify prompts to fire after the CLI opens when queuing a CLI-open command or starting a new session.
- shipped: f7caebb

### R-commands-004 · shipped
Shortcuts and commands from the non-compact toolbar are available in compact view and fully customizable.
- shipped: 664187d4

### R-commands-005 · shipped
Repo/session context and prompts are automatically and reliably preserved and delivered when sending prompts to a new or existing session, and never silently disappear before the backend processes them. Prompts are delivered reliably in read mode as well.
- asked: 2026-09-17
- shipped: 3702412, 04abe68, fc9f913, ff36455

### R-commands-006 · shipped
Commands can be queued as one-off items without requiring a recurring schedule.
- shipped: 58066b0

### R-commands-007 · requested
Choosing an image in the Send sheet and coming back returns to the prompt text with the typed words and schedule intact; a prompt is never lost on that round trip.
- asked: 2026-09-14
- note: Item misread the ask: it was about losing the prompt, not editing after sending. Code has an annotator round trip back to send, fix commit not pinned.

### R-commands-008 · shipped
One-time non-recurring prompts display in the active section only and show their execution time instead of a 'not armed' status.
- asked: 2026-09-13
- shipped: 58066b0

### R-commands-009 · shipped
/compact command is promoted as an alternative to the new-session button.
- asked: 2026-09-19
- shipped: de77902

### R-commands-010 · shipped
User can save an idea or bug for later without it auto-firing into the backlog.
- asked: 2026-09-20
- shipped: 869f2328

### R-commands-011 · shipped
Successful /compact submissions are detected as completed rather than reported as failed to send.
- asked: 2026-09-20
- shipped: 7122b77

### R-commands-012 · shipped
User can press a button to generate a conversation title, and a separate button to generate a commit message, both via the same cheap AI mechanism with different prompts.
- asked: 2026-09-21, 2026-09-21
- shipped: e8b83db

### R-commands-013 · shipped
Prompts and commands accept both "waterplane" and "WP" as names for the product.
- asked: 2026-10-01
- shipped: eb7757f

### R-commands-014 · shipped
The local-runtime sheet shows its temperature-reading install steps as copy-ready commands, each with a copy button.
- asked: 2026-10-06
- shipped: a5b785ef
- note: Item generalised one screen to all commands.

### R-commands-015 · shipped
After a slash command the reader cannot show, the app asks whether to switch to the CLI, with a don't-ask-again option kept per device and set in Settings.
- asked: 2026-10-11
- shipped: 09841249

### R-commands-016 · requested
In the edit dialogue the command line is shown shortened, not as the long raw command.
- asked: 2026-10-12

