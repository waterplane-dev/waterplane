---
name: web-files
description: waterplane phone client — bytes between phone and desktop (packages/web/src): pull.ts (code in pull/), download.ts + DownloadButton.tsx, installPolicy.ts + AppsSheet.tsx (the APK that installs itself), shellLink.ts, the annotator (annNote.ts, annClip.ts, annMove.ts; code in annotator/), pasteImages.ts, Gallery.tsx, FilesSheet.tsx, FileReview.tsx, StorageSheet.tsx, SweepSheet.tsx, idb.ts/offlineCache.ts, persist.ts. Load BEFORE touching a download or pull, an annotated or pasted image, the APK self-install and background link, the gallery and viewer, remarks on a text file, what the phone stores, the offline caches, or the outbox/inbox sweep.
---

# waterplane web — files between phone and desktop

Everything that moves or stores bytes on this side: downloads and pulls, the APK that installs itself, marked images, the gallery, the file browser, the offline caches and the sweep. Router: `web`. Reasoning: [web.md](../../../docs/notes/web.md).

- `persist.ts` — `navigator.storage.persist()` at boot: IndexedDB is best-effort and the browser may
  drop queued uploads, partial downloads and the screenlog unasked.
- `annNote.ts` + the **highlighter** (`ImageAnnotator`'s `marker`) + `annClip.ts` + `annMove.ts` + `annKnobs.ts` —
  **what a marked image SAYS.** Code: `annotator/` (`useAnnotator.ts`, `annPointer`/`annEdit`/`annDraw`/`annOcr`);
  Marks are NUMBERED from ONE list in the words and in the pixels (`visibleMarks` feeds both
  `markNote` and the canvas badges), exact twins collapse, a colour is said only when it
  distinguishes, typed and read-back words are never clipped. `withUploadSize` appends the grid the
  agent ACTUALLY receives, and only where that is a fact; `collagePanelNote` says what a combined
  image IS. The highlighter swipes translucent ink (multiplied, so the words stay readable) and the
  band is READ on the host (`api.readText` → `POST /api/host/readtext`) from the CLEAN image. **The read is shown
  and editable before anything is sent**; it degrades to a sentence, never to a guess. The note is a
  PROMISE as readily as a string, settled in `queueUpload` after the bytes are parked.
  **A mark may be STARTED OFF THE PICTURE** — the gesture is the WRAPPER's, not the canvas's.
  What overhangs is CUT on release (`annClip.ts`, node-tested), never sent: a BOX is clipped (its
  visible part cannot change — only the cut edge gains a stroke), a SEGMENT is clipped along its own
  line so an arrow keeps its DIRECTION, an ELLIPSE is dropped-or-kept but never reshaped, and a LABEL is MOVED, never
  dropped — it is the last copy of typed words. `clampToImage` clamps BOTH edges. **Moving or reshaping
  an already-placed mark is `annMove.ts`** (pure, node-tested): a SMALL mark's own end dots are
  hidden, so any direct drag on it means MOVE; RESIZE is a
  three-chip row (`whole · A · B`) consulted only by a RELATIVE drag — the finger lands anywhere and
  the mark follows by the delta, never a floating handle to aim instead. A move clips on release
  through the SAME `annClip.ts` rules a fresh draw does, and one leaving nothing on the picture is
  REFUSED, never a silent delete. **Knob mode (`annKnobs.ts`, pure, node-tested) is the OPT-IN
  alternative** (`knobs` in the move row, `waterplane.annKnobs`, synced): move · size · turn knobs on
  strings — every mark turns but the highlight band, and an arrow/line wears a knob per END instead
  of size + turn. Relative drag stays the default.
- `collage.ts` + `CollageSheet.tsx` — more than one image picked: one picture, or several? Declining
  is one tap. Combining produces ONE picked file, so everything downstream is the single-image path.
  **Falling back is REPORTED, never silent.**
- `installLog.ts` + the Apps sheet's `installed` pane (started by `startInstallLog` at boot, not by an App branch) —
  **which version of what is on which phone.** One host, MANY clients: the install happens on a phone with the app closed, so the log lives on the desktop (`host/installlog.ts`). **The report is a RE-STATEMENT** — the whole history on every `welcome`, merged on a reproducible key, never queued and no ackId. **The phone's own clock or nothing** (`installedAt` off the shell; absent ⇒ the row says *reported*); merge rules are `shared`'s `installlog.ts`. **The device NAME must never sync** — its job is to differ per phone.
- `pull.ts` / `PullSheet.tsx` —
  download queue with three engines (code: `pull/` — `pullManager`/`pullQueue`/`pullRange`/`pullBgFetch`/`pullNative`/`pullSave`; `pull.ts` is a facade, `dropOne` is bound in `pullManager.ts:99` to `pullDropOne` (body in `pull/pullRange.ts:176`); architecture [pulllink-architecture.md](../../../docs/notes/pulllink-architecture.md)): Background Fetch, the **native
  engine** (APK), and the chunked Range loop. Saving out is `nativeSave.ts`.
  **The auto-download switch is per WebView** (`pull.auto`, never synced). A browser cannot see the APK, so it
  ASKS once (`browserPullAsk` → `PullBrowserAsk` under the strip; Android, not the shell, auto on, an
  automatic row on its way). With the switch off, the strip and the menu chip count only what moves
  or was tapped (`stripRows`) — a file waiting for a tap is the sheet's, not a standing bar.
- `installPolicy.ts` + `nativeInstall.ts` + `AppsSheet.tsx` — **the APK that installs itself.** **One dialog per
  app, EVER**: the FIRST install of any package always shows the system installer (no flag removes
  it, and the row SAYS so in advance rather than promising silence), and every later build is quiet. **A refused silence is not a
  failure** — the row reads *waiting for you to confirm*, never *failed*. **The list is
  PACKAGES, never file names** (`Installs.read` reads the
  archive, and unreadable is EMPTY never guessed — such a row still offers the tap and promises
  nothing). Synced (`waterplane.installAllow`, `repoColors`' argument) and MIRRORED into the shell, because
  the install runs where the document is frozen. **The automatic path is narrower than a tap**:
  access granted, package on the list, AND already installed — an unattended first install is only a
  notification asking for a tap nobody asked for. A browser is told NOTHING; every platform refusal is a SENTENCE with the Settings button beside it, never a dimmed
  control. Pure half node-tested (`installPolicy.test.mjs`). **`AppsSheet.tsx` is the LIST and its
  own screen** — a switch reachable only from the download that brought the file cannot be SURVEYED (**a count on a control is a
  filter**). `appRows` is the UNION of the list and the builds still here: an allowed package with
  nothing downloaded is a row (that is the app you want to switch OFF), several builds of one package
  are ONE row and it is the NEWEST, and a row that cannot be acted on is not a row. **No state of its
  own** (synced key + `pull.ts`'s records ⇒ paints offline, hence `PERSISTED_OVERLAYS`); the Downloads
  row toggle STAYS — deciding in the moment is not surveying — and `appStateText`/`installStatusText`
  are ONE implementation or the two screens word *waiting to confirm* and *failed* apart.
  **Who OWNS an app's updates is read, not assumed** (`quietVerdict` over `ShellInstall.sources` →
  `Installs.source`): ownership is granted on a package's FIRST install only, so an app first installed
  by a file manager or Android Studio asks on EVERY update whatever waterplane requests — the row says so
  (`quietOwnerText`, with the uninstall-once remedy and its data cost). Unknown (old shell, not
  installed) is ABSENT, never "not ours". `QUIET_INSTALL_RULES` is the whole list, said once on the
  sheet; the repo half is the setup row `apk-install` (`host/apkcheck.ts`, advisory).
  **The `setup` pane (`AppsSetupPane.tsx` over `appReady.ts`, pure, node-tested) is the whole chain per
  app**: the desktop's facts (`GET /api/apps/readiness`, `host/appready.ts` → `apkRepoFacts`) joined
  on the package — a flavor's `applicationIdSuffix` included — with this phone's half; the first `no`
  is the BLOCKER, `unknown` blocks nothing, the last attempt is THIS phone's (another's success says
  nothing about this one). Its two chips are one `readinessCut`.
  **All of that is the `dev` flavor.** The `play` shell (Google Play) answers `distribution:"play"` +
  `self` in `ShellInstall.status()` (`shellDistribution`; ABSENT ⇒ inherit dev): it never installs
  itself (`isPlaySelf` ⇒ `PLAY_SELF_TEXT`, refused natively in `Installs.refusal` too), has no
  auto-install switch (`allowToggle` null, `playAutoText` says why), no quiet path. `packages/app/README.md`.
- `nativePull.ts` — the download that keeps going when you switch apps. Chromium freezes the document in the background, so the transfer moves to a `dataSync`
  foreground service that keeps its BACKOFF on disk. **The LIST is the truth and `pullChanged` is a
  courtesy**; **`nativeOwned` is what stops the pump re-handing a row over**, and a TAP may.
- `download.ts` + `downloadState.ts` + `DownloadButton.tsx` —
  **the ONE download button, app-wide.** A `local` record has three
  privileges, each earned by a failure: created with **no `pull.add`**, never withdrawn by `sync()`,
  and pumped **with the auto-download switch off**. **One tap, one file** (`autoSave`; `installDownloads()` is called
  from `main.tsx`). **The folder is ASKED, not remembered**; **`savedPresent`
  undefined is not `false`**. `downloadState.ts` is the pure half. One button: `local/no-anchor-download`.
- `storagePlan.ts` + `storageAudit.ts` + `StorageSheet.tsx` — **what this phone is HOLDING, and
  getting some of it back.** `SweepSheet` for the desktop's transport dirs; this is the same question
  about the device. **Two kinds, kept apart, and never one button**: a `cache` costs a re-fetch, a
  `keep` row (scrollback the TUI never put on the wire, recordings not yet read, photos from sends
  that DIED) is content — `groupUses` returns two groups and nothing returns their union. Every count
  carries its bytes; **null bytes is UNMEASURABLE, never `0 B`**, and it poisons the group total
  rather than being folded in as zero. **`unnamedBytes` degrades to absent** — `estimate()` is an
  approximation and can read BELOW what was measured, so "500 B of it is named below" about a
  reported 100 B is never printed. **It reaches into no store it does not own**: four have memory
  state as well as disk and a bare `idbClear` is a lie with a delay — hence
  `forgetThumbs` / `forgetScreenLogs` / `forgetDictations` / `forgetKept` / `forgetCacheStore` beside
  their own state. `uploads` is ONE store holding two things: a `keep:` orphan is droppable, a queued
  send's photo is **`cant`** and says so. Downloads are read off `pull.ts`' records, not the store (the native engine's bytes
  are a FILE, outside `estimate()` and said so), and dropping them is `pulls.dropBytes(ids)` —
  **ids, never a rule**, sharing `dropOne` with the seven-day eviction. `storagePlan.test.mjs`.
- `idb.ts` / `offlineCache.ts` — read-side caches (transcripts, tool details, gallery listings and
  documents, file-browser listings). `prefetchTranscript()` and the term feed's 5-min
  `sweepTranscripts()` (`core/term/useTermFeed.ts`, over `offlineCache.ts`) are
  what make the reader work offline for a session you have not opened yet.
- `shellLink.ts` — the background link, the half that isn't Java. `ShellLinkService` fixes backgrounding
  by EXISTING; everything the page tells it is a PARAMETER, because none of it is a fact about the APK.
  `shellNudge` is listened for BESIDE the four wake events, deliberately not through them.
  **`installShellBridge()` is called once in `main.tsx`, before React mounts** — a cold start from a
  notification beats any listener, so the id is PARKED. The whole native stack (service, plugin,
  worker, boot receiver) is **inert until `enableShellLink()` is called**, so the Settings toggle is
  the only thing that starts it. A refused notification permission is NOT a failure.
- `docKind.ts` — **the one extension table on this side**: what the viewer can PAINT
  (`viewerHandles`), and what it paints FORMATTED first with a toggle back to source (`isRich` =
  markdown + HTML). The rendered HTML
  branch frames the FILE not the truncated text, sits ahead of the text gates, and is
  `sandbox="allow-scripts"` with **no `allow-same-origin`** — the opaque origin makes its `Origin:
  null` one the host's guard refuses, so an artifact cannot call the API that wrote it. A notification about a file the app can render OPENS it (`openArtifact` →
  `galleryCtxForFile` → `Gallery`'s `openFile`, which renders from the alert's own payload with no
  listing), and the download becomes its own tap target beside it. Anything unpaintable stays the
  download it was. The host words the alert to match (`files.ts` `readsInline`) — widen the two lists together.
