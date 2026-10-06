---
name: host-ledgers
description: waterplane host ledgers (packages/host/src): everything this desktop counts and keeps on disk. ctxlog.ts (window, spend, split, per-record cost, cold-start rebuilds, compactions, off the CLI's DATED log), ctxwindow.ts, tokenstats.ts (+ rate-limit windowSeries), budget.ts, sessionbudget.ts (dollars per window point), usagelog.ts, and how a second backend's store reader (opencode's, an extension) is asked for its transcript, context series, conversation id and ledger. Load BEFORE changing any token, context, cost, budget or limit number the host reads off disk, or adding a reader of either CLI's logs or store. A reading here degrades to ABSENT, never to a wrong number.
---

# waterplane host — the ledgers

The counted half of the host: every token, context, cost and limit figure this desktop keeps on disk, claude's and opencode's, kept apart and each degrading to absent rather than to a plausible wrong number. Router: `host`. Reasoning: [host.md](docs/notes/host.md).

- `ctxlog.ts` · `ctxcursor.ts` · `ctxupdate.ts` · `ctxproject.ts` · `ctxagents.ts` — how full the window has been, off the log, which is DATED. Refuses three
  plausible-and-wrong charts: a STREAMING turn repeated under one `message.id`, the rejection's
  `<synthetic>` zero-usage turn, and a SIDECHAIN. Incremental via a cursor whose `consumed` is the
  offset past the last NEWLINE. **The window is not in the log and is never invented.** It also
  answers **what the session SPENT**, which is a different number: `usageTok` is a RUNNING counter
  (never a fold over the capped `samples`) and includes the OUTPUT the readings exclude, and
  `agentUsage()` adds the Task tool's own logs, **read WHOLE, forward in `MAX_READ` chunks, never tail-capped** (a 246 MB agent log read from its tail showed 307M of 786M spent) — measured, 0 of 7,761 logs here carry an inline
  sidechain, the agents are all in `<conversation>/subagents/agent-*.jsonl`, and one real session
  read 271k in its window against 368M used, 355M of it in 19 agents. **Read BEFORE the "log has not
  moved" early return** (an agent writes while the parent log sleeps); a missing directory is a
  measured ZERO, any other failure publishes NO total rather than one the agents are missing from.
  **The SPLIT rides that same pass** (`split`, and the agents' own): four kinds plus a REQUEST
  count, accumulated behind the identical guards so `tokenTotal(split)` IS `usageTok` — never a
  second tally, which would drift a few percent and be unarguable. Its record rules must stay
  `tokenstats.ts`'s exactly (all-four-zero dropped, 1-hour tier READ), or the per-session and
  all-sessions screens divide by different denominators. **And the COST, PER RECORD** (`cost`,
  `unpriced`, on the agents too): the rate belongs to the model that ran the request and the day it
  ran on, both of which change inside one conversation — pricing `split` as a whole would charge the
  whole history at `cur.model`, the NEWEST (haiku is a fifth of opus, so a 5× error on the turns it
  gets wrong). Same bag as the split, so money and tokens cannot come from different records; an
  agent is priced on ITS OWN model. **Nothing priced ⇒ NO cost, never a breakdown of zeros** (a `$0`
  chip reads as free, and the row falls back to tokens), the money rides only where the subagent
  directory was READ (the `usageTok` rule — a bill missing eight agents is worse than none), and what
  no rate covered is COUNTED, never charged zero. **Every sample also carries WHAT it was made of and
  WHO made it**: `kinds` (this request) AND `cum` (the running counter) — both, because the spend
  chart is cumulative and a client-side cumsum over THINNED samples ends below the total printed
  above it; and a model INDEX into a table keyed by **ALIAS** (`normalizeModel` — the log spells one
  model several ways and raw ids band as two colours both reading `opus-5`; pricing still uses the
  RAW id). The table is sorted by volume on the way out and **every index is rewritten with it**, into
  NEW objects (`downsample` returns the cursor's own array under the cap). `agentUsage` keeps a
  **ROSTER** too (`runs`): one dated, sized, attributed row per agent log — an agent with no usable
  timestamp is in the TOTAL and off the roster (spend, not a moment), and `withAgentRuns` folds an
  agent's model into the table by alias, appending one the parent never ran (measured: a 45 MB
  opus-only parent with 34 fable/sonnet agents). **The agents are DATED, so their spend is placed in
  time**: `agentCumOf` merges every agent log's running total by timestamp into `agentCum` (≤120
  points, each bucket's LAST kept, so the last point IS `agentTok` — an undated record rides into its
  log's next dated one, an undated log onto the final point), and `agentEnvelope` folds the agents'
  windows onto the spark's own readings as `agentEnv` (max per reading's stretch).
  **And what the GAPS cost** (`coldStarts`, the same pass): a request that comes back to an EXPIRED
  prompt cache re-WRITES the window it had already paid to cache, at up to twenty times the read
  rate, and **the curve cannot show it** — the window is the same size either side. Recognised by
  `shared/sessioncost.ts`'s `isColdRebuild` and priced per record like everything else here, with
  the PREMIUM over re-reading kept apart from what the writes cost (only the premium is money the
  clock spent rather than the work). Two traps, both of which fake a WARM reading and both of which
  are defended twice: a **compaction in the gap** (the boundary flag AND the arithmetic — 31,579
  written against 347,182 carried-and-not-read is not a re-write of that window), and
  **`write > read`, which is the WRONG test** — a cold resume still reads the 32.5-36.8k
  tools-and-system preamble, so a 66k conversation comes back reading 36,770 and writing 30,638.
  The test is whether the read covered what was CARRIED (`REBUILD_READ` 0.8). **A rebuild is NOT a
  spark mark and not a tick on any chart**: there is nothing at that x for a rule to point at, and
  the two event colours are a validated pair whose red one means the ACCOUNT refused a request.
  Measured through this reader: **387 re-writes, 80M tokens, $712 above what re-reading would have
  cost**, on one desktop.
  **And what the COMPACTIONS did** (`compaction`, the same pass): shed = `Σ pre − post` (exact, and
  it CHAINS — each drop is measured against what the last one left); **saved = the shed × every
  REQUEST since, never per compaction** (one boundary shedding 173k with seven turns after it saved
  1.2M — the per-compaction reading understates a long conversation by the number of turns in it);
  rebuild = the cache write on the FIRST request after the boundary and no other. Priced per record
  like everything else here, the saving **as CACHE READS** and the rebuild as the WHOLE first write:
  both err AGAINST compacting looking worthwhile, deliberately, because the panel is read to decide
  whether to keep doing it. **The summarisation request is NOT in the log** (measured: no assistant
  record between the boundary and the next prompt; the summary is a `user` row with no usage), so
  the cost is a floor and nothing subtracts the two sides into a net. A boundary missing either end
  of the drop OR its trigger goes to `unmeasured` and enters no row — `count + unmeasured` minus the
  manual ones would assert a trigger nobody recorded. Measured over this desktop's 32 compacting
  logs, read whole: **20 compactions and $984 saved** (a tail read had said 19 and $748 — three
  logs past `MAX_READ` lost their earliest boundary). **Every log, parent and agent, is read WHOLE,
  forward in `MAX_READ` chunks, never from its tail**: a tail is a total that starts in the middle
  and looks complete, which is a wrong number, not a floor. One-time cost measured at 50-86 ms for
  28-47 MB logs; the size check on each poll is a `stat`, never a read.
- `transcript.ts` · `transcriptlog.ts` · `transcriptparse.ts` · `transcriptscreen.ts` · `transcriptturns.ts` — the CLI's conversation log as the reader's document (rules: `host-machine`'s `transcript.ts` entry; reasoning: host.md). A reading degrades to ABSENT, never to a wrong number; cut by subject like `ctxlog.ts` — location and record predicates / the parse / TUI chrome / turns the log does not hold.
- `ctxwindow.ts` — the most context each model has been SEEN to hold, persisted. **The mark only ever
  RISES**, and is never used raw.
- `tokenstats.ts` — every token every conversation on this desktop ever used. **Store VERSION 5**
  adds `FileSummary.r`, the same `isColdRebuild` tally crossed by hour×model (so the premium can be
  priced per model and day, like every other figure here) — present only on files that HAVE one, and
  the boundary rows are let through the `"usage"` pre-filter by a second substring test, because
  without them every post-compaction write reads as a cold rebuild. Three rules:
  **dedupe by `message.id`** (70% inflation otherwise), **skip `<synthetic>`**, **keep the four kinds
  apart for ever**. Subagents ARE counted. Per-file summaries, aggregate DERIVED. **Yields to the
  event loop every 64 reads** — 7 s of `readFileSync` is an outage for every live session. The
  hour×model cross key makes four more projections FREE — no rescan, no version bump:
  `TokenDay.byModel` (the only form a migration is visible in), `TokenHour.byModel` (the only bucket
  a LIVE rate-limit window can be cut out of — neither window is a calendar day; web `usageCut.ts`),
  `TokenGroup.byModel` on the REPO rows
  (why two repos with equal tokens differ several-fold in cost — opus is 2.5× sonnet, 5× haiku) and
  `TokenDay.agents` (subagents STARTED, a count of EVENTS never a slice of tokens; a transcript's
  launch is its EARLIEST bucket, so a long agent is ONE bar on the day it began).
  **A repo is `repoOfWorktree(cwd)`**: an agent worktree (`<repo>/.claude/worktrees/<name>`) is its
  repo's spend, never a repo called `agent-<id>`. **`top`** is the dearest `TOP_CONVOS` conversations
  with their `subagents/` transcripts FOLDED IN (the agents' slice kept apart as `agentTotals`), priced
  per record like every other figure and ranked by money, tokens where nothing was priced.
  **`windowSeries()` folds the SAME store into PAST rate-limit windows** (`GET /api/tokenwindows`;
  web `usageCut.ts` draws them as two heat grids): the wire carries a fortnight of hours, the store
  keeps every hour ever seen, so a weekly window from July can only be answered here — 103 KB and
  26 ms warm for 117 five-hour windows and 8 weeks, measured. **The GRID is the caller's**
  (`w=<id>:<anchor>:<len>`, echoed by id): a reset instant is scraped off `/usage` and a length is a
  property of the plan, neither being a fact about a ledger of hours. **`windowCells()` is the whole
  correctness and is exported for its own test** — it REPEATS the live cut's rule (an hour counts
  from the top of the hour its window opened in) rather than re-deciding it, which is why it answers
  a LIST: the opening hour is in that cell and the one before it. A window with no row RAN NOTHING;
  `oldestHour` is what tells that apart from a window the record does not reach.
  `packages/host/test/tokenwindows.test.mjs`.
- `budget.ts` — the ceiling before the wall. The ONE place that asks `shared/budget.ts`. **An explicit
  send, an ANSWER to a live box, and UPLOADS are never held** — the budget stops unattended work.
- `sessionbudget.ts` — **the per-session budget's calibrator**: one `windowSeries` per `/usage`
  reading (each window from `resetAt − 5 h|7 d` to `checkedAt`), its cost ÷ the window's pct =
  dollars per point (`shared/sessionbudget.ts`'s `sessionBudgetCal`, `weekUsdPerPct`'s rule), handed
  to `sessions.setBudgetCal` and on to `SessionInfo.budget.cal`. Cached on `checkedAt`; a failed fold
  keeps the last figure (it goes stale, and stale is `unknown`). **Never spawns a scrape** —
  `syncUsagePolling` polls while a live session has a percent budget. Hour-wide cells ⇒ "≈".
- **A second backend's store** (opencode's, the first) is read by a STORE READER its extension
  contributes by name (`api.storeReader`, `backends/readers.ts`'s `storeReaderFor`): the reader view
  (`sessions/record.ts`), the context series and tool details (`sessions/ctxseries.ts`'s `storeFor`),
  which conversation a session is in (`sessions/convid.ts`'s `detectBackendId` →
  `PluginStoreReader.discover`, exactly one candidate or none) and its ledger at
  `/api/tokenstats/<id>` (`PluginStoreReader.ledger`, served verbatim). Core keeps the poll contract
  and the watcher's cadence; every answer degrades to ABSENT, and a reader that left (its plugin
  switched off) answers nothing. opencode's readers and their rules: `packages/extensions/opencode/README.md`.
- `usagelog.ts` — the `/usage` readings this daemon took, KEPT, so the two limit windows have a
  history. **Nothing is ever scraped for it** — it records what was already fetched. The series is
  therefore IRREGULAR and a gap is a gap, never resampled. The reset instants ride along because a
  5-hour window rolling over is otherwise indistinguishable from usage being refunded. A failed probe
  is DROPPED, not recorded as two nulls; an unchanged reading is kept every `REPEAT_MS` anyway,
  because "flat for four hours" and "nobody looked" are opposite facts.
