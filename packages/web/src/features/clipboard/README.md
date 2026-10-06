# clipboard

Text between the session and the phone's (or the desktop's) clipboard: the **Terminal text** sheet
(`text` — the live grid, or the cached transcript when the reader has unmounted the xterm; tick
lines, copy, quote into compose, and every URL rejoined across the rows the terminal broke it into)
and the **To desktop clipboard** sheet (`clip` — stage text from the compose draft, the phone's
clipboard or typing, and put it on the DESKTOP's system clipboard; nothing is typed into the
session). Also the **Answer the list** sheet (`answers`, `DecisionsSheet.tsx`): every numbered — else
bulleted, else picked — item on the screen with one short field and quick chips each (`yes`/`no`/
`your call`, plus an item's own "X, or Y?"), inserted into compose as `My decisions:` + `4. Label:
answer` lines. Fed by `openDecisions(picked?)` — the rows picked on the live terminal
(`core/session/useTermPick.tsx`) or in the reader (`useReaderPick.tsx`), else the grid, else the cached transcript's tail. Also `openLink` / `copyLink`, which App's sign-in bar (`LoginBar`) shares.

**Owns**

- `store.ts` — `dump` (`{ text, source: "grid" | "transcript" }`, written only by `openTextDump`)
  and `clipSeed` (the compose draft at the tap, written only by `openClipSheet`). Both writers,
  and `openLink`/`copyLink`, are `actions.ts`; `ClipSheet.tsx` and `TextSheet.tsx` are the sheets. The clip sheet's
  edits are its own component state, seeded on mount — the sheet is a fresh mount per open.
- `decide` (the sheet's source lines) and `decideAnswers` (typed answers by item text, so closing
  the sheet does not delete them; cleared for the items that were inserted).
- Sheets: `clip`, `text`, `answers` — all `persisted: false` (neither is in `PERSISTED_OVERLAYS`).
- Toolbar commands: `clip` (→ `openClipSheet`), `select` (→ `openTextDump`) and `decide`
  (→ `openDecisions`, "answer list"). The items stay
  declared in `toolbar.ts`.
- No wire frames: the desktop clipboard is `api.setClipboard` (HTTP), and the transcript fallback
  is `offlineCache.getTranscript` (IndexedDB, no host). No storage keys.
- Track ids: `action:decide.open`, `action:clip.open`, `action:link.open`, `action:link.copy` (unchanged).

**Reads from App** through `core().compose`: the `draft` (the clip sheet's seed and its "compose
draft" button), `gridText()` (read BEFORE the text sheet opens, which unmounts the terminal) and
`insert` (quote in compose — adds, never overwrites).

**Rules that apply**: a link goes out through `openExternal` (the APK cannot `window.open`) and
always says what happened in a toast; the compose draft is never overwritten (quote INSERTS).

**Exports for core**: `openDecisions` and `quoteIntoCompose` — the terminal's long-press menu and
pick bar (`core/session/pickUi.tsx`, shared by the terminal and the reader) call them.

**Tests**: `logic.test.mjs` (`quoteBlock`, `emptyDumpText`, `decisionItems`, `optionsOf`,
`decisionBlock`).
