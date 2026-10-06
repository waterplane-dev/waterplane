# pad

The pad as a sheet: target-less notes that can be a chain and carry files. The editor, the
per-note merge, the tombstones and the refusal rules are `PadSheet.tsx`'s and `outbox.ts`'s (skill
`web-send`); this feature wires them to the core and owns nothing else.

**Owns**

- `store.ts` — `padFocus`: which note to scroll to and flash on open (set by `openPadAt`, cleared
  on close). Not in the route on purpose.
- Sheet: `pad` (`persisted: false`).
- `actions.ts` — `openPadAt`, `closePad`, `dispatchNote` (into the one Send surface; the seed's
  `padId` retires the note only when the send is POSTED) and `fileNote` (*file it*: the existing
  `queueBacklog` `mode: "backlog"` row, no label, the note removed only once the row is queued; a
  refusal leaves the words on the pad).

**Reads from core**: `world.visibleRepos`/`repos`, `useQueueEntries()`, `conn.status`,
`files.attachForInbox`, `files.annotate(…, "pad")` (the annotator's pad round trip lives in the
images feature), `nav.openSend`, `send.targetFor`, `queue.queueBacklog`, `compose.removePadNotes`
(the ONE pad delete), `say`.

**Exports**: `openPadAt(noteId)` — App binds it as `nav.openPadAt` (the assessment's "your words are
on the pad" row).
