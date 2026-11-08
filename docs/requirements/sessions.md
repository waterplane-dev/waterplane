# sessions

### R-sessions-001 · requested
The close-sessions dialog lets the person type their own idle time for closing inactive sessions, with 24 hours as the default.

### R-sessions-002 · shipped
The gallery's outbox view defaults to files from the last 4 hours.
- shipped: 664187d4

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
After asking for a fix from the repo readings sheet, the new session appears in the main view so the person can check the agent's answers.
- asked: 2026-09-21

### R-sessions-016 · shipped
Sending a prompt offers a choice of target: same session, a new session, or another open session, defaulting to the last choice used.
- asked: 2026-09-24, 2026-09-24
- shipped: cb34e8e

### R-sessions-017 · shipped
Every place that lets the person pick another session as a target shows the short name the desktop gave that session, beside its title.
- asked: 2026-09-24
- shipped: cb34e8e7

### R-sessions-018 · shipped
A button in the session cost view opens a new session that analyzes the cost drivers and suggests improvements without implementing them.
- asked: 2026-09-26
- shipped: 3c4f0a2

### R-sessions-019 · shipped
A prompt timed shortly before the weekly reset is let past the 5-hour session ceiling as well as the weekly ceiling, until that reset.
- asked: 2026-09-30
- shipped: 01cfc6f0

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
### R-sessions-030 · shipped
A background model call the desktop makes on its own is refused in a folder the claude CLI does not trust, so that folder's hooks never run from it; the refusal is said once.
- asked: 2026-10-04
- shipped: 4698c58a

### R-sessions-031 · shipped
Tapping a repo's worktree chip filters the list to that repo's worktree rows, like the other header chips.
- asked: 2026-10-05
- shipped: 2f56055d

### R-sessions-032 · shipped
In Downloads, the newest finished download is at the top of the On this phone list.
- asked: 2026-10-06
- shipped: eeb82bfb

### R-sessions-033 · shipped
A shared item can go to the currently open session, a new session, or an existing session the user selects.
- asked: 2026-10-06
- shipped: c1d7d699

### R-sessions-034 · shipped
A /fork typed on the phone opens a normal tab in the app and switches to it. Backlog rows in one repo wait only on queued or automatic sessions, say when they wait for an answer with a button to open that session, and Fire starts a row on one tap.
- asked: 2026-10-06
- shipped: b93af861, 5ed143c9

### R-sessions-035 · superseded
A worktree is shown next to the session it belongs to, not visually closer to the session below it.
- asked: 2026-10-06
- shipped: dc5373ce
- superseded-by: R-git-014

### R-sessions-036 · shipped
When a fan-out is run over several repos, a strip above Run shows its kick-off progress (sent, then how many of the repos have started) with a link to the run's list.
- asked: 2026-10-08
- shipped: 4b31cb7f

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

### R-sessions-050 · shipped
A prompt sent into a session is detected as delivered without the user pressing the on-screen return key.
- asked: 2026-10-16
- shipped: 5eff24ea

### R-sessions-051 · superseded
Prompts from marked screenshots go to a new session with the prompt pre-filled for the user to review and send, not to the backlog.
- asked: 2026-10-16
- superseded-by: R-vault-021

### R-sessions-052 · shipped
Restarting a session, even with a second tap, gives one session in the list, not two copies of the same conversation.
- asked: 2026-10-19
- shipped: 8d69613a

### R-sessions-053 · shipped
When an agent inside a session grows past a window size the person chose, the phone alerts them, and the context sheet lists the most expensive agents with an interrupt-and-re-plan button.
- asked: 2026-10-20
- shipped: 4c6ff87f, f6cf4904
- note: Auto-compact at 400k was already set and works on the main conversation only; the ask was about subagents running away.

### R-sessions-054 · shipped
The vault's re-arm card starts each grant row with the project name, so which project it is reads first.
- asked: 2026-10-22
- shipped: 7c57d37a

### R-sessions-055 · shipped
Closed and archived sessions are listed in the same card style as open sessions.
- asked: 2026-10-22
- shipped: 1ab33702, a82b2f95

### R-sessions-056 · shipped
A session still on an older Claude binary than the installed one can be restarted once it is idle, and Send asks whether to restart onto the new binary first.
- asked: 2026-10-23, 2026-10-24
- shipped: ba813d9a, 158badcb

### R-sessions-057 · superseded
Sessions can be found again later, so a session with a pending next step can be located.
- asked: 2026-10-26
- superseded-by: R-sessions-041

### R-sessions-058 · shipped
A plugin-backend session that stops at a dated usage wall resumes at the reset time as Claude sessions do; a wall with no reset time schedules nothing.
- asked: 2026-10-28
- shipped: 20307bfd

### R-sessions-059 · shipped
Creating a session returns without running repository compliance inspection, so it is not blocked by git scans.
- asked: 2026-10-30
- shipped: c050de92

### R-sessions-060 · shipped
From the main view, one tap jumps straight to the session that is requesting approval.
- asked: 2026-10-30
- shipped: 4acf842d


### R-sessions-061 · shipped
After a sign-out, one sign-in on the desktop is enough: the phone then ASKS to continue the stopped sessions ("continue all N") and nothing is typed into any of them before that tap. The offer appears only after the desktop confirms the account is signed in again; when it cannot tell, it says so and leaves the decision to the person. The sessions then continue one at a time, the first alone, never all at once.
- asked: 2026-11-02 (owner), 2026-11-02
- shipped: 55b4feb9, 59fead43

### R-sessions-062 · shipped
No automatic recovery (usage-limit or spend-cap continue, network retry, sign-in continue) types over words a person has in the desktop composer: the continue waits, the session says so ("words in the composer at the desk"), and it is typed once the words are sent or cleared. A dim suggestion the composer proposes is not the person's words.
- asked: 2026-11-02 (owner)
- shipped: a16bedbf, 55b4feb9, b2981528
### R-sessions-063 · shipped
A session menu option copies the reference information for a coding session to the clipboard, optionally with the selected text.
- asked: 2026-11-01
- shipped: 505cf8ba

