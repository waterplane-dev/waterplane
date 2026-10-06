# shellLogins — the logins cheat sheet for shell sessions

The `logins` sheet: one row per CLI login that can be finished from a phone (gcloud, gh, firebase,
codex, npm, tailscale, docker), each with its command and a one-line note on what the flow does. A
tap ADDS the command to the compose box (`compose.insert`, appending) and closes the sheet; it is
never sent for the person. Rows whose plain command redirects to `localhost` on the desktop carry
a warning, and the one count on the sheet ("redirect to localhost · n") is a filter with an "n of N"
bar. The header says log in once, then move the token into a secret store — generic on purpose:
public code names no particular store.

**Owns**: `logic.ts` (`LOGIN_ROWS`, the wording, the one cut) and `actions.ts` (`openLogins`,
`insertLogin`). No store: the rows are constants.

**Reached from**: the toolbar key `logins` (`toolbar.ts`), drawn only for a shell session
(`isShellBackend`, in `core/session/ToolbarMenu.tsx`), and the "logins" button on the shell links
bar (`ShellLinksBar.tsx`) via `openLogins`. Sheet id `logins` (an `Overlay`, not persisted).

**Reads from core**: `compose.insert`, `nav.open`/`nav.close`, `say.toast`/`say.track`
(`action:logins.open`, `action:logins.insert`).

**Tests**: `logic.test.mjs`.
