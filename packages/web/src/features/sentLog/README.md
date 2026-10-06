# sentLog — the sent-command audit log

Everything this app typed into a session, including what it decided by itself (a plugin's
auto-answers, the usage-limit auto-continue, backlog and fan-out sends), with each delivery's
verdict. The sheet itself is `SentLogSheet.tsx` at the top level; this folder owns its state and
wiring.

**Owns**
- stores (`store.ts`): `entries` — the log, newest first, capped at 300 on the phone; `scope` —
  the session the sheet is filtered to (null = all).
- overlay `sentlog` (not persisted — a reload does not land back on it).
- toolbar command `sent` (this session's log; `toolbar.ts` still declares the item).
- wire frames in: `sent.log` (the whole list), `sent.new` (one row appended live — or a
  CORRECTION of an ambiguous row by id, re-sorted by time; `logic.ts`). Frames out: `sent.get`,
  `sent.clear`.
- `actions.ts`: `openSentLog`, `openSentForActive` (the command), `onSentNew`.
  `SentCommandsSheet.tsx`: `SentLogSheet.tsx` wired to the stores.
- `openSentLog(sessionId | null)` — the burger menu's entry point (`liveAsk`, so a tap with the
  link down says so).

**Reads from `core()`**: `conn` (send/liveAsk), `nav` (open/close/attach), `world.sessions`,
`say.toast`. No storage keys.

**Tests**: `logic.test.mjs` (replace-by-id, newest-first, cap). e2e: `scripts/e2e-sent.mjs`.
