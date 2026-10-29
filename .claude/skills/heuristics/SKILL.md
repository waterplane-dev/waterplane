---
name: heuristics
description: waterplane's regex heuristics over the claude TUI — everything read off the rendered screen: choice boxes (prompt.ts, askbox.ts, planbox.ts), the question with no box (question.ts), sign-in and shell links, usage-limit and spend walls with the resume queue (limit.ts, limitlog.ts, limitretry.ts, spendwall.ts), the context meter (context.ts), permmode.ts, keyhints.ts, turn boundaries (Stop hook, /compact), claudeversion.ts and the health record (clihealth.ts). Load BEFORE editing any of those or anything else that reads the rendered screen, changing how a box is detected, merged or answered, or what counts as a turn ending. These degrade to null, never to a wrong number.
---

# waterplane heuristics over the TUI

Every reader here is a regex over `claude`'s rendered output: fragile to upstream changes, pinned by
e2e and fixtures, and **null or absent when unsure — never a wrong value.** Turn-state code lives in
`packages/host/src/sessions/` (`turn.ts`, `wall.ts`, `resume.ts`, `drive.ts`, `boxes.ts`, `links.ts`);
the knobs (`STOP_VERIFY_MS`, `IDLE_PING_MS`, `LIMIT_SWEEP_MS`, `SERVING_TURN_MS` from env
`LIMIT_SERVING_MS`, `PROMPT_SETTLE_MS`) are in `sessions/knobs.ts`. `sessions.ts` is a facade.
Narrative and incidents: [protocol-and-security.md](../../../docs/notes/protocol-and-security.md#moved-out-of-skill-heuristics-2026-10-17).

- **Turn boundaries prefer hooks over silence.** `hooked` ⇒ `Stop` drives backlog readiness and
  completion, turn-finished push, the plugins' `question` event. Only unhooked sessions fall back to
  "no output for `WATERPLANE_IDLE_MS`" (and `WATERPLANE_IDLE_PING_MS` for the push), which can fire on a
  mid-task pause — which is why auto-fire is opt-in and every item is manually advanceable.
- **A `Stop` hook is the CLI ASKING to end the turn, not the answer — a hook may say no** (a
  keep-going loop: `/goal`, a checklist driver; the continuation fires NO `UserPromptSubmit`). So the
  Stop is HELD against the screen before it is believed (`sessions/turn.ts`:
  `armTurnWatch`/`checkTurnWatch`/`settleStop`, `STOP_VERIFY_MS` 1.2 s): the CLI's working line
  (`shared/working.ts` — ONE matcher, shared with the phone's reader) printed AFTER the Stop is the
  one thing that may contradict it. Each pass scans only the bytes since the last (`seq` delta, no
  render), the hold is **re-earned every pass** so a continuation that ends without a second Stop
  cannot strand the session busy, and `settleStop` is the one idempotent end-of-turn path (flag,
  `stopCount`, capture seal, ping, `turnEnded`). **Records no health observation** — the hook was
  answered, not broken. `e2e-stophook.mjs`.
- **`/compact` announces NOTHING** (no `UserPromptSubmit`, no `Stop`) while grinding for minutes, and
  the same watch covers any work that announces nothing: armed on OUTPUT for a hooked session with no
  turn believed, a working line publishes one (`setTurn(…, {fromScreen:true})`), retired when the
  line stops and retired QUIETLY — no `stopCount`, no push, no `turnEnded`. **Delivery's submit proof
  (`deliver/deliverreturn.ts`) reads `turnFromHook()`, never this**: a host-inferred spinner is
  evidence the CLI is busy, never evidence about a Return (`e2e-submit.mjs`'s `deaf` case).
  **EXCEPT for the one command provable no other way**: `shared/slash.ts`'s `worksUnannounced` (a
  set of ONE — `/compact` — held apart from `isLocalCommand` and `startsNoTurn`) admits
  `turnFromScreen()` as the BOTTOM rung, **guarded by a snapshot taken BEFORE the keystroke** so a
  session already spinning proves nothing; 3 s per press, two presses; audit row `submit:
  "screen-turn"` (weaker, kept apart). Widening that set hands a command the weakest proof in the
  file. **Read the RENDERED GRID, never raw bytes** (`screenlog.ts`'s `gridText()`): the byte delta
  is only the cheap gate, because repaints splice cursor moves and charset escapes through the text.
  `shared/working.ts` also reads the PROGRESS ROW (block glyphs + a percentage, below the phrase) —
  the parenthetical arrives half a minute in. The Esc-sweep interlock keeps reading plain `turnActive`.
  `scripts/e2e-stophook.mjs` (`STUB_MODE=goal`), `scripts/e2e-submit.mjs` case 7.
- **Hold-until-idle uses `laneBusy()`, not `turnActive`**: parked on a question, `awaitingInput`, or
  blocked on a limit are all quiet-but-unable-to-run. Same facts as `sessions/drive.ts`'s
  `autoFireBlocker` and `intentVerdict`'s rung 5 — one ladder, home in the `shared` skill (`sessionWall`).
  An ENDED session is not busy. The client keeps `holdUntilIdle` for the one job the host cannot do:
  a CHAIN queued behind a `session.create`, where prompt 2 must not be typed while prompt 1's turn
  runs or the TUI concatenates them. "Wait until this repo is free" as DEFERRED work is
  `trigger:{kind:"idle"}`.
- `prompt.ts` — two-stage choice-box detector: a lenient scan of a byte window produces a candidate,
  re-detected STRICTLY against `screenText()`. Unparsable dialog ⇒ `awaitingInput`. **Both stages
  must survive a half-read screen.** **A box is PUBLISHED only once two consecutive strict reads agree**
  (`sessions/boxread.ts`'s `readTwice`, `PROMPT_SETTLE_MS`): tmux paints in chunks, and a read between two is a
  label cut mid-word that `mergeBox` would keep for ever (`e2e-promptlive.mjs`). **A box that has scrolled UP is a box that was ANSWERED** —
  retired the moment the CLI draws its COMPOSER under it (`isComposerRow`), never on a row count.
  **Output never retires a prompt — only the strict verifier clears it.** A box may be TALLER than
  the terminal, so the strict pass does not anchor on index 1. A checkbox box is SUBMITTED on its own
  row (`navToSubmit` measures the gap in SELECTABLE ROWS) — **and that row says `Submit` OR `Next`**
  (`Next` on every question of a multi-question ask but the last, where Return moves on rather than
  answering), so the word DRAWN travels to the phone's button and its marker slot is the cursor glyph
  only. **ONE BOX STAYS ONE BOX while the TUI repaints under it** (`sameBox`/`mergeBox`): the strict
  pass reads what is legible NOW, and re-publishing re-keys `promptFingerprint` — which re-opens a
  card somebody hid, stales a queued answer and fires a push. Identity is `askId` where the CLI gives
  one (the pending call + question index — the one handle a repaint cannot move), else structural AND
  the question strictly, because a wrong question over live buttons is the mistake this must not
  make. **An id is never enough on its own** — the shared option rows must agree too, and at least
  one agreement must be a row of the box's OWN (`Other`/`Chat about this` are drawn under every
  question). `kind` is DERIVED, so it is tested AFTER the id. The merge only ADDS, and **a published
  label is never rewritten** (labels are the fingerprint). `samePrompt`, never `JSON.stringify` —
  key order is not a change.
- **claude's own box with no numbers**: 2.1.293's first-launch trust box draws `❯ No, exit` /
  `  Yes, I trust this folder`, unnumbered. `prompt.ts`'s `readNavBox` reads it by SHAPE, strict
  pass only: the footer row is the screen's LAST non-blank row, a one-column run of 2..8 rows
  directly above it with exactly one `❯`, nothing numbered — published `nav: true`, kind derived as
  ever (`trust`). The cursor stays OUT of the box (identity). A tap walks Up/Down with a re-read per
  key (`sessions/boxes.ts`'s `chooseClaudeNavBox`), refuses if the label at that index changed, never types a
  digit. `packages/host/test/trustbox.test.mjs`, `e2e-trustbox.mjs`.
- **A TUI with no numbers** (opencode's) is read by a SCREEN READER its extension contributes by
  name (`api.screenReader`, `PluginScreenReader`): `sessions/boxread.ts`'s `checkNavBox` keeps the
  shape — cheap gate, render, miss budget, resize grace — and `choosePromptBox` walks one arrow per
  pass, RE-READS, and **REFUSES rather than pressing a bare Return**; the reader only answers
  `candidate`/`read`/`prompt`/`stillUp`/`navTo`, and a throw reads as no box. opencode's
  (`ocprompt.mts`): the opencode extension's README (`packages/extensions/opencode/`, private, not in
  the public tree).
- `question.ts` — **a box is not the only question**: `prompt.ts` answers "is the CLI blocked on a
  dialog", this answers "did the TURN END ON A QUESTION TO YOU" — the question with NO BOX, the
  commonest way work stops here. Nothing is blocked in the CLI, so `prompt`/`awaitingInput` are
  empty and the session reads `done`. `sessions/turn.ts`'s `checkAsking()` runs it on the turn-end
  transition and publishes `SessionInfo.asking`. A parsed `prompt` outranks it, a limit block is a
  clock not a question, and any keystroke or a turn STARTING retires it. The `at` stamp survives
  re-idles (idle re-enters per repaint; a restarted clock reads "asked 0s ago" for ever). **It is a
  signal, never an interlock; it blocks nothing**: `sessionWall`/`laneBusy` are untouched, because
  typing into that session is the correct move. `packages/host/test/question.test.mjs`,
  `e2e-askprose.mjs`.
- `askbox.ts` — the question as the CLI wrote it: `AskUserQuestion` is a TOOL CALL — in the jsonl,
  or, since 2.1.304 writes it there only once ANSWERED, in the `PreToolUse` hook matched to that one
  tool (`claude.ts`; `Session.askHook`, `asksFromCall`, refused once the log shows its result). Late
  enrichment is ADDED by `mergeBox` (`desc` onto a published row). Only a PENDING call counts, newest wins, **matching is by
  LABEL, never index**, two labels must agree AND be a majority. Those fields are **outside
  `promptFingerprint`** so late enrichment cannot invalidate a queued answer. `recoverHead` puts
  back the options a TALL box scrolled off its own top — exact, because the log's option *i* IS the
  TUI's row *i*, but only where a shared index PROVES the alignment, and it only ever ADDS
  (rewriting a scraped label would make a queued answer stale). `AskQuestion.id` is
  `<toolUseId>#<n>`, what `prompt.ts`'s `sameBox` is asked; the `#n` is load-bearing. **`pickAsk`
  requires a UNIQUE best match** — one call may carry several questions; a tie enriches nothing.
- `planbox.ts` — the plan a plan-approval box asks about. **`ExitPlanMode` is NOT in the jsonl while
  its box is up** (unlike `AskUserQuestion`), so the plan comes from the plan FILE: the newest
  `plan_mode` attachment's `planFilePath`, else `<config>/plans/<slug>.md` off the `slug` every record
  carries. Recognised by the QUESTION ("…a plan…"), never by `kind` (that question says "proceed",
  which files it as `tool`). Rides as `DetectedPrompt.plan`, outside `promptFingerprint`, capped at
  `PLAN_CAP` (48 KiB); the freshest read wins in `mergeBox` (the file can be edited mid-box). Once
  answered, the parser renders the call's `input.plan` as prose, not a folded tool row.
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
  beside `? for shortcuts`. The top rule may wear `ultracode` (composer.ts's anchor rejects that shape;
  this one must not). Ultracode: that label, else the NEWEST `Ultracode on (this session only)` /
  `Ultracode off` / refusal row; a picker's mid-row `Ultracode on` never counts. Real grids in
  `packages/host/test/fixtures/permmode/`.
- `keyhints.ts` — the shortcuts the CLI names on screen (`(shift+tab to cycle)`, a picker's `s for
  this session only`) → `SessionInfo.keyHints`, chips at the head of the phone's key row. Read ONLY
  from the footer under the newest composer frame (same ≤6 rows as `permmode.ts`, the person's
  status line included on purpose), else the last 3 rows when a picker replaced the composer —
  never the transcript. Only keys the row lacks (`shared/keyhint.ts`'s `keyHintBytes`; `ctrl+c` is
  the row's `^C`, `ctrl+g` opens an editor the phone cannot leave); a bare letter only on a row with
  another hint and only lower case; a `…` verb or one a wrap cut is dropped. Re-read on the quiet
  tick with the mode (`livemode.ts`); the phone hides a tapped one-shot chip until the list changes.
- `context.ts` — the context meter off the rendered screen: `PCT_RES` (percent phrasings: "Context
  left until auto-compact: N%", "N% context left", "Context remaining: N%"), `RATIO_RE` ("123k/200k
  tokens"). **`leftPct` is percent FREE**, never used; `usedTok`/`totalTok`
  only when an absolute figure is printed; null when no shape matches. Its health gate
  (`METER_GATE_RE`) is deliberately NOT built from the matchers it checks, so it can disagree with
  them, and requires a figure on a non-conversation row. Pinned by e2e.
- `packages/shared/src/claudeversion.ts` — `TESTED_CLAUDE_VERSION` (now `2.1.304`): the newest `claude`
  build a person last verified these heuristics against. **Bump it when you re-verify** (the owner's
  call); the doctor warns for NEWER only (no minimum is claimed), unparsable ⇒ no warning. 2.1.304
  rests on 8 harvested fixtures + the real-CLI smoke; the context meter, the limit notice and `/fork`
  are not vouched by a 2.1.304 capture ([which](../../../docs/notes/protocol-and-security.md#claudeversionts--the-build-the-heuristics-were-last-verified-against)).
- `clisuggest.ts` — the CLI's dim-text proposal for the next prompt, read off the empty composer by
  comparing the PLAIN render (holds the words) against the render with dim cells blanked (holds
  nothing); words that survive the blanking were typed, never a proposal; the generic `Try "how
  does <filepath> work?"` placeholder is refused by shape. Null on any doubt.
- `clihealth.ts` — **An observation is a miss only if the primary rule was the RIGHT RULE and failed**
  (the health record, a host singleton; the rule half is `shared/clihealth.ts`). A rule correctly
  declining to fire is a good outcome and records NOTHING — not a miss, and not a `good` either.
  **Record where the fallback is TAKEN**, never wherever a flag happens to be false; **ONE observation
  per EVENT** (gate a trailing `good` on the rescue not having fired — `deliver/deliverrun.ts`'s echo
  path); where one path covers several events, ask which this is first (a turn ALREADY running is a
  person interjecting, `DeliverOpts.interactive`, records nothing). The CLI's inline pickers draw a
  footer row and a `❯` with NO numbered options: `dialogEvidence.composer` separates them.
  **The INTERLOCK is unchanged** — a picker taking keystrokes is still a session not to type into.
  `e2e-clihealth.mjs`, `packages/host/test/deliversubmit.test.mjs`.
  [The false alarms in full](../../../docs/notes/protocol-and-security.md#what-counts-as-a-miss-in-full).
  Host side: **unset `noteHealth()` is a silent no-op**; writes and broadcasts DEBOUNCED; **notify on a
  verdict TRANSITION, never per observation**; the captured block-notice sample **must NEVER be routed
  into a PTY**.
  **Fixture harvest** (`clifixtures.ts`): a `good` may carry a `fixture` THUNK; the store keeps ONE
  redacted capture per signal per CLI version under `<state>/clifixtures/` — chrome rows verbatim,
  every other row masked, a `shape` signal as a key skeleton (`shared`'s `fixtureSample`); the echo as
  prompt+grid masked alike, the block notice ROT13'd (`FIXTURE_FORMS`). `tools/harvestfixtures.mjs --write`
  copies them in with the role its reader (`test/signalreaders.mjs`) gives; a person reviews.
  [Why](../../../docs/notes/testing-and-ops.md#harvested-screen-fixtures-clifixturests-toolsharvestfixturesmjs).
- `limit.ts` — usage-limit banner + reset parsing → auto-continue, plus the **resume queue**
  (`sessions/resume.ts`, `releaseResume`): a limit is an ACCOUNT fact, so sessions block as a group
  on one reset instant. UI is `LimitSheet.tsx`. `LimitResumeMode` = `one` / `repo` / `all`, and **in
  every mode the first resume of a wave goes alone**. `detectHeadlessLimit` reads the block out of a
  `claude -p` ENVELOPE, `limitNote` is the one sentence every headless caller says, and `limited` is
  not `error`.
- `limitretry.ts` — the retry cadence is pure (`nextLimitAttempt`, `LADDER_MS`): a DATED reset is
  trusted, weekly or not; with no dated reset the delay WIDENS instead of a flat cadence.
- **Spend walls** (`limit.ts`'s `spend`, `limitlog.ts`'s API-error rows, `spendwall.ts`): an API-key/cloud account out of credit or over a spend limit is a wall with NO ladder - one attempt at the printed instant or a configured usd calendar period's reset (`periodBounds`), else `noteGaveUp` (`sessions/wall.ts`; needs the person). Never a guessed clock. Messages are built from halves in tests too. `spendlimit.test.mjs`.
- `netlog.ts` — the CLI GAVE UP on a transient API error: the NEWEST assistant row is `<synthetic>`, `isApiErrorMessage`, `error: "server_error"` AND its text a known transient shape (errno, can't reach, connection lost/dropped/refused, no response, 5xx/529). A spend wall (`detectSpendText`) or a `quotaLimits` row is never one; an unknown shape is no retry. Feeds `sessions/apiretry.ts`'s ladder (`netRetryDelay`). `netlog.test.mjs`.
- `limitlog.ts` — the same question asked of the CLI's own log, which is DATED. **The log OUTRANKS
  the screen in both directions**; **`unknown` when there is nothing to read** — an absent log is
  never a verdict.
- **Limit recovery — five rules** (`sessions/wall.ts`'s `checkLimit`; the recovery tests are
  `e2e-limitrepaint.mjs`, `e2e-limitstuck.mjs`, `e2e-limitbusy.mjs`):
  1. Verified on idle: only banner text at/after the last `continue` echo counts, asked of the
     RENDERED GRID (rows below the echo row) and still after the block has CLEARED (`attempts > 0`),
     because tmux repaints the old banner above the echo on every resize and re-attach.
  2. **A block clears only after an attempt or a TURN STARTING** (`turnStartedAt`) — never on the
     banner merely scrolling out of the scan window, and never on "real user input" (an Esc, an arrow
     or a digit runs no turn).
  3. Blocked sessions are silent, so the `LIMIT_SWEEP_MS` server-side sweep re-scans them with no
     client attached — **and must not skip a blocked session for being mid-turn**; a turn STARTING on a
     session believed blocked asks directly too (`setTurn`).
  4. **A turn IN FLIGHT outranks a banner still on screen** (`servingNow` in `sessions/wall.ts`,
     `SERVING_TURN_MS`): not "a turn started at some point" (`blockedSince` is stamped on the `!was`
     edge ONLY, so a failed auto-continue leaves `turnStartedAt > blockedSince` true), but DURATION —
     a rejected turn dies in seconds. A resume in flight is excluded outright (`releaseResume`'s
     verdict).
  5. `e2e-limitbusy.mjs` pins rule 4 with the banner deliberately left ON SCREEN: scrolling it off
     passes for the easy reason.
  The one at-limit colour is `--limit` (web-chrome's `styles.css`).
