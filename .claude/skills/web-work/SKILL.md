---
name: web-work
description: waterplane phone client, a repo's waiting work and the sheets that act on it (packages/web/src): Backlog.tsx + backlogFilter.ts, BuildSheet.tsx + buildPrompt.ts, clockDirectory.tsx + clockCuts.ts, ActivitySheet.tsx + activityRows.ts, SetupSheet.tsx + setupRemedy.ts, AssessSheet.tsx + assessRows.ts + assessPicks.ts, GitView.tsx. Load BEFORE touching a backlog row or its filters, a schedule's clock and the drop-the-clock verbs, a build form, the repo-setup checklist, an assessment a person approves, or the commit screen — and before putting a count on any control here, because a count is a filter and nothing applies itself.
---

# web — a repo's waiting work

The sheets a person grooms, fires and reviews a repo's work from: the backlog and its cuts, builds, the clock directory, activity, repo setup, assessments and git. Router: `web`. Reasoning: [web.md](docs/notes/web.md).

- `BuildSheet.tsx` + `buildPrompt.ts` — build buttons for one repo, and **three** answers to an empty field:
  `set up` spends an agent turn on the whole repo; the EDITOR's suggest list is free
  (`build.scan` → `shared/buildscan.ts`) — a rate-limited Claude is why you are here.
  **A tap FILLS THE FIELDS and saves nothing.** The query is what you already typed, and only for a
  NEW build. **The count on the control counts the FILTERED list.** Its three empty states
  (unanswered · repo describes nothing · query matches nothing) are worded apart. One scroll region
  (`.build-body`), because a build log is unbounded.
  The third is the EDITOR's **`work it out`** (`buildPrompt.ts`, pinned): ONE agent turn on
  ONE entry, seeded with what is typed — **the brief is asked for ON THE PHONE first**, nothing
  sent until the button under it, and with nothing said the verb is a sentence not a dimmed
  button. An existing entry names its id (*edit
  that one in place*), and both prompts share ONE copy of the builds.json schema. **A parameterised build opens its form, never runs on a tap**
  (`BuildRunAsk`): nothing is picked for you (a missing value REPLACES Run with the sentence, never
  a dimmed button), a list that could not be read falls back to a typed field WITH the reason, and
  the `optionsCmd` is shown because it RAN when the form opened. Seeded from the stored defaults and
  **nothing else** — a remembered last value would make the form lie. The values ride into the queue
  row's name (`buildRunTitle`) and onto the run row.
  **What a build LEAVES BEHIND is a row here** (`ArtifactPolicyRow`, `shared/artifacts.ts`): collect
  + name, remove older, keep N, per repo, ON BY DEFAULT; **`undefined` draws NO row**; both prompts
  carry `ARTIFACT_RULES`.
