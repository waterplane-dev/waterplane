---
name: web-term
description: waterplane phone client — the terminal and the reader (packages/web/src): Terminal.tsx and the geometry it reports to the PTY, TranscriptView.tsx (code in transcript/) with transcriptUtil.ts, PromptAnswer.tsx and its trust overlay in TermArea.tsx, ForkTurn.tsx + forkAnchor.ts, screenlog.ts + ScrollbackSheet.tsx, cliKeys.ts, strayKeys.ts. Load BEFORE touching what is drawn from a live PTY or a transcript: answering a choice box by tap, reader turns and tool folding, fork and reset, the scrollback archive, CLI key mode or stray desktop keys.
---

# waterplane web — the terminal and the reader

The two surfaces that show what the CLI is doing — the live terminal and the transcript reader — plus the scrollback archive, forking a turn and raw CLI keys. Router: `web`. Reasoning: [web.md](../../../docs/notes/web.md); moved-out stories: [web.md](../../../docs/notes/web.md#moved-out-of-skill-web-term-2026-10-17); the reader's code map: [transcript-architecture.md](../../../docs/notes/transcript-architecture.md).

- `suggestionBy.ts` — who a suggested answer is from, in words: the plugin's `byName`, then
  its model only when it named one — for the answer card, the reply bar and the reader alike. Never
  a model id alone (that was the oracle's wording), never blank.
- `PromptAnswer.tsx` + `TermArea.tsx` (`core/session/`) — **the one card a choice box is answered by tapping**, drawn by the reader's
  `tr-ask` and by `QuestionsSheet`. The `approve` BAR under the terminal is GONE (it took its height from
  the PTY and hid options a scroll region Android draws no scrollbar on), so the surfaces that draw the
  card are the two with a scroll of their own, and nothing here is capped or clamped. In the terminal view
  a box is answered the terminal's way (press the digit). **One exception, the trust box**
  (`termAnswers.ts`, kind `trust` only): `TermArea.tsx` draws the card as an OVERLAY at the grid's bottom
  (`.term-answer`, its own scroll, never a PTY resize), because it is a new person's first box, before
  they know the key bar, and the CLI draws it unnumbered with the cursor on "No, exit". Widen that
  predicate only for a box with the same argument. **The commit row is never inside the option list** (on a
  multi-select Submit is the only control that answers). Every tap is still `answerPrompt` — durable,
  fingerprinted, refused host-side once the box is gone — **no new send path**; sharing one body is
  what stopped the sheet's copy sending a DIGIT at a `nav` box. `CliPeek.tsx` (the reader's empty state: the top of the live
  screen), `useReaderPick.tsx` and `useTermPick.tsx` (line pick in the reader and the terminal) live in `core/session/`.
- `TranscriptView.tsx` + `transcriptUtil.ts` — reader view (code: `transcript/` — the compaction divider in `TvTurn.tsx`, the `source === "history"` test in `TvOutline.tsx`, folding in `tvRows.ts`; map: [transcript-architecture.md](../../../docs/notes/transcript-architecture.md)). **A `marker: "compaction"` turn is a labelled DIVIDER**
  (`.tr-mark`), never a prompt somebody sent and left blank — that would be a claim about a person
  where the fact is about the tool. **`source` is tested for `"history"` by EQUALITY, never
  `!== "jsonl"`**: `"store"` is a backend's own dated record (its store reader's) and is EXACT, and an unknown source
  must read as exact too. **The spinner waits for the CACHE, never for the host.** Offline
  status is labelled *last known* and the pulse stops. Tool calls obey `waterplane.readerTools`
  (`transcriptUtil.ts`, synced: `fold`/`list`/`full`); a lone tool call is never folded. **The reader owns no BUTTONS of its own** —
  outline, find and refresh are ordinary toolbar actions, split by view. `shared/working.ts` scrapes the
  CLI's own spinner out of the PTY tail the socket already delivers — **anchored on its SHAPE**
  (gerund + ellipsis + a parenthetical with a duration or tokens), never on a hint string. An ellipsis alone is not a spinner (truncated warnings carry one).
  **A quiet main loop is not a quiet session**: `SessionInfo.agents` (host `agents.ts`) is its own
  rung under "waiting on you" and above idle, with ONE ROW PER AGENT — the count is not the
  progress. The same fact moves `sessionStatus()` from `done` to `coding` in `sessionFacts.tsx`, so
  the row, the repo roll-up and the filter still agree.
