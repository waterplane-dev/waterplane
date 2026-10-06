# Token statistics: target architecture

`TokenStatsSheet.tsx` is 3268 lines and is the last big screen in core. It moves to
`packages/extensions/token-stats/` and is split there. This note is written before the first cut
(refactoring skill, step 1); the plan it serves is item 5b of
[extensions-plan.md](../analysis/extensions-plan.md). Reasoning for the rules it leans on:
[refactoring.md](refactoring.md), [web-architecture.md](web-architecture.md).

## Layers

```
extensions/token-stats/web   (the screen)
        |  imports only
        v
   sdk/ (ledgers, explainCost)  +  kit/ (kit/chart, until, ResourceState)  +  @waterplane/shared
        |
        v
      core
```

- **The extension imports only `@waterplane/sdk`, `@waterplane/kit`, `@waterplane/shared`, react, lucide-react and
  files inside its own folder.** Pure `.ts` siblings are imported with `.ts`. Nothing in the
  folder value-imports an alias that a node test loads: `usageCut`, `statsInsights`, `guests` import
  only `@waterplane/shared`; `perRequest.ts` takes `import type { DayPoint } from "@waterplane/kit"`.
- **Core never imports the extension** except the one registry line
  (`import { manifest as tokenStats } from "../../../extensions/token-stats/web/index.ts"`).
- Extension id and folder are `token-stats`: ids are lower-case (`FEATURE_SHEET_RE`, `PLUGIN_ID_RE`
  are `^[a-z][a-z0-9-]`), and webshape requires manifest id = folder name.

## The one API: `sdk/ledgers.ts`

Module-level and read-only (not on `CoreApi`):

- `ledgers.tokenStats` — `CachedRead<T>`: `read(fresh)`, `fromCache()`, `toCache(v)`. The cache is
  the PHONE's own IndexedDB copy, never the ledger.
- `ledgers.views()` / `ledgers.viewDoc(def)` — the ledger views OTHER extensions contribute
  (`FeatureManifest.ledgerViews`, a `LedgerViewDef` each: backend id, label, `hasData`, `summary`,
  `rescanTitle`, `cache` shape + `usable`, `View`) and a `CachedRead` of each one's document
  (`GET /api/tokenstats/<id>`, cached under the id). `views()` is bound by `core/extensionPoints.ts`
  (the one registry reader; importing the registry from the SDK is a module-load cycle).
- `ledgers.usageLog(hours)`, `ledgers.tokenWindows(specs, fresh?)` — the two other host reads.
- `ledgers.refreshUsage(quiet?)` — moved verbatim from `features/tokens/actions.ts`.
- `explainCostPrompt` / `CostSubject` re-exported from `sdk/index.ts`.
- The live `/usage` reading is `useCore().world.usage`; `App` calls `useUsage()`, so it re-renders
  on `usage.status`.

## Kit: `kit/chart`

`statsPlot.ts` (+ its test), `TokenComposition.tsx` and `useBoxWidth.ts` move to
`packages/web/src/kit/chart/` behind `kit/chart/index.ts`; `kit/index.ts` re-exports it, plus
`until` and `type ResourceState`. `statsPlot` is shared with core only through `TokenComposition`
(`compose`). **Core importers use the direct path** (`./kit/chart/TokenComposition`), never the
barrel, so the kit never becomes a cycle through `Sheet`. No shim files at the old paths.

## The sheet id: an adopted core sheet

The sheet keeps the core id **`"tokens"`**, `persisted: true`, declared by the extension. Four core
doors open it (launcher, session header, `TokenSettings`, `features/tools`), `#o=tokens` is a
persisted overlay, and the usage counters `overlay:tokens` / `action:tokens.explainCost` stay
continuous. `core/sheets.ts` wraps an ExtBoundary only for `^feature:` ids, so rendering is
identical. webshape holds it: `ADOPTED_CORE_SHEETS = { "token-stats": ["tokens"] }` — an extension may
declare exactly those literal core ids and `persisted` must equal membership in `PERSISTED_OVERLAYS`;
every other extension sheet is `feature:<id>/<name>` and never persisted. A second test holds that
every sheet id across features and extensions is declared once (the table's Map lets the last win
silently). Follow-up, not here: an ExtBoundary around adopted sheets.

`features/tokens` stays core: `store.ts` (usage store, `useUsage`), the `usage.status` handler,
`TokenSettings.tsx`, README. It loses `TokensSheet.tsx`, `actions.ts`, its `sheets:` entry and the
`refreshUsage` export.

## Layout and cap

Every extension web file is held to **900 lines** (`webshape`). While the root was being cut it was
exempt by a ratchet (`MAX_TOKENSTATS_LINES`, lowered in every commit); the ratchet is deleted now that
the root is under the cap, so the cap alone governs.

