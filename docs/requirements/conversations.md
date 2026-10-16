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

