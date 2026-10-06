# context

The context window as a SHAPE, for one session: the `context` sheet. `ContextSheet.tsx` (and
`ContextGraph.tsx`/`contextPlot.ts`) is the screen itself and is unchanged — its rules (one y
axis, a total never without its split, two doors on the cost panel with `/compact` leading) are in
the `web-numbers` skill. This folder is WHICH session it is about and its two doors.

**Owns**

- `store.ts` — `ctxSid`: whose sheet is open when it is NOT the attached session's. Null means the
  attached one. Written only by `actions.ts`: `openContextFor(s)` (a launcher row's cost tile —
  deliberately no `attach`, the series is read by id over HTTP), `openContext()` (the header chip)
  and `closeContext()`, and cleared by the sheet's fresh-session door (`freshFromContext(repo)`,
  which is `closeContext()` then `nav.openRepo`).
- `logic.ts` — `contextSubject` (the row's session, else the attached one, else null so the sheet
  falls through to the screen underneath) and `compactToast`.
- `ContextEntrySheet.tsx` — the wiring. Sheet: `context`, persisted.
- Track ids: `action:session.context`, `action:ctx.compact` (unchanged).

**Reads from core**: `world.sessions/active/backends/sessionRepo/sessionRowTitle/sessionCan/
sessionCant` (the `/compact` door is drawn only where the backend takes slash commands, and its
absence is a sentence), `queue.submitInput` (the `/compact` goes through the send queue with an
ackId, aimed at the SUBJECT, never the attached session), `compose.pushHistory`, `nav.open/close/
openRepo`, `conn.status`, `say.toast/track`.

**Exports for App**: `openContextFor(s)` (launcher row cost tile), `openContext()` (header chip).

**Tests**: `logic.test.mjs`.
