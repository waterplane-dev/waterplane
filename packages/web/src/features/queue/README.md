# queue

The queue sheet: the phone's send queue row by row (queued, in flight, failed), grouped by lane,
plus the launches the desktop is holding until their files land. The sheet is the flat
`QueueSheet.tsx`; the rules are the `web-send` skill's (`outbox.ts`, `sendConfirm.ts`): the
queue is the ONE send path, **ref-authoritative** in the core, retried only with the same ackId, a
`failed` row kept in full for ever, an `unconfirmed` verdict the desktop's QUESTION and never a
failure.

**Owns** nothing. The send queue is the core's (`core/queue`); this folder is its sheet.

**Sheet**: `queue` (not persisted).

**Reads from core**: `useQueueEntries()`, `queue.laneLabel/goneLanes`, every `queue.verbs.*`
(edit, remove, move, re-aim, hold, serial, send now, retry failed, restore, add a prompt to a
queued open — each IS App's function of that name), `world.sessions/visibleRepos/launches`,
`conn.liveSend` (`launch.cancel`/`launch.run` on a held launch: live-only, and the one tap that
sends `launch.run`, which `bulkverbs.test.mjs` pins), `nav.openSend/close`,
`queue.flush/idleReason/repoIdOf/serial` (the serialize switch writes through to the flusher's
ref), `send.targetFor`.

**Exports for App**: none — App opens it by id (`setOverlay("queue")`).
