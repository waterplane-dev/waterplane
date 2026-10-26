---
name: web-work
description: waterplane phone client — a repo's waiting work and the sheets acting on it (packages/web/src): Backlog.tsx + backlogFilter.ts (code in backlog/), BuildSheet.tsx + buildPrompt.ts, ScheduleSheet.tsx + clockDirectory.tsx, ActivitySheet.tsx, SetupSheet.tsx + RepoHealthRegion.tsx (Repo readings: three regions), AssessSheet.tsx + assessRows.ts, FanoutSheet.tsx, GitView.tsx. Load BEFORE touching a backlog row or its filters, a schedule or its clock, a build form, the repo-readings sheet, an assessment a person approves, a fan-out, or the commit screen — and before putting a count on any control here: a count is a filter and nothing applies itself.
---

# web — a repo's waiting work

The sheets a person grooms, fires and reviews a repo's work from: the backlog and its cuts, builds, schedules and the clock directory, activity, repo readings, assessments, fan-out and git. Router: `web`. Reasoning, and the long form of each bullet that says so: [web.md](../../../docs/notes/web.md) (*Moved out of skill `web-work`*). Where the code lives now: [backlog-architecture.md](../../../docs/notes/backlog-architecture.md), [activity-architecture.md](../../../docs/notes/activity-architecture.md), [assess-architecture.md](../../../docs/notes/assess-architecture.md).

