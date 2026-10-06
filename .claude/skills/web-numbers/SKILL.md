---
name: web-numbers
description: waterplane phone client, context, tokens and cost as screens (packages/web/src): ContextLimits.tsx, ContextSheet.tsx + ContextGraph.tsx + contextPlot.ts, TokenComposition.tsx, the session-cost reminder (sessionCostPill, costTag, costNotice.ts over shared/sessioncost.ts), TokenStatsSheet.tsx + TokenInsights.tsx + statsInsights.ts + statsPlot.ts + usageCut.ts + guests.ts (contributed ledger tabs) + PerRequestSection.tsx + perRequest.ts, RepoHealthTiles.tsx + RepoHealthTable.tsx + repoHealthPlot.ts + repoHealthWords.ts. Load BEFORE drawing or wording any token, context-window, usage or dollar figure on the phone, changing a chart's axis, palette or control grammar, drawing the repo-health series, or touching the context-weight threshold form. A total is never printed without its split, and a readout refuses nothing.
---

# web — the numbers screens

Context, tokens and money as things a person reads: the context window as a shape, the composition strip, the cost reminder, the two usage ledgers and the threshold you can argue with. Router: `web`. Reasoning: [web.md](docs/notes/web.md).

- `ContextLimits.tsx` — the THIRD answer, on the one row that quotes a number: argue with the
  threshold. The `context-weight` row's line was env-only and host-wide, so the sentence credited the
  user with a decision they were never offered and a repo with load-bearing invariants sat amber for
  ever. **The form opens on the STORED override, never on the effective number** — those differ
  whenever the host's env is doing the work, and pre-filling from `effective` turns *inheriting 20k*
  into *pinned at 20k* on the first Save. **A blank field is “inherit”, not zero.** Every value names
  its source (default / set on this host / set for this repo); **nothing is greyed out** — a refusal
  is a sentence, and the host refuses too (this validates for speed, never as the gate). The host
  answers with the RE-RUN report, so the row restates itself.
