---
name: web-numbers
description: waterplane phone client — context, tokens, cost and health as screens (packages/web/src and packages/extensions/token-stats/web): ContextLimits.tsx (the threshold form), ContextSheet.tsx + ContextGraph.tsx + contextPlot.ts, TokenComposition.tsx, the session-cost reminder (costNotice.ts), TurnCostCard.tsx, BudgetField.tsx, TokenStatsSheet.tsx + usageCut.ts, RepoHealthTiles.tsx + repoHealthPlot.ts, HealthIndexChart.tsx. Load BEFORE drawing or wording any token, context-window, usage, dollar or health figure on the phone, changing a chart's axis, palette or control grammar, or touching the context-weight threshold form. A total is never printed without its split, and a readout refuses nothing.
---

# web — the numbers screens

Context, tokens, money and repo health as things a person reads: the context window as a shape, the composition strip, the cost reminder, the two usage ledgers, the health series and score, and the threshold you can argue with. Router: `web`. Reasoning and the long form of every bullet below: [web.md](../../../docs/notes/web.md) (*Moved out of skill `web-numbers`*), [charts-architecture.md](../../../docs/notes/charts-architecture.md), [token-stats-architecture.md](../../../docs/notes/token-stats-architecture.md).

- `ContextLimits.tsx` — the THIRD answer, on the one row that quotes a number: argue with the
  threshold. **The form opens on the STORED override, never on the effective number** — those differ
  whenever the host's env is doing the work, and pre-filling from `effective` turns *inheriting 20k*
  into *pinned at 20k* on the first Save. **A blank field is “inherit”, not zero.** Every value names
  its source (default / set on this host / set for this repo); **nothing is greyed out** — a refusal
  is a sentence, and the host refuses too (this validates for speed, never as the gate). The host
  answers with the RE-RUN report, so the row restates itself.