```
web/index.ts  TokensSheet.tsx  TokenStatsSheet.tsx (root: the header note and the two cached reads)  constants.ts  when.ts
web/LimitWindows.tsx  WindowHeats.tsx  UsageSpark.tsx  TokenStatsBody.tsx (every hook)
web/TotalsCard.tsx  OverTimeCard.tsx  Readouts.tsx  TableView.tsx  guests.ts (contributed tabs)
web/charts/{DayChart,MixChart,Bars}.tsx
web/{TokenInsights,PerRequestSection}.tsx  web/{usageCut,perRequest,statsInsights}.ts + tests
```

## Region inventory and cut order

Line numbers are the pre-move file's; re-derive with `grep -n "^function\|^export function\|^const "`.

| Region | Becomes | Cut |
| --- | --- | --- |
| LimitWindows, WindowUsed (~261-466) | `LimitWindows.tsx` | C5 |
| WindowScope, HEAT_*, WindowStep, WindowHeats, WindowHeat (~467-663) | `WindowHeats.tsx` | C5 |
| SPARK_*, UsageSpark (~664-961) | `UsageSpark.tsx` | C5 |
| the second ledger's view (~2919-3268) | its own extension since 2026-10-04 (a `LedgerViewDef`) | C6 (landed after the charts) |
| DayChart, AgentDayChart, MixDay, MixChart, ClockChart, Bars, ModelLegend (~2233-2840) | `charts/*` | C7 (landed first: the second ledger's view draws DayChart, now lent as `LedgerViewParts`) |
| WeekNav, Composition, Tiles, WindowTiles, TableView, NumRow | `Readouts.tsx`, `TableView.tsx` | C8 |
| TokenStatsBody state + two JSX regions | `TokenStatsBody.tsx`, `TotalsCard.tsx`, `OverTimeCard.tsx` | C9 |

## Hazards

- **Hook and effect ORDER is behaviour**: `LimitWindows`' mount-once `useEffect([])` quiet re-scrape,
  and `TokenStatsBody`'s week-seeding effect, keep their position. `tools/tokenstatspins.test.mjs`
  pins the hook sequence of the three stateful components, file-agnostically.
- Callbacks: `onRefreshUsage` is `ledgers.refreshUsage` (same body, reads core live); no new
  `useCallback` deps.
- Import prunes can alias the wrong symbol (lucide set: `BarChart3, ChevronLeft, ChevronRight, Clock,
  Gauge, Grid3x3, Loader, RefreshCw`) — render-check, do not trust tsc.
- A hook-free extracted card takes its render values as props; a `boxRef` goes onto the same element.
- Behaviour-neutral throughout: no fixes on the way.

## As landed

Cut order was C5 limits, then charts, then opencode, then readouts and table, then the body: the
opencode view draws `DayChart`, so cutting it first would have made it import back into the root it
was being cut from. The body keeps every hook and effect (its hook sequence is pinned unchanged by
`tools/tokenstatspins.test.mjs`); `TotalsCard.tsx` and `OverTimeCard.tsx` are hook-free and take
render values as props, with the width probe's ref passed onto the element that always carried it.
The helper words of the readouts live in `when.ts`, the shared constants in `constants.ts`. A headless
412x915 render of the finished split matched the pre-split commit across chart/values, cost, the
mix/share/area views, week and one step back, 90 days, all time and a reload on `#o=tokens`.

## The scan does not hold the event loop

`tokenstats.ts` yielded every 64 re-read files, but ONE big log was still one synchronous
read + decode + split + parse: measured 0.5-2.4 s of stall on a scratch host, delaying a phone's
answer by over 200 ms. The disk half now lives in `host/tokenscan.ts`: the directory walk, the stats
(one directory's in parallel, consumed in walk order) and the reads are the async calls, and
`summarizeLog` reads a log in `SCAN_CHUNK` (4 MB) slices cut at the newline BYTE — which never
occurs inside a UTF-8 sequence, so each slice decodes exactly as the whole file did — handing the
lines over in order to the unchanged per-line rules and yielding every `SLICE_MS` (8 ms) of
parsing. Only the stat'ed `size` is read, as before. `packages/host/test/tokenscan.test.mjs` pins it:
the document over `fixtures/tokenscan.mjs` equals `fixtures/tokenscan.expected.json`, which the
one-buffer reader produced before the change; every slice size from 3 bytes up agrees; and the
longest stall on a 28 MB log is held under 60% of a one-buffer read of it, measured in the same run.

## Local models, all backends, and your own prices

**claude-local writes into Claude's ledger.** It is the same binary pointed at another runner
(Ollama), so `qwen3-coder:30b-64k`'s tokens are in the same jsonl logs `tokenstats.ts` reads, and
the Claude Code tab used to count them into a hero read as "what Claude did". There is no second
ledger to open, and a second tally would drift — so both tabs are CUTS of the one ledger by model
id, off the per-model buckets the store already keeps (`TokenGroup` per model, `TokenDay.byModel`,
`TokenHour.byModel`, `TokenGroup.byModel` on repos). No rescan, no store version bump.

- **The split** is `shared/pricing.ts`'s `isAnthropicModel`: Claude wherever it was served
  (`claude-…`, a Bedrock `us.anthropic.claude-…`, an OpenRouter `anthropic/claude-…`) versus
  everything else. Wider than `normalizeModel` on purpose — a Bedrock Claude id is unpriced but
  still Claude's.
- **Claude Code tab** (`web/localSplit.ts`, `splitLocal`): Anthropic models only by default, with
  the sentence *n of N models shown — … on the claude-local tab* and one button to show all N and
  back (not persisted, like the source). Totals, cost, unpriced, models, days (and a day's
  subagent launches), hours and repos are cut exactly through their `byModel`. What the store
  never crosses with the model — the clock face, the subagent slice, the costliest conversations,
  the expired-cache tally, the conversation count, the host-folded window boxes — is passed through
  and NAMED in the sentence, never silently mixed. A document with a bucket that has activity and
  no `byModel` (an older host) is refused in words and every model is shown.
- **claude-local tab** (`GET /api/tokenstats/claude-local`, host `localledger.ts`'s
  `localSliceLedger`): the complementary cut as a `BackendTokensDoc` — per model, per day
  (`days[].byModel`, additive), `sliceOf` saying where it is cut from, and `sessions` ABSENT (a
  conversation is not per model; the field became optional for this). Between the two tabs every
  token is shown exactly once and nothing sums them.
- **All backends** (`web/AllBackendsView.tsx` + `web/overview.ts`): one card per backend, each its
  own unit, its own total WITH its split and its last active day; a billed unit (Copilot's premium
  requests) on its own line. No cross-backend total, no shared axis, no bars that would imply one.
  An unreadable ledger is its sentence. The tab rides on the ledger-tab id state under `*all`
  (backend ids are `^[a-z]`), so it costs no hook; the split costs one `useState` + one `useMemo`
  at the top of `TokenStatsBody`, pinned in `tools/tokenstatspins.test.mjs`.

**The Local runner tab** (`web/LocalRunnerView.tsx` + `web/localRunner.ts`, host `localusage.ts`,
`GET /api/localusage`, wire `shared/wire/localusage.ts` + folds in `shared/localusage.ts`). Not a
backend's ledger: what the RUNNER (ollama) did per model, whichever backend asked — so it is never
summed with, and never shares a scale with, the token cards; its All-backends card says it overlaps
them. Per model over a span (`today · 7 days · 30 days · all`, a cut, so no counts on the chips):
**busy time with its split** (prompt processing · generating — the runner's own timings), loading
apart, **time to answer apart and labelled** (HTTP wall time, includes queueing), **requests with
their split by endpoint** (`/v1/messages` = claude-local, `/v1/responses` = Codex, …), **tokens with
their split** (prompt processed · reused from the runner's cache · generated), throughput only as a
ratio of measured sums, **memory** (resident typical = mean of samples, peak, GPU share, resident
time, context) and the machine while it was loaded (used typical/peak, least available, swap peak);
then one line per model per day. `model: null` is its own card carrying the host's one sentence.
Absent states are separate sentences (`localUsageNotes`): ollama not running, not asked yet, server
log not readable, no request seen yet. **The tab and the card exist only where the host has the
route AND has seen the runner or kept a day** (`showRunnerTab`) — an older host (404) or a desktop
without local models gets neither. The read costs one `useRemoteResource` beside `extraId` in
`TokenStatsBody`, pinned in `tools/tokenstatspins.test.mjs`; the tab rides on the same id state under
`*runner`.

**Your own prices** (`shared/pricing.ts`: `parseUserPrices`, `userRateFor`, `costOfAny`; host
`localledger.ts`: `readUserPrices`). A JSON file — `WATERPLANE_PRICES`, else `prices.json` in the
per-user config dir — of `{"<id or glob>": {"input", "output", "cacheRead"?, "cacheWrite"?,
"currency"?}}` per million tokens. Rules: **the list first** (`costOf` is asked before the file and
its answer returned unchanged — pinned over every listed id, dated and `[1m]` spellings, against a
catch-all glob); **no entry ⇒ a gap with the sentence naming the file**, never $0; **a kind with
tokens and no rate ⇒ a gap naming the kind** (never input-rate, never free); exact id beats a glob,
the more literal glob beats the looser one; **one total per currency, never converted**. A refused
entry is a sentence on the tab. On claude-local, a model the backend's catalogue lists as
`zeroCost` (loopback Ollama) is priced at zero FIRST, so a glob written for a hosted twin cannot
charge a local model. The prices reach the claude-local ledger only; the Claude Code tab's money is
still the Anthropic list and nothing else, and opencode stays unpriced.
