# shell

All items: asked by the owner 2026-10-05 — "full control from my phone".
Design: `docs/notes/host.md` (`backends/shell.ts`) and SECURITY.md. Shipped, pending a check on a real phone.

### R-shell-001 · shipped
A repo can be opened as a plain login shell from its menu. It runs in the same terminal, tabs,
socket and launcher as a claude session, and it survives a host restart like one.
- asked: 2026-10-05
- shipped: 27eb8a26, ba52f59c

### R-shell-002 · shipped
A shell session shows none of the readouts that only make sense for claude (model, context gauge,
turn-finished ping, claude-only gaps). Its tab is named "shell · <repo>", never by a model, and one
quiet line says what it is.
- asked: 2026-10-05
- shipped: 27eb8a26, ba52f59c

### R-shell-003 · shipped
Words typed into a shell go through the same confirmed send path as a prompt to claude, and the
raw keys stay available. There is no second send path. No line runs before the confirmed Return:
several lines go in as one bracketed paste where the shell takes one (zsh, fish), and are refused
in words otherwise; a send while a program is in front of the shell (`vim`, `sleep`) is refused
naming it, unless that program is visibly asking for a code or a yes/no question (`[y/N]`) — then one line goes to it. A shell's commands are not kept as
prompt history.
- asked: 2026-10-05
- shipped: 27eb8a26

### R-shell-004 · shipped
A shell is never opened on a peer desktop and never by a job (refused where every session is
opened, `SessionManager.create`, unless a person tapped it). It sits behind the same device
boundary as a claude session; no extra gate and nothing wider. It does not inherit the daemon's
API keys.
- asked: 2026-10-05
- shipped: 27eb8a26

### R-shell-005 · shipped
An https link a program prints in a shell is tap-to-open on the phone. A one-time code printed
near the link gets a copy button, and while the CLI is visibly waiting for a code the phone can
paste it. A link to the desktop's own localhost says it cannot be opened from the phone. A link
read across several screen rows is published only when the program's own output holds it as one
string; an errno, an all-letter word or a time range is never a code; a link with userinfo
(`user@host`) is never published.
- asked: 2026-10-05
- shipped: 27eb8a26, 094f068a

### R-shell-006 · shipped
When a CLI in a shell session asks the desktop to open a browser, the page opens on the phone
instead. The shim posts to a loopback-only route that refuses proxied requests; unknown sessions
and non-http(s) URLs are ignored. A browser link expires after 10 minutes even on a quiet shell.
- asked: 2026-10-05
- shipped: 27eb8a26, 094f068a

### R-shell-007 · shipped
A logins sheet in a shell session inserts phone-finishable login commands (gcloud, gh, firebase,
codex, npm, tailscale) into the compose box, never sending them, and says which default flows
redirect to localhost and cannot finish from a phone.
- asked: 2026-10-05
- shipped: 094f068a

### R-shell-008 · superseded
A session and its companion shell are two tabs in the session header, `[Claude | Shell]`, the one on
screen lit, one tap to switch either way. With no companion yet, Shell opens one. The terminal's own
corner group carries no shell/CLI toggle any more (zoom, reader and full screen stay there).
- asked: 2026-10-07 (marked screenshot, `.claude/inbox/combined-2-screens-marked-muxpwpemf8d236.png`)
- shipped: b48a9c65
- superseded-by: R-shell-009

### R-shell-009 · shipped
A session and its companion shell are two tabs in the session header, `[Claude | Shell]`, the one on screen lit, one tap to switch either way. The tabs appear only once a companion shell exists (made from the burger menu's "companion shell"); a session without one shows no tabs. The terminal's own corner group carries no shell/CLI toggle (zoom, reader and full screen stay there).
- asked: 2026-10-07 (marked screenshot, `.claude/inbox/1000078229-marked-muyfrphn1803f5.png`), 2026-10-07
- shipped: f1d7de27, b48a9c65

### R-shell-010 · shipped
Shell and login actions are visible as buttons in the phone UI and easy to find.
- asked: 2026-10-05
- shipped: 97f4eb04, 094f068a

### R-shell-011 · shipped
Users can manually spawn a temporary companion shell for a coding session from a menu option; it is discarded automatically when that session is closed.
- asked: 2026-10-06
- shipped: d41dc74f

### R-shell-012 · shipped
Terminal capability replies never reach a pane as typed text.
- asked: 2026-10-09
- shipped: 59e1d6ad, 46317caa

### R-shell-013 · shipped
A prompt seeded into the compose box leaves CLI key mode so the prompt box is in sight, and the app says so.
- asked: 2026-10-11
- shipped: 0bc7ad40

### R-shell-014 · shipped
The first prompt into a new repo answers claude's workspace-trust box with Yes and does not end the session as exited.
- asked: 2026-10-11
- shipped: 25353b14


### R-shell-015 · shipped
A command the agent asks the person to run (`! cmd`, or a shell code block) carries a "shell" button in the reader that puts the command — without the `!` — into the session's companion shell's prompt box, opening that shell when there is none; it is never run without the person's Send.
- asked: 2026-10-27
- shipped: 0562059d