- `ContextSheet.tsx` + `ContextGraph.tsx` + `contextPlot.ts` — the context window as a SHAPE, geometry
  and sentences pure and node-tested (code: `contextPlot/cplot*.ts`; [charts-architecture.md](../../../docs/notes/charts-architecture.md)).
  **One y axis for every graph: 0 to 100% of the model's window**, never re-fitted to the data,
  falling back to tokens **while saying so**. Row spark: top = `autoCompactSetTok`. The TIME axis is
  piecewise and the break is DRAWN. Colours are VALIDATED, not chosen; there is a table twin.
  **ONE CONTROL GRAMMAR, shared with the all-sessions screen and written above both returns**: the
  head holds chrome only (back, re-read) · a body-changing choice is a `.ts-filter` row of LABELLED
  `.key` chips lit `.key.active`, directly above the first thing it changes · a section-scoped choice
  is `.ts-seg-chips` in that `.section-head` · a running verb says so in its own glyph, never
  `disabled`. **The context sheet has NO `show as` / `stack by` rows**: areas ALWAYS stacked by token
  kind (flat only where the host sends no kinds); the by-model stack lives on the all-sessions screen.
  **Long method prose FOLDS into `details.hint-more`; an ABSENCE never does** — a mean that is not
  drawn, a chip that is not offered, an outlined box standing for *nobody measured this*:
  `Unavailable.tsx`'s rule applied to prose. `axisNote` is the caption, one per `windowFrom`:
  **`"config"` is ATTRIBUTED, never presented as a measurement** (what the backend's configuration
  STATES; a local runner may hold less). The sheet is gated on derived `contextSeries`, not the live gauge.
  **CHARTS TOGETHER, then panels, then captions** — name → spend chart → context chart + summary +
  legends → agent lanes + readout + legend → composition strip → cost panel (one door) → expired
  cache → compactions → captions. The three charts share one `makePlot` x axis; charts are NAMED
  (`.ctx-chart-title`); every prose `.empty` also carries `.ctx-note`.
  **`/compact` is ONE door, on the context chart's name**, drawn ONLY where
  `sessionCan(subject, "slash")`, absent with its reason in TEXT, and **`costDoorsText(false)` is
  NULL** (a sentence naming a door that is not there is the same lie in prose); sent through
  `submitInput` with an ackId, aimed at the SUBJECT, never the attached session. **TWO doors, one
  subject** (`ctxSid`; null = the attached session): a launcher row's cost tile is a CONTROL —
  `role="button"` + the stopPropagation PAIR (click AND the `pointerdown` that arms the row drag) —
  opening the graph for THAT row **without attaching it**; its affordance is the tile's own edge,
  never a dotted underline or a `title`.
  **A TOTAL IS NEVER PRINTED WITHOUT ITS SPLIT** — 96% of every token here is a cache read, so
  "16M spent" alone is out by two orders of magnitude. `ContextSeriesDoc`'s `split`/`agentSplit` are
  `TokenTotals` from the host's SAME pass (`tokenTotal(split)` IS `usageTok`, tested — never a
  second tally), drawn by the SHARED `TokenComposition.tsx`. **`split.turns` is REQUESTS, not
  prompts**: `cacheReading` divides by it on both screens. The bar folds the agents IN and says how
  much (`splitNote().lead`). Absent, never zeros.
  **The all-sessions screen stacks by model too, and its repo bars always do.** `MixSeries` takes a
  value ACCESSOR so `stacks`/`stackAreas` serve kinds, models and agent COUNTS from one
  implementation; **the readout and the legend follow the split**. Two `ModelLegend`s exist
  (`ContextGraph.tsx`, token-stats `charts/Bars.tsx`) — unify before adding a third; the chip row
  SCROLLS rather than wraps.
  **The row's spend chip is MONEY**: `costChip(spark.costUsd) ?? usageChip(spark.usageTok) ??
  fmtTokensFine(end)`, every rung ABSENT rather than zero (rules: shared `sessioncost/`, skill
  `shared`); tokens move into the title with `costText`; the curve stays in tokens.
  **`stackBands` geometry, four rules**: the LINE stays and the stack's top edge IS it · the context
  chart stacks only the three kinds that ARE context · the spend chart stacks `cum`, never a cumsum
  of `kinds` over THINNED samples · bands in palette order, bottom first, accumulated in VALUE space.
  **A model's hue is FIXED app-wide by family** (`modelHue.ts`; the tail is ONE grey band), never a
  volume rank. **A band with nothing in it is dropped, and so is its legend entry.** **Subagents are
  SWIM LANES on the same axis** (`agentLanes`): first-fit packed in PIXELS, coloured by `modelSlots`,
  dearest outlined in ink, the PICKED bar ringed in `--accent`, a tap answering in a TEXT line
  (`agentReadout`). A `running` agent runs to the right edge and FADES, is out of the median. Their
  SPEND is the grey band on the spend chart (`agentSpendBand` over `agentCum`); an undated agent is
  in the totals, off the chart, and `agentUndatedText` SAYS so. **Prose splits `{lead, more}`**
  (`spendNote`, `splitNote`): the lead is only absences and where-the-agents-are; method folds.
  **The `Expired cache` panel is what the GAPS cost**, from shared `sessioncost/`, drawn only when
  it happened (no zero row), and on the all-sessions screen under the whole-corpus cut ONLY. **A
  rebuild is not drawn on any chart**; in the values view it wears the INK dot, never the usage-limit
  red (that would claim the account refused a request). **`CompactionPanel` is what the ticks DID** —
  two rows split by trigger, tokens AND money on each side (read and write prices differ up to 20×);
  `compactionMethodText()` FOLDS, kept, never deleted; `compactionWindowText` sits DIRECTLY under the
  multiple.
- `PerRequestSection.tsx` + `perRequest.ts` — $/request: a RATIO OF SUMS (extension `token-stats/web/`).
- `RepoHealthTiles.tsx` + `RepoHealthChartKit.tsx` + `RepoHealthStack.tsx` + `RepoHealthWeight.tsx` + `repoHealthPlot.ts` + `repoHealthWords.ts` —
  (also `RepoHealthLongest.tsx`, `RepoHealthMags.tsx` — reuses `repoHealthPlot.ts` geometry and `RepoHealthStack.tsx`'s `StackChart`, never a second top-edge-is-total stack — `RepoHealthOwn.tsx`, `RepoHealthTable.tsx`) **the repo-health series as charts**, in region 2 of the repo-readings sheet (the sheet ⇒ `web-work`).
  Hand-rolled SVG on the `ContextGraph`/`contextPlot` pattern, **no charting library**: geometry
  pure in the `.ts`, paint in the `.tsx`, every sentence in the words module. **The TOOL states, you
  draw** — `repoHealthPlot.ts` has NO imports and `repoHealthPlot.test.mjs` asserts BY TEXT that it
  cannot name a percentile, rank, slope, median, regression or `.sort()`; a number a chart wants is
  added to the TOOL (`tools/repohealth/readings.mjs`).
  **One tile per `plot.series`** (the engine's readings; today seven, incl. `context.skillCount`
  which is `plain`: drawn, never ranked) — the VALUE is the answer, so a tile whose curve cannot be
  drawn still prints its number; `retouch.rate` **with its denominator beside it**. **A TWO-COLUMN grid**: compact (value, slope,
  32px curve, no scrub) until a tap opens ONE across both tracks with the full anatomy. **Ink at reduced opacity, end dot in `--accent` ringed in `var(--panel)` — never
  `--ctx-series`** (that means "this conversation's tokens"). **x is the READING INDEX, not the
  calendar**: `weeks` folds to each week's last reading (`foldPlot`), `commits` draws every
  day-reading — ONE x-axis row per region, persisted (`healthAxis`), the caption naming the mode; day ticks are the days AT three positions in reading order
  (`indexTicks`, `want` with NO default); **a null CUTS the line** — never interpolated, never at
  zero; **a flat series draws at MID-height** (`(v-lo)/(hi-lo)` is 0/0 → `NaN`); **y is fitted per
  series** except the stack and the dumbbell (zero-based magnitudes) — and **both fitted bounds are
  PRINTED** (one label for a flat series), because an unlabelled fitted axis reads as zero-based.
  **Crosshair: the INDEX is state, pixels derived each render**; it snaps only to drawn readings and
  **its answer is a TEXT LINE under the chart** (day · value · `sha7`), never a floating box — the
  ONLY route to a past day's figure, so always present; untouched it reads the LATEST reading, and
  the drag instruction is said ONCE per region (`SCRUB_HINT`, kit
  `chartWords.ts`, is ONE wording for every scrubbable chart; it stays import-free — node --test loads it bare — and extensions reach it via `@waterplane/kit`). On touch lifting does not clear it
  (`clearsOnLeave` is mouse-only; `pointercancel` RESTORES the prior pick). **Always-on weight = two
  stacked bands** in `TokenComposition.tsx`'s validated `SLOT`, top edge = the total, two-entry
  legend; bands accumulate in VALUE space and a column any band lacks is a hole in EVERY band.
  **Per-area `expected → ceiling` dumbbell**, latest reading, ONE x scale; `subs: 0` is a number, not
  a zero-length bar. **Magnitudes (`RepoHealthMags.tsx`) in the OPEN, never behind a fold** — lines by
  package as a STACK, source files and production deps as curves with **no rank and no slope beside
  them**, the longest-files tape in the tool's order; **p95 and the longest file are WORDS, not
  rules**. `RepoHealthTable.tsx` prints the same figures as TEXT — last 14 readings, oldest first,
  packages folded by `foldPartSeries` (the stack's fold) — because two band hues are under 3:1 on
  light and a crosshair answers for ONE day. **No *open the drawn page* button**:
  `.claude/outbox/repohealth.html` is a SENTENCE naming the full path (`drawnPageWords`).
  **Every metric carries a `?`** (`HintChip.tsx`, ids `repohealth.<series key>`): a missing entry is
  a failing test in `tools/repohealth.test.mjs` and `scripts/e2e-hints.mjs`, because a chip with no
  def renders NOTHING. **No coloured band, zone, grade or red region, and no `--warn`/`--dead` on
  the series tiles**: the slope is a glyph in `currentColor` with its word (rising LOC and rising
  hatches are opposite news); the index's contribution bars are the ONE hue exception
  (`--hix-up`/`--hix-down`). Four validated slots, **never a generated fifth** — `foldPartSeries`
  folds the tail into one hueless band, and a slot follows the ENTITY. **Each card and tile measures its OWN box** (`useBoxWidth`, a
  CALLBACK ref). **Not plotted, and said so with the reason**: tripwires, path lists, and
  `dups.pairsPerKloc`/`cochange` (a curve would invite a rank). **The longest file LEADS the region**
  (`RepoHealthLongest.tsx`): one run per HOLDER via `holderGeom`, **slots to the NEWEST holders**, a
  handover marked **only between two NAMED readings**; no `paths` on the wire ⇒ one ink run and the
  caption says so. `repoHealthWords.ts` is under a test banning verdict words AND status tokens:
  **`rankSentence` is the ONE fraction→percentile conversion** and **a null rank returns the tool's
  own reason, never a `0th`**; absences are a sentence each (`repoHealthPlotAvailability`, three
  states), and a mixed `PREREG_VERSION` still DRAWS the rows on disk while saying so. **Every reading
  says WHOSE it is, once per group as a heading, never a badge per tile**: the engine's
  (`source: "central"`) and the repo's own (`plot.own`, `RepoHealthOwn.tsx`, `ownShow`'s three
  states; attributed to the repo, never the sheet's verdict; absent ≠ declares none).
- `HealthIndexChart.tsx` + `healthIndexWords.ts` — **the health SCORE on
  the phone** (`HealthIndexSection.tsx` fetches it), the top of the repo-readings series region: a fixed 0–100 axis labelled on every rule;
  the good line is the repo's context warn line (16,000 by default), shared's `healthindex.ts` is the
  ONE layer that judges and `healthIndexWords.ts` computes no index, move or percentile — it rounds, lays out pixels and words. **The only STATUS colour is an alert**
  (`--dead` severe / `--warn` warn) with icon AND words — the one exception to "no status colour"
  above. Absent = NO chip, never `Health 0`. No socket in the chart (VS Code reuses it).
- `TokenComposition.tsx` — `KindBar` + `CacheVerdict` + the validated four-slot `SLOT` palette
  (code: `kit/chart/`), the ONE strip wherever a token total is printed. **It decides no numbers**:
  bag, denominator and formatter are the caller's, because the two ledgers count differently and one
  has no prices — and `whole` is not always the sum of the bag (a contributed ledger's fifth kind has
  no hue; it rides as a `children` legend entry with no swatch).
- **The session-cost reminder** (shared `sessioncost/`, `costNotice.ts`, `sessionCostPill`, `costTag`,
  one toast, the context sheet's top panel) — **what a turn here costs against a fresh one, as a
  readout.** Deliberately NOT folded into `contextPill` (that says how much window is LEFT, this what
  the next turn PRICES AT). Absent until there is something to say and silent for the first
  `MIN_TURNS`. Two weights of **`--warn`, never `--dead`/`--limit`**. The toast fires once per
  session per level step up, only for the session on screen — `shouldNotice` is pure and tested
  (`active` is a fresh object every frame). **Nothing here disables, intercepts or refuses
  anything.** Its sibling is a LARGE RUNNING SUBAGENT (`ContextSpark.liveAgentTok` ≥ shared
  `AGENT_LARGE_TOK`, worded by `liveAgentText` only): the `liveAgentTag` chip, a sentence on the
  context sheet, one toast per CROSSING (`shouldNoticeAgent`); recency re-asked on the PHONE's clock
  (`liveAgentAt`, `AGENT_LIVE_MS`). Both toasts' effects live in `core/session/useCostNotices.ts`.
- `TurnCostCard.tsx` —
  (with `TermCostStrip.tsx`, `lastTurnCost.ts`, `turnMix.ts`, `NextTurnCost.tsx`) **per-turn cost: ONE component for both views** (reader fold under every turn, terminal strip under
  the newest turn WITH figures, in two fixed heights — a resize repaints the PTY). **Absent beats
  derived**: no figures ⇒ no strip, never a row of zeros. `turnMix` hues by `modelHue` (fixed per
  family); `NextTurnCost` is a reading, never a gate, shared with VS Code (`noDoors` for a shell with
  no doors). `TermCostStrip` reads the reader's IndexedDB transcript copy, refreshed by turn-end `prefetchTranscript`, never per PTY byte; a found turn stays found.
- `BudgetField.tsx` —
  (with `SessionBudgetSheet.tsx`, `budgetInput.ts`) **the session budget**: shared
  words it (never re-worded here); **unknown never trips** and says why in text; blank is no budget; a
  percent is “≈”; with no valid cap the set button is ABSENT and a sentence stands there; clear is a
  `ConfirmButton`; “Set” is said only when the desktop answers with the cap (`budgetConfirmed`). `budgetInput.ts` stays top-level (Send sheet, launch ask, context sheet all draw `BudgetField`); it never imports `features/sessionBudget`.
- `TokenStatsSheet.tsx` + `TokenInsights.tsx` + `statsInsights.ts` + `statsPlot.ts` + `usageCut.ts` + `guests.ts` — **now
  `packages/extensions/token-stats/web/`** (plot + strip in `kit/chart/`, `statsPlot.ts` a barrel over
  `kit/chart/stats/splot*`; [token-stats-architecture.md](../../../docs/notes/token-stats-architecture.md)).
  **SEVERAL ledgers, never one number.** A SOURCE PICKER (not a filter ⇒ **no counts on the chips**):
  Claude's, plus one chip per CONTRIBUTED ledger view (an extension's `ledgerViews`, `guests.ts`),
  drawn only when `hasData`, never greyed, resets each open. **The docs never meet in one reducer** —
  different accounting, so a merged total is the most convincing wrong number here. A contributed view
  owns its document's rules (its README); the rule it inherits is **no price it cannot source**
  (`pricing.ts` is claude's table).
  **ONE STICKY SPAN for every box** (`span.ts`, R-usage-025); only the compact NOW block is
  unfiltered. Calendar spans are CALENDAR days; what cannot be cut says so. Insights are ABSENT unless
  measured and large, never a control; costliest conversations are drawn IN MONEY. **`TableView`
  takes the window CUT.** **The hero never appears without the split.** Prices exist on the CLAUDE
  view ONLY, always a labelled COUNTERFACTUAL off one dated table. A week is a WINDOW you step
  through; gaps are FILLED inside one, the cumulative line stops at TODAY.
  **Limit windows** (`LimitWindows`, `UsageSpark`): a CHART, not a sparkline; the 0–100 axis is
  **fixed, never fitted** AND **labelled on all three rules**; a time axis under it; the reading
  under the finger is a **text line** on `RepoHealthTiles.tsx`'s crosshair rules (selection = the
  reading's TIMESTAMP). **A gap is CUT, a rollover is CUT and drawn, and `usageMarksText` names each
  mark ONLY where drawn.** A rollover is two signals, never the scraped reset alone: the instant moved
  past `RESET_EPS_MS` (shared `burn.ts`) **or the figure FELL past `DROP_EPS_PCT`**. The burn rate /
  “full around” projection is **absent** rather than approximate. Per-day `total`/`mix`/`share`, a
  **7-day mean over CALENDAR days, computed over the whole series then clipped**; time series are
  **columns or an area** (an area only over the GAP-FILLED series `fillSeries`/`fillMix`; a normalized
  stack stays **cut**); a window too wide loses the chip rather than dimming it; the clock face is
  **categorical, all 24 slots**.
  **Two KINDS of span, one control**: a live rate-limit window or calendar days. `usageCut.ts` is the
  live cut (pure): a window is `resetAt − len`, the cut **starts at the NEAREST hour to the instant it
  opened** (`windowStartHour`, shared — ONE helper for every window edge) and **SAYS which way it errs**
  (`cutSpan`, `leadClause`). **Three refusals, three sentences, never a zero** (`cutRefusalText`): no
  reset instant · the reading's window ALREADY RESET · the hour record does not reach back; a refused
  window has **no chip**. The cut carries tokens, cost and a model split (`modelSplit` false on an
  older host ⇒ a sentence; **one EMPTY split is a quiet hour, not an old daemon**), **no repos and no
  conversation count** — so under a window *By repo* is the host's cost window and the hero counts
  TURNS. `WindowTiles` is its own four tiles. **One `windowCut` call feeds both** the figure under the
  limit bar (`WindowUsed`, a button — a figure on a control is a filter) and the chip's cut.
  **Every window BEFORE this one is a BOX** (`WindowHeats`/`WindowHeat`/`WindowStep`, `windowSpecs`/
  `windowGrid`/`seriesCut`/`heatFrac`/`heatStep`, host `GET /api/tokenwindows`): the host folds them,
  **the GRID goes UP** (`anchor` = scraped reset, `lenMs` = `LIVE_WINDOWS`'), cell = `[windowStartHour
  (opened), windowStartHour(reset))` so neighbours TILE. **A window that ran nothing is a real empty
  box; one the record does not reach is an OUTLINE** (`oldestHour`). **TWO grids, never one scale**;
  the ramp is **one hue at five alphas off `--accent-rgb`**, never `--chart-*` slots (those mean
  identity), **square-rooted** with the caption saying so. **Both ends of the stepper are SENTENCES**,
  never a dimmed arrow. A past window is the SAME `WindowCut`; **`hours` is OPTIONAL** (absent = the
  host folded it) and `isCut` keys on `openedAt`.
- `WeekCard.tsx` + `weekBands.ts` — (chart: `charts/RepoHourChart.tsx`) **"Where the week went"**; the cost
  view opens on the week since the reset and “By repo” follows ANY window. A tapped hour is a FILTER
  (`weekCut` feeds column AND list; “n of N” + clear). Four hues follow their repo (`repoSlots`), the
  rest one grey; the % axis is fixed 0–100 and LABELLED. ONE points calibration per screen, made in
  the body, absent with its refusal sentence.
- `PeriodCard.tsx` + `periodWords.ts` — the `$` chip and “Where the month went” for api/cloud accounts: [web.md](../../../docs/notes/web.md).
