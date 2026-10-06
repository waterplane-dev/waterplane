---
name: web-term
description: waterplane phone client, the terminal and the reader (packages/web/src): Terminal.tsx + useLinger and the geometry it reports to the PTY, TranscriptView.tsx with transcriptUtil.ts, PromptAnswer.tsx, ForkTurn.tsx + forkAnchor.ts, screenlog.ts + ScrollbackSheet.tsx, and cliKeys.ts. Load BEFORE touching what is drawn from a live PTY or a transcript: answering a choice box by tap, reader turns and tool folding, fork and reset, the scrollback archive, or CLI key mode.
---

# waterplane web — the terminal and the reader

The two surfaces that show what the CLI is doing — the live terminal and the transcript reader — plus the scrollback archive, forking a turn and raw CLI keys. Router: `web`. Reasoning: [web.md](docs/notes/web.md).

- `suggestionBy.ts` — who a suggested answer is from, in words: the plugin's `byName`, then
  its model only when it named one — for the answer card, the reply bar and the reader alike. Never
  a model id alone (that was the oracle's wording), never blank.
- `PromptAnswer.tsx` — **the one card a choice box is answered by tapping**, drawn by the reader's
  `tr-ask` and by `QuestionsSheet`. The `approve` BAR under the terminal is GONE: it took its height
  from the PTY, so it was capped, clamped and three-sized — and on a six-option box with a paragraph
  each it still showed TWO, with four inside a scroll region Android draws no scrollbar on. In the
  terminal view a box is answered the terminal's way (press the digit); a card there only covers the
  CLI drawing the same question. So the surfaces that draw it are the two with a scroll of their own,
  and nothing here is capped or clamped. **The commit row is never inside the option list** (on a
  multi-select Submit is the only control that answers). Every tap is still `answerPrompt` — durable,
  fingerprinted, refused host-side once the box is gone — **no new send path**; sharing one body is
  what stopped the sheet's copy sending a DIGIT at a `nav` box.
- `TranscriptView.tsx` + `transcriptUtil.ts` — reader view. **A `marker: "compaction"` turn is a labelled DIVIDER**
  (`.tr-mark`), never a prompt somebody sent and left blank — that would be a claim about a person
  where the fact is about the tool. **`source` is tested for `"history"` by EQUALITY, never
  `!== "jsonl"`**: `"store"` is a backend's own dated record (its store reader's) and is EXACT, and an unknown source
  must read as exact too. **The spinner waits for the CACHE, never for the host.** Offline
  status is labelled *last known* and the pulse stops. Tool calls obey `waterplane.readerTools`
  (`transcriptUtil.ts`, synced: `fold`/`list`/`full`); a lone tool call is never folded. **The reader owns no BUTTONS of its own** —
  outline, find and refresh are ordinary toolbar actions, split by view. `shared/working.ts` scrapes the
  CLI's own spinner out of the PTY tail the socket already delivers — **anchored on its SHAPE**
  (gerund + ellipsis + a parenthetical with a duration or tokens), never on a hint string: the old
  "esc to interrupt" anchor went stale and the reader said "working" for nine minutes with no sign
  it had stopped matching. An ellipsis alone is not a spinner (truncated warnings carry one).
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
- `Terminal.tsx` + `useLinger` — **a resize repaints the whole screen, so layout churn IS flicker**:
  report geometry only when cols/rows changed, transient strips linger and keep stable height.
  **A fit measured on a COLLAPSED container is not reported at all** (`drawableViewport`,
  `shared/ptysize.ts`): `FitAddon` answers for a no-height box too, and the `54x3` it reported left a
  session the CLI could not draw a composer in, so every send into it came back unconfirmable. The
  last-reported geometry is deliberately NOT updated when a report is withheld, or the real one that
  follows is skipped as a no-change.
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
  write. **It has the corner pair's zoom as a THIRD stored value** (`waterplane.scrollZoom`) — its lines
  were wrapped once by an 80-column grid and a narrower phone wraps them again, so smaller text is
  what puts a terminal line back on one line; never the CONSOLE's zoom (that reports new cols/rows
  and resizes the live PTY — reading history must not reshape the session) and never the READER's
  (prose that reflows is a different size question). Mechanism IS the reader's: one `--ui-font`
  override on `.sb-body` over `nextReaderZoom`'s ladder, the pair anchored right on `margin-left:
  auto` so the hits group appearing with a query cannot walk it under your finger.
- `cliKeys.ts` — **CLI mode**: the compose box becomes a raw key pipe, per device, NOT synced. Android
  soft keyboards report no `keydown` for letters, so the box holds a pad of spaces and every `input`
  is diffed. **Don't advance the baseline mid-composition, and don't reset the value through state.**
