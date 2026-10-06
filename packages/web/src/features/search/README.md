# search — host-side session search

The `search` sheet: one session's (or every session's) prompts, current screen or saved history,
searched ON THE DESKTOP (`sessionSearch.ts` on the host) and answered as `session.searchResults`. The
sheet itself is the flat `SearchSheet.tsx`, wrapped by `SessionSearchSheet.tsx`. The reader's
in-page find is a different thing and stays the reader's (`fireReader("find")`): in the reader the
document is on the phone; from the terminal there is none, so `find` comes here.

**Owns** (`store.ts`, one writer — `actions.ts`): `search` = `{ scope, results, loading }` — the
session the sheet is scoped to (null = all), the last answer (null until one lands, cleared on
open) and whether a request is in flight. `logic.ts`: `acceptsResults`, the scope match.

**Sheet**: `search` (not persisted). **Messages**: `session.searchResults` — kept only when it
answers the scope on screen, so a stale reply from a just-closed scope cannot clobber the new one.
Out: `session.search`, a plain send because the sheet is the receipt (it shows loading and states
offline itself) and a search replayed on reconnect answers a sheet that has moved on.

**Reads from core**: `world.sessions`, `conn.status/send`, `nav.open/attach/close`.

**Exports for App**: `openSearch(sessionId | null)` — the toolbar's `find` in the terminal view and
the launcher menu's search.

**Tests**: `logic.test.mjs`. e2e: `scripts/e2e-search.mjs`.
