# history — what was sent into a session

The `history` sheet: every prompt, slash command and filed backlog item sent into the session on
screen, newest last, with *resend* (drops it back into the composer) and *pin* (makes an entry the
session's overview label). The sheet is the flat `HistorySheet.tsx`, wrapped by
`PromptHistorySheet.tsx`.

**Owns** (`store.ts`, one writer — `noteHistory` in `actions.ts`): `history`, a map of session id →
entries, **seeded from the offline history cache** (`loadHistorySnap`, output stripped — see
`offlineCache.ts`), so the sheet has something to show before a reply lands and with no link.
`noteHistory` also writes the cache (`saveHistoryEntries`). `logic.ts`: the pin receipt.

**Sheet**: `history` (not persisted; `null` with no session on screen). **Messages**: none of its
own — `session.history` stays a `case` in App because the same frame is the terminal feed's proof
that the host answered an attach (`hostAnsweredFor`); App's case calls `noteHistory(id, entries)`.

**Reads from core**: `world.active`, `conn.status/send`, `compose.insert` (appends, never overwrites
the draft — `local/no-draft-clobber`), `nav.close`, `say.toast/track` (`action:session.pin`).

**Exports for App**: `noteHistory(sessionId, entries)`.

**Tests**: `logic.test.mjs`. e2e: `scripts/e2e-pin.mjs` (the pin).