- `Backlog.tsx` + `backlogFilter.ts` — **a repo's waiting work: the LIST, never a place words are
  "sent to".** Every item opens its own session when it fires — the shared `backlog · <repo>`
  conversation is retired (`shared/sessioncost.ts` is why) — so group heads read *Each in a new
  session* / *In <session title>* / *Aimed at a session that closed*. **That third group is not a
  queue**: a `{kind:"session"}` row whose session went is held on `sessionGone` for ever, nothing
  re-aims it, so it is out of `nextFireIds` and its chip reads *target closed — held* (it used to say
  *"it runs in a new one instead"*, which the host has never done). **One WHEN, one name**: the row
  verb is `when <session> is free` / `waits for <session>` with the composer's `Hourglass` — it was
  `queue here`, a fourth spelling of the composer's `When free`, needing a paragraph and a dedicated
  `open a session here` to give it a target; both are gone, the reason the verb is ABSENT stays. **It writes no prompts**: its add form was a fifth prompt
  textarea and is now `send…` into `SendSheet` (seeded to this repo, WHEN = *when it's free*); the
  leftover `waterplane.backlogDraft` is RESCUED and said, never dropped. **No phone-side batch runner**
  (`queue mode` and the `⊕` staging buttons): the intent store serializes per repo on the HOST.
  **`fire` is never gated on a session existing** — firing opens one; only the link refuses, in
  words. A row shows its own TEXT (clamped to three lines), never `label`, which `add()` fills with
  `text.slice(0, 40)`; `realLabel` tells a typed label from that truncation. Status + age chips are
  a FILTER, cross-counted (`backlogCounts`): with an age on, the status chips count only that
  window, and vice versa. `ageBucket` owns the edges and the age windows NEST (`withinAge`). Drag is
  blocked while filtered as well as while searching — `onReorder` sends the WHOLE order. The filter
  is the tap, not a setting. Ages tick (`useNow.ts`, shared with `ActivitySheet`).
  **Schedules and this list are TWO sheets with the seam drawn in both directions** — a rule is a
  clock listing every repo, an item is words waiting in ONE; the join was what was missing, not the
  separation. A row a rule wrote wears `from the schedule “x”`; a schedule card's `backlog · 1 item`
  opens that row. The link is `lastResult.childId` and therefore the LAST item per rule only —
  never matched on the label, which a child inherits. Its three sentences are `backlogFilter.ts`'s
  (`fromScheduleWords` / `scheduleRuleLabel` / `scheduleItemsLabel`), and `focusIds` is how any cut
  opens this sheet from outside.
  **The smart pick is the one feature here that APPLIES ITSELF**, so the sheet's job is that nothing
  is destroyed and every row says what happened to it; **its state has a SECOND home** (the launcher
  repo header's `Sparkles`, and *on in N repos* here — a count, so the tap opens those N) because a
  switch readable only from inside the repo it is on cannot be surveyed: the per-repo tick is drawn only when the host
  sent `smartPick` (**`undefined` ≠ `[]`** — an old daemon would ignore the message and the switch
  would flip back) and only while online; the last-look STRIP words a failure as plainly as a
  success, verbatim from `smartpickOutcomeText`, with tokens/$ off the envelope and **ABSENT when it
  carried none**; **`merged from N` is a filter** whose ids cut takes the UNHIDDEN base (the
  originals are archived — that is the point) and whose sentence's `idsLabel` is the sheet's,
  because only it knows which side was tapped, and its count NAMES its base (*3 of 12, archived
  included*); **the undo is reachable in the case it exists FOR** — the pass picks and applies in one
  breath, so whoever the notification wakes meets a row that has ALREADY RUN — so the same
  `backlog.unmerge` is `undo` while it waits and **`put them back`** once it has STARTED — running
  included, because the HOST accepts it there (it archives the row without stopping it) and a
  refusal drawn in that state withheld the capability in exactly the case the feature exists for;
  the running row's NOTE carries what the tap will not do, never a dimmed button, and it is drawn
  INSTEAD of `smartWroteWords`, never beside it. **A `running` row is never hidden by the archived
  cut** (`hiddenByArchive`, one predicate for the sheet's base, the repo counts and the composer's
  badge) — that same tap archives it mid-run. The toast says the verb the BUTTON wore. Those strings
  and the state rule are `backlogFilter.ts`'s (`smartWroteWords` / `undoWhileRunningWords` /
  `undoOfferFor` / `hiddenByArchive`), pinned; **`you placed this`** is what
  makes "the sort never moves your drag" visible. `auto off` carries a sentence (it pauses every
  deferred send in the app, not just this list) and the check/validate verdicts wear `CHECK_ICON`,
  never the `⏳ ⚠ ✓ ✗` that were glued to their labels. `IMG_RE` is `shared/smartpick.ts`'s now — one regex, global, never
  `.test()`.
  **A row's TITLE and its KIND are `shared/naming.ts`'s, and `label` (the person's) is never
  replaced by `headline` (the machine's)** — `itemHeadline` is the ONE display rule on both ends and
  `realLabel` is only its typed half; a derived title wears `Sparkles` and, expanded, says whose it
  is (`HEADLINE_BY_WORDS`, TEXT never a `title`). **Absent category = NOBODY SAID**: no chip, no
  default bucket; `categoryBucket` is that axis's `ageBucket` (one function, chip count AND cut,
  `none` its own chip), cross-counted with status and age. **No colour per kind** — a red `bug`
  beside a red `failed` reads as a failure; `CATEGORY_ICON` is the difference. `name these N`
  (`backlog.name`, DURABLE, `nameableInCut`/`nameNote`/`NAME_COST_NOTE`) is the one bulk verb here
  that is not a `ConfirmButton`; while `naming` holds a row the button is ABSENT with
  `NAME_RUNNING_NOTE` and the row wears `naming…`. Editing a suggestion SAVES IT AS YOURS (`hand`,
  never overwritten again); clearing it puts the row back in reach of a pass. The edit form's two
  hints are `headlineEditHint`'s, pinned — a promise about the host's `hand` stamp is not an inline
  literal.
- `clockDirectory.tsx` + `clockCuts.ts` — **recurrence decides the list.** A one-off aimed at ONE
  place (`isTimedWorkRow`) is a BACKLOG row wearing a clock, never a Schedules card: it is spent by
  its one run, so there is nothing to arm, pause or skip — and filing it under Schedules took it off
  the list the smart pick is fed from (measured: 9 live `at` rows, all one-off, 7 `failed`, in no
  backlog). A recurring rule, and a one-off SWEEP (no single backlog to live in), stay cards. What
  Schedules keeps is a read-only DIRECTORY, `On a clock · N`, one line per timed item with **exactly
  ONE affordance** — open it where it lives; a line with verbs would be the second home this change
  removes, which is why it is its own module. **`clockCuts()` is ONE call producing every list and
  every number on this subject** — cards, lines, the spent foot, the horizon and the two kind counts
  — and the launcher chip makes the SAME call over the same two lists as the sheet it opens, so
  `horizon.total` IS the sheet's `standingTotal` rather than a second count that has to agree. Three
  hand-rolled copies of the standing test said **13 · 8 · 2** about one set of rows (chip, chip's own
  title, sheet): `isStandingClock` is the one predicate now — has a clock, not archived, **not
  settled**, and not spent read **WITH `lastOccurrence`** (`isSpentOnce`'s `window`/`oneShot` branch
  is only that field, so dropping it means no such row can ever read as spent). `horizonBucket` stays
  the only home of the hour/day/week edges. **No cards but clocks ⇒ the directory IS the body**,
  headed *Nothing repeats*; the `Empty` stays keyed on both together.
- **`drop the clock`** (`backlogFilter.ts`: `clockWords`/`dropClockNote`/`dropClocksLabel`/
  `dropClocksToast`/`holdChipWords`) — the verb that answers "run the ones that were skipped":
  `intent.update` carrying a `trigger` of `idle`, a plain `liveSend`, taking the instant off and
  leaving the words. A one-off cannot be re-armed, and `re-fire` beside it runs it THIS SECOND in a
  session of its own (`runNow` skips the ladder) instead of putting it back where the smart pick can
  see it. Two states, two different offers, never one sentence; the receipt names the CLOCK and never
  a state (the host kicks synchronously — the row may already be `blocked` or firing).
  **`holdForHost` survives it** — and that, plus *auto and the smart pick take it from there*, are
  **TEXT on the row, never a `title`** (invisible on a phone, the `Unavailable.tsx` rule): the hold
  chip carries `· survives a dropped clock` where the verb is offered, `dropClockNote` is drawn under
  the chips AND used as the button's title, so there is one string and not two copies of a claim.
  `when` is the Send sheet, never an inline field. On the `failed` cut the bar grows `drop the clocks
  on these N` (`ConfirmButton`): **the count is the cut on screen**, the note says what it left alone
  (and says nothing about a rest when there is none), and **one tap is ONE receipt** — the wire has
  no batch `intent.update`, so `liveSendAll` sends N frames and `dropClocksToast(n)` is said once;
  the per-row loop toasted seven times and named the count never. `▶ next` skips a row whose instant
  is still ahead — it is not next, its clock is. **Its sibling for the row with NO clock is `run it
  again`** (`RUN_AGAIN_LABEL`/`runAgainRowNote`/`runAgainState`/`runAgainEligible`/`runAgainIds`/
  `runAgainLabel`/`runAgainNote`/`runAgainAimedCount`/`runAgainClosedNote`/`runAgainToast`/
  `requeuedWords`): a `failed` row is terminal, so nothing ever looks at it again
  (measured: 0 queued, 19 failed) — `intent.requeue` puts it back with its words, its place and its
  failure, and it is **the one backlog mutation that is DURABLE** (queued offline through `queueOp`
  on an `intent:<id>` lane). **`failed` is a STATE, not an event**, so the tap carries the row's own
  `finishedAt` as `failedAt` and the host refuses a row that settled AGAIN since — and **that refusal
  is TOASTED** (`op.ack`'s `ok:false`, this op alone: its tap is on a row that does not change, so
  silence read as yes). **ONE eligibility edge** (`runAgainState` → `offered`/`held-closed`/`none`,
  never restated in the component): failed, no clock (that verb is *drop the clock*), not archived,
  and **not aimed at a session that CLOSED** — nothing re-aims one, so a re-queue makes it wait for
  ever; the verb is ABSENT and `runAgainClosedNote()` says why in TEXT, never a dimmed button.
  **The promise is worded OFF THE ROW** (`targetSessionId`, the field the group heads read, never the
  optional `fresh`): *a new session of its own* is true only of a fresh row, and the bulk note takes
  `aimed` so a mixed cut is two clauses — only an all-fresh cut may say *one at a time in this repo*.
  `re-fire` beside it is the other promise: this second, not in turn. The row's TEXT and the button's
  title are ONE string, the bulk `run these N again` (`ConfirmButton`) counts the cut on screen with
  one receipt for one tap, and a revived row draws `requeuedWords` — worded apart per state,
  **`by:"run"` reads *started again*** (it was fired, not queued), `(2nd time)` **only when the host
  sent a count** (`n` is optional; absent ⇒ NO ordinal, never `requeues.length`), the old failure
  quoted only where the entry carried one.
- **A count on a control is a FILTER** (`horizonBucket`/`horizonLead`/`HORIZON_LABEL` in
  `shared/schedule.ts`, the schedules chip, `ScheduleSheet`'s `focus`). A tap on "2 within the hour"
  opens those two, never the ten for the reader to re-derive them from. **One bucketing function
  feeds both the number and the cut** — a second copy of the edge makes the badge a liar. The
  filtered view carries `.filter-bar`: what is hidden, `n of N` against the UNFILTERED list, and a
  *clear* button. **Empty states stay keyed on the unfiltered count** (a filter matching nothing must
  not claim nothing is scheduled). **The filter is the tap, not a setting** — cleared when the
  overlay closes. **The pool is two kinds and the chip's sentence says which** (`N rules · N on a
  clock in a backlog`) — one `horizonBucket` over both, so the tap opens what it counted whichever
  kind those rows are. **A spent one-off is not a schedule at all** (`isStandingSchedule`, same
  function for the chip's count and `ScheduleSheet`'s list): it cannot be re-armed, so "not armed" named a
  state with no way out. It is Activity's row, and the sheet's foot says how many and opens exactly
  those. The one sentence both surfaces say about such a row is `SPENT_ONCE_TEXT`, and *run it now*
  still WORKS on it (the host revives and fires it) — Activity used to refuse the tap the schedule
  sheet offered.
- `ActivitySheet.tsx` + `activityRows.ts` — **every posted piece of work, one row for its whole life.**
  **A row never vanishes on a state change; it changes verdict.** **It reads `Intent` DIRECTLY and
  infers no lifecycle** — five builders were five copies of one job. **Don't add a sixth — add the row
  to `intentKind`.** `disabledReason` rather than a boolean. A row is titled by its own kind's rule:
  **prose** for work/launch/sweep, **name** for a schedule/build/assess — and a machine's
  `headline` goes IN FRONT of the prose. **`intentTitle` is deliberately NOT `itemHeadline`**
  (`headline || prose || label || …`): `Intent.label` still has three MACHINE writers, so
  label-first titled rows `file · <name>`. Consequence: a label typed in the Backlog form names the
  row on the Backlog, while Activity, the chain picker and `clockDirectory` show the headline — and
  the picker SNAPSHOTS it into `after.title` for ever. The fix is to stop minting titles into
  `label`; until then this is one exception, pinned by name.
- `SetupSheet.tsx` + `setupRemedy.ts` — **`Repo readings`: ONE sheet, two
  regions, and the seam is the COMPARATOR, never time.** Against the conventions
  (`ComplianceCheck`) = a fact against a line somebody chose, so it can be on the wrong side of it:
  stripe, pass/warn/fail, counted in the badge, sometimes a `fix`. Against its own past (the
  series, drawn in `RepoHealthRegion.tsx`) = no side to be on. **TWO
  `useRemoteResource`s, two `Empty`s, two age lines, two write halves** — "the checklist could not
  be read" and "the series could not be read" are different sentences.
  The region switch is `ContextSheet.tsx`'s grammar (`.ts-filter` row, labelled `.key` chips lit
  `.key.active`, above what it changes; the repo picker above THAT). `initialRegion` picks the
  landing region.
  **`context-weight` is the proof the merge is real** — the one subject measured both ways, agreeing
  on the number and differing in CLOCK (working tree now vs last commit measured). It keeps its
  stripe (it quotes a threshold, argued with in `ContextLimits.tsx`) and gains `WeightTwin`: both
  halves' sparklines and the rank sentence. **Both figures are named by their clock and RECONCILED
  BY NOTHING** (`bothClocksWords`) — an uncommitted CLAUDE.md edit is the gap a reader wants. The
  working-tree figure is not a wire FIELD (it sits inside the check's prose), so the clause points
  at the sentence above rather than regexing a number out of it.
  Region 1 keeps its two answers: the host's idempotent `fix`, and for what a patch cannot close
  **the finding as words for that repo's agent** via `SendSheet` — `remedyPrompt` **quotes the
  check's own `detail`** (a paraphrase loses the file names) plus one line of guidance per id; the
  bulk button hands over **what the RE-RUN report still shows**; a `CHECK_REMEDY` preset wins where
  one exists. **`isSetupFinding` (`@waterplane/shared`) is the ONE spelling of the predicate** — there
  were three, and `patchFindings` omitted host scope, so "Fix all" counted the daemon's Gemini row
  beside a badge that never has. `focus: "findings"` cuts region 1 to those rows with a
  `.filter-bar` saying `n of N` against the UNFILTERED list and a *clear*; **region 2 is untouched
  and says nothing about it.**
- `RepoHealthRegion.tsx` — `Repo readings`'s region 2, split out of
  `SetupSheet.tsx` past the 900-line cap. Holds `SeriesRegion` and
  `RepoHealthMenuItem`, landing on `series`. **No stripe, no status colour,
  no fourth status, counted in nothing**, never a `ComplianceCheck`, and no
  `--warn`/`--dead` anywhere here. A series row's verb is *ask the agent
  about this…* → `seriesRemedyPrompt`: **quotes the tool's rank sentence and
  `detail` VERBATIM**, asks for an explanation and a proposal, **never a
  change**; nothing is sent by the tap. Behind-ness is in COMMITS, never
  days. **A refusal prints as the TOOL'S OWN paragraph** (200, `ok: false`):
  it ends in a command that DELETES the series and nothing here runs it.
  Every sentence here is `repoHealthWords.ts`'s, and the charts are
  `web-numbers`'. `RepoHealthSheet.tsx` is DELETED, merged into
  `Repo readings`, drawn from here now.
- `AssessSheet.tsx` + `assessRows.ts` + `assessPicks.ts` — the assessment as a diff a person approves. **Nothing applies
  itself.** Words IN FULL, **never clipped**; a merge is ONE decision about all N; confirms on the
  BULK buttons. **A RUNNING run says what it is doing** (`assessWatch`; quiet is an AGE never
  "stuck"). **`accept` names its EFFECT** (`assessAcceptWords`, per verdict AND store), TEXT never a
  title. **A verb that does nothing is not drawn** — `unclear`, pad notes and merge members get a
  `CantInline` sentence, never a greyed accept; ticks read FUTURE tense: only Apply acts.
  **A `wanted` PAD NOTE is OFFERED, not just judged** — `cleanAssessment` copies the note's own text
  into `proposal.news` with `AssessNew.fromNote` (verbatim by CONSTRUCTION, not by asking the CLI),
  APPENDED after every CLI-written item so `choices.news` indices keep their meaning, ticked through
  the same `pickedNews`. The row's refusal then POINTS at the offer (`ASSESS_NOTE_OFFERED`) instead
  of closing. **It must not look like a new item**: `NotebookPen` + *from your pad*, `NOTE_ITEM_WORDS`
  (*file it* / *will be filed*), `assessNoteItemNote`, `.asr-offer` — a person has to tell their own
  words from the run's. **The note comes off the pad on the RECEIPT, never the tap** — and only on
  PROOF: `assessBusy` is a **ref-authoritative** `Map<ackId, noteIds>`, `!ok` moves nothing, and
  `ok` clears exactly `ticked ∩ msg.filed` (`assessFiledSplit`/`assessFiledWords`, one sentence per
  outcome). `ok` is NOT proof a row posted — the host's loop carries on past a refusal and still
  counts it — `[]` is the claim *nothing landed*, and `filed` ABSENT clears NOTHING and says the
  notes were left on the pad, never worded as a failure. A socket dying in the gap leaves the row AND the note
  — two visible copies, one tap to clear. Never a loss, never a silent one.
  **A `still wanted` verdict on a FAILED row PUTS IT BACK IN THE QUEUE** (`AssessDisplayRow.failed`
  off `AssessItem.state`, the host's own field): `assessRowPosition` replaces the inline *position N
  in the order* literal, which on a terminal row named a place in a queue it is not in; the verb
  becomes `put it back`; `assessApplySummary.requeue` is a fourth count DISJOINT from `keep` and
  `assessApplyLabel` says *put N back in the queue* in full; `assessApplyNote(requeue)` drops the
  flat *nothing is built or sent* it can no longer keep; and the bulk `keep all N` is the one place
  this sheet ADDS a confirm, naming both numbers (*Keep N — put K back?*). **WHERE a put-back row
  runs is `requeueWhereWords(one)`, ONE clause for the four strings that said it** (accept title,
  `assessBulkLines`, bulk-keep title, `assessApplyNote`): *each in a session of its own* is false for
  a row aimed at a session, `AssessItem` does not carry the target, so it names both outcomes and
  lets the row decide rather than asserting the wrong one.
  **The run's TITLES are a proposal like everything else** — the head draws the kind chip and the
  title (`Sparkles` only when it is the run's, `assessRowHead`), and ONE switch BESIDE pin-ranks —
  side by side, LAST IN THE SCROLL, never a band in the fixed footer (ONE measurement, 320×780 at
  `--ui-font` 1: the list keeps 399 px, the pair is 314 px; at 400×850, 520/250) — decides whether
  any of it is written (`assessNameQuestion`/`ASSESS_NAME_WRITE`/
  `ASSESS_NAME_SKIP`/`assessNameNote`, default WRITE, kept in `assessPicks.ts`). A posted row's name
  rides with its prompt regardless — it has no words of anybody's to sit on.
  `AssessApplySummary.name` counts EXISTING rows only, un-gated by the switch and by the ticks.
  **The scroll is where a question can be MISSED, so the footer restates BOTH answers**: with
  `rankedN > 0` `assessApplyLabel` says `· order pinned`/`· order free` (unconditional on the
  answer), and with the naming switch on, `· title N`. **The guide grows ONE line**, never a
  paragraph — the head must not grow.
  **`read the plan` OPENS `.waterplane/plan.md` in the viewer**, never the composer (`backlog.ts` retired
  the one-session-per-plan shape; `news` is the route to work, no parser), **carrying
  `run.planMtime`**: one path rewritten per run, un-versioned, is A's plan under B's verdicts;
  absent stays absent. **A file the words name is DRAWN** (`AttachStrip compact`). Ticks survive a
  side trip (`assessPicks.ts`).
  **A COLUMN BASIS IN PIXELS IS A CLAIM ABOUT HOW WIDE WORDS ARE** — `.asr-asks > .asr-pin` is
  `flex: 1 1 18ch` and `.asr-answer > .key` is `flex: 1 1 12ch; min-width: 0; white-space: normal`,
  never the annotator's `.annot-tools tri` (`overflow: visible` over `flex: 0 0 auto` `.key`s, and a
  36 px floor): a fixed `118px` column at a larger `--ui-font` painted `the smart pick may re-sort
  it` over the question beside it and `leave the rows as they are` 347 px off the screen. `ch`
  scales with the text, so the pair drops to ONE column where two would be narrower than the words,
  with no media query — the threshold is the comfort, the no-overflow/no-overlap is `min-width: 0`
  plus wrapping and holds past the 1.45 ceiling. **`18ch` is measured in `.form-hint`'s 13px sans,
  NOT the `.key`'s 14px mono the overflowing words are in** — say what a basis is measured in or it
  reads as a promise; and cite the SELECTOR of the 36px exception, never a line number.
  **1.45 IS NOT THE CEILING** — Android multiplies px text by the SYSTEM font scale on top of
  `--ui-font`, so ~1.9 is reachable: `.act-bulk .key`, **and `.assess-sheet`'s `.act-acts` /
  `.section-head` / `.sheet-head` `.key`s**, are `flex: 0 1 auto; min-width: 0; max-width: 100%;
  white-space: normal` with the icon `flex: none` — `approve the merge` and the step-log toggle were
  each wider than a 320px screen in an `overflow: visible` strip.
  **AFTER an apply the sheet has a ROUTE** — `open the backlog — N waiting in <repo>`
  (`assessOpenBacklogLabel`), a count that IS the filter (`assessReadyCut` → ids → `openBacklogCut`,
  bar labelled `assessCutLabel`). **The cut is EVERY non-archived `queued`/`blocked` row in the
  repo** — that IS the groomed backlog. It was this run's share (`origin`/`wanted`) and said *4
  waiting in usmc* over a repo with 7 waiting, because an `unclear` row is queued and excluded by
  construction; the fix was the cut, never the wording. LIVE `backlogItems`, never the ticks
  (`dropPicks` runs ON apply) and never `intents` (builds/launches/schedules are not backlog rows);
  gated on `run.applied` IN the pure module; a ZERO count is dropped and its sentence is about the
  REPO. **A route never clears `assessRepo`** — the cut is pushed OVER the sheet's history entry, so
  nulling it made Back paint the launcher under `overlay === "assess"` and the next Back do nothing.
  The cut it lands in says whether anything will run it — `focusRunWords(breakdown, auto, smartOn)`,
  fed a `FocusRunBreakdown` built off `nextFireIds`' own predicates, **never a count**: an ids base
  holds ARCHIVED rows on purpose, so `merged from 3` was told "3" and claimed all four clauses. It
  returns **`null` when nothing in the cut starts**; *a session of its own* only for FRESH rows,
  *in <session>* for aimed; *one at a time in this repo* only with `aimed === 0` (one per GROUP
  fires); *in the order you see* only with the smart pick OFF; what is not starting is COUNTED, not
  diagnosed. **ONE COPY of "auto is off"** — the head banner is drawn exactly when that sentence is
  not (keyed on the sentence, not on `filter.ids`), and the switch's title is `FOCUS_AUTO_ON_TITLE`.
- `GitView.tsx` — review, stage, commit, push. Its **`message` button asks the DESKTOP to draft the
  commit message** (host `commitmsg.ts`, one cheap toolless call over the diff `Commit all` would
  record): an EMPTY box takes the answer straight away, a box with words in it gets the draft
  offered ABOVE it with *Use this one* / *Keep mine* — seeding over a draft is a delete and this
  box is the last copy of those words. `writing…` is a LABEL, never a disabled attribute, and every
  refusal is the host's own sentence in the note line, never an empty box.