- `ContextSheet.tsx` + `ContextGraph.tsx` + `contextPlot.ts` — the context window as a SHAPE, geometry
  and sentences pure and node-tested. **One y axis for every graph: 0 to 100% of the model's window**,
  never re-fitted to the data, falling back to tokens **while saying so**. The TIME axis is piecewise
  and the break is DRAWN. Colours are VALIDATED, not chosen; there is a table twin.
  **ONE CONTROL GRAMMAR, shared with the all-sessions screen and written above both returns**: the
  head holds chrome only (back, re-read) · a body-changing choice is a `.ts-filter` row of LABELLED
  `.key` chips lit `.key.active`, directly above the first thing it changes · a
  section-scoped choice is `.ts-seg-chips` in that `.section-head` · a running verb says so in its own
  glyph, never `disabled`. **`.key.on` has no rule outside `.bl-modal-seg`** — a class name is a CLAIM about `styles.css`.
  **The context sheet has NO `show as` / `stack by` rows** (owner removed both, 2026-10-03): one
  chart view, areas ALWAYS stacked by token kind (flat only where the host sends no kinds), subagent
  lanes and the agents' spend band unchanged. The by-model stack lives on the all-sessions screen.
  **Long method prose FOLDS into `details.hint-more`; an ABSENCE never does** — a mean that is not
  drawn, a chip that is not offered, a section that cannot be answered, an outlined box standing for
  *nobody measured this*: `Unavailable.tsx`'s rule applied to prose. Restatements and reassurances are
  cut. `axisNote` is the
  caption, one per `windowFrom`: **`"config"` is ATTRIBUTED, never presented as a measurement** — it
  is what the backend's configuration STATES, not something anybody watched, and a local runner may
  hold less. The sheet is gated on derived `contextSeries`, not on the live gauge.
  **THE CHARTS SIT TOGETHER, then the panels, then the captions** — name → spend chart → context chart + summary + legends →
  agent lanes + readout + legend →
  composition strip → cost panel (two doors) → expired cache → compactions → captions (truncated,
  `axisNote`, gaps, *where these numbers come from*). The three charts share one `makePlot` x axis,
  so a step in the grey band lines up with the agent bar that caused it; the
  panels used to be interleaved under "their" chart, which put prose between charts read together.
  Charts are NAMED (`.ctx-chart-title`).
  Every sheet prose `.empty` also carries
  `.ctx-note` — `.empty` sets no size, so a bare one rendered at the body's 15px between 12px lines.
  **TWO DOORS on the cost panel and `/compact` LEADS** (`.key.primary`): it keeps the conversation
  and re-reads a summary of it, a fresh session keeps nothing, and the ledger six lines below already
  prices the last one at 168× what it cost. Drawn ONLY where `sessionCan(subject, "slash")` —
  `headerCmds.ts`'s bug verbatim — absent with its reason in TEXT, and **`costDoorsText(false)` is
  NULL**: a sentence naming a door that is not on the screen is the same lie in prose. Sent through
  `submitInput` with an ackId, aimed at the SUBJECT and never at the attached session.
  **TWO doors, one subject** (`ctxSid`; null = the attached session, cleared on close and by the
  header chip): a launcher row's cost tile is a CONTROL — `role="button"` + the stopPropagation
  PAIR (click AND the `pointerdown` that arms the row drag; a nested `<button>` is invalid inside
  the row) — and opens the graph for THAT row **without attaching it**, the series being read by id
  over HTTP. Its affordance is the tile's own EDGE: never the dotted underline (that mark is for a
  line of text, not a stack of two SVGs) and never a `title`.
  **A TOTAL IS NEVER PRINTED WITHOUT ITS SPLIT** — 96% of every token here is a cache read, so
  "16M spent" alone is out by two orders of magnitude on what somebody typed. `ContextSeriesDoc`'s
  `split`/`agentSplit` are `TokenTotals` from host `ctxlog.ts`'s SAME pass (`tokenTotal(split)` IS
  `usageTok`, tested — never a second tally), drawn by the SHARED `TokenComposition.tsx` so a kind
  cannot change hue between this screen and the all-sessions one. **`split.turns` is REQUESTS, not
  prompts** (the outline's `turns` stays what it is): `cacheReading` divides by it on both screens.
  The bar folds the agents IN and says how much (`splitNote().lead`). Absent, never
  zeros. `cacheReading(t, "session")` re-words the mean's caveat and drops the advice — the corpus
  wording points at this very screen, and the cost panel above already has the buttons.
  **The all-sessions screen stacks by model too, and its repo bars always do.** `MixSeries` grew a
  value ACCESSOR so `stacks`/`stackAreas` serve kinds, models and agent COUNTS from one
  implementation; **the readout and the legend follow the split** (a model stack under a kind legend
  is four correct bands wearing four wrong names). Repo bars carry their model split inside their own
  length — the answer to why equal-token repos differ in cost. One `ModelLegend` for all three, and
  the chip row SCROLLS rather than wraps.
  **The row's spend chip is MONEY, the sheet's headline leads with the same figure.** `38M` beside
  `18M` cannot say which session was dear — that is the model and the cache share — so the chip is
  `costChip(spark.costUsd) ?? usageChip(spark.usageTok) ?? fmtTokensFine(end)`, every rung ABSENT
  rather than zero, and an unpriced model or an older host lands on exactly the row that shipped
  before. Tokens move into the title with `costText`, the ONE sentence that keeps a dollar figure
  from being read as a bill (list-price counterfactual, and it NAMES what no rate covered). The
  curve stays in tokens — a second axis in dollars is the same shape twice.
  **The two areas STACK by token kind, and a third chart counts the fan-out.** `stackBands` is the
  geometry, and four rules hold it: the LINE stays and the stack's top edge IS it · the context chart stacks only the three
  kinds that ARE context (output is not in the window until the turn after) · the spend chart stacks
  `cum`, never a cumsum of `kinds` over THINNED samples · bands in palette order, bottom first,
  accumulated in VALUE space. **A model's hue is FIXED app-wide by family** (`modelHue.ts`; the tail
  is ONE grey band), never a volume rank. **A band with nothing in it is dropped, and so is its legend entry**
  (the table spans the conversation AND its agents). **Subagents are SWIM LANES on the same axis**
  (`agentLanes`): one bar per agent from `at` to `endAt`, first-fit packed in PIXELS (the axis is
  piecewise) into the fewest lanes, coloured by `modelSlots`, dearest outlined, a tap answering in a
  TEXT line under the strip (`agentReadout`). Their SPEND is the grey band on the spend chart
  (`agentSpendBand` over the host's `agentCum`, step-held, top edge = the dashed total; absent ⇒ the
  gap as before), and the row spark draws `agentEnv` as a faint area BEHIND the line, clamped at the
  axis top. An undated agent is in the totals and off the chart, and `agentUndatedText` SAYS so in
  the open. **Prose splits `{lead, more}`** (`spendNote`, `splitNote`): the lead is only absences
  and where-the-agents-are; method folds.
  **The `Expired cache` panel is what the GAPS cost** — beside the compaction panel because the two
  are the same kind of fact (money no prompt asked for) and easy to confuse: compacting rebuilds a
  window somebody threw away, this rebuilds one that went cold. One sentence from
  `shared/sessioncost.ts`, drawn only when it happened (there is no zero row — "you never left this
  session overnight" is not news), and the same wording appears on the all-sessions screen under the
  whole-corpus cut ONLY, beside the unpriced and fast-mode clauses. **A rebuild is not drawn on any
  chart** (the window does not move, and the two event colours are a validated pair) — in the values
  view it wears the INK dot, never the usage-limit red, which would claim the account refused a
  request.
  **`CompactionPanel` is what the ticks DID** — two rows split by trigger, tokens AND money on each
  side (a cache read against a cache write differ up to 20× in price, so the counts alone are not a
  ratio). **`compactionMethodText()` FOLDS** into a `hint-more` disclosure — four sentences of method
  under two numbers already on the rows — kept, never deleted: it is why the ratio errs against
  compacting. **The saving is money NEVER SPENT and the rebuild is already inside the session's total**
  — the sentences say which, or a reader adds them. **`saved 0` is `$0` in tokens and is refused**
  (`compactionRowFacts` → *nothing back yet*); **past the window the multiple stops meaning
  anything** and `compactionWindowText` says so DIRECTLY under it, withheld where no turn has run
  since; an `unmeasured` boundary is never called "the CLI's own".
- `PerRequestSection.tsx` + `perRequest.ts` — $/request: a RATIO OF SUMS.
- `RepoHealthTiles.tsx` + `RepoHealthLongest.tsx` + `RepoHealthTable.tsx` + `repoHealthPlot.ts` + `repoHealthWords.ts` — **the repo-health series as
  charts, in `SetupSheet.tsx`'s region 2** (the sheet itself ⇒ `web-work`). Hand-rolled SVG on
  the `ContextGraph`/`contextPlot` pattern, **no charting library**: geometry pure in the `.ts`,
  paint in the `.tsx`, every sentence in the words module. **The TOOL states, you draw** —
  `repoHealthPlot.ts` has NO imports and `repoHealthPlot.test.mjs` asserts BY TEXT that it cannot
  name a percentile, rank, slope, median, regression or `.sort()` (the guard shape
  `tools/repohealth.test.mjs` uses on `judge.mjs`); a number a chart wants is added to the TOOL.
  **Six stat tiles** (`size.p95`, `retouch.rate` **with its denominator beside it**,
  `hatches.perKloc`, `context.claudeMdChars`, `context.descChars`, `untested.count`) — the dataviz
  form for *a current value plus a trend*, so the VALUE is the answer and a tile whose curve cannot
  be drawn still prints its number. Full-width ~32px sparkline, **ink at reduced opacity, end dot in
  `--accent` ringed in `var(--panel)` — never `--ctx-series`**, which means "this conversation's
  tokens" everywhere else and would claim the wrong entity. **x is the READING INDEX, not the
  calendar** (a 57-day hole would empty two thirds of every tile) and the caption says so — the
  **day ticks are the days AT three positions in reading order** (`indexTicks`, `want` with NO
  default: how many labels fit is the caller's fact), so the middle label is the middle READING and
  not the middle of the span; **a null
  CUTS the line** — never interpolated, never at zero — a lone reading is a dot and a lone stack
  column a hairline; **a flat series draws at MID-height**, because `(v-lo)/(hi-lo)` is 0/0 and
  paints `NaN`; **y is fitted per series** (six units, no shared axis) except the stack and the
  dumbbell, which are zero-based magnitudes — and **both fitted bounds are PRINTED up the left**
  (`hiY`/`loY` = `py(hi)`/`py(lo)`, so a label lands on the line it names; one label for a flat
  series, since two identical numbers on two edges read as a span), because an unlabelled fitted
  axis reads as a zero-based one and every rise on it looks like a doubling. **Crosshair: the
  INDEX is state and the pixels are derived each render** — held as coordinates it outlives a
  rotation and the ring then marks a different point than the words name; it snaps only to drawn
  readings (holes are not in `pts`), and **its answer is a TEXT LINE under the chart** carrying day
  · value · `sha7`, never a floating box. **On touch, lifting does not clear it** (`pointerleave`
  fires when a touch pointer is destroyed, so one handler for both wipes the answer as the finger
  moves off it) — `clearsOnLeave` is mouse-only, `pointercancel` RESTORES the pick the gesture
  began with (a vertical scroll over a tile fires down-then-cancel and would otherwise re-pick
  every chart it passed), and a second touch on the chosen reading lets go. This line is the ONLY
  route to a past day's figure here — there is no values table as `ContextChart` has — so it is
  always present and says how to use it. **Always-on weight = two stacked bands** in
  `TokenComposition.tsx`'s validated `SLOT`, top edge = the total, two-entry legend: the one chart
  here that prints a total, so it prints the split in the same mark; bands accumulate in VALUE space
  and a column any band is missing is a hole in EVERY band. **Per-area `expected → ceiling`
  dumbbell**, latest reading, ONE x scale (the comparison is between areas); `subs: 0` is one
  number, not a zero-length bar. **Magnitudes in the OPEN, never behind a fold** — lines by package
  as a STACK over time (top edge = the whole tree), source files and production deps as curves with
  **no rank and no slope beside them** (nothing compares them to anything, and a tile's clothes
  invite a reading nobody took), the longest-files tape as columns in the tool's order; **p95 and
  the longest file are WORDS, not rules**, since a dash means a threshold on every other chart
  here. `RepoHealthTable.tsx` prints the same figures as TEXT — last 14 readings, oldest first so a
  row runs the direction the pixels above it do, packages folded by the same `foldPartSeries` the
  stack uses — because two band hues are under 3:1 on light and a crosshair answers for ONE day.
  **No *open the drawn page* button**: `.claude/outbox/repohealth.html` is still written and still
  the better read on a desktop, but every card on it is on this sheet, so it is a SENTENCE naming
  the full path (`drawnPageWords`) and not a control offering a second surface. **Every metric
  carries a `?`** (`HintChip.tsx` → `showHint`, ids `repohealth.<series key>` in the shared
  catalog): one explanation per subject, reachable by chip and by long press, never a second copy of
  the words — and a missing entry is a failing test in `tools/repohealth.test.mjs` (text match) plus
  a scan for `<HintChip id="…">` / `hint="…"` in `scripts/e2e-hints.mjs`, because a chip with no def
  renders NOTHING and five explained tiles beside a bare sixth read as "that one is obvious". **No
  coloured band, zone, grade or red region anywhere, and no `--warn`/`--dead`**: the slope is a
  glyph in `currentColor` with its word beside it, because rising LOC and rising hatches are
  opposite news. Four validated slots, **never a generated fifth** — `foldParts` folds the tail into
  one hueless band, and a slot follows the ENTITY, not its size today. **Measured width prop**, like
  `ContextChart`, via a CALLBACK ref (the box is conditional and the read async, so a `[]`-deps
  effect leaves width at 0 for the life of the sheet). **Not plotted, and said so with the reason**:
  tripwires (events, not series), the path lists (top three ride in the row's `detail`), and
  `dups.pairsPerKloc`/`cochange`, which the tool reads with NO rank — a curve would invite one.
  **The longest file LEADS the region** (`RepoHealthLongest.tsx`): its length over the series with
  the tool's per-reading `longest.paths`, one run per HOLDER via `holderGeom` — **slots go to the
  NEWEST holders** (today's file is always slot 0; past four the oldest fold to ink), a hole cuts a
  run, and a handover is a solid ring in the new hue plus a thin ink step, **only between two NAMED
  readings** (a missing name is not the file changing). No `paths` on the wire ⇒ one ink run and the
  caption says a new holder cannot be told from growth. Today's tape sits under it.
  `repoHealthWords.ts` is under a test banning verdict words AND status tokens: **`rankSentence` is
  the ONE fraction→percentile conversion on this side** (two of them shipped `0th percentile` for
  months) and **a null rank returns the tool's own reason, never a `0th`**; absences are a sentence
  each — a family absent, under 2 readings, `plot` absent vs `null` vs an object
  (`repoHealthPlotAvailability`, three states), and a mixed `PREREG_VERSION`, where the charts are
  **still drawn** over the rows on disk while saying so, because refusing removes the only view of
  the problem.
- `TokenComposition.tsx` — `KindBar` + `CacheVerdict` + the validated four-slot `SLOT` palette, the
  ONE strip wherever a token total is printed. **It decides no numbers**: bag, denominator and
  formatter are the caller's, because the two ledgers count differently and one has no prices —
  and `whole` is not always the sum of the bag (a contributed ledger's fifth kind has no hue; it rides as a
  `children` legend entry with no swatch).
- **The session-cost reminder** (`shared/sessioncost.ts`, `costNotice.ts`, `sessionCostPill`, `costTag`, one toast,
  the context sheet's top panel) — **what a turn here costs against a fresh one, as a readout.**
  Deliberately NOT folded into `contextPill`: that says how much window is LEFT, this says what the
  next turn PRICES AT. Absent until there is something to say and silent for the first `MIN_TURNS`.
  Two weights of **`--warn`, never `--dead`/`--limit`**. The toast fires once per session per level
  step up, only for the session on screen — the decision is `costNotice.ts`'s `shouldNotice`, pure and
  tested, because `active` is a fresh object every frame and the effect around it cannot be.
  **Nothing here disables, intercepts or refuses anything.**
  Its sibling is a LARGE RUNNING SUBAGENT (`ContextSpark.liveAgentTok` ≥ shared `AGENT_LARGE_TOK`,
  worded by `liveAgentText` only): the `liveAgentTag` chip beside `costTag`, the sentence on the
  context sheet, one toast per session per CROSSING (`shouldNoticeAgent` — dropping under re-arms).
  Recency is re-asked on the PHONE's clock (`liveAgentAt`, `AGENT_LIVE_MS`): the spark is only
  rebuilt when a log moves. Both toasts' effects live in `core/session/useCostNotices.ts`.
- **The session budget** (`BudgetField.tsx`): shared words it; **unknown never trips** and says why in text; blank is no budget; a percent is “≈”.
- `TokenStatsSheet.tsx` + `TokenInsights.tsx` + `statsInsights.ts` + `statsPlot.ts` + `usageCut.ts` + `guests.ts` — **now `extensions/token-stats/web/`** (token-stats-architecture.md; plot + strip in `kit/chart/`). **SEVERAL ledgers, never one number.** A SOURCE PICKER (not a
  filter ⇒ **no counts on the chips**): Claude's, plus one chip per CONTRIBUTED ledger view — an
  extension's `ledgerViews` (`LedgerViewDef`, `@waterplane/sdk`; `guests.ts`), each drawn only when
  its `hasData` says the host answered with something in it, else pixel-identical; never greyed;
  resets each open. The sheet reads `/api/tokenstats/<id>`, caches it under the id, and LENDS the
  view its widgets (`LedgerViewParts`); the guest's "All backends" card is its `summary`, totalled
  and split HERE. **The docs never meet in one reducer** — different accounting, so a merged total
  is the most convincing wrong number here.
  **A FILTER IS THE HEAD OF THE BOX IT FILTERS** (`ScopeCard`; [web.md](docs/notes/web.md)):
  `count in` + `show as` reach everything and are one STICKY row; live-window chips head **Totals**,
  calendar chips head **Over time** (the hours follow them too); every section repeats its span
  (`ScopeTag`); what no filter touches says so. Charts measure the CONTENT box.
  Insights (`statsInsights.ts`) are ABSENT unless measured and large, never a control; costliest
  conversations are drawn IN MONEY. `LimitWindows`' refresh carries the WORD *re-read*. **`TableView` takes the
  window CUT** — the twin printed ALL-TIME model and repo lists under a live-window heading while the
  chart half refused *By repo* (an hour bucket carries the model, not the repo), and the half that
  exists so no fact is chart-only was the one lying.
  A contributed view owns its document's rules (its README); the sheet's rule it inherits is **no
  price it cannot source** — `pricing.ts` is claude's table. Every token this desktop has used, behind **every usage
  readout in the app**. The limit windows carry a CHART of the kept readings (`UsageSpark`) —
  not a sparkline: 40px of unlabelled shape was read as exactly that, a strip with no number in it
  whose breaks meant nothing to anyone who had not read the source. So the 0–100 axis is **fixed,
  never fitted** AND **labelled on all three rules** (an unlabelled fixed axis reads as a fitted
  one), there is a **time axis** under it (weekday only where it crosses midnight, or the labels
  collide), and the reading under your finger is a **text line under the chart** on
  `RepoHealthTiles.tsx`'s crosshair rules — the selection is the reading's own TIMESTAMP, since this
  series grows at its end. **A gap is CUT, a rollover is CUT and drawn, and `usageMarksText` names
  each mark ONLY where it was drawn.** A rollover is two signals, never the scraped reset alone:
  the instant moved past `RESET_EPS_MS` (the CLI prints a wall-clock MINUTE and recomputes it as the
  window slides, so `!==` marked dozens of rollovers that never happened), **or the figure FELL past
  `DROP_EPS_PCT`** — the reading taken as a window rolls names no reset at all, so the instants
  either side are compared against an unknown, and inside one window the count only goes up. The
  burn rate / "full around" projection is **absent** rather than approximate. The per-day chart has
  `total` / `mix` / `share` — `share` is the only reading that moves when the total does not — plus a
  **7-day mean over CALENDAR days, computed over the whole series then clipped**. The time series
  may be drawn as **columns or as an area** (a second, separate chip pair: form is not the question):
  an area is only ever drawn over the GAP-FILLED series, because this is the one series here whose
  holes are measured zeros (`fillSeries`/`fillMix`) — a normalized stack is still **cut** at an
  empty bucket, and a window too wide to fill loses the *area* chip rather than dimming it. `Per hour` is the
  same chart with `stepMs`; the clock face is **categorical, all 24 slots drawn**. `LimitWindows` leads because only those two percentages have a CLOCK on them.
  **The hero never appears without the split.** Prices exist on the CLAUDE view
  ONLY and always as a labelled COUNTERFACTUAL off one dated table. A week is a WINDOW you step
  through; inside one week gaps are FILLED, and the cumulative line stops at TODAY.
  **TWO scope controls, because there are two kinds of window**: `RANGES` scopes the TIME CHARTS
  (calendar, ending today, totals stay all-time); the row under the hero scopes the READOUTS to a
  LIVE rate-limit window — the answer to "50% of WHAT". `usageCut.ts` is that cut, pure and
  node-tested: a window is `resetAt − len`, and because the finest bucket on record is a `TokenHour`
  the cut **starts at the TOP of the hour the window opened in and SAYS how many minutes wider than
  the window that is** (`cutSpan`) — exact about a stated span, never approximate about the window.
  **Three refusals, three sentences, never a zero** (`cutRefusalText`): no reset instant · the
  reading's window ALREADY RESET (a real scrape describing the previous five hours is the dangerous
  one) · the hour record does not reach back. A refused window has **no chip**. The cut carries
  tokens, cost and a model split (host `TokenHour.byModel`, `modelSplit` false on an older host ⇒ a
  sentence, and **one EMPTY split is a quiet hour, not an old daemon**); it carries **no repos and no
  conversation count** — an hour bucket has neither — so *By repo* is ABSENT with its reason and the
  hero counts TURNS instead. `WindowTiles` is its own four tiles, not `Tiles` filtered: four of
  those six are facts about the corpus. **One `windowCut` call feeds both** the figure under the
  limit bar (`WindowUsed`, a full-width button — a figure on a control is a filter) and the chip's
  cut.
  **And every window BEFORE this one is a BOX** (`WindowHeats`/`WindowHeat`/`WindowStep`,
  `usageCut.ts`'s `windowSpecs`/`windowGrid`/`seriesCut`/`heatFrac`/`heatStep`, host
  `GET /api/tokenwindows`): 3% of a window is a number with nothing to compare it against, and the
  only history either window had was a 24-hour strip of scraped PERCENTAGES. **The host folds them**
  — the document ships a fortnight of hours, so this side can cut the window running now and nothing
  older — but **the GRID goes UP** (`anchor` is the scraped reset, `lenMs` is `LIVE_WINDOWS`'), so the
  two windows' semantics stay in one table here. **The hour rule is repeated, never re-decided**: a
  cell counts from the top of the hour its window opened in, so cell 0 and the line under the limit
  bar cannot be two numbers about one five hours — the price is that neighbours share that hour and
  the caption SAYS the boxes do not sum. **A window that ran nothing is a real empty box; one the
  record does not reach is an OUTLINE** (`oldestHour` tells them apart, and the grid ENDS at the
  record rather than drawing unknowns back to the epoch). **TWO grids, never one scale** (a week holds
  ~34 five-hour windows), each legend naming its own busiest box; the ramp is **one hue at five
  alphas off `--accent-rgb`**, never the categorical `--chart-*` slots (those mean identity), and
  **square-rooted** with the caption saying so. A tap is the same `{id, back}` the stepper writes —
  ONE idea of what is selected — and **both ends of the stepper are SENTENCES** (nothing newer has
  happened · the record stops here), never a dimmed arrow. A past window is the SAME `WindowCut`, so
  `cutSpan` counts to its own reset rather than "to now" and the tiles swap *Resets in* for *Ran
  until*; **`hours` is OPTIONAL on a cut now** (absent = the host folded it, never "there were none")
  and `isCut` keys on `openedAt`. An older host answers nothing and the screen is pixel-identical.
