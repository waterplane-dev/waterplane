# images

Pictures and repo files on the phone: the two hidden pickers, the annotator and every round trip
through it (the session's compose box, the Send sheet's draft, the pad's editor, a backlog item
being re-marked), the combine-or-not question, the full-screen viewer, the "new N" strip a turn
leaves, the gallery, the file tree and the transport-directory sweep. Rules for the components it
wraps (`ImageAnnotator`, `annNote`/`annClip`/`annKnobs`, `CollageSheet`, `Gallery`, `FilesSheet`,
`SweepSheet`, `ImageSwiper`): skill `web-files`. Those files are imported, never moved here.

**Owns**

- `store.ts` — `ann` (the picture on the annotator + its batch), `collage`, `swipe` (the viewer's
  place; a session strip is read live), `galleryCtx`, `sweepFor`, `browseRepoId` + `browseAim`,
  `newImages` (per session, persisted under `LS.newImages`, written through in `boot`) and
  `minimizedNewImg`; plus `flow`, the annotator's routing refs (where its result goes, which repo
  the sheet that opened it attached into, which backlog item is being re-marked).
- Sheets: `collage`, `image`, `swipe`, `sweep` (guarded — a restored route with nothing behind it
  falls through), `gallery` and `browse` (`persisted: true`).
- Wire frame in: `session.images` (the strip). Out: `backlog.update` after a re-mark, through
  `conn.liveSend` — it is not a durable op, so offline the row is left as it was and the toast
  says so (the marked picture is parked and still uploads); only an open socket says *updated*.
- Commands `image`, `file`, `files`, `browse`; toolbar item `inbox` (the outbox count, a filter).
- `boot`: the two hidden `<input type=file>`s on `document.body` (so no screen renders them), the
  `ATTACH_OPEN_EVENT` listener, the strip's write-through.

**The upload buffer is not here.** The bytes ride the send queue, so the buffer is the queue
core's (`core().queue.uploads`) and every park goes through `queueImageUpload`.

**Reads from core**: `world` (repos, sessions, the active session and repo, `refreshRepos`),
`nav` (incl. `sendSeeded` — whether closing the annotator goes back to the Send sheet),
`conn.liveSend` (the re-mark's `backlog.update`), `compose.insert` (appends only) and `compose.seedDraft` (`continueImageInSession` seeds the
screen it opens — the attached session, or the pending one `launch.openCwd` returns — never the box
being left) and the
sheet-draft trio (`loadSheetDraft`/`seedSheetDraft`/`appendSheetDraft`, keyed by `SEND_DRAFT` from
`sendIntent.ts` and `pad.editor`), `queue.uploads` and `queue.queueImageUpload`, `launch.openCwd`,
`say`.

**Exports for App and core screens**: App binds `files.*` to `viewImage`, `openArtifact` (a named
`returnTo` is `files.openFileFrom`, and counts no notification tap), `downloadArtifact`,
`pickImageFor`, `pickFileFor`, `attachForInbox`, `annotate`, `annotateUrl`, `openSweep`,
`backlogEditImage` (`editBacklogImage`) and `openBrowseAt` (`browseTo`). Also `openFileRef`,
`openGalleryFor`, `openOutboxFor`, `openGalleryForSend`, `openBrowseFor`, `openNewImages`,
`seedFromRoute` (App calls it in render with its first `parseHash()` — on every render, and a
module flag makes every call after the first a no-op), `annotatorBusy` (App's reload guard ORs it
with the upload buffer's), `NewImagesStrip`, `NewImagesTag`, `galleryCtxForFile`.
