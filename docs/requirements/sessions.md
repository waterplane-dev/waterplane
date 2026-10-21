# sessions

### R-sessions-001 · requested
Session timeout is customizable; default is 24 hours.

### R-sessions-002 · requested
Default session-timeout setting is 4 hours.

### R-sessions-003 · shipped
User can control automatic session continuation when multiple sessions have the same state.
- shipped: 3702412

### R-sessions-004 · shipped
Session creation logic is handled by the backend, not the client.
- shipped: 6b101ad

### R-sessions-005 · shipped
Sessions with auto-resume enabled automatically resume when a usage limit resets, and auto-fire of queued items halts around a configurable percentage threshold (default 90%) until then, showing a label when auto-resume occurs.
- shipped: 6a63d3b, 13081a8, 49940fd, 8cc4f68

### R-sessions-006 · requested
Only one active session per repository can be enforced, as an option.

### R-sessions-007 · shipped
Inactive sessions do not remain incorrectly marked as active/running.
- shipped: 358ebd4

### R-sessions-008 · shipped
Resume re-attaches a session and displays useful up-to-date information about it (e.g. the actually-running model).
- shipped: 37eb8cf

### R-sessions-009 · shipped
Session search results display the session title, first prompt, last prompt, and how long it has been open.
- shipped: 5782931

### R-sessions-010 · shipped
Sessions can be marked as done to indicate successful completion when the CLI fails to properly detect success.
- asked: 2026-09-16
- shipped: f7caebb

### R-sessions-011 · shipped
Sessions can be starred.
- asked: 2026-09-12
- shipped: e99b908

### R-sessions-012 · shipped
User can scroll through past 5-hour and weekly sessions shown as a heatmap of boxes.
- asked: 2026-09-20
- shipped: 8e79bd0

### R-sessions-013 · shipped
Session list and session detail views share consistent structure, minimal text, and uniform button behavior.
- asked: 2026-09-21
- shipped: 8f710c1

### R-sessions-014 · shipped
Table/graph view toggle button is positioned consistently with other controls across screens.
- asked: 2026-09-21
- shipped: 858a2fb

### R-sessions-015 · requested
Main view displays a visible session where the user can check agent answers.
- asked: 2026-09-21

### R-sessions-016 · shipped
Sending a prompt offers a choice of target: same session, a new session, or another open session, defaulting to the last choice used.
- asked: 2026-09-24, 2026-09-24
- shipped: cb34e8e

### R-sessions-017 · requested
When targeting another open session, relevant keywords for that session's topic display alongside the session options.
- asked: 2026-09-24

### R-sessions-018 · shipped
A button in the session cost view opens a new session that analyzes the cost drivers and suggests improvements without implementing them.
- asked: 2026-09-26
- shipped: 3c4f0a2

### R-sessions-019 · requested
The session limit is consistent across the codebase.
- asked: 2026-09-30

### R-sessions-020 · shipped
Fork and reset cut at the inspected point, before the tapped turn.
- asked: 2026-09-30
- shipped: 7d81033

### R-sessions-021 · requested
When manually running a scheduled prompt, the user sees which session it ran in and its current status.
- asked: 2026-09-30

### R-sessions-022 · shipped
Sessions opened by fired backlog items and scheduled prompts stay open by default; closing when done is a setting plus a per-item override.
- asked: 2026-10-01
- shipped: cd04487, 0b398fa

### R-sessions-023 · shipped
Recently closed sessions mark the ones that closed automatically and say why they ended.
- asked: 2026-10-01
- shipped: 025f6de, e31a4c0

### R-sessions-024 · shipped
Closed sessions show enough to identify their content and purpose: headline, kind, outcome, summary or last prompt, and open time.
- asked: 2026-10-01
- shipped: 025f6de, e31a4c0

### R-sessions-025 · shipped
Main sessions view shows each session's first and latest prompt, visually separated.
- asked: 2026-10-01
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
- asked: 2026-10-01
- shipped: b6f9684


### R-sessions-029 · shipped
A claude session's permission mode (manual, accept edits, plan, auto — and bypass / don't ask where the session has them) can be read and switched from the phone the way the desktop's mode menu does, following a change typed at the desk; ultracode shows as the CLI last confirmed it. A mode the session's shift+tab cycle does not hold, an open question box or an unreadable footer is said in words, never guessed.
- asked: 2026-10-07
- shipped: 0567a97
### R-sessions-030 · requested
When a new project folder is opened for the first time, waterplane asks whether to trust it; until trusted, the folder runs in restricted mode and its hooks do not execute.
- asked: 2026-10-04

### R-sessions-031 · requested
Tapping the worktree chip does not apply the note filter.
- asked: 2026-10-05

### R-sessions-032 · requested
The latest item shows at the top of the list.
- asked: 2026-10-06

### R-sessions-033 · shipped
A shared item can go to the currently open session, a new session, or an existing session the user selects.
- asked: 2026-10-06
- shipped: c1d7d699

### R-sessions-034 · requested
Sessions started from the backlog or by the scheduler appear in the main session view.
- asked: 2026-10-06

