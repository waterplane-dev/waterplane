# share

"Share → waterplane" from any other app on an Android phone (the system share sheet), in the APK.
The shell (`ShellShare.java`) copies what was shared into the app's cache and hands the page
`{ files: [{ url, name, type, size }], text }` through `window.shellShare` (`shellShare.ts`, which
checks every URL is this page's origin under `/_capacitor_file_/`). This feature asks WHERE it goes
and then hands off; it attaches nothing of its own.

**Owns**

- `store.ts` — `shared`, the share being decided. In memory only: a reload is "not now".
- Sheet `share` (`ShareInSheet`): the share's contents, then four answers — **this session** (the
  one on screen, when there is one), **another open session**, **a new session in…** or **inbox
  only** (`RepoPicker`, the on-screen session's repo first and labelled; a toggle picks which).
  Inbox only opens no session: the files are parked in the queue under lane `inbox:<worktree>` for
  `.claude/inbox/`, and any text goes to the clipboard. `drop it` closes without sending. While the
  socket is not open the sheet says sessions are still coming — a cold start from the share sheet
  draws before the session list arrives.
- `boot`: `onShellShare` → open the sheet. A second share while one waits replaces it, and says so.

**Rules**

- **Any app can share to this one** — nothing lands anywhere until a person picks a target, and
  even then nothing is SENT: text is appended to the box, files are attached, the person sends.
- **Routed exactly as the compose bar's paperclip** (`core().files.attachFiles` → images'
  `routeFiles`), never a second upload path. Pictures go through the annotator only when *mark
  them up first* is on — the default for ONE picture; several default to straight up, because a
  25-photo share through the combine question and 25 annotator screens is where a person got lost
  and nothing uploaded. Everything else is parked and uploaded with its path in the box.
- Files are routed only once the target IS the session on screen — the upload lane and the box are
  the active session's. A new session behind a launch question waits up to 10 minutes; past that the
  share comes BACK to this sheet, never dropped.

**Reads from core**: `world` (active, sessions, repos), `nav` (`attach`, open/close),
`launch.openCwd`, `compose.seedDraft`/`insert`, `files.attachFiles`, `say`.