- `SweepSheet.tsx` — **clearing out `.claude/outbox` / `.claude/inbox`**, the
  bulk answer. **Nothing applies itself**: it
  plans, says so, and a person taps twice — no timer, and deliberately **no auto-clean switch**.
  **The chip IS the filter** (one `planSweep` feeds both) and
  **every count carries its bytes**.
  `sweepKeepText` says what STAYS (plan-is-the-contract: `shared`'s `sweep.ts`). Outbox and inbox are
  separate scopes with **no "both"** (one is re-derivable, one may be a photo's only copy). `now` is
  FROZEN per plan. `ConfirmButton`; an empty cut is a SENTENCE, not a dimmed
  button; after a run it RE-READS rather than editing rows out, and "already gone" is said apart from
  "could not be removed".
- `SweepSheet`'s second chip row (shared's families module) — **the cut that is not an age.** `keep the newest N of each` is `pruneVictims` with every row "produced" and nothing protected — the by-hand
  half of `artifacts.ts`' prune, and the THIRD reader of `familyKey`, deliberately the same function.
  **Outbox only**, **mutually exclusive with the age chips** (`pickAge`/`pickKeep` clear each
  other — two predicates feeding one number is two copies of the edge), ladder `[1,3,5]` and never a
  typed N, and **the family COUNT is said beside the file count**. `shared/test/sweepfamilies.test.mjs`.
- `Gallery.tsx` —
  code: `gallery/` (`useGalleryOpen.ts` has `directRef` and `showFile`; `GalleryViewer.tsx` holds the sandboxed HTML frame; `useGalleryPick`/`GalleryPickBar`). Four filters over an HTTP listing, cached per tab + coverage and re-filtered locally. **Thumbnail bytes are cached by the PAGE** (`thumbCache.ts`), cache-first, because the service
  worker is never registered in the APK. In the worker `v` decides HOW, not WHETHER: versioned ⇒
  cache-first, un-versioned ⇒ network-first. **An UN-VERSIONED document is cacheable by nobody**
  (`fileMtime.ts`'s rule): read AND write are skipped, fresh
  bytes or nothing. **A viewer opened straight at a file closes the GALLERY** (`directRef`,
  `showFile` the one writer of `open`), honouring `returnTo` — × on a browse-then-open still means
  back to the grid. **Combine** is a pick MODE with its own bar (`useGalleryPick`, `GalleryPickBar`),
  never a hidden long-press: pictures in TAP order (the panel numbers), one repo only, then the same
  collage sheet every multi-image pick gets and the annotator (`GalleryEntry.tsx` fetches the bytes
  through `api.fileBlob`; a failed fetch is said, nothing half-combined goes on).
- `FileReview.tsx` + `fileRemarks.ts` — **remarks on a text file**, the annotator's round trip for a
  file being READ: mark lines (source) or blocks (rendered markdown, via `Markdown`'s opt-in
  `lineTag`, which names SOURCE lines), say what should change, send every remark as ONE message
  (`remarksToChat` — seeded into the repo's session draft, appended, never submitted). One ordering
  numbers the badges and the message. Remarks and the comment being written are typed words:
  persisted per repo+path (`LS.fileRemarks`, kept by the hard reset), cancel/delete ask once. A
  remark FOLLOWS its quoted lines after the file changed (`relocate`) and says so when they are
  gone — never re-pointed at whatever sits on its old numbers. Pure half `fileRemarks.test.mjs`.
- `pasteImages.ts` —
  **TEXT WINS** (with `desktopShot.ts` and `artifactMarks.ts`): a paste with non-blank `text/plain` never opens the annotator; a pasted picture takes the picker's route (`routeFiles`). `desktopShot.ts` is the one screenshot path (`POST /api/host/screenshot`) — never a second capture route. `artifactMarks.ts` new/opened/downloaded marks are kept on this phone (storage class `host`), never synced, validated against mtime.
- `FilesSheet.tsx` — the repo browser and the rare edit. **Saving is never queued** — a write composed
  now and replayed in an hour carries a base the file left behind. A `stale` refusal keeps the typed
  text and **never re-sends with a fresh base**.