### R-sessions-035 · shipped
A worktree is shown next to the session it belongs to, not visually closer to the session below it.
- asked: 2026-10-06
- shipped: dc5373ce

### R-sessions-036 · requested
The user can see the kick-off progress of a session.
- asked: 2026-10-08

### R-sessions-037 · shipped
Open sessions are numbered per repo from 0, in list order; only open sessions get numbers and a filter never renumbers the rest.
- asked: 2026-10-09
- shipped: 7e2cb96c

### R-sessions-038 · shipped
Sending a file to a session shows a picker of the live sessions to choose from, and a separate new-session button sits beside it.
- asked: 2026-10-09
- shipped: f15b3ed8

### R-sessions-039 · shipped
A repo with no active session wears the same header and fold as the others; opened, it shows a "No active session" line pointing to the + button.
- asked: 2026-10-12
- shipped: b6df0dab


### R-sessions-040 · shipped
Every repo header carries two worded buttons right under the repo name: "+ now" opens a new session at once, "+ later" opens the Send sheet aimed at that repo with its When on "when it's free". They replace the header's bare + and the "⋯" menu's send….
- asked: 2026-10-13
- changed: "+ later" opens a session screen, not the Send sheet — R-sessions-046

### R-sessions-041 · shipped
A session can be flagged for follow up, beside its star, with a flag icon. The flag is one-shot: opening the session never clears it, only the person's explicit "done" tap does. It is kept per conversation, so it survives restarts, a closed session and a resume, and a bulk close spares flagged sessions.
- asked: 2026-10-14
- shipped: 308625ba, dc25a182

### R-sessions-042 · shipped
Who set the follow-up flag is visible in its colour and words: the person by hand, the person's launch option, or the session's own agent (with its one-line reason under the row and in the notification).
- asked: 2026-10-14
- shipped: 308625ba, dc25a182

### R-sessions-043 · shipped
A backlog item, a scheduled prompt and a fan-out can be launched with "Flag for follow up when done", off unless ticked; the session gets the flag when it is done (no turn running, no box open, nothing still running under it). A run that failed or stopped on a usage limit never gets it from this option.
- asked: 2026-10-14
- shipped: bea81941, dc25a182

### R-sessions-044 · shipped
An agent in a waterplane-driven session can flag its own session for follow up with a one-line reason when it finishes with something the person should read; it can set the flag but never clear it.
- asked: 2026-10-14
- shipped: f66af4b4, dc25a182

### R-sessions-045 · shipped
A count of flagged sessions shows on the repo group; tapping it shows exactly those sessions, saying "n of N" with a clear button.
- asked: 2026-10-14
- shipped: dc25a182

### R-sessions-046 · shipped
"+ later" (and a worktree row's send button) opens the same session screen as "+ now", with the same prompt box — paste, drop, chain, dictation — instead of a separate prompt input in the Send sheet. Where the terminal would be, it says the session starts only once the backlog item runs. Send queues it for a new session when the repo is free; "elsewhere or later…" puts it on a clock. Nothing is queued until Send, and the draft stays for the next "+ later" on that repo.
- asked: 2026-10-15

### R-sessions-047 · shipped
An emergency halt stops every AI process waterplane started on the desktop (agent sessions, attached or detached, with their tools and sidecars, and headless model runs) with a hard kill after a short grace, and latches across host restarts until the person lifts it. While it is on, nothing automatic starts and no AI session can be started; the app says in plain words that AI is halted and how to lift it. Processes started outside waterplane are not reached yet, though that may become optional.
- asked: 2026-10-15
- shipped: 68ae6d70

### R-sessions-048 · shipped
A session budget can be set HARD instead of the default soft. Soft is R-sessions-027 unchanged. Hard, once over: queued and scheduled sends stay held, each send the person makes from the phone asks "send anyway?" first (yes runs that one turn, no keeps the words in the box), and every turn the person did not send — a subagent reporting back, a chained or resumed prompt — gets one Esc, turn after turn, not only at the crossing. The budget field shows both choices, each saying what it does, with soft preselected.
- asked: 2026-10-18 — "A and b and make this optional as alternative "hard" behavior. Explain it clearly in the UI what both options do and have the current one be the default"
### R-sessions-049 · shipped
A shell session keeps the repo it was opened in even after the person cds elsewhere, and a session whose folder is inside a repo or worktree is labelled with that repo's name, including after it is closed.
- asked: 2026-10-15
- shipped: 579c8b42

### R-sessions-050 · requested
A prompt sent into a session is detected as delivered without the user pressing the on-screen return key.
- asked: 2026-10-16

### R-sessions-051 · requested
Prompts from marked screenshots go to a new session with the prompt pre-filled for the user to review and send, not to the backlog.
- asked: 2026-10-16

### R-sessions-052 · requested
Each session appears once in the session list.
- asked: 2026-10-19

### R-sessions-053 · requested
Long sessions auto-compact at the configured 400k context, and the phone offers intervention buttons when a session nears its context limit.
- asked: 2026-10-20

