---
name: heuristics
description: waterplane's regex heuristics over the claude TUI — everything read off the rendered screen: the choice-box detector prompt.ts (and the contributed screen readers it hosts), the question as the CLI itself wrote it (askbox.ts), the question with no box (question.ts), the sign-in link (login.ts), a shell's links and one-time codes (shelllinks.ts), usage-limit banners, resets and the resume queue (limit.ts, limitlog.ts), the context meter (context.ts), the permission-mode footer and ultracode (permmode.ts), turn boundaries with the Stop hook and /compact, and the health record that tracks when they miss (clihealth.ts). Load BEFORE editing any of those or anything else that reads the rendered screen, before changing how a box is detected, merged or answered, and before changing what counts as a turn ending. These degrade to null, never to a wrong number — keep it that way.
---

# waterplane heuristics over the TUI


- **Turn boundaries prefer hooks over silence.** `hooked` ⇒ `Stop` drives backlog readiness and
  completion, turn-finished push, the plugins' `question` event. Only unhooked sessions fall back to
  "no output for `WATERPLANE_IDLE_MS`" (and `WATERPLANE_IDLE_PING_MS` for the push), which can fire on a
  mid-task pause — which is why auto-fire is opt-in and every item is manually advanceable.
- **A `Stop` hook is the CLI ASKING to end the turn, not the answer — and a hook may answer no.** A
  hook that blocks (`decision: block` — every keep-going loop: a `/goal` hook, a checklist driver)
  sends the reason back in and the CLI carries straight on with **no `UserPromptSubmit`**: the
  continuation is a meta message in the conversation, invisible on the wire. So a live turn
  published `turnActive: false`, the reader said "idle — nothing running" over
  "✻ Crafting… (9m 35s)", and the queue typed into it. The exact signal is therefore held against
  the screen before it is believed (`sessions.ts`:
  `armTurnWatch`/`checkTurnWatch`/`settleStop`, `WATERPLANE_STOP_VERIFY_MS`, 1.2 s): the CLI's own
  working line (`shared/working.ts` — ONE matcher, the matcher the phone's reader shares) printed
  AFTER the Stop is the one thing that may contradict it. Each pass scans only the bytes printed
  since the last one (`seq` delta, no render), the hold is **re-earned every pass** so a
  continuation that ends without a second Stop cannot strand the session busy, and everything else
  settles immediately. `settleStop` is the one end-of-turn path (flag, `stopCount`, capture seal,
  ping, `turnEnded`), idempotent. **Records no health observation** — the hook was answered, not
  broken. `e2e-stophook.mjs`.
- **…and `/compact` announces NOTHING** — no `UserPromptSubmit`, no `Stop` — while grinding for
  minutes ("Compacting conversation… (35s)"). **The same watch covers work that announces nothing
  at all**, armed on OUTPUT for a hooked session with no turn believed: a working line with no turn
  believed publishes one (`setTurn(…, {fromScreen:true})`), retired when the line stops and retired
  QUIETLY — no `stopCount`, no push, no `turnEnded`, because nothing finished a turn.
  **`deliver.ts`'s submit proof reads `turnFromHook()`, never this**: a
  spinner the host inferred is evidence the CLI is busy, never evidence about a Return
  (`e2e-submit.mjs`'s `deaf` case is the pin) — **EXCEPT for the one command that can be proved no
  other way.** `/compact` fires no hook, and the log is silent about slash commands, so the ladder
  filed a compaction at 15% as *"typed, but Return was swallowed"*, the one sentence written to be
  acted on by hand. `shared/slash.ts`'s **`worksUnannounced`** (a set of ONE, held apart from
  `isLocalCommand` — the phone's *is this a modal?* — and `startsNoTurn` — *is there a turn to wait
  for?*) admits `turnFromScreen()` as the bottom rung, **guarded by a snapshot taken BEFORE the
  keystroke** so a session already spinning proves nothing; 3 s per press and two presses, because
  the screen proof lands a window after the paint starts; audit row `submit: "screen-turn"`, kept
  apart because it is weaker. Widening that set hands a command the weakest proof in the file.
  **And the watch reads the RENDERED GRID, never the raw bytes** (`screenlog.ts`'s `gridText()` —
  the live VT the recorder already feeds, a buffer read and not a replay): the byte delta is only
  the cheap GATE, because a repaint interleaves cursor moves and charset escapes and the compaction
  line arrives as `C\x1b(Bo\x1b(Bm\x1b(Bp…` spliced through the previous frame — on screen for two
  minutes, matching nothing. **`shared/working.ts` also reads the PROGRESS ROW as the measurement**
  (block glyphs + a percentage + nothing else, on the row below the phrase): the parenthetical
  arrives half a minute in, and the first seconds are the whole delivery window. A stub cannot
  surface either — both were measured against the binary. The Esc-sweep interlock keeps reading
  plain `turnActive` — an Esc into a compaction interrupts it. `scripts/e2e-stophook.mjs`
  (`STUB_MODE=goal`, which now paints the scattered bytes and ignores a Return at an empty
  composer), `scripts/e2e-submit.mjs` case 7.
- **Hold-until-idle uses `laneBusy()`, not `turnActive`**: parked on a question, `awaitingInput`, or
  blocked on a limit are all quiet-but-unable-to-run. Same three facts as
  `sessions.autoFireBlocker`, deliberately — "queue for this session" and "hold until idle" are one
  intent, and `intentVerdict`'s rung 5 is the same ladder again. An ENDED session is not busy.
  The client keeps `holdUntilIdle` for the one job the host cannot do: a CHAIN queued behind a
  `session.create`, where prompt 2 must not be typed while prompt 1's turn is running or the TUI
  concatenates them. "Wait until this repo is free" as DEFERRED work is `trigger:{kind:"idle"}`.
- `prompt.ts` — two-stage choice-box detector: a lenient scan of a byte window produces a candidate,
  re-detected STRICTLY against `screenText()`. Unparsable dialog ⇒ `awaitingInput`. **Both stages
  must survive a half-read screen.** **A box is PUBLISHED only once two consecutive strict reads agree**
  (`boxes.ts`'s `readTwice`, `PROMPT_SETTLE_MS`): tmux paints in chunks, and a read between two is a
  label cut mid-word that `mergeBox` would keep for ever (`e2e-promptlive.mjs`). **A box that has scrolled UP is a box that was ANSWERED** —
  retired the moment the CLI draws its COMPOSER under it (`isComposerRow`), never on a row count.
  **Output never retires a prompt — only the strict verifier clears it.** A box may be TALLER than
  the terminal, so the strict pass does not anchor on index 1. A checkbox box is SUBMITTED on its own
  row (`navToSubmit` measures the gap in SELECTABLE ROWS) — **and that row says `Submit` OR `Next`**
  (measured on the binary: `Next` on every question of a multi-question ask but the last, where
  Return moves on rather than answering), so the word DRAWN travels to the phone's button and its
  marker slot is the cursor glyph only. **ONE BOX STAYS ONE BOX while the TUI repaints under it**
  (`sameBox`/`mergeBox`): the strict pass reads what is legible NOW, and re-publishing re-keys
  `promptFingerprint` — which re-opens a card somebody hid, stales a queued answer and fires a push.
  Identity is `askId` where the CLI gives one (the pending call + question index — the one handle a
  repaint cannot move), else structural AND the question strictly, because a wrong question over
  live buttons is the mistake this must not make. **An id is never enough on its own** — the shared
  option rows must agree too, and at least one agreement must be a row of the box's OWN
  (`Other`/`Chat about this` are drawn under every question). `kind` is DERIVED, so it is tested
  AFTER the id. The merge only ADDS, and **a published label is never rewritten** (labels are the
  fingerprint). `samePrompt`, never `JSON.stringify` — key order is not a change.
- **claude's own box with no numbers**: 2.1.293's first-launch trust box draws `❯ No, exit` /
  `  Yes, I trust this folder`, unnumbered. `prompt.ts`'s `readNavBox` reads it by SHAPE, strict
  pass only: the footer row is the screen's LAST non-blank row, a one-column run of 2..8 rows
  directly above it with exactly one `❯`, nothing numbered — published `nav: true`, kind derived as
  ever (`trust`). The cursor stays OUT of the box (identity). A tap walks Up/Down with a re-read per
  key (`boxes.ts`'s `chooseClaudeNavBox`), refuses if the label at that index changed, never types a
  digit. `packages/host/test/trustbox.test.mjs`, `e2e-trustbox.mjs`.
- **A TUI with no numbers** (opencode's) is read by a SCREEN READER its extension contributes by
  name (`api.screenReader`, `PluginScreenReader`): `sessions/boxes.ts`'s `checkNavBox` keeps the
  shape — cheap gate, render, miss budget, resize grace — and `choosePromptBox` walks one arrow per
  pass, RE-READS, and **REFUSES rather than pressing a bare Return**; the reader only answers
  `candidate`/`read`/`prompt`/`stillUp`/`navTo`, and a throw reads as no box. opencode's
  (`ocprompt.mts`): the opencode extension's README (`packages/extensions/opencode/`, private, not in
  the public tree).
- **A box is not the only question.** `prompt.ts` answers "is the CLI blocked on a dialog";
  `question.ts` answers "did the TURN END ON A QUESTION TO YOU" — the question with NO BOX, the
  commonest way work stops here, and the one that published nothing for the longest. The agent ends
  on "Want 2 implemented, or leave it at 1?" and returns to its composer: nothing is blocked in the
  CLI, so `prompt`/`awaitingInput` are empty, the session reads `done`, the push says "Turn
  finished", and a decision sat unasked. The heuristic existed; it lived inside
  the retired in-core oracle gating a Gemini call, so the detection was conditional on `GEMINI_API_KEY` and with
  no key the tail was never read. Now `sessions.checkAsking()` runs it on the turn-end transition
  and publishes `SessionInfo.asking`. A parsed `prompt` outranks it, a limit block is a clock not a
  question, and any keystroke or a turn STARTING retires it (so a reply typed at the desk clears
  the phone's badge too). The `at` stamp survives re-idles — idle re-enters per repaint, and a
  restarted clock reads "asked 0s ago" for ever. **It is a signal, never an interlock; it blocks
  nothing**: `sessionWall`/`laneBusy` are untouched, because typing into that session is the correct
  move and prose is not a box a queued prompt can fall into.
  `packages/host/test/question.test.mjs`, `e2e-askprose.mjs`.
- `askbox.ts` — the question as the CLI wrote it: `AskUserQuestion` is a TOOL CALL, so its full text
  is in the jsonl before anyone answers. Only a PENDING call counts, newest wins, **matching is by
  LABEL, never index**, two labels must agree AND be a majority. Those fields are **outside
  `promptFingerprint`** so late enrichment cannot invalidate a queued answer. `recoverHead` puts
  back the options a TALL box scrolled off its own top — exact, because the log's option *i* IS the
  TUI's row *i*, but only where a shared index PROVES the alignment, and it only ever ADDS
  (rewriting a scraped label would make a queued answer stale). `AskQuestion.id` is
  `<toolUseId>#<n>`, what `prompt.ts`'s `sameBox` is asked; the `#n` is load-bearing. **`pickAsk`
  requires a UNIQUE best match** — one call may carry several questions, and two sharing "Yes"/"No"
  gave question 1's id, descriptions and head to a screen showing question 2; a tie enriches nothing.
- `planbox.ts` — the plan a plan-approval box asks about. **`ExitPlanMode` is NOT in the jsonl while
  its box is up** (unlike `AskUserQuestion`), so the plan comes from the plan FILE: the newest
  `plan_mode` attachment's `planFilePath`, else `<config>/plans/<slug>.md` off the `slug` every record
  carries. Recognised by the QUESTION ("…a plan…"), never by `kind` (that question says "proceed",
  which files it as `tool`). Rides as `DetectedPrompt.plan`, outside `promptFingerprint`, capped at
  `PLAN_CAP`; the freshest read wins in `mergeBox` (the file can be edited mid-box). Once answered,
  the parser renders the call's `input.plan` as prose, not a folded tool row.
- `login.ts` — the sign-in link, rejoined off the RENDERED screen (`shared/urls.ts`) because at phone
  width the grid breaks a 300-char OAuth URL across six rows. Detection is on the URL's SHAPE, never
  the CLI's prose. `at` is kept across repaints — a login link expires.
- `shelllinks.ts` — a SHELL session's links and codes (`caps.turns === false` only, armed by
  `sessions/links.ts`'s `armLinksCheck` on the quiet tick). Every https URL, `http://` only for
  localhost (`local`), max 3 newest-last; **a code exists only as a property of a link** within ±6
  rows (device shapes, or a token after a code label) — never without a link, never a SHA, never
  after `$`/`pid`/`port`, never an errno (`ECONNREFUSED`), a labelled token always has a digit or
  dash, a device shape a letter. **A link joined across rows must be in the PTY's bytes as one
  string** (`provenJoin`, the tail `links.ts` passes; cursor moves count as line breaks) — git's
  `remote:` and a `$` prompt pass every geometric test; unproven ⇒ the first row only if it is
  shorter than the pane, else nothing. `awaitingCode` only when the LAST row ends on the code prompt. Patterns
  built in halves; a throw is null, never a wrong link. `packages/host/test/shelllinks.test.mjs`.
- `permmode.ts` — the permission mode off the footer under the NEWEST composer frame (rule, `❯`
  row, closing rule, ≤6 footer rows), else null — a box, a picker or a slash menu is null, never a
  mode. On 2.1.293 the default mode is LABELLED (`⏸ manual mode on`); no label is `default` only
  beside `? for shortcuts`. The top rule may wear `ultracode` (echo.ts's anchor rejects that shape;
  this one must not). Ultracode: that label, else the NEWEST `Ultracode on (this session only)` /
  `Ultracode off` / refusal row; a picker's mid-row `Ultracode on` never counts. Real grids in
  `packages/host/test/fixtures/permmode/`.
- `prompt.ts` / `limit.ts` / `context.ts` are regex heuristics over TUI output — fragile to upstream
  changes, pinned by e2e.
- **An observation is a miss only if the primary rule was the RIGHT RULE and failed** (the health
  record, `shared/clihealth.ts`). A rule correctly declining to fire is a good outcome and records
  NOTHING — not a miss, which turns a working heuristic into a permanent amber chip nobody reads any
  more, and not a `good` either, which fills the twenty-slot window with successes and makes the real
  misses arithmetically invisible. **Record where the fallback is TAKEN, never wherever a flag
  happens to be false**; **ONE observation per EVENT** — a rescue that notes its `fallback` and then
  falls through to a trailing `good` files a miss AND a success for one delivery, which is a rate
  about nothing and a `good` claiming something nobody saw (`deliver.ts`'s echo path, fixed by
  gating the `good` on the echo actually having been seen). And where one code path covers three different events, ask which event this
  is before writing the record: a hooked session with a turn ALREADY running is a person interjecting
  (`DeliverOpts.interactive` — records nothing), a pipe the host has not yet HEARD FROM is the
  primary rule answering late (ask again first), and only no pipe at all is a fallback worth a word.
  The CLI's own inline pickers are that trap from the other side: `/effort` and the slash menus draw a
  REAL footer row and a `❯` cursor with NO numbered options, so footer-plus-cursor filed a miss per
  visit to a menu that was never a question. `dialogEvidence.composer` separates them — the composer's
  STATUS LINE inside the box's span means the CLI still takes typing, and a modal box never draws it.
  Only that line counts: the `❯` INPUT row cannot, since an upstream renumber (`1)`) leaves `❯ 1) Yes`,
  which reads as a composer and is the one miss this signal exists for. **The INTERLOCK is unchanged** —
  a picker taking keystrokes is still a session not to type a prompt into.
  `e2e-clihealth.mjs`, `packages/host/test/deliversubmit.test.mjs`. The false alarms in full:
  [protocol-and-security.md](docs/notes/protocol-and-security.md#what-counts-as-a-miss-in-full).
- `limit.ts` — usage-limit banner + reset parsing → auto-continue, plus the **resume queue** in
  `sessions.ts`: a limit is an ACCOUNT fact, so sessions block as a group on one reset instant.
  UI is `LimitSheet.tsx`. `LimitResumeMode` = `one` / `repo` / `all`, and **in every mode the first
  resume of a wave goes alone**. `detectHeadlessLimit` reads the block out of a `claude -p`
  ENVELOPE, `limitNote` is the one sentence every headless caller says, and `limited` is not
  `error`.
- **Spend walls** (`limit.ts`'s `spend`, `limitlog.ts`'s API-error rows, `spendwall.ts`): an API-key/cloud account out of credit or over a spend limit is a wall with NO ladder - one attempt at the printed instant or a configured usd calendar period's reset (`periodBounds`), else `noteGaveUp` (needs the person). Never a guessed clock. Messages are built from halves in tests too. `spendlimit.test.mjs`.
- `limitlog.ts` — the same question asked of the CLI's own log, which is DATED. **The log OUTRANKS
  the screen in both directions**; **`unknown` when there is nothing to read** — an absent log is
  never a verdict.
- Limit recovery is verified on idle: only banner text at/after the last `continue` echo counts —
  asked of the RENDERED GRID (rows below the echo row), and still after the block has CLEARED
  (`attempts > 0`), because a repaint redraws the old banner above the echo and tmux repaints on
  every resize and re-attach (its 5 s start-up redraw is gone, `termqueries.ts`): read off the bytes, that redraw re-blocked a
  session that had just resumed (`e2e-limitrepaint.mjs`). And
  **a block clears only after an attempt or a TURN STARTING** (`turnStartedAt`) — never on the banner
  merely scrolling out of the scan window, and never on "real user input": an Esc, an arrow or a
  digit runs no turn and proves nothing about the account, yet one of them landing while the session
  waited in the resume queue cleared the block with attempts still 0, so no `continue` was ever typed
  and the prompt that hit the wall never ran. `e2e-limitstuck.mjs`. Blocked sessions are silent, so a
  `WATERPLANE_LIMIT_SWEEP_MS` server-side sweep re-scans them with no client attached — **and that sweep
  must not skip a blocked session for being mid-turn**, which is the mirror bug: both paths into
  `checkLimit` hung off silence (`markIdle` at `WATERPLANE_IDLE_PING_MS`, the sweep skipping anything
  newer than that), so a session that came back at the reset and worked for an hour straight, spinner
  repainting every frame, was never quiet enough to be re-asked and wore "at limit" the whole time
  while visibly running. A turn STARTING on a session believed blocked asks directly too
  (`setTurn`), that being the earliest moment the belief can be shown wrong.
- **A turn IN FLIGHT outranks a banner still on screen** (`servingNow`,
  `WATERPLANE_LIMIT_SERVING_MS`). Running `checkLimit` more often fixes nothing on its own: the screen
  branch re-marks the block while `det.blocked` holds, and when `limitlog.ts` answers `unknown` —
  no conversation id, no file, a tail with nothing parseable — there is no dated source at all, so
  the wall sits in the rendered tail for the life of the session and shadows the clearing gate for
  ever. Not "a turn started at some point": `blockedSince` is stamped on the `!was` edge ONLY, so a
  failed auto-continue leaves `turnStartedAt > blockedSince` true for the rest of a block that is
  entirely real. **DURATION is what separates them** — a rejected turn dies in seconds, the banner
  being the CLI's answer to it — and a resume in flight is excluded outright, that window belonging
  to `releaseResume`'s verdict. `e2e-limitbusy.mjs` pins both rules, with the banner deliberately
  left ON SCREEN: scrolling it off passes for the easy reason.
- **One at-limit fact, one colour** (`--limit`, web `styles.css`). The same three blocked sessions
  read as starred (`.tag.limit-auto` in the star's gold), waiting (`.tag.wait`'s red fill, for the
  manual case), broken (`.repo-group-stat.limit` in `--dead`) and blocked (`.head-wait.limit`'s
  orange) depending on which line of the launcher you looked at, plus a red `.key.danger` in the
  session toolbar beside the kill button. All five are `var(--limit)` now; only the manual one is
  filled, because it is the only one that needs a hand.

- `clihealth.ts` — the CLI integration's own health; the rule half is `@waterplane/shared`'s `clihealth.ts`.
  Module-level singleton with a free `noteHealth()`; **unset is a silent no-op**. Writes and
  broadcasts DEBOUNCED. **Notify on a verdict TRANSITION, never per observation.** The captured
  block-notice sample **must NEVER be routed into a PTY**.
