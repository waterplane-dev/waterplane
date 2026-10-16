# newSession

**Ctrl+N / ⌘N / Alt+N opens a new session from the keyboard** — the launcher's `+ now`, with no
mouse between the press and the new session's compose box.

- **On a session screen** the press is `+ now` for that session's repo (its worktree, when it is in
  one) through `nav.openRepo` — the same create, queue lane and pending screen as the tap. A session
  outside every listed repo opens the next one in its folder (`launch.openCwd`).
- **Anywhere else** it asks which repo (`askRepo`, the top-level `AskRepo.tsx`): caret in a filter, ↑/↓ or Ctrl+N/Ctrl+P
  walk the rows, Return opens, Esc closes. An empty filter lists primaries only; a typed one searches
  worktrees and branches too (`askRepoRows.ts`).
- The pending screen puts the caret in the compose box on its own (`ComposeBar`'s pending-id focus,
  never on a touch screen), so typing the first prompt is the next keystroke.

**Why Alt+N as well.** A plain browser TAB never receives Ctrl+N on Windows/Linux, nor ⌘N anywhere:
Chrome and Firefox reserve the chord and open a window before the page is told. An installed app
window — and Ctrl+N on a Mac, which the browser does not use — does reach the page. Alt/Option+N
works in every tab; it is matched on `code` because Option+N on a Mac types a dead key.

**On the shortcut card.** Holding Ctrl/⌘/Alt alone lists this chord (`ShortcutCard.tsx`, table in
the top-level `shortcuts.ts`), registered at `boot`. Its `when()` is `newKeyFree` — the same predicate
the listener stands down on — and its words name the repo a press would open in (`newKeyWhat`), or
say it will ask. `newKeyNote` puts the "this browser tab never receives Ctrl+N — Alt+N does the
same" sentence on the row where the browser keeps the chord.

**Owns**: `logic.ts` (which press is "new"; `logic.test.mjs`) and `actions.ts` (the capture-phase
listener, `boot`ed by the manifest, and what a press does). The dialog is NOT here: it is mounted in
`main.tsx` beside `AskTextHost`, and `main.tsx` may not import a feature (`local/feature-boundary`),
so it is the top-level `AskRepo.tsx`, reusable by any other "which repo?" asked from a keyboard.

**Rules**: the listener runs in the CAPTURE phase so a focused xterm does not eat the press, and it
stands down while any in-app dialog is up (the repo question included). Nothing new about creating
a session lives here — every open goes through `nav.openRepo` / `launch.openCwd`.
