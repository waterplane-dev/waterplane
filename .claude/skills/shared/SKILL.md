---
name: shared
description: waterplane @waterplane/shared (packages/shared/src): the wire DTOs and the pure logic both ends must agree on. Load BEFORE adding or changing a wire message or field, and before touching the send queue transport, the intent model and its verdict ladder, token/context/budget/cost maths, schedules, assessments, or any rule that the host and the phone must not word two different ways. Build it before type-checking host or web.
---

# waterplane shared package

  Reasoning: [host.md](docs/notes/host.md#packagesshared).
  `index.ts` is an INDEX, not the protocol: DTOs live in `wire/` (`session` `backend` `oracle`
  `telemetry` `notify` `work` `repo` `transcript`), the two unions in `wire/messages.ts`, all
  re-exported, so no import site names a file. **Add a message ⇒ `wire/messages.ts`; add a field ⇒
  the domain file.** `backend.ts` is the wire subset of a host-side `BackendDescriptor`
  (`BackendInfo`): capability booleans say whether a backend HAS a thing at all, never whether it is
  currently on, and an absent `contextWindowTokens` is unknown — never a guessed number.
  - `queue.ts` — send-queue **transport**: lanes, `holdUntilIdle`+`release`, `retargetEntry`,
    `pendingCreate` (bound on the create's own `createAck`, never on the lane — `create:<cwd>` is per
    REPO), `answerInsertAt`, `adoptReferencedUploads`, `serial`+`busySerialGroups` (a lane frees at
    the ACK, so a serialized entry waits for its GROUP — the **cwd** — to go quiet; every session
    counts there, while the INTENT ladder's `intentSerialHolders` counts only sessions opened for
    queued work, and a turn that ended asking in prose holds it as a question), `goneLanes`.
    **`sessionWall` is the ONE answer to "can this session take a prompt right now"** — limit, then an
    open dialog parsed or not, then a live turn; `laneBusy` is it as a boolean, and `intent.ts`'s
    `sessionBlocker` and the host's `autoFireBlocker` are it plus their own rungs. There were FOUR
    hand-written copies and one had already drifted. **THERE IS NO CLOCK IN THIS MODULE** — no TTLs,
    no age-based expiry; `maxAttempts` is the one give-up left. **THE RESCUE IS THE HOST'S.**
  - `intent.ts` — a BARREL over `intent/` (`types` `row` `facts` `words` `budgetpass` `kind`
    `target` `verdict` `clean`; import only `./intent.js`, never a slice — [layout](docs/notes/shared-architecture.md)): the durable INTENT model, and **`intentVerdict`, the ONE ladder** deciding whether
    deferred work may run: gate, budget, trigger, serial, target readiness, in that order, **because
    the order is by what the user can DO about it**. Rung 2 and the `budget` trigger skip a row whose `pastBudget` waiver is in force (`budgetWaived`: one start long, until the reset it was granted against — `budgetHold` asks it beside `budgetPass`) — nothing below rung 2 reads it.
    **Rung 2 also lifts for a row inside the lead window of the reset its cap guards**
    (`budgetPassOf`/`budgetHold`): a `window`/`before` row anchored to the SAME window the tripped
    ceiling is about, between its own `nextAt` and that reset — never before it, never past it,
    never for `after`, never a session pass past the weekly cap (a WEEKLY pass does cover the
    session cap — nothing later in that week either), and never without `facts.budgetOver`
    (absent = nobody said which cap = hold). A recurring rule's child carries it as
    `Intent.budgetPass`. Also owns **`intentKind` + the classifiers** — one classification for BOTH ends. `cleanIntentRow` caps counts and labels and
    **NEVER the words**. **`IntentRequeue` is one record per time a SETTLED row was put back**
    (`REQUEUE_KEEP`, newest last, oldest dropped): it carries the `result` the row had, because
    the next run overwrites `Intent.result` and losing why it failed last time loses the only
    reason a person had to think twice — capped by COUNT, never by the words inside an entry, and
    an entry that cannot say when or WHO is dropped rather than defaulted. `by` is THREE taps:
    `assess` (a verdict applied), `hand` (the row's own *run it again*, which leaves it WAITING) and
    `run` (the first half of *run it now* — already going, so "put back in the queue" must not be
    drawn over it). **The LIST is the capped words; `Intent.requeueCount` is the uncapped NUMBER** —
    `requeues.length` froze at 5 and said *(5th time)* on the ninth, a reading degrading to a WRONG
    number. The count is cleaned strictly (a real, whole, positive number) and absent means NOBODY
    COUNTED, which is also how *never put back* is spelled. **A row rung 3 has RELEASED is never re-judged by rung 3** (`clearedOccurrence`, persisted): every
    tick re-runs the ladder from scratch, so a row held by a rung BELOW rung 3 used to spend its own
    `graceMin` on the waits it was told to perform and then be failed for it — a real `waits until
    free` rule died that way on a desktop that never stopped running, and the sentence blamed the
    machine. The stamp is per-OCCURRENCE; only `HELD_MAX_MS` (24 h, never < the grace) still expires
    one, in its own wording. Two OPT-IN rungs sit between serial and target readiness, most specific
    first: 4.5 `holdForHost` (hold until nothing on the host is starting or running — absent means
    the host being busy elsewhere is none of this row's business) and 4.6 `noSlot` (`auto` rows whose
    target spawns a session wait for one of the desktop's automatic-session slots; a person's own tap
    never does). `cleanTarget` normalises every `{kind:"repo"}` to `fresh: true` — the shared
    per-repo backlog conversation is RETIRED, and `sessioncost.ts` is why. The `after` trigger
    chains one row behind another's finish (`onlyIfOk`, an opt-in `graceMin`, a `title` SNAPSHOT so
    the sentence survives the predecessor being compacted); it reads four OPTIONAL facts —
    `settled` (how the finished rows finished), `knownIntents` (what tells "not yet" from "gone", so
    a dead predecessor FAILS the row rather than stranding it), `chainWaits` (the edges, so a
    cycle fails with a sentence instead of two rows waiting politely for each other for ever) and
    `neverSettles` (the rows that never go terminal — the RECURRING schedules — so *after the
    nightly sweep* FAILS naming the rule instead of waiting for ever under the most reassuring
    sentence here) — and an absent fact always means *nobody said*, which waits. A chained prompt is
    `work`, never `schedule`: no recurrence, no clock to arm. **`isTimedWorkRow` says the same of a
    ONE-OFF `at` aimed at one place** — RECURRENCE, not trigger kind, decides which list a row lives
    in, so a one-off is a backlog row (with `BacklogItem.at` on the wire) and only a standing rule or
    a one-off SWEEP (`repos`, no single backlog to live in) is `isScheduleRow`. **Derived, never
    stored**, so editing *once* → *weekly* moves the row with no migration; `timedWorkKey` is the
    "same clock" equality. Rung 5's `repo` case asks `fresh`
    BEFORE `facts.repoSession`: opening the session IS the work, so a repo whose last item's session
    is still lingering must not gate the next one on it (`repoAnySession` and the two
    shared-backlog-conversation refusals went with that branch).
  - `closed.ts` — **what a *Recently closed* row may say**: `cleanClosedRow` (old rows unchanged,
    unknown `closedBy`/`kind` dropped never rounded), `clipClosedText` (one line, 200), the item's
    outcome only once SETTLED (`closedItemFacts`), and `sessionOriginOfIntent` — one classification
    of an intent's session (fanout/agent/schedule/backlog) for every opener.
  - `dictate.ts` — **the audio format both ends agree on**: 16 kHz mono PCM, the header the PHONE writes (`pcm16ToWav`) so the host needs no transcoder, the caps in SECONDS (a person dictating thinks in seconds, and 32 kB/s makes bytes the same fact), and `dictateRefusal` so one clip is refused in one wording whichever end noticed. `wavFacts` walks the chunks rather than assuming `data` at 36, and measures the body by the bytes that ARRIVED — a length field describes audio a dead socket never sent.
  - `dictateterms.ts` — **the person's dictation vocabulary** (synced `waterplane.dictate.terms`, one term per line, `TERM: misheard, misheard`), parsed by ONE function on both ends and sent with each clip. Two levers: whisper's `--prompt` (what moves the SPELLING — a lone term is said twice, because `Kwixel.` alone was MEASURED to change nothing) and corrections after the fact. Re-casing touches only identifier-shaped terms (≥3 chars, digit or inner capital) so `Go` never rewrites "go"; the prompt handed back on silence is refused as no speech (`isPromptEcho`). The browser engine gets the corrections only.
  - `installlog.ts` — **what an install log may claim.** Keyed, idempotent merging (a phone re-states its whole history on every connect, so this must not duplicate or lose one), `at` ABSENT where the shell could not stamp it — never the report time wearing an install's clothes — devices DERIVED from the entries so the two cannot disagree, a repeat FILLS IN what was missing and never blanks what was there, and `installReportFrom` refusing every non-terminal outcome (`asked` is a person being waited on, not an install).
  - `buildscan.ts` — **which build commands a repo may be TOLD it has.** Every candidate is read out
    of a file somebody already wrote there, so a gradle task with no evidence is never offered. A
    suggestion is TYPING, not saving. A publishing command is flagged, **never filtered**; an
    already-configured one stays in the list, marked — a list that shrinks as you use it reads as
    broken. `total` rides beside a capped list so the UI can say what it hid.
  - `buildparams.ts` — **what a build button ASKS before it runs**, so a monorepo gets one entry
    instead of forty. Verbatim substitution at `{{id}}` in `cmd` AND `dir`, the `WATERPLANE_PARAM_<ID>`
    copy as well, a value is ONE LINE, an **undeclared placeholder is LEFT AS WRITTEN** (an empty
    substitution builds the wrong thing successfully), and a parameter with no value and no default
    **REFUSES the run by name** rather than picking the first option for an unattended fire.
  - `artifacts.ts` — **what a build LEAVES BEHIND, and what it is called.** The per-repo policy
    (`collect`/`prune`/`keep`, **on by default** — an unparsable field falls back to the DEFAULT,
    never to off), the name (`<repo>-<variant>-<version|sha|stamp>`, and **a name that already says
    which build it is, is KEPT**), `familyKey` — "which artifact IS this", **moved here from the
    host** so the prune and the download queue cannot answer it differently — the fold (size **and**
    a caller-supplied fingerprint; no fingerprint ⇒ never folded) and `pruneVictims` (only families
    this run produced, only past the newest `keep`, never the run's own output). Disk is
    `host/artifacts.ts`. `shared/test/artifacts.test.mjs`.
  - `tokens.ts` — what a pile of token counts MEANS. `sampleTotals` is the ONE reader of
    `SampleKinds`, the positional tuple every per-request split rides as (1,200 of them per document
    — the key names would be most of the bytes); its order is `TOKEN_KINDS`' order and a second
    hand-written index is a chart with the right numbers in the wrong colours. Exists because of one measurement: 96% of all
    tokens are **cache reads**, so the four kinds are never merged and the total always ships beside
    its split. `fmtCount` keeps three significant figures; `fmtShare` says `<1%` rather than `0%`.
  - `sessioncost.ts` — **what one more turn in THIS session costs, against a fresh one.** Denominator
    is the session's own FIRST reading (a measured per-repo fact — baseline is mostly `CLAUDE.md` +
    tools), never a constant; a truncated log yields NO baseline rather than a guess. `breakEvenTurns`
    is derived from `pricing.ts`'s cache multipliers **at the 1-hour write tier** (measured: 8,160
    of 8,160 main-conversation cache writes; only subagents write 5m, so a blended ratio is the
    wrong input) — it read 1.25× and was ~65% low, the one number here that was WRONG and not
    absent. That is why it can say *a quick question is still cheaper here* and mean it — **except
    on a cache that has expired**, where re-READING becomes re-WRITING and that sentence is an
    order of magnitude wrong: `cacheLikelyCold` is the guard, `true` only past the TTL PLUS
    HALF AN HOUR (the hour is a 36%-wide coin toss at its edge and the log stamps generation END,
    not request start). **Measuring this from logs has two traps that both fake WARM**: a compaction
    inside the gap (excluded, never counted warm) and `write > read`, which is the wrong test — a
    cold resume still reads the 32.5-36.8k preamble, so a 60k conversation comes back reading 36.8k
    and writing 30.6k. Corrected: 89% cold by 70 min, 96% by 90, 100% (48/48) at 2-4 h, one warm in
    118 past four (a fork continuing the prefix in another file). **Never mid-turn, no countdown, no
    dollar figure**, and the clock is the PHONE's at
    render — a host-computed flag is stale on arrival. **It produces sentences and never a refusal.** `seriesCostFields`
    is the ONE derivation, so the host's spark and the sheet's full document cannot disagree.
    **`usageTok`/`agentTok` are a DIFFERENT fact from `spentTok`** — what the session has USED
    (output side and subagent logs included) against the volume the curve integrates to; `usageText`
    is the one wording, always *so far* (both are floors), the agent clause only when there is one,
    and **absent beats derived**: a total reconstructed from `spentTok` would leave out every agent.
    **`isColdRebuild`/`ColdStarts`/`coldStartText` are what the GAPS cost** — a request that came
    back to an expired cache and re-WROTE the window instead of re-reading it. `REBUILD_READ` is 0.8
    and it is the real test (a warm turn reads back essentially all of it); `REBUILD_WROTE` is
    measured against what the read LEFT OVER, never the whole window, because the 32.5-36.8k
    preamble is most of a small conversation and none of a large one — and that second half is also
    what catches a compaction whose boundary nobody wrote down. The sentence leads with the PREMIUM
    over re-reading, says *so far* nowhere and *wasted* never (a conversation worth coming back to
    is worth what it costs), and states no amount it could not price.
    **`compaction*` is what compacting DID** — shed (both sides of the drop, chaining across
    several), SAVED (the shed × every REQUEST since, not per compaction — one boundary shedding 173k
    with seven turns after it saved 1.2M) and the REBUILD. Priced as CACHE READS and the rebuild as
    the whole first write after the boundary: both err AGAINST compacting looking worthwhile, on
    purpose, because the panel is read to decide whether to keep typing `/compact`. The saving is
    money NEVER SPENT and the rebuild is already inside the session's total — every sentence says
    which. `saved 0` is the token spelling of `$0` and is refused (`compactionRowFacts` →
    *nothing back yet*); an `unmeasured` boundary is NEVER called "the CLI's own"; and past the
    model's window `compactionWindowText` replaces the multiple's meaning — those turns could not
    have run at all — which is withheld where no turn has run since.
    **`costChip`/`costText` are those two in MONEY**, which is what a launcher row now prints: `38M`
    and `18M` side by side say nothing about which session was dear (that is the model and the cache
    share), `$4.21` is the same fact with the arithmetic done. `costChip` answers **null, never
    `$0`** — a zero beside a session that ran reads as free — so the row falls through to the token
    chip, and `costText` never states a figure without saying it is a list-price COUNTERFACTUAL and
    naming what no rate covered.
  - `costwindow.ts` + `burn.ts` — **one week, read one way on both ends** (`wire/costwindow.ts` is the
    DTO). `weekCut` is the ONE bucketing function: the figure on an hour and the list that hour opens
    are the same predicate over `CostConvo.byHour` (a count on a control is a filter). `foldLaunches`
    makes a fan-out run ONE row; `rankRepos`, `agentModelInsight`, `pickSimilarRun`/`fanoutHintText`.
    **`ptsCalibration` REFUSES, with a sentence per reason, rather than guess** (reset-bounded
    stretches of 6 h and 5 points, spread under 35%, within 40% of the per-reading level rate) and
    `ptsText` is absent on a refusal. `burn.ts` owns `usageSegments` (lifted out of `splotUsage.ts`,
    which re-exports it, so chart and push cut a rollover alike), `burnStretch`/`burnVerdict` and
    `burnPushText`, which always ends "Nothing was paused." Reasoning: host.md `costwindow.ts`.
  - `ctxwindow.ts` — how big a model's window is; the number every context graph calls 100%.
    **Not a table keyed on the id** — the CLI's log records the BASE id even for a 1M conversation
    (measured: `claude-opus-5` at 998,242 tokens with no `[1m]`), and a 200k table drew those at five
    times their real fullness. `resolveContextWindow` orders: TUI gauge, then the MEASUREMENT snapped
    up `WINDOW_LADDER`, then the id, then null; `windowFrom` travels with the number.
  - `budget.ts` — the usage BUDGET. **FAILS OPEN** on an unreadable or stale reading, and clears past
    a known reset on the CLOCK alone. `budgetCeilings` is the per-window truth `budgetVerdict` is the
    first line of; `budgetHoldText`/`budgetPassPendingText`/`budgetOtherCapText`/`budgetLeftoverText` are the only
    wordings of a budget hold. `leftoverCeiling` (`leftoverMax`, default 20) is NOT an account pause:
    it holds only rows `budgetLeftoverOf` names — a weekly pass or weekly waiver that outlived its
    reset unstarted ([host.md](docs/notes/host.md#what-a-lift-leaves-behind-after-the-reset--leftoverof-and-the-leftover-ceiling)).
  - `sessionbudget.ts` — the per-session budget ([host.md](docs/notes/host.md#sessionbudgetts--a-sessions-own-budget)) — **a cap on ONE session** (tokens, dollars, or ≈% of the 5-hour/weekly window), spend being the session's own `ContextSpark` total, subagents inside it. **Unknown never trips**: a stale/missing reading, an uncalibrated window or an unpriced model is a verdict of `unknown` with a `why`, and `sessionBudgetHeld` — the ONE predicate, phone queue (`budgetHeldLanes`) and intent ladder (`budgetHeldSessions`, reason `sessionBudget`) alike — is true only for `over`. Percent units reuse `weekUsdPerPct` and `BUDGET_STALE_MS`; the account's `budget.ts` is a separate thing.
  - `assess.ts` — **what an assessment is ALLOWED to conclude.** Every cap is on a COUNT, a citation
    or a label, **never on the words**: prose past `MAX_PROMPT_CHARS` is DROPPED with a note. A run
    also proposes a `headline` and a `category` per row, merge and new item — carried even on
    `unclear` and downgraded rows, because naming is a reading of the WORDS and not a claim about the
    codebase — and written only under `AssessChoices.writeNames`, one question at the foot of the
    sheet rather than a fourth control per row.
  - `naming.ts` — **a title and a kind for a row, and who wrote them.** `label` is the PERSON's
    field, `headline` is the machine's, and `itemHeadline` is the ONE display rule: a typed label
    always beats a derived headline. Every value travels with a `NameAuthor` (`hand`/`assess`/
    `name`) and is dropped on read without one — a title that cannot say who wrote it cannot say
    whether a person may be overwritten, and `hand` is what makes "never overwrite typed words"
    checkable rather than promised. `category` is one of four exact words and **absent means nobody
    said** — `"bugfix"` is dropped, never rounded to `chore`, and there is no synonym table because
    a synonym table is a second vocabulary. A headline that is merely its own item's first words is
    DROPPED, and its own test ONE-directional (`text.startsWith(headline)`) — NOT `typedName`'s
    two-way rule, which refused every title that merely OPENED with a prompt under 40 chars. A
    refused title is SAID (`headlineRefusedText`), never dropped in silence.
    **`branchLabel`/`repoBranchLabel`/`trimDefaultBranch` are the other half of the same question:
    which branch a row needs to SAY.** `main` and `master` on a PRIMARY worktree say nothing and
    come off — two names and no pattern, because those two are the ones git creates and anything
    else was chosen; a worktree keeps its branch whatever it is called, since that is the only thing
    telling it from its siblings. `trimDefaultBranch` does it at DRAW time for titles already stored
    as `usmc · main`, so no persisted title — least of all a hand-typed one — is ever rewritten.
    `GitView` and `BranchPicker` never call these: on the screen you switch branches from, the
    current branch is a fact, not clutter.
  - `itempaths.ts` — `imagePaths`/`transportPaths` (`IMG_RE`/`TRANSPORT_RE`): the image and `.claude/outbox|inbox` paths a work item's words name.
  - `intent/slot.ts` — **which waiting timed rows fire TOGETHER**: `slotsOf`/`slotMates` (the ONE bucketing function — count and cut), `findSlot` (key matched with `RESET_MATCH_MS` tolerance, never as a string), `latestClock` (a merge carries the latest member clock; near-tie of different rules ⇒ null). Feeds `assess.run`'s optional `scope`; assessment `conflict` is words with no mutation, `split` is refused if it loses a `transportPaths` path. [host.md](docs/notes/host.md#the-slot-check--sharedintentslotts-and-the-assessments-conflictsplit).
  - `schedule.ts` (wall-clock rules, `nextFireAt`, `isSpentOnce` — a spent `once` is not a schedule
    somebody switched off. **`hours` places nothing and `nextFireAt` never reads it**: the anchor
    says when work becomes worth doing, quiet hours are a policy over every anchor, and the ladder
    counts the GRACE from `hoursOpenFrom` — the window's opening — or a 03:00 rule behind a
    07:00–22:00 window is "missed" daily having never been allowed to try. `guardWindow` tests
    `minPctLeft` against the OTHER usage window, which is the only thing that lifts the *after-edge
    has nothing to test* rule: *right after the session window resets, only if 30% of the week is
    left*) · `promptid.ts` (question fingerprint) · `settings.ts` (synced-key
    allow-list) · `hints.ts` · `hosturl.ts` · `netfuse.ts` · `screenlog.ts` (`scrollOffCount` anchors
    on the TOP of the new grid) · `urls.ts` (rejoins a wrapped URL on the WRAP GEOMETRY, never on "the
    next row looks URL-ish") · `gallery.ts` (`coversQuery` is strict containment, never a broadness
    score) · `wire/localrt.ts` + `localrt.ts` (**what the local runner
    holds**, and the pure "will a second model fit" SENTENCE the phone says under the picker —
    **`reachable:false` is not an empty model list**; tokens/sec deliberately absent) ·
    `wire/sysstat.ts` (**the DESKTOP's own numbers**, riding on that sample: CPU split, memory
    breakdown, the process table folded BY PROGRAM, temperature and fans. **Every section optional and
    absent means no reader — never a zero**; `cpu` needs two readings so the first sample has none;
    the slow readers carry their OWN timestamp; `rssSumBytes` exists because RSS counts a shared page
    once per process and the rows must not be added up) ·
    `wire/telemetry.ts`'s **`TokenWindow`/`TokenWindowSeries`/`TokenWindowsDoc`** (**one PAST
    rate-limit window per row**, folded by the host because the document ships a bounded fortnight
    of hours: `back` counts whole windows from the one running now and the INSTANTS are derived from
    `anchor`/`lenMs` on both ends, so a row cannot disagree with the grid it is in; only windows that
    RAN something are sent, and `oldestHour` is what tells "ran nothing" from "no record") ·
        `wire/backendtokens.ts` (**a backend's OWN ledger — `BackendTokensDoc`, never summed with `TokenTotals`**:
    its kinds are the backend's (a `Record`, never folded into claude's four), `unit` where the bill is
    not tokens. `available:false` is a 200 with a reason — "no store here" is an answer, not an error.
    An extension whose document predates this shape keeps its type in its own `shared/` and core
    serves it verbatim) · `sweep.ts` (**clearing out a transport directory**: the age ladder NESTS, one predicate
    feeds both the chip's number and the cut it opens, every tally is `{count, bytes}` because a
    count alone is not the decision, and **the PLAN is the contract** — the caller sends back the
    paths it showed, never an age for the host to re-cut. Plans and words only; it deletes nothing
    and schedules nothing) · `attach.ts` (`unknown` is never collapsed into `missing` — one is a dead tunnel, the
    other a lost photo) · `launch.ts` (what is LEFT of the old launch gate) · `fanoutruns.ts` (call it
    ONCE per list, never per row) · `collage.ts` (`pickCols` optimizes the ASPECT that comes out) ·
    `pad.ts` (**the pad's per-note merge**: one JSON array of notes AND tombstones, discriminated by
    fields so an older bundle drops the tombs and keeps a working pad; `serializePad` is CANONICAL
    or the two devices never stop pushing at each other, the tie-break is lexical never *prefer
    mine*, an EDIT after a delete keeps the note and drops the tombstone, and a merge **never**
    sheds for size — the caps bind on a local add, which REFUSES in words. **THERE IS NO CLOCK IN
    `mergePad`**: the tombstone TTL is cut against the newest stamp in the UNION of the two docs,
    never `Date.now()`, or two clock-skewed phones push one tombstone back and forth once per
    debounce for the whole skew window; the cap is applied AFTER the resurrection rule. Owns the sheet's
    sentences too. `draftToRescue` — seeding a sheet draft over typed words is a DELETE, that store
    having no listing of its own) · `clihealth.ts` ·
    `pricing.ts` (**list prices, per model, asked for a DAY** — an unknown model prices to `null`
    never to a guess, `PRICES_AS_OF` rides to the UI. Cache read is 0.1× of input EXCEPT where the
    list publishes its own (`Rate.cacheRead`: Fable 5.1 at $0.25 against $10 input, 0.025× — and
    cache reads are 96% of the tokens, so the rule alone is 4× on the dominant line); writes are
    1.25×/2× by TTL and the 1-hour tier is READ. **A cached table rots**: Sonnet 5 sat at an
    `intro` $2/$10 "until 2026-08-31" over a $3/$15 base that the list does not have, so every
    sonnet reading after 1 September was half again too dear. Fast mode is knowingly absent — the
    log does not record the speed) ·
    `ptysize.ts` (**a grid too small for the CLI to draw a composer in is not a viewport** — the
    client withholds a fit measured on a collapsed container, the host CLAMPS one; a session left at
    `54x3` made every delivery into it unreadable, so unconfirmable, for forty minutes) ·
    `working.ts` (the CLI's own working line off raw PTY bytes — **one matcher for both ends**: the
    phone's reader says what a turn is doing with it, and `sessions.ts` decides with it whether a
    `Stop` hook a keep-going loop refused really ended the turn; two copies would be two opinions
    about whether a session is working, and the queue's interlock hangs off the answer).
  - `repohealth.ts` + `repohealthread.ts` — the zero-token repo-health series on the wire, split
    because the halves fail differently: the first is the paths, the DTOs and one sentence per
    state that has nothing to draw; the second is every parser that turns a run's stdout into them.
    **A parser there rebuilds its result from the fields it NAMES**, so a field nobody named is
    dropped in silence — that has shipped three times (`longest`, `rank`, then `areasAbsent` + an
    area's `reason`, which blanked the per-area panel on every repo with no `<router>-*`
    convention). Adding a field ⇒ name it in the parser AND type it; the test runs the real engine
    and asserts every key path it emits survives the parse. Reasoning:
    [host.md](docs/notes/host.md#repohealthts-and-repohealthreadts-in-shared--one-subject-two-failure-modes).
  - `healthindex.ts` — the health SCORE: absolute 0–100 vs fixed `HEALTH_GOOD` values, headline
    `min(geomean of five entry scores, worst + 30)` with `cappedBy` and `alerts` (each worded here),
    trend second. The one layer that takes a side. **Wire fields added after the score
    (`mean`, `cappedBy`, `alert`, `alertText`) are optional: the phone updates over the air, absent =
    that host did not say.** Good values are provisional; why absolute and why capped:
    [host.md](docs/notes/host.md#the-health-score-kept-current-by-healthwatchts).
  - `hosts.ts` — the multi-host DTO and its pure rules: `SavedHost`, `HostLan`, `cleanSavedHost`,
    `planHostMigration` (one legacy `hostBase` → the first entry, idempotent), `planHostSwitch`
    (which keys a switch parks/restores and in what order — every copy lands before the bare key it
    came from is removed), `dbNameFor`. Web-only (a browser has one host); Android shell reads it.
  - `lanroute.ts` — `decideLanRoute`: the three ANDed gates (saved SSID, a fresh `/api/health`
    probe, `/api/lan/verify`'s HMAC) that decide LAN vs tailnet, pure and node-tested so the phone's
    ladder (`web/lanRoute.ts`) and the host's identity routes (`host/lanid.ts`) read the same
    contract. `NetState` is also the Android `ShellNet` plugin's shape.
  - `pairing.ts` — the QR pairing code: format, TTL, single-spend semantics, the deep-link
    (`waterplane://pair?u=<base>&c=<code>`) and landing-URL (`<base>/pair/<code>`) parsers, both resolving
    to the same `{base, code}` through `normalizeHostBase` so a scanned link can never carry a
    `javascript:`/`data:` base.
  - `devices.ts` — the paired-device row (`DeviceRow`) as the phone sees it, without the token hash
    the host keeps: `sortDevices`, `cleanDeviceRow`, `normalizeDeviceName`, `deviceSeenDue` — the one
    place both the host's ledger and the phone's "paired devices" list agree what a row is.
    Reasoning for all four: [host.md](docs/notes/host.md#modules-claudemd-links-here-for-and-this-file-never-covered).
