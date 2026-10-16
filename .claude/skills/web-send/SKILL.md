---
name: web-send
description: waterplane phone client, the path from typed words to a confirmed delivery (packages/web/src): ws.ts, outbox.ts and the offline send queue, sendConfirm.ts, attachments.ts/AttachStrip.tsx, PadSheet.tsx, RepoPicker.tsx, PromptComposer.tsx, useVoice.ts with dictateHold.ts/dictateQueue.ts, composeSend.ts/NextPrompt.tsx/sendMemory.ts, and SendSheet.tsx/sendIntent.ts. Load BEFORE changing how a prompt is composed, queued, retried, targeted, scheduled, dictated or confirmed — most rules here exist because words ran twice or were silently deleted.
---

# waterplane web — typed words to a confirmed send

Everything on the path from a typed word to a delivery the desktop has confirmed: the one socket, the one queue, drafts and the pad, attachments and dictation, and the sheet that decides what, where and when. Router: `web`. Reasoning: [web.md](docs/notes/web.md).

- `ws.ts` — single `HostConnection`. Never trusts `readyState === OPEN` on wake; ping-verifies, closes
  on `freeze`/`pagehide`, last-resort reload gated on `/api/health` actually answering.
- `outbox.ts` — drafts + **the offline send queue, the single send path** (`input`/`backlog`/`upload`/
  `op`). One delivery in flight per lane; cap enforced on the way IN; retries only with the same
  ackId; an attempt rolled back when the socket wasn't open; every attached file parked to IndexedDB
  before it can be lost. Queued opens carrying a prompt are **serialized per repo by default**.
  **Seeding a sheet draft rescues first** (`seedSheetDraft` + `shared/pad.ts`'s `draftToRescue`;
  enforced, with its reason, by lint `local/no-draft-clobber`). The old draft becomes a PAD NOTE and is SAID; `seeded`/`kept`/**`refused`**, and on a refusal the
  draft is left exactly where it is (a rescue that could not happen must not also be a delete) —
  **and the SEED then drops its `padId`/`ackId`** (`seedAfterRescue`): the sheet is composing the
  rescued draft, so Send must not retire the note or the row those OTHER words came from.
  **`removePadNotes` is the one pad delete** — every removal path uses it, because a dispatch with
  no tombstone is a note the other device sends a second time.
  **A `failed` row is kept, in full, for ever** — no TTL, no retire, no ledger; `OUTBOX_CAP` overflow
  FAILS the oldest rather than dropping it. What became of an ambiguous delivery is the HOST's
  question (`delivery.settled`).
- `sendConfirm.ts` — **an `unconfirmed` verdict is the desktop's QUESTION, not a failure.** The row is
  typed-and-being-confirmed (muted, no triangle, NO recovery buttons — re-sending by hand is how a
  prompt runs twice) until `delivery.settled` stamps `hostSettled` or `CONFIRM_WINDOW_MS` runs out.
  It went red seven seconds after Send while the host still had four re-sends to spend.
  **`unsubmitted` is excluded on purpose** — that one IS known and IS waiting on a person.
- `attachments.ts` + `AttachStrip.tsx` — the files a queued prompt names. The inbox path is written
  into the text BEFORE the bytes move, so the path says nothing about whether the file will exist.
  **Every thumbnail here OPENS**, and the payload is the path + repo + verdict, **never the URL on
  screen**. Bytes of a dying upload are **moved aside, not deleted**.
- `PadSheet.tsx` — a note is target-less but can be a CHAIN and carry FILES. **A note that knows its
  repo says so**; marked, never preselected. **The pad is synced and the merge is PER NOTE**
  (`shared/pad.ts` on adopt, tombstones so a delete TRAVELS), replacing a whole-list last-write-wins. The trash stays a `ConfirmButton` because the tombstone makes it a
  delete everywhere. **It REFUSES rather than sheds** — the editor stays open with the buffer and
  the reason, checked BEFORE the buffer is cleared. **`file it`** (only where the note's `cwd`
  resolves; nothing drawn where it does not) is `queueBacklog`'s existing `mode: "backlog"`, **no
  `label`** so the row arrives untitled by anybody, and the note goes only after the row is queued.
  `BootGuard`'s reset keeps `waterplane.syncTs`, and `waterplane.padRescue` + its migrated mark until
  `migratePadRescue` has read it RAW (never through the old TTL-applying reader) exactly once —
  **every rule about those ten notes is `padMigrate.ts`'s `migrateRescueRows`**, node-tested, `core/queue/migrate.ts`'s
  `migratePadRescue` keeping only the read/write/mark: one phone has them, the source is read once and then marked.
- `RepoPicker.tsx` — "which repo?", asked once. A note that names its `cwd` has that repo FIRST and
  labelled; a primaries-only filter **must keep a SELECTED worktree visible and counted**.
- `PromptComposer.tsx` — **the one prompt-writing surface.** Dictation writes into the turn the CARET
  is in (`focusRef`, written on focus and read by `AttachButtons`, which is mounted in the action bar
  and cannot see focus itself), and the bar's `in repo` button names a file the repo ALREADY has —
  the gallery with `insertInto: "send"`, because the clipboard route needs a secure context and a
  plain `http://100.x` tunnel is not one. The primary box GROWS rather than
  `rows={N}`; carries the prompt CHAIN (delivered one turn at a time, never concatenated) and an
  `inline` mode.
- `secretAsk.ts` + `useCompose`'s secret state — **a password asked on a SHELL's screen** (the cursor
  line ENDS with `Password:` / `passphrase for …:`, read by `Terminal`'s `onCursorLine`) swaps the
  draft box for a masked `<input type=password>` with an eye to reveal and no auto-capital. Its words
  are never `compose`, never a draft, never `pushHistory`, never an outbox row: they go as raw keys
  (`sendInput` + `\r`, the CLI pipe's path) and offline REFUSES — a queued password lands on whatever
  is on screen later. `not a password` hides it until that ask goes. Shell sessions only: claude's TUI
  draws typed words on its cursor line. Shell composers also drop autocapitalize/autocorrect.
- `useVoice.ts` + `dictateLang.ts` + `DictateLangPill.tsx` + `VoiceButton.tsx` — **dictation: two engines, one button** — and ONE control drawing it on every surface (`VoiceButton`: the compose bar's round mic with clock, held badge and pills; a sheet or a file remark draws the same, never a labelled second chrome). `host` (the desktop's whisper, ~30× realtime) when it answers available AND this document may open a mic; `browser` (Web Speech — Google's cloud, the engine that was not good enough) otherwise; neither ⇒ `supported` false and the caller draws NO button. **The fallback is SAID** (`dictateFallback.ts` + `DictateFallbackPill.tsx`): while the phone's recogniser listens, a warn pill sits where the language pill would, its tap toasting WHY (plain http, no recording API, or the desktop's own `reason`), toasted once per page too — Android's recogniser dictated garbage nobody could tell was not whisper's. A "no" from `/api/host/dictate` is not memoised. **`getUserMedia` needs a secure context**, so a bare `http://100.x` tunnel falls back by construction, and the APK needs `RECORD_AUDIO` — a new APK, not an OTA bundle. **FOUR states**: `transcribing` is held apart from `listening` (the words land ~1 s after you stop, and a button back at idle reads as a tap that did nothing), and `held` is a recording the link could not carry yet. The status read is ONE memoized promise per page. Capture is 16 kHz mono PCM via `AudioContext({sampleRate})` so the host needs no transcoder, `ScriptProcessorNode` on purpose (an `AudioWorklet` needs a blob URL in the WebView), each callback COPYING its channel data. **Dictation APPENDS — onto what the box holds AT LANDING, never a snapshot from the tap** (`appendDictation`; a held clip lands minutes later and a stale base is a delete), **and every failure is a TOAST with nothing appended.** **The LANGUAGE is the dictation's, never the device's** — it was `navigator.language`, and whisper told a language TRANSLATES every other one into it, so English spoken into a German phone arrived as fluent German prose. Default `auto`, picked on the pill beside the mic (both chromes, one stored choice), read at the STOP so it travels with the clip and a held recording keeps the language it was made in. **The pill is drawn only WHILE recording, and only on the host engine** — furniture the rest of the time, and the browser recogniser is given its language at the start, so there is nothing to change about a running one; the standing choice and the pill's LIST are two Settings rows (`dictate-lang`, `dictate-langs`, `SetMulti`), defaulting to three languages (`DICTATE_LANGS_DEFAULT`) because the pill is tapped one-handed mid-sentence. `dictateLangOffered` never returns an empty list and always includes the language in use. Every offered code must survive `whisperLang` unchanged — an unknown one transcribes NOTHING — which `shared/test/dictate.test.mjs` pins.
- `dictateWatch.ts` — **a microphone that stops hearing SAYS so.** A long dictation is an untouched phone: the screen timed out, the WebView paused the `AudioContext`, and the button went on saying *listening* over audio that was never recorded. The button's clock (`Voice.heard`) counts FRAMES that arrived, so it freezes with the mic; `captureStall` (a gap since the last frame, a lag against the wall clock since the open — a resumed context hides a hole in the middle — or an ended track) stops, hands over what WAS heard, vibrates and toasts WHEN. A screen wake lock is held while recording where the WebView offers one. The 300 s cap ROLLS OVER into a new clip instead of closing the mic; the browser recogniser's own `onend` (Android ends "continuous" sessions itself) is said too. Pure half node-tested.
- `dictateHold.ts` + `dictateQueue.ts` — **a recording is not lost to the link.** `api.dictate` went out on the 20 s JSON fuse while a minute of speech is 1.9 MB uploaded before the first response header, so a slow tunnel ABORTED it and the only copy of the audio was dropped — the reported *"talk for a minute and then see it run into an error"*. Now: XHR with progress (bound SILENCE, never the transfer), bytes parked in IndexedDB (`dictations`) BEFORE the first attempt, one clip at a time oldest-first, backoff that **never gives up** (nobody re-says a sentence), a reconnect clearing every backoff, and the CAP REFUSING a new clip rather than shedding an old one. **Where the words land is checked TWICE** — `VoiceBox.key` (the session, the chain turn) at the tap and again at landing; a mismatch or a gone box sends them to the PAD and SAYS so. Nothing is destroyed to tidy up: a full pad leaves the clip on the ladder. Pure half node-tested (`dictateHold.test.mjs`); `installDictations()` in `main.tsx`.
- **A row opened in `SendSheet` is RE-DECIDED, never duplicated** (`whenRoute` in `sendIntent.ts`).
  `seed.scheduleId` was read by the `at` arm alone, so choosing *now* / *when it's free* / *after…*
  on a live timed row posted a second row beside the armed one and the words ran twice. Four routes:
  `upsert` (a clock — `schedule.save` on the same id), `patch` (`intent.update` carrying the new
  trigger AND the words and target), `post` (nothing to re-decide, or a spent row that can never run
  again), `refuse` (running/starting, a re-aim at several repos, a build) — the refusals reach the
  BUTTON through `sendBlocker`, before the tap. The receipt says *the same row*.
- `composeSend.ts` + `NextPrompt.tsx` / `nextPromptState.ts` + `sendMemory.ts` — **the compose bar's split button and
  the strip above it.** Two modes, `Send` and `When free`, **one row that runs NOTHING**
  (*keep it on the pad* → `addPadNote` with the session's `cwd`: no target, no trigger, out of
  reach of `auto`, filed onto a backlog later only by a person — it may never
  be worded as *queued*/*scheduled*, and a refusal leaves the words in the box), plus ONE errand
  (*elsewhere or later…*) into `SendSheet`. Two rows carry `mode: null`, so a caller switches on
  `key`, never on `mode === null`. **`.send-more` restates `flex: 0 0 auto`**: `.row-more`'s
  `flex: 0 0 100%` is a WIDTH in the launcher's row parent and a HEIGHT inside the compose COLUMN,
  where it made every menu button as tall as the composer. **`when it's free` is held by the DESKTOP** (a work item pinned to the session):
  one holder, so the phone may sleep — `holdUntilIdle` survives only where the host cannot hold it,
  i.e. a prompt chained behind a `session.create` and `submitInput`'s local-command guard — **and a
  local command routes there on purpose**: `/usage` opens a VIEW and starts no turn, so a pinned item
  watching for one never settles. **The mode is remembered PER REPO** (`sendMemory.ts`, pure and
  node-tested) — queueing five prompts *when it's free* was five taps on the chevron. The deleted
  `waterplane.sendMode` armed this button with a wall CLOCK and said so nowhere: only `now`/`idle` are
  ever recalled onto it and `sendModeLabel` spells both out on the face, a schedule is recalled
  onto the SHEET (which draws the rule, `recalledWhenNote` saying it was), a stale one-off expires
  itself at READ time, and a chain is NEVER remembered (it names one predecessor row).
  `composeSend.test.mjs` pins the labels, titles and toasts, and **`sendModeToast` takes the HOLDER**
  (plus `phoneHold`, because the two phone-held cases are two different promises) — "held" when the
  PHONE is holding it is a promise about a locked screen it cannot keep. `nextPromptView` reads both
  queues and `NextPromptView.holder` says which; the phone's own lane goes first (it is the one a tap
  can still change). **The strip's wait verb is `when it's free` and it hands the words to the
  DESKTOP** (`handToDesktop` — `retargetEntry` into `backlog` mode + `autoFire`), never
  `toggleHoldQueued`, which put the phone back in the holder's chair two taps from the composer that
  had just stopped doing it. **A pinned row is drawn even on an IDLE session**, wearing the host's own
  `waiting` sentence: the phone cannot see the gate/budget/limit rungs, and hidden it left the whole
  screen silent about words that were certainly going to run. Offline it says `· as of <age>`.
- `SendSheet.tsx` + `sendIntent.ts` — **the one send surface.** Four orthogonal decisions — WHAT,
  WHERE, WHEN, HOW MANY AT ONCE — that twelve sheets each hard-coded a different combination of. Text
  first, then two collapsed rows *To* and *When*; the primary button **restates the whole decision**
  and, disabled, **says why**. **The decision survives the annotator round trip, not just the words**
  (`SendResume` + `onDecide`, in `core/send`'s `sendResumeRef`, cleared with the seed) — a schedule set before
  attaching a picture silently reverted to *now*.
  `dispatchIntent()` maps one `SendIntent` onto send paths that already
  exist and **adds none**. **To is `this session` · `a new session` · `several repos`** — `work
  item` named the retired shared backlog conversation and is gone; what was different about
  continuing is the chip `pick up its last conversation` (`resume`, `--continue`). With nothing open
  `this session` is **not drawn at all** and `<Unavailable>` says why — it was a dimmed segment whose
  reason lived in a `title`, and tapping it answered a REPO target (`firstSession` on an empty list),
  i.e. silently a different question.
  **When is THREE anchors** — `at a time` · `a usage window` · `after another…` — over the two live
  instructions (`now` / `when it's free`); **rare power goes under *more*, never onto the top row.**
  A chain (`after`) is the one WHEN `backlog.add` cannot carry (no trigger), so it rides as
  `intent.post`; its picker is `chainCandidates` (running, then waiting, then settled inside
  `CHAIN_RECENT_MS`; never a `canceled` row, always a failed one, and **never a RECURRING rule** —
  a standing rule never goes terminal, so `settled` can never name it and the chain would wait for
  ever; `ruleRecurs` here and `IntentFacts.neverSettles` on the host, one reading, and the ladder
  FAILS such a row because a rule can be edited into recurring after the chain was made) titled by **`activityRows`'
  exported `intentTitle`** — the name is SNAPSHOTTED onto the trigger, so a second copy of that rule
  would drift. **An empty picker is a SENTENCE, never a dimmed segment.** A chain may name a live
  session; a clock keeps it by its CONVERSATION (`IntentTarget.resumeConvId`, `reopensConversation()`), never re-aimed at the repo. **A chain into SEVERAL repos is refused in words** — a
  sweep is ONE prompt (`fanout.ts` reads `steps[0]`), and unrefused it dropped turns 2..n on the
  desktop silently; the label is `Fan out to N repos after …`, never the sequential `Queue in N`.
  Under *more*: `hours` — **the RUN window, never called "quiet hours" on screen** (the fields are
  07:00–22:00 and the host reads them as the hours it MAY run, so the old labels made "not while I'm
  asleep" produce the opposite); a policy over any anchor, wraps midnight, zero width is SAID not
  guessed, grace counts from the OPENING — and, beside the pct chips, `guardWindow` (which METER the
  headroom condition reads, so *right after the session window resets, only if 30% of the week is
  left* is sayable), labelled by its VERB (`GUARD_LABEL`: *checks the session meter*) so it does not
  wear the same two nouns as the anchor control ten lines above; an `after` edge guarding its OWN
  window is worded, never dimmed. **Leaving `at` does not delete the rule** — every exit goes through
  `leaveAt`, which parks the WHOLE `when` in `atMemo`, and the row says the schedule is kept.
  **One clause for the fresh-session wait** — *when this repo is free*, in the button, the toast and
  the hint. **`offlineLabel` never prefixes `Queue ·` onto a label that already opens with it.**
  **Never re-word a rule `describeRule` already spells.**
  Re-time mode's *let past the budget* sends `intent.waive` for exactly `budgetHeldIds` (`isBudgetHeld`: due, no waiver in force — also the header ⌛ count), drawn only when the budget holds them; never `intent.run` (`bulkverbs.test.mjs`).
  **Every string here is pinned by `sendIntent.test.mjs`** — a reword is a decision about the app's
  vocabulary and edits the test in the same change.
