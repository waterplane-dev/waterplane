---
name: web-files
description: waterplane phone client, bytes moving between phone and desktop (packages/web/src): pull.ts/PullSheet.tsx, nativePull.ts, download.ts/downloadState.ts/DownloadButton.tsx, installPolicy.ts/nativeInstall.ts/AppsSheet.tsx, installLog.ts, annNote.ts/annClip.ts/annMove.ts/annKnobs.ts and the highlighter, collage.ts, Gallery.tsx, FilesSheet.tsx, SweepSheet.tsx, docKind.ts, idb.ts/offlineCache.ts, persist.ts, shellLink.ts. Load BEFORE touching a download or a pull, an annotated image, the APK's self-install and background link, the gallery and viewer, the offline caches, or the outbox/inbox sweep.
---

# waterplane web — files between phone and desktop

Everything that moves or stores bytes on this side: downloads and pulls, the APK that installs itself, marked images, the gallery, the file browser, the offline caches and the sweep. Router: `web`. Reasoning: [web.md](docs/notes/web.md).

- `persist.ts` — `navigator.storage.persist()` at boot: IndexedDB is best-effort and the browser may
  drop queued uploads, partial downloads and the screenlog unasked.
- `annNote.ts` + the **highlighter** (`ImageAnnotator`'s `marker`) + `annClip.ts` + `annMove.ts` + `annKnobs.ts` — **what a marked image SAYS.**
  Marks are NUMBERED from ONE list in the words and in the pixels (`visibleMarks` feeds both
  `markNote` and the canvas badges), exact twins collapse, a colour is said only when it
  distinguishes, typed and read-back words are never clipped. `withUploadSize` appends the grid the
  agent ACTUALLY receives, and only where that is a fact; `collagePanelNote` says what a combined
  image IS. The highlighter swipes translucent ink (multiplied, so the words stay readable) and the
  band is READ on the host (`api.readText` → `POST /api/host/readtext`) from the CLEAN image — small
  text survives the mark and not the upload shrink, which is the whole reason. **The read is shown
  and editable before anything is sent**; it degrades to a sentence, never to a guess. The note is a
  PROMISE as readily as a string, settled in `queueUpload` after the bytes are parked.
  **A mark may be STARTED OFF THE PICTURE** — the gesture is the WRAPPER's, not the canvas's, because
  a thumb starting a box on the edge of a phone-sized image taps the edge instead of dragging from it.
  What overhangs is CUT on release (`annClip.ts`, node-tested), never sent: a BOX is clipped (its
  visible part cannot change — only the cut edge gains a stroke), a SEGMENT is clipped along its own
  line so an arrow keeps its DIRECTION, an ELLIPSE is dropped-or-kept but never reshaped (an arc that
  moves the instant the finger lifts is worse than one that overhangs), and a LABEL is MOVED, never
  dropped — it is the last copy of typed words. `clampToImage` clamps BOTH edges: clamping the origin
  alone kept the width, so a crop dragged in from off the left GREW as it went. **Moving or reshaping
  an already-placed mark is `annMove.ts`** (pure, node-tested): a SMALL mark's own end dots are
  hidden (a finger cannot land on them anyway), so any direct drag on it means MOVE; RESIZE is a
  three-chip row (`whole · A · B`) consulted only by a RELATIVE drag — the finger lands anywhere and
  the mark follows by the delta, never a floating handle to aim instead. A move clips on release
  through the SAME `annClip.ts` rules a fresh draw does, and one leaving nothing on the picture is
  REFUSED, never a silent delete. **Knob mode (`annKnobs.ts`, pure, node-tested) is the OPT-IN
  alternative** (`knobs` in the move row, `waterplane.annKnobs`, synced): move · size · turn knobs on
  strings — every mark turns but the highlight band, and an arrow/line wears a knob per END instead
  of size + turn (owner, 2026-10-15) (a box-like gains `Mark.angle`; a turned blur
  pixelates the box AROUND it, clipped), sized in screen px, working off the total
  delta from `base` and settling through `settleMove`. Relative drag stays the default.
- `collage.ts` + `CollageSheet.tsx` — more than one image picked: one picture, or several? Declining
  is one tap. Combining produces ONE picked file, so everything downstream is the single-image path.
  Decodes ONCE; paranoid encode (size ladder, `toDataURL` fallback, canvases zeroed).
  **Falling back is REPORTED, never silent.**
- `installLog.ts` + the Apps sheet's `installed` pane — **which version of what is on which phone.** One host, MANY clients: the install happens on a phone with the app closed, so the log lives on the desktop (`host/installlog.ts`). **The report is a RE-STATEMENT** — the whole history on every `welcome`, merged on a reproducible key, never queued and no ackId. **The phone's own clock or nothing** (`installedAt` off the shell; absent ⇒ the row says *reported*); merge rules are `shared`'s `installlog.ts`. **The device NAME must never sync** — its job is to differ per phone. Attached in `main.tsx`; no `App.tsx` branch.
- `pull.ts` / `PullSheet.tsx` — download queue with three engines: Background Fetch, the **native
  engine** (APK), and the chunked Range loop. Saving out is `nativeSave.ts` — a WebView drops a
  `blob:` anchor download SILENTLY.
  **The auto-download switch is per WebView** (`pull.auto`, never synced): a browser tab and the APK
  on one phone each have their own, so both fetched every build. A browser cannot see the APK, so it
  ASKS once (`browserPullAsk` → `PullBrowserAsk` under the strip; Android, not the shell, auto on, an
  automatic row on its way). With the switch off, the strip and the menu chip count only what moves
  or was tapped (`stripRows`) — a file waiting for a tap is the sheet's, not a standing bar.
- `installPolicy.ts` + `nativeInstall.ts` + `AppsSheet.tsx` — **the APK that installs itself.** The transport already
  put a fresh build on the phone; what was left was four taps per build, per app. **One dialog per
  app, EVER**: the FIRST install of any package always shows the system installer (no flag removes
  it, and the row SAYS so in advance rather than promising silence), and every later build is quiet
  — API 31's `USER_ACTION_NOT_REQUIRED` + `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, plus API 34's update
  OWNERSHIP, which is requested on the loud install that buys it. **A refused silence is not a
  failure** — it returns `STATUS_PENDING_USER_ACTION` carrying the same confirm intent, so asking can
  never cost an install; a confirmation that cannot be raised from the background becomes a
  NOTIFICATION and the row reads *waiting for you to confirm*, never *failed*. **The list is
  PACKAGES, never file names** (three repos here all build `app-debug.apk`; `Installs.read` reads the
  archive, and unreadable is EMPTY never guessed — such a row still offers the tap and promises
  nothing). Synced (`waterplane.installAllow`, `repoColors`' argument) and MIRRORED into the shell, because
  the install runs where the document is frozen. **The automatic path is narrower than a tap**:
  access granted, package on the list, AND already installed — an unattended first install is only a
  notification asking for a tap nobody asked for. A browser is told NOTHING (`installIntroText` →
  null); every platform refusal is a SENTENCE with the Settings button beside it, never a dimmed
  control. Pure half node-tested (`installPolicy.test.mjs`). **`AppsSheet.tsx` is the LIST and its
  own screen** — a switch reachable only from the download that brought the file cannot be SURVEYED,
  and the count said *2 apps install themselves* with nowhere to tap (**a count on a control is a
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
  nothing about this one), and `failureText` turns Play Protect's `VERIFICATION_FAILURE` and an
  abandoned session into sentences. Its two chips are one `readinessCut`.
  **All of that is the `dev` flavor.** The `play` shell (Google Play) answers `distribution:"play"` +
  `self` in `ShellInstall.status()` (`shellDistribution`; ABSENT ⇒ inherit dev): it never installs
  itself (`isPlaySelf` ⇒ `PLAY_SELF_TEXT`, refused natively in `Installs.refusal` too), has no
  auto-install switch (`allowToggle` null, `playAutoText` says why), no quiet path. `packages/app/README.md`.
- `nativePull.ts` — the download that keeps going when you switch apps. **Chromium freezes the
  DOCUMENT on its own, 300 s after `visibilitychange`**, so the transfer moves to a `dataSync`
  foreground service that keeps its BACKOFF on disk. **The LIST is the truth and `pullChanged` is a
  courtesy**; **`nativeOwned` is what stops the pump re-handing a row over**, and a TAP may.
- `download.ts` + `downloadState.ts` + `DownloadButton.tsx` — **the ONE download button, app-wide.**
  Replaces a hidden `<a download>` that did **nothing at all in the APK**. A `local` record has three
  privileges, each earned by a failure: created with **no `pull.add`**, never withdrawn by `sync()`,
  and pumped **with the auto-download switch off**. **One tap, one file** (`autoSave` +
  `installDownloads()` in `main.tsx`). **The folder is ASKED, not remembered**; **`savedPresent`
  undefined is not `false`**. `downloadState.ts` is the pure half. One button: `local/no-anchor-download`.
- `storagePlan.ts` + `storageAudit.ts` + `StorageSheet.tsx` — **what this phone is HOLDING, and
  getting some of it back.** `SweepSheet` for the desktop's transport dirs; this is the same question
  about the device, where `used 340 MB` was a dead stat on a screen somebody had opened looking for
  something to act on. **Two kinds, kept apart, and never one button**: a `cache` costs a re-fetch, a
  `keep` row (scrollback the TUI never put on the wire, recordings not yet read, photos from sends
  that DIED) is content — `groupUses` returns two groups and nothing returns their union. Every count
  carries its bytes; **null bytes is UNMEASURABLE, never `0 B`**, and it poisons the group total
  rather than being folded in as zero. **`unnamedBytes` degrades to absent** — `estimate()` is an
  approximation and can read BELOW what was measured, so "500 B of it is named below" about a
  reported 100 B is never printed. **It reaches into no store it does not own**: four have memory
  state as well as disk and a bare `idbClear` is a lie with a delay (the thumb warmer's `queued` then
  refuses to refill what it just emptied, `screenlog`'s `logs` re-saves on the next beat, the
  dictation INDEX names blobs that are gone, the transcript prefetch thinks it is warm) — hence
  `forgetThumbs` / `forgetScreenLogs` / `forgetDictations` / `forgetKept` / `forgetCacheStore` beside
  their own state. `uploads` is ONE store holding two things: a `keep:` orphan is droppable, a queued
  send's photo is **`cant`** and says so — that verb lives on the queue screen with the words in
  front of you. Downloads are read off `pull.ts`' records, not the store (the native engine's bytes
  are a FILE, outside `estimate()` and said so), and dropping them is `pulls.dropBytes(ids)` —
  **ids, never a rule**, sharing `dropOne` with the seven-day eviction. `storagePlan.test.mjs`.
- `idb.ts` / `offlineCache.ts` — read-side caches (transcripts, tool details, gallery listings and
  documents, file-browser listings). `prefetchTranscript()` and the term feed's 5-min
  `sweepTranscripts()` (`core/term/useTermFeed.ts`, over `offlineCache.ts`) are
  what make the reader work offline for a session you have not opened yet.
- `shellLink.ts` — the background link, the half that isn't Java. `ShellLinkService` fixes backgrounding
  by EXISTING; everything the page tells it is a PARAMETER, because none of it is a fact about the APK.
  `shellNudge` is listened for BESIDE the four wake events, deliberately not through them (those
  return early when the page is not visible, which is exactly this case).
  **`installShellBridge()` is called once in `main.tsx`, before React mounts** — a cold start from a
  notification beats any listener, so the id is PARKED. The whole native stack (service, plugin,
  worker, boot receiver) is **inert until `enableShellLink()` is called**, so the Settings toggle is
  the only thing that starts it. A refused notification permission is NOT a failure: the service still
  runs and the queue still drains, there is simply nowhere for alerts to appear.
- `docKind.ts` — **the one extension table on this side**: what the viewer can PAINT
  (`viewerHandles`), and what it paints FORMATTED first with a toggle back to source (`isRich` =
  markdown + HTML; an `.html` deck was written to be looked at, not read as tags). The rendered HTML
  branch frames the FILE not the truncated text, sits ahead of the text gates, and is
  `sandbox="allow-scripts"` with **no `allow-same-origin`** — the opaque origin makes its `Origin:
  null` one the host's guard refuses, so an artifact cannot call the API that wrote it. Lifted out of `Gallery.tsx` because the notification feed decides before any
  viewer exists — a notification about a file the app can render OPENS it (`openArtifact` →
  `galleryCtxForFile` → `Gallery`'s `openFile`, which renders from the alert's own payload with no
  listing), and the download becomes its own tap target beside it. Anything unpaintable stays the
  download it was. Warm push, cold push and the row all take the same path; closing returns to the
  feed. The host words the alert to match (`files.ts` `readsInline`) — widen the two lists together.
- `SweepSheet.tsx` + `shared/sweep.ts` — **clearing out `.claude/outbox` / `.claude/inbox`**, the
  bulk answer to 6.8 GB of transport files across fourteen repos. **Nothing applies itself**: it
  plans, says so, and a person taps twice — no timer, and deliberately **no auto-clean switch**.
  **The chip IS the filter** (`27 · 3.9 GB` opens exactly those 27; one `planSweep` feeds both) and
  **every count carries its bytes** — 27 of 31 files reads as "most", and was 97% of the size.
  `sweepKeepText` says what STAYS (plan-is-the-contract: `shared`'s `sweep.ts`). Outbox and inbox are
  separate scopes with **no "both"** (one is re-derivable, one may be a photo's only copy). `now` is
  FROZEN per plan. `ConfirmButton`; an empty cut is a SENTENCE, not a dimmed
  button; after a run it RE-READS rather than editing rows out, and "already gone" is said apart from
  "could not be removed".
- `shared/sweepfamilies.ts` + `SweepSheet`'s second chip row — **the cut that is not an age.** 33 of
  one repo's 38 outbox files are APKs across 13 families; another holds ONE family of 72. `keep the
  newest N of each` is `pruneVictims` with every row "produced" and nothing protected — the by-hand
  half of `artifacts.ts`' prune, and the THIRD reader of `familyKey`, deliberately the same function.
  **Outbox only** (inbox photos are all-variable names ⇒ every file its own family ⇒ a control that
  can only select nothing), **mutually exclusive with the age chips** (`pickAge`/`pickKeep` clear each
  other — two predicates feeding one number is two copies of the edge), ladder `[1,3,5]` and never a
  typed N, and **the family COUNT is said beside the file count** ("14 of 38" could be one family or
  nineteen). Not a policy control: prune is already on by default, so the recurrence lever is the
  scaffold `CLAUDE.md` line, not a switch. `shared/test/sweepfamilies.test.mjs`.
- `Gallery.tsx` — four filters over an HTTP listing, cached per tab + coverage and re-filtered locally
  (a 4h listing may never answer "all time"). **Thumbnail bytes are cached by the PAGE** (`thumbCache.ts`), cache-first, because the service
  worker is never registered in the APK. In the worker `v` decides HOW, not WHETHER: versioned ⇒
  cache-first, un-versioned ⇒ network-first. **An UN-VERSIONED document is cacheable by nobody**
  (`fileMtime.ts`'s rule): the text cache is keyed on `(repo, relPath, mtime)` and a seed with no
  mtime is 0, so every rewrite of one path files under one key — read AND write are skipped, fresh
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
- `FilesSheet.tsx` — the repo browser and the rare edit. **Saving is never queued** — a write composed
  now and replayed in an hour carries a base the file left behind. A `stale` refusal keeps the typed
  text and **never re-sends with a fresh base**.
