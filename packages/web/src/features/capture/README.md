# capture

Verified capture from the phone: a repo's screenshot targets (`.waterplane/capture.json` on the desktop),
the runs that take them — a one-shot or a `watch` that keeps a frame each time the screen moves —
their verdicts and their streamed output. Reached from a repo row's `⋯ → capture`; the sheet itself
is the flat `CaptureSheet.tsx`. The host side and the reasoning are `docs/notes/capture.md` and the
`host-machine` skill (`capture.ts`).

**Owns** (`store.ts`, one writer each — `actions.ts`, called by the handlers in `index.ts` and the
sheet `VerifiedCaptureSheet.tsx`; the words and the name lookup are `logic.ts`):

- `captures` — `sdk/repoRun.ts`'s `repoRunStore`, the same one `build` uses: targets per repo
  **seeded from the device cache** (`loadCaptureSnap`/`saveCaptureSnap`; an empty list is a CLAIM,
  and this sheet is opened away from the desk) with their age, runs upserted by id and capped at 60,
  and each run's output (300 kB tail, pruned with its run).
- `captureRepo` — the repo the sheet is open on, which a reconnect re-asks `capture.list` for.
- `captureBackends` — what this DESKTOP can drive right now. **Never cached, never defaulted**: an
  empty entry is "nobody has said", worded apart from "said no".

**Sheet**: `capture` (not persisted). **Messages**: `welcome` (re-sync, which is also the only
refresh of the backends), `capture.list`, `capture.run` (toast carrying the host's verdict
verbatim), `capture.output`.

**Reads from core**: `conn.send`/`conn.liveSend`, `queue.queueOp` (`capture.run` is DURABLE — a
replay would be a second browser fighting the first over one screen; `watch` is the same op with
one flag, never a second send path), `nav.overlay/open/close`, `files.downloadArtifact`,
`say.toast`.

**Rules that apply**: `capture.output` re-renders only while `core().nav.overlay === "capture"`.
`capture.cancel` is live-only and never queued — a cancel delivered an hour late calls off a run
that finished long ago. A backend that cannot run says why in a sentence (`Unavailable.tsx`),
never as a greyed control.

**Exports for App**: `openCaptureFor(repo)`.