- `ForkTurn.tsx` + `forkAnchor.ts` — *fork from here* BRANCHES, *reset to here* REWINDS IN PLACE; both are one durable
  `session.create` carrying `forkAtTurn`. **"Here" is BEFORE the tapped turn** — its prompt is what
  gets taken back (Copilot's checkpoint, the CLI's `/rewind`); the host cuts AFTER a turn, so the wire
  carries the newest logged turn ABOVE the tapped one, and the words say "before #N". Reset KILLS a running session, so it goes through
  `askConfirm` and peeks at the WORKTREE (never `session.closecheck`, whose reply handler would
  ARCHIVE the session being reset). **A cached transcript is fine to compose from, but the verb is
  disabled rather than queued** — a reset replayed an hour late kills an hour of work.
  `forkAnchor.ts` is WHERE the cut lands: a `screen:` turn (`/btw` — the CLI wrote nothing to the
  log) cuts at the newest LOGGED turn before it, which is exact because a screen turn changed
  nothing, and the row SAYS which number it used; a synthesized `t<N>` is refused instead, because
  it stands for real history the parse could not name. Unavailable is a SENTENCE
  (`Unavailable.tsx`), never a dimmed pair.
- `Terminal.tsx` — **a resize repaints the whole screen, so layout churn IS flicker**:
  report geometry only when cols/rows changed; the transient strips beside it (`core/queue`'s) linger by `useLinger.ts` (also used by `core/queue/useQueue.ts` and uploads) and keep stable height.
  **A fit measured on a COLLAPSED container is not reported at all** (`drawableViewport`,
  `shared/ptysize.ts`, whose bullet in `shared` has the `54x3` reason): `FitAddon` answers for a
  no-height box too. The last-reported geometry is deliberately NOT updated when a report is withheld, or the real one that
  follows is skipped as a no-change.
  The feed behind it is `core/term/useTermFeed.ts`: **PTY bytes are REFS, never state** (a frame mutates the buffer and bumps `writeSeq`, the one re-render). `ptyTail.ts` persists the attached session's tail in IndexedDB (never localStorage: its quota belongs to the send outbox) **with its `seq`**, handed back as `resumeSeq` on attach so a live host stitches only the delta.
- `screenlog.ts` + `ScrollbackSheet.tsx` — **scrolling the TUI is a REMOTE operation**, so a dead link
  means the gesture does nothing. Lines that scrolled off are archived per session in IndexedDB and an
  upward pan opens that archive. **Two sources and they are not equal**: this device's copy is a
  RECONSTRUCTION (a view switch archives the outgoing screen WHOLE, so blocks repeat; anything painted
  with the app closed was never captured, so blocks are missing), while the host replays the real PTY
  RECORDING of the same thing (`api.scrollback`, host `screenlog.ts`) — **never a replay**: the CLI
  draws in the ALTERNATE screen, which keeps no scrollback, so replaying the bytes answers with ONE
  SCREEN however long the session ran. The host's copy **replaces this one only when it is actually
  more** (`history || longer`) — a just-restarted daemon has one screen and must not talk the phone
  out of an hour's archive. Asked ONCE per successful read, the local copy is the DEFAULT (never a
  spinner in front of readable text), and **which one is on screen is SAID**. A flick is ONE wheel
  write. **Its zoom is a THIRD stored value** (`waterplane.scrollZoom`) — its lines were wrapped once by an
  80-column grid and a narrower phone wraps them again, so smaller text is what puts a terminal line back on
  one line; never the CONSOLE's zoom (that resizes the live PTY — reading history must not reshape the
  session) and never the READER's. Mechanism IS the reader's: one `--ui-font` override on `.sb-body` over
  `nextReaderZoom`'s ladder.
- `cliKeys.ts` — **CLI mode**: the compose box becomes a raw key pipe, per device, NOT synced. Android
  soft keyboards report no `keydown` for letters, so the box holds a pad of spaces and every `input`
  is diffed. **Don't advance the baseline mid-composition, and don't reset the value through state.**
- `KeyRow.tsx` + `useChord.ts` + `chordState.ts` + `KeysPop.tsx` + `cliShortcuts.ts` — **any key combination**:
  hint chips (host `keyHints`), sticky `Ctrl`/`Alt`/`Shift` (tap = next key, twice = lock, worded on
  the button), the fixed keys, and the `Keys` list of claude's own shortcuts. **One encoding**,
  `shared/chord.ts`; a combination with no terminal bytes is REFUSED in words, never sent as another
  key. A held modifier makes the compose box the key pipe for ONE key (`cliMode` widened by
  `chord.armed`) — the letter never lands in the draft. The list leaves out `ctrl+d`, `ctrl+g`/`ctrl+e`,
  `ctrl+v` on purpose and is an overlay, never a PTY resize. [web.md](../../../docs/notes/web.md#keyrowtsx--usechordts--keyspoptsx--any-key-combination-from-a-phone)
- `strayKeys.ts` (`core/session/`) — **a desktop key typed at no field goes to the terminal**, then
  the terminal keeps the keyboard; through `sendInput`, never a new send path. **A stray Esc, any
  Ctrl/Alt/Meta chord and Tab are NEVER forwarded** — a stray Esc or ^C interrupts a running turn;
  those reach the CLI only from the FOCUSED terminal. Enter/Space on a button activate it. Decided
  after every other keydown handler (`escape.ts`'s reason) and off while a panel, dialog or confirm
  is over the grid. The focused grid SAYS it has the keys (wide CSS), and Ctrl+C over a selection
  copies (`Terminal.tsx`'s key handler) instead of interrupting.