- `BuildSheet.tsx` + `BuildEditor.tsx` + `BuildRunAsk.tsx` + `BuildArtifacts.tsx` + `buildPrompt.ts` — build buttons for one repo, and **three** answers to an empty field:
  `set up` spends an agent turn on the whole repo; the EDITOR's suggest list is free (`build.scan` →
  shared `buildscan.ts`) — a rate-limited Claude is why you are here; the EDITOR's **`work it out`**
  (`buildPrompt.ts`, pinned) is ONE agent turn on ONE entry, **the brief is asked for ON THE PHONE
  first**, nothing sent until the button under it, and with nothing said the verb is a sentence, not
  a dimmed button. **A tap FILLS THE FIELDS and saves nothing.** The query is what you already typed,
  and only for a NEW build. **The count on the control counts the FILTERED list.** One scroll region
  (`.build-body`). An existing entry names its id (*edit that one in place*); both prompts share ONE
  copy of the builds.json schema. **A parameterised build opens its form, never runs on a tap**
  (`BuildRunAsk`): nothing is picked for you (a missing value REPLACES Run with the sentence), a list
  that could not be read falls back to a typed field WITH the reason, the `optionsCmd` is shown
  because it RAN, and the form is seeded from the stored defaults and **nothing else** (a remembered
  last value would make the form lie). The values ride into the queue row's name (`buildRunTitle`).
  **What a build LEAVES BEHIND is a row here** (`ArtifactPolicyRow`, shared `artifacts.ts`): collect +
  name, remove older, keep N, per repo, ON BY DEFAULT; **`undefined` draws NO row**; both prompts
  carry `ARTIFACT_RULES`. `BuildScopeChoice.tsx` + `buildScope.ts` pick where an entry LIVES (the
  committed file or this desktop's own; drawn only for a host that sent `localIds`).
- `Backlog.tsx` + `backlogFilter.ts` — **a repo's waiting work: the LIST, never a place words are
  "sent to".** Code: `backlog/` (`useBacklogCuts.ts` has the local `nextFireIds` Set) +
  `backlogFilter/`. Every item opens its own session when it fires — the shared `backlog · <repo>`
  conversation is retired — so group heads read *Each in a new session* / *In <session title>* /
  *Aimed at a session that closed*. **That third group is not a queue**: a `{kind:"session"}` row
  whose session went is held on `sessionGone` for ever, nothing re-aims it, so it is out of
  `nextFireIds` and its chip reads *target closed — held*. **One WHEN, one name**: the row verb is
  `when <session> is free` / `waits for <session>` with the composer's `Hourglass`; the reason the
  verb is ABSENT stays. **It writes no prompts**: `send…` opens `SendSheet` (seeded to this repo,
  WHEN = *when it's free*); a leftover `waterplane.backlogDraft` is RESCUED and said, never dropped.
  **No phone-side batch runner**: the intent store serializes per repo on the HOST. **`fire` is never
  gated on a session existing** — firing opens one; only the link refuses, in words. A row shows its
  own TEXT (three lines), never `label` (`add()` fills it with `text.slice(0, 40)`; `realLabel` tells
  typed from truncated). Status + age chips are a FILTER, cross-counted (`backlogCounts`); the age
  windows NEST (one `ageBucket`/`withinAge`). Drag works in any cut: `onReorder` sends the rows ON
  SCREEN and the host trades their OWN slots (`reorder`), so a hidden row keeps its seat — never
  renumber a subset 0..n. The filter is the tap, not a setting. Ages tick (`useNow.ts`, shared with
  `ActivitySheet`).
  **Schedules and this list are TWO sheets with the seam drawn in both directions** — a rule is a
  clock listing every repo, an item is words waiting in ONE. A row a rule wrote wears `from the
  schedule “x”`; a schedule card's `backlog · 1 item` opens that row. The link is
  `lastResult.childId`, the LAST item per rule only — never matched on the label, which a child
  inherits. The three sentences are `backlogFilter.ts`'s (`fromScheduleWords` / `scheduleRuleLabel` /
  `scheduleItemsLabel`); `focusIds` is how any cut opens this sheet from outside.
  **A `running` row is never hidden by the archived cut** (`hiddenByArchive`, one predicate for the
  base, the repo counts and the composer's badge). Nothing re-sorts rows on its own; a row a drag (or
  a pinned assessment rank) placed is marked `handOrdered` and says so. `auto off` carries a sentence
  (it pauses every deferred send in the app) and check/validate verdicts wear `CHECK_ICON`.
  **A row's TITLE and KIND are shared `naming.ts`'s, and `label` (the person's) is never replaced by
  `headline` (the machine's)** — `itemHeadline` is the ONE display rule on both ends; a derived title
  wears `Sparkles` and, expanded, says whose it is (`HEADLINE_BY_WORDS`, TEXT never a `title`).
  **Absent category = NOBODY SAID**: no chip, no default bucket; `categoryBucket` (`none` its own
  chip) is cross-counted with status and age. **No colour per kind** (`CATEGORY_ICON` is the
  difference). `name these N` (`backlog.name`, DURABLE; `nameableInCut`/`nameNote`/`NAME_COST_NOTE`)
  is the one bulk verb here that is not a `ConfirmButton`; while `naming` holds a row the button is
  ABSENT with `NAME_RUNNING_NOTE`. Editing a suggestion SAVES IT AS YOURS (`hand`, never overwritten
  again); clearing it puts the row back in reach of a pass; the edit form's hints are
  `headlineEditHint`'s, pinned.
- `ScheduleSheet.tsx` — the schedules sheet.
  Also `ScheduleWeekBar.tsx` + `scheduleWeekPlot.ts` (the week bar) and `RetimeBar.tsx`. **The chip's count** (shared `schedule/`: `schedhorizon.ts` `horizonBucket`/
  `horizonLead`/`HORIZON_LABEL`; `ScheduleSheet`'s `focus`) follows CLAUDE.md's count-is-a-filter
  rule; the filtered view is `.filter-bar`. **Empty states stay keyed on the unfiltered count.**
  **The filter is the tap, not a setting** — cleared when the overlay closes. **The pool is two kinds
  and the chip's sentence says which** (`N rules · N on a clock in a backlog`), one `horizonBucket`
  over both. **A spent one-off is not a schedule** (`isStandingSchedule`, `schedfire.ts` — same
  function for the chip and the list): it is Activity's row, the sheet's foot says how many and opens
  exactly those; its one sentence is `SPENT_ONCE_TEXT`, and *run it now* still WORKS on it (the host
  revives and fires it). `RetimeBar.tsx` re-times the TICKED rows with one new instant, one receipt,
  one component for the backlog and the directory; with nothing ticked it is a sentence, never a
  dimmed button; ticks survive a cancel (the re-time mode's *let past the budget* verb is `web-send`'s). `ScheduleWeekBar.tsx` is READ-ONLY and `scheduleWeekPlot.ts` computes no
  edge of its own (the host's `nextAt`, the one usage reading; an unread window is absent).
- `clockDirectory.tsx` + `clockCuts.ts` — **recurrence decides the list.** A one-off aimed at ONE
  place (`isTimedWorkRow`, shared `intent/kind.ts`) is a BACKLOG row wearing a clock, never a
  Schedules card (it is spent by its one run; filing it under Schedules took it off the backlog).
  A recurring rule and a one-off SWEEP stay cards. Schedules keeps a read-only DIRECTORY, `On a clock
  · N`, with **exactly ONE affordance** per line — open it where it lives. **`clockCuts()` is ONE
  call producing every list and every number on this subject**, and the launcher chip makes the SAME
  call as the sheet it opens, so `horizon.total` IS the sheet's `standingTotal`. `isStandingClock` is
  the one predicate: a clock, not archived, **not settled**, not spent read **WITH `lastOccurrence`**.
  `horizonBucket` is the only home of the hour/day/week edges. **No cards but clocks ⇒ the directory
  IS the body**, headed *Nothing repeats*; the `Empty` stays keyed on both together.
- **`drop the clock`** (`backlogFilter.ts`: `clockWords`/`dropClockNote`/`dropClocksLabel`/
  `dropClocksToast`/`holdChipWords`) — answers "run the ones that were skipped": `intent.update`
  carrying a `trigger` of `idle`, a plain `liveSend`, taking the instant off and leaving the words. A
  one-off cannot be re-armed, and `re-fire` beside it runs it THIS SECOND in a session of its own
  (`runNow` skips the ladder). Two states, two offers, never one sentence; the receipt names the
  CLOCK, never a state. **`holdForHost` survives it**; that and *auto takes it from there* are **TEXT
  on the row, never a `title`**; `dropClockNote` is drawn under the chips AND is the button's title,
  one string. `when` is the Send sheet, never an inline field. On the `failed` cut the bar grows
  `drop the clocks on these N` (`ConfirmButton`): **the count is the cut on screen**, the note says
  what it left alone, and **one tap is ONE receipt** — the wire has no batch `intent.update`, so
  `liveSendAll` sends N frames and `dropClocksToast(n)` is said once. `▶ next` skips a row whose
  instant is still ahead. **Its sibling for the row with NO clock is `run it again`** (the
  `runAgain*` family in `backlogFilter/runAgain.ts`, plus `requeuedWords`): a `failed` row is
  terminal, so `intent.requeue` puts it back with its words, place and failure, and it is **the one
  backlog mutation that is DURABLE** (`queueOp` on an `intent:<id>` lane). **`failed` is a STATE**,
  so the tap carries the row's `finishedAt` as `failedAt` and the host refuses a row that settled
  AGAIN — and **that refusal is TOASTED** (`op.ack`'s `ok:false`). **ONE eligibility edge**
  (`runAgainState` → `offered`/`held-closed`/`none`): failed, no clock, not archived, and **not aimed
  at a session that CLOSED** — then the verb is ABSENT and `runAgainClosedNote()` says why in TEXT.
  **The promise is worded OFF THE ROW** (`targetSessionId`, never the optional `fresh`): *a new
  session of its own* only for a fresh row; the bulk note takes `aimed` so a mixed cut is two
  clauses, and only an all-fresh cut may say *one at a time in this repo*. The row's TEXT and the
  button's title are ONE string; the bulk `run these N again` counts the cut on screen with one
  receipt; `requeuedWords`: **`by:"run"` reads *started again***, `(2nd time)` **only when the host
  sent a count** (absent ⇒ NO ordinal), the old failure quoted only where the entry carried one.
- `ActivitySheet.tsx` + `activityRows.ts` — **every posted piece of work, one row for its whole
  life** (code: `activity/`). **A row never vanishes on a state change; it changes verdict.** **It
  reads `Intent` DIRECTLY and infers no lifecycle** — don't add a sixth builder, add the row to
  `intentKind`. `disabledReason` rather than a boolean. A row is titled by its own kind's rule:
  **prose** for work/launch/sweep, **name** for a schedule/build/assess, a machine's `headline` IN
  FRONT of the prose. **`intentTitle` is deliberately NOT `itemHeadline`**: `Intent.label` still has
  three MACHINE writers, so label-first titled rows `file · <name>`. Consequence: a label typed in
  the Backlog form names the row on the Backlog, while Activity, the chain picker and `clockDirectory`
  show the headline (the picker SNAPSHOTS it into `after.title`). One exception, pinned by name; also
  stated in `web-send`.
- `SetupSheet.tsx` (+ `AlwaysOnRows.tsx`, the always-on list under the `context-weight` row: repo rows, this desktop's rows, unsized rows say so, doors to sessions that carried them) + `setupRemedy.ts` — **`Repo readings`: ONE sheet, THREE regions** (`ReadingsRegion`
  = `setup` · `series` · `optins`), **and the seam is the COMPARATOR, never time.** Against the
  conventions (`ComplianceCheck`) = a fact against a line somebody chose: stripe, pass/warn/fail,
  counted in the badge, sometimes a `fix`. Against its own past (the series, drawn in
  `RepoHealthRegion.tsx`) = no side to be on. **Separate `useRemoteResource`s, `Empty`s, age lines and
  write halves** — “the checklist could not be read” and “the series could not be read” are different
  sentences. The region switch is `ContextSheet.tsx`'s grammar (`.ts-filter` row, labelled `.key`
  chips, above what it changes; the repo picker above THAT); `initialRegion` picks the landing region.
  **`context-weight` is the proof the merge is real** — the one subject measured both ways, agreeing on
  the number and differing in CLOCK. It keeps its stripe and gains `WeightTwin`: **both figures are
  named by their clock and RECONCILED BY NOTHING** (`bothClocksWords`); the working-tree figure is not
  a wire FIELD, so the clause points at the sentence above rather than regexing a number out of it.
  Region 1 has two answers: the host's idempotent `fix`, and for what a patch cannot close **the
  finding as words for that repo's agent** via `SendSheet` — `remedyPrompt` **quotes the check's own
  `detail`**; the bulk button hands over **what the RE-RUN report still shows**; a `CHECK_REMEDY`
  preset wins where one exists. **`isSetupFinding` (`@waterplane/shared`) is the ONE spelling of the
  predicate.** `focus: "findings"` cuts region 1 with a `.filter-bar` saying `n of N` against the
  UNFILTERED list and a *clear*; **the other regions are untouched and say nothing about it.**
- `RepoHealthRegion.tsx` — region 2 (`series`), split out of `SetupSheet.tsx` past the 900-line cap;
  holds `SeriesRegion` and `RepoHealthMenuItem`. **Cards under a sticky jump bar** (`RepoHealthCards.tsx`):
  a chip per DRAWN card (navigation — no count, no lit state, an absent card has no chip) and the
  refresh verb at its end; one x-axis row (`weeks`/`commits`, the latter ABSENT with its sentence
  where the host sends no commit series); the daily notes ONE closed row (`RepoHealthNotes.tsx`). **The frame is
  shared with the VS Code Health view** — it imports no `api.ts`/`Markdown`, and which cards are drawn is
  `shownSections`, never a second copy. CSS in `repohealth.css`,
  scoped under `.rh-region`. **No stripe, no status colour, no fourth status,
  counted in nothing**, never a `ComplianceCheck`, and no `--warn`/`--dead` on the SERIES tiles; the
  one exception is the health INDEX section it renders first (`HealthIndexSection`, ⇒ `web-numbers`):
  alert colour + icon + words. A series row's verb is *ask the agent about this…* →
  `seriesRemedyPrompt`: **quotes the tool's rank sentence and `detail` VERBATIM**, asks for an
  explanation and a proposal, **never a change**; nothing is sent by the tap. Behind-ness is in
  COMMITS, never days. **A refusal prints as the TOOL'S OWN paragraph** (200, `ok: false`): it ends
  in a command that DELETES the series and nothing here runs it. Every sentence is
  `repoHealthWords.ts`'s, the charts are `web-numbers`'.
- `OptInRegion.tsx` + `optInSeed.ts` — region 3, **Opt-ins**: offers, not readings (the shared opt-in
  catalog, `optins.ts`, and its header are the design). **Counted in NOTHING** — no stripe, no status hue, never
  in the badge. **Every count and list is `optInCut`'s**; the folded `declined`/`unfit` heads are the
  lists they open. **A tap seeds, never sends**: `fix` is the host's `complianceFix`, `open` lands on
  `series` or the capture sheet, `agent`/`schedule` seed the Send sheet (`optInSeed`: the phone's
  zone, the catalog's model, `waitUntilFree`). The repo menu's `OptInMenuItem` lands on `optins`.
- `AssessSheet.tsx` + `assessRows.ts` + `assessPicks.ts` — the assessment as a diff a person approves
  (code: `assess/arows*.ts`, `assess/`). Words IN FULL, **never clipped**; a merge is ONE decision
  about all N; confirms on the BULK buttons. **A RUNNING run says what it is doing** (`assessWatch`;
  quiet is an AGE, never “stuck”). **`accept` names its EFFECT** (`assessAcceptWords`, per verdict AND
  store), TEXT never a title. **A verb that does nothing is not drawn** — `unclear`, pad notes and
  merge members get a `CantInline` sentence, never a greyed accept; ticks read FUTURE tense: only
  Apply acts.
  **A `wanted` PAD NOTE is OFFERED, not just judged**: `cleanAssessment` copies the note's text into
  `proposal.news` with `AssessNew.fromNote` (verbatim by CONSTRUCTION), APPENDED after every
  CLI-written item so `choices.news` indices keep their meaning. It must not look like a new item
  (`NotebookPen` + *from your pad*, `NOTE_ITEM_WORDS`, `.asr-offer`). **The note comes off the pad on
  the RECEIPT, never the tap**, and only on PROOF: `assessBusy` is a **ref-authoritative**
  `Map<ackId, noteIds>`, `!ok` moves nothing, `ok` clears exactly `ticked ∩ msg.filed`
  (`assessFiledSplit`/`assessFiledWords`). `ok` is NOT proof a row posted — `[]` is *nothing landed*,
  and `filed` ABSENT clears NOTHING and says the notes were left on the pad. A socket dying in the
  gap leaves the row AND the note (two visible copies); never a loss, never a silent one.
  **A `still wanted` verdict on a FAILED row PUTS IT BACK IN THE QUEUE** (`AssessDisplayRow.failed`
  off `AssessItem.state`): `assessRowPosition` replaces the inline *position N* literal; the verb is
  `put it back`; `assessApplySummary.requeue` is a fourth count DISJOINT from `keep`; `AssessApplySummary.name` counts EXISTING rows only, never gated by the naming switch or the ticks;
  `assessApplyNote(requeue)` drops the flat *nothing is built or sent*; the bulk `keep all N` is the
  one place this sheet ADDS a confirm, naming both numbers. **WHERE a put-back row runs is
  `requeueWhereWords(one)`**, ONE clause for the four strings that said it — `AssessItem` does not
  carry the target, so it names both outcomes.
  **The run's TITLES are a proposal like everything else**: the head draws the kind chip and title
  (`Sparkles` only when it is the run's, `assessRowHead`), and ONE switch BESIDE pin-ranks, LAST IN THE
  SCROLL (never a band in the fixed footer), decides whether any is written (`assessNameQuestion`/
  `ASSESS_NAME_WRITE`/`ASSESS_NAME_SKIP`/`assessNameNote`, default WRITE, `assessPicks.ts`). A posted
  row's name rides with its prompt regardless. **The scroll is where a question can be MISSED, so the
  footer restates BOTH answers**: `rankedN > 0` ⇒ `· order pinned`/`· order free`, naming on ⇒ `·
  title N`. **The guide grows ONE line**, never a paragraph.
  **`read the plan` OPENS `.waterplane/plan.md` in the viewer**, never the composer, **carrying
  `run.planMtime`** (one path rewritten per run is A's plan under B's verdicts); absent stays absent.
  **A file the words name is DRAWN** (`AttachStrip compact`). Ticks survive a side trip.
  **Column bases are in `ch`, never px** (a basis in px is a claim about how wide words are): `.key`s
  wrap (`min-width: 0; white-space: normal`), the pair drops to ONE column where two would be
  narrower than the words, no media query; Android multiplies text by the SYSTEM font scale on top of
  `--ui-font`, so ~1.9 is reachable. Say what a basis is measured in, and cite the SELECTOR of an
  exception, never a line number.
  **AFTER an apply the sheet has a ROUTE** — `open the backlog — N waiting in <repo>`
  (`assessOpenBacklogLabel`), a count that IS the filter (`assessReadyCut` → ids → `openBacklogCut`,
  `assessCutLabel`). **The cut is EVERY non-archived `queued`/`blocked` row in the repo**, never this
  run's share; LIVE `backlogItems`, never the ticks and never `intents`; gated on `run.applied` IN the
  pure module; a ZERO count is dropped. **A route never clears `assessRepo`** (the cut is pushed OVER
  the sheet's history entry; nulling it broke Back). The cut says whether anything will run it —
  `focusRunWords(breakdown, auto)`, fed a `FocusRunBreakdown` built off `nextFireIds`' own predicates,
  **never a count**; **`null` when nothing in the cut starts**; *a session of its own* only for FRESH
  rows, *in <session>* for aimed, *one at a time in this repo* only with `aimed === 0`; what is not
  starting is COUNTED, not diagnosed. **ONE COPY of “auto is off”** — the head banner is drawn exactly
  when that sentence is not; the switch's title is `FOCUS_AUTO_ON_TITLE`.
- `FanoutSheet.tsx` —
  (kickoff strip: `fanoutKickoff.ts`) a sweep is ONE prompt over N repos (the host's fan-out
  executor reads `steps[0]` and nothing else); a chain into several repos is refused in words (⇒ `web-send`,
  `sendIntent/sendLabels.ts`). The kickoff strip is pure: one sentence and one fraction, failures
  count as kicked off.
- `slotCheck.ts` + `slotAskStore.ts` + `SlotAskLayer.tsx` — **the slot check**: rows that fire
  together, checked together ([web.md](../../../docs/notes/web.md)). Every count is `@waterplane/shared`'s
  slot functions and **N is exactly the ids sent** (`slotChecks`, `slotAskFor` = `slotMates`). The ask
  after a timed send waits for the list to hold the row ON THE NEW CLOCK, is a card beside the toast
  (never a modal, never a toast), and *don't ask in this repo* names its way back. *check* never runs
  over a running or undecided proposal (`slotCheckStart`). A conflict is words: its verbs are the
  rows' own and it has NO choice; a split is approved behind a confirm into `AssessChoices.splits`.
- `GitView.tsx` — review, stage, commit, push. **`message` asks the DESKTOP for a draft** (host
  `commitmsg.ts`): an EMPTY box takes it, a box with words gets it offered ABOVE with *Use this one* /
  *Keep mine*. `writing…` is a LABEL, not a disabled attribute; a refusal is the host's sentence in the
  note, never an empty box. **`fix in a new session…`** on a failed push/pull (`gitFailPrompt.ts`)
  SEEDS the Send sheet, never sends (`copy`: same words, toast receipt); the push stays yours; both
  die with their note.
