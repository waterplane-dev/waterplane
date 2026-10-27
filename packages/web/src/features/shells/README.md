# shells — what a background shell under a session is doing

The `shells` sheet: one row per background shell (a `run_in_background` Bash call, a Monitor) running
under a session's CLI, what it is doing in plain words (`shellWords`, shared/shells.ts), and stop —
via a two-tap `ConfirmButton`, never a grey button and never `window.confirm`. The foot line says
what CLAUDE.md decided: closing the session stops every one of these too, fully, with no "leave
running" option.

**Owns** (`store.ts`, one value, written only by `actions.ts`): `shellsSid` — whose sheet is open,
when it is not the attached session's (a row's own chip, or the launcher's "shells" filter). `null`
means "the attached one", `context`'s `ctxSid` exactly. No store for the shells themselves:
`SessionShell[]` already rides every `SessionInfo.shellList` over `session.list`/`session.updated`,
so the sheet reads it straight off the session it is handed rather than keeping a second copy.

`logic.ts` also holds `notePendingClose`/`takePendingClose` — a plain module `Set` of session ids
THIS phone has sent `session.remove` for, not a `createStore` (nothing renders off it). `session.closed`
is a BROADCAST, so without this every open phone would toast the SAME shells-stopped receipt for a
close only one of them asked for.

**Sheet**: `shells` (not persisted — the data is live-only, with no offline cache the way `context`'s
series has; a restored route falls back to the attached session or, with none, paints nothing).

**Opening a row** reads `GET /api/shell?id=&pid=` (host `readShellDetail`): the whole command — the
`SessionInfo` copy is capped at 240 chars — and the last 64 KB of the CLI's own
`tasks/<taskId>.output`, ANSI stripped, re-read every 3 s while the row stays open and the page is
visible. The pid only selects among that session's own wrapper shells; the file path comes from the
transcript join, never the request. No join ⇒ no output, and the row says why.

**Sends**: `shell.kill` (`killShell`, live-only, no ackId, never queued offline — CLAUDE.md: a kill
delivered an hour late hits whatever now holds that pid). `liveSend`'s own toast ("stopping…") is the
tap's receipt; the actual outcome is a SECOND toast off the `shell.killed` reply, because only that
message knows whether the group actually died (`onShellKilled`).

**Messages**: `shell.killed` (the definitive stop/refuse toast), `session.closed` (a follow-up toast
naming how many shells stopped WITH the session, and any that did not — CLAUDE.md's decision said out
loud; nothing is said when both `shellsStopped` and `shellsLeft` are 0, since the close verb's own
"archived …" toast already covers that case — and nothing is said at ALL unless `takePendingClose`
proves THIS phone was the one that sent the `session.remove`, since the message is a broadcast).

**Reads from core**: `world.sessions`/`world.active` (`shellsSubject`, the sheet's session), `nav.open`
/`nav.close`, `say.toast`/`say.track` (`action:session.shells`, `action:shell.kill`).

**Capability by presence**: a row is only ever offered a stop button once `shellList` has actually
arrived (an old host, or `WATERPLANE_SHELLS=0`, means the sheet says so in words rather than pretending
there is nothing to stop).

**Exports for App/other core screens**: `openShells()` (the attached session), `openShellsFor(s)` (any
session — the row chip's door, `core/sessions/tags.tsx`'s `shellsTag`).

**Tests**: `logic.test.mjs` (`shellsSubject`, `shellKilledToast`, `sessionClosedShellsToast`,
`notePendingClose`/`takePendingClose`).

**A command into the shell** (`lineToShell`): the reader draws a "shell" button after a `! cmd` code
span and on a shell fence (`bangLine.ts`, via `FileRefCtx.toShell`). A tap goes to the session's
companion shell — the live one, else a new one — and SEEDS the command (bang dropped) into its box
on its own line. It never runs it; no shell on the desktop ⇒ copied instead.

