# codeFolder

The code folder the host scans for repos, from the phone: a one-time "Which folder holds your
repos?" dialog when the host only GUESSED the folder (or a chosen one has vanished), and the
Settings row *Code folder* that opens the same dialog any time. The host half is
`packages/host/src/rootchoice.ts` (`GET`/`POST /api/host/root`; types in `shared/rootchoice.ts`).

**Owns**

- `store.ts` — `rootInfo` (the last `GET`) and `rootUi` (idle · restarting · manual: where a save
  stands), written only by `actions.ts`.
- `actions.ts` — `loadRoot`, `checkFolder` (check only, `{ path }`), `saveFolder` (`save: true`),
  `openCodeFolder` (the one door: Settings and the ask both use it), `leaveCodeFolder` (the sheet's
  `onLeave`: any way out records "later" for THIS guess), and `onWelcome`.
- `CodeFolderSheet.tsx` — overlay `codefolder` (not persisted). Candidate rows and the typed path only
  SELECT; the folder changes on the tap of *Use this folder* or *Keep <root>*. `named` (the variable
  sets it) and `!canChange` (this connection may not) offer no save and SAY so — no dimmed buttons.
- `CodeFolderSettings.tsx` — the row (`code-folder`, Connection, order -5): path, how it was picked
  in words, a pending note.
- `logic.ts` — wording, the dismissal key, `shouldAskNow`, `afterSave`; `logic.test.mjs`.

**When it opens unprompted**: the `welcome` handler reads `GET /api/host/root`; if `rootNeedsAsking`,
this guess (`<picked>:<root>`) is not in `LS.codeFolderLater`, no sheet is open and it is not the demo,
it opens. A restart after a save ends on the welcome that names the new root (or after 6 s).

**Reads from core**: `nav.open/close/overlay`, `say.track`.

**Rules**: nothing applies itself (a save is a tap); a refusal is the host's sentence, verbatim; a
guess waved away is not asked again on this device, but Settings still reaches it.
