# share

"Share → waterplane" from any other app on an Android phone (the system share sheet), in the APK.
The shell (`ShellShare.java`) copies what was shared into the app's cache and hands the page
`{ files: [{ url, name, type, size }], text }` through `window.shellShare` (`shellShare.ts`, which
checks every URL is this page's origin under `/_capacitor_file_/`). This feature asks WHERE it goes
and then hands off; it attaches nothing of its own.

**Owns**

- `store.ts` — `shared`, the share being decided. In memory only: a reload is "not now".
- Sheet `share` (`ShareInSheet`): the share's contents, then three answers — **this session** (the
  one on screen, when there is one), **another open session**, **a new session in…** (`RepoPicker`,
  the on-screen session's repo first and labelled). `drop it` closes without sending.
- `boot`: `onShellShare` → open the sheet. A second share while one waits replaces it, and says so.

**Rules**

- **Any app can share to this one** — nothing lands anywhere until a person picks a target, and
  even then nothing is SENT: text is appended to the box, files are attached, the person sends.
- **Routed exactly as the compose bar's paperclip** (`core().files.attachFiles` → images'
  `routeFiles`): pictures through the annotator (several → the combine question), everything else
  parked and uploaded with its path in the box. Never a second upload path.
- Files are routed only once the target IS the session on screen — the upload lane and the box are
  the active session's. A new session behind a launch question waits up to 10 minutes; past that the
  share comes BACK to this sheet, never dropped.

**Reads from core**: `world` (active, sessions, repos), `nav` (`attach`, open/close),
`launch.openCwd`, `compose.seedDraft`/`insert`, `files.attachFiles`, `say`.
