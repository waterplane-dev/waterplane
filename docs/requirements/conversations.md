# conversations

### R-conversations-001 · shipped
Conversations archive instead of delete; archiving happens immediately, closes the session's CLI connection, and archived sessions are easily found in the archive view. A bulk 'archive all done' button is also available.
- asked: 2026-09-18
- shipped: 664187d, 3702412

### R-conversations-002 · shipped
Conversations can be filtered by started/not-started status.
- asked: 2026-09-20
- shipped: d9138e5

### R-conversations-003 · shipped
Conversations can be filtered by starred status, and bulk-close can choose to keep or close starred conversations.
- asked: 2026-09-21
- shipped: e99b908

### R-conversations-004 · shipped
Bulk-close combines multiple cuts at once instead of one at a time (state, idle time, open time, what is still
running underneath, an unsent draft or a queued prompt, whether the conversation ever started, and repo), shows the
exact rows it is about to close with a per-row "keep" toggle before it sends anything, and says how many background
shells the close will stop — closing a session always stops its background shells, fully, with no "leave running"
option or per-shell keep.
- asked: 2026-09-28
- shipped: this change (`core/launcher/CloseSheet.tsx` + `closeModel.ts`)

### R-conversations-005 · requested
Compacting a conversation keeps the text the user had entered before the compact.
- asked: 2026-10-06

### R-conversations-006 · requested
The dialogue remembers what the user said last time and offers a reset button that clears that memory.
- asked: 2026-10-15


### R-conversations-007 · shipped
A conversation can be bookmarked (live or from the archive) with an optional one-line note; the archive filters to a repo's bookmarks, shows each conversation's tab name beside its first prompt, and opens a bookmarked conversation read-only without starting the CLI.
- asked: 2026-10-21
- shipped: host + shared 5eac5bbc (`bookmarks.ts`, `archive.ts`, `routes/apirepofiles.ts`, shared `bookmark.ts`); phone UI in the commit after it (`ArchiveSheet.tsx` Bookmarks filter + per-row bookmark/note/read, `ArchiveReader.tsx` over `TranscriptView`'s `source` seam, the session menu's `bookmark` line `core/sessions/bookmark.tsx`, the mark on Recently closed rows)

### R-conversations-008 · shipped
The archive lists a non-claude backend's conversations (when that backend's facts include `conversations`), resumes one under that backend and deletes one after a confirm; reading/forking/bookmarks stay claude's until a backend provides them.
- asked: 2026-10-22 (backend contract v2 follow-up, workflow backend-v2-followups, package b-archive-non-claude)
- shipped: this change (`ArchiveSheet.tsx` backend switch over `GET/DELETE /api/conversations`, `features/tools/logic.ts` `archiveBackends` + `liveConversationIds` matching `backendSessionId`, `webapi/webapiTree.ts` `conversations`/`conversationsDelete`)
