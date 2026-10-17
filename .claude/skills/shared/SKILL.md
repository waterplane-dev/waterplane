---
name: shared
description: waterplane @waterplane/shared (packages/shared/src): the wire DTOs (a new message goes in its `wire/messages/` slice, never the barrel) and the pure logic both ends must agree on. Load BEFORE adding or changing a wire message or field, and before touching the send queue transport, the intent model and its verdict ladder, token/context/budget/cost maths, schedules, assessments, the health index, or any rule that the host and the phone must not word two different ways. Build it before type-checking host or web.
---

# waterplane shared package

Reasoning: [host.md](../../../docs/notes/host.md#packagesshared). Everything here is pure, runs on
both ends, **degrades to ABSENT, never to a wrong number**, and produces sentences a person acts on —
never a refusal or a mutation.

`index.ts` is an INDEX, not the protocol: DTOs live in `wire/` (`backend` `backendtokens` `capture`
`costwindow` `install` `intent` `localrt` `localusage` `notify` `notifylink` `onboard` `repo` `sent`
`session` `sysstat` `telemetry` `transcript` `work`; `oracle` is retired), all re-exported, so no
import site names a file. `wire/messages.ts` is a BARREL — the unions live in
`wire/messages/{clientsession,clientbacklog,clienthost,clientwork,hostcore,hosttools}.ts` and
`wire/session.ts` is a barrel over `wire/session/*`. **Add a message ⇒ the slice whose subject it is;
the barrel never changes for it. Add a field ⇒ the domain file.**
[Layout](../../../docs/notes/shared-architecture.md#the-wire-modules-wiresessionts-and-wiremessagests-as-barrels).
`wire/backend.ts` is the wire subset of a host-side `BackendDescriptor` (`BackendInfo`): capability
booleans say whether a backend HAS a thing at all, never whether it is currently on, and an absent
`contextWindowTokens` is unknown — never a guessed number.

**Import only the barrel, never a slice** (`tools/sharedshape.test.mjs`: 500-line slices, 600 for
`intent/`, no importer names a slice; `assess/` is not yet pinned). Where the logic lives:
`queue.ts` → `queue/queue*`; `sessioncost.ts` → `sessioncost/cost*`; `schedule.ts` →
`schedule/sched*`; `clihealth.ts` → `clihealth/health*`; `assess.ts` → `assess/sass*`; `intent.ts` →
`intent/*`. Grep the slice, not the
barrel, for `sessionWall` (`queuelane`), `cacheLikelyCold` (`costtypes`), `hoursOpenFrom`
(`schedzone`), `nextFireAt` (`schedfire`).
[Tables](../../../docs/notes/shared-architecture.md#the-logic-modules-sessioncost-schedule-queue-clihealth-as-barrels).

- `sendstamp.ts` + `clientframe.ts` + `stream.ts` — `SendStamp` (`firstSentAt`/`sentAt`) rides EVERY
  ackId'd durable message: a new durable message type adds `& SendStamp` (grep
  it in the `wire/messages/` slices). `clientframe.ts` is the ONE shape check the host makes on a decoded
  frame (an unknown `t` is a versioned no-op, never an error): `isClientFrame` checks only a non-null
  non-array object with a string `t` — **never add a known-`t` check**, handlers validate their own
  fields. `stream.ts` is the binary frames on the one socket (never durable, never a second socket).
- `brand.ts` + `brandmigrate.ts` + `statedir.ts` + `envresolve.ts` + `nodemin.ts` — identity and
  precedence. The next rename edits `brand.ts` VALUES only (`local/no-brand-literal`;
  `tools/brand.test.mjs` lists what cannot import it); `brandmigrate` COPIES localStorage legacy keys
  once, never moves; `statedir` is the state-dir/root precedence; `envresolve`: current name wins,
  then legacy names newest first, a legacy hit is reported once, never refused; `nodemin`'s `NODE_MIN` (20.12.0, `util.parseEnv`) is the ONE Node floor (package.json
  `engines`, doctor, `env.ts`) and `nodepin.test.mjs` pins root `engines` to it — change both together.
- `queue.ts` — send-queue **transport**: lanes, `holdUntilIdle`+`release`, `retargetEntry`,
  `pendingCreate` (bound on the create's own `createAck`, never on the lane — `create:<cwd>` is per
  REPO), `answerInsertAt`, `adoptReferencedUploads`, `serial`+`busySerialGroups` (a lane frees at
  the ACK, so a serialized entry waits for its GROUP — the **cwd** — to go quiet; every session
  counts there, the INTENT ladder's `intentSerialHolders` only sessions opened for queued work),
  `goneLanes`.
  **`sessionWall` (`queue/queuelane`) is the ONE answer to "can this session take a prompt right
  now"** — limit, then an open dialog parsed or not, then a live turn; `laneBusy` is it as a boolean,
  and `intent/target.ts`'s `sessionBlocker` and the host's `autoFireBlocker` are it plus their own
  rungs — never a fifth hand-written copy. **THERE IS NO AGE-BASED EXPIRY IN THIS MODULE** — no
  TTLs; `maxAttempts` (ANDed with `MIN_TRY_MS`, 60 s) ends a ROUND, which is retried after
  `roundDelay`, not the entry. **THE RESCUE IS THE HOST'S.**
- `intent.ts` — a BARREL over `intent/` (`types` `row` `facts` `words` `budgetpass` `kind` `target`
  `verdict` `clean` `slot`; [layout](../../../docs/notes/shared-architecture.md)): the durable INTENT
  model, and **`intentVerdict`, the ONE ladder** deciding whether deferred work may run: gate,
  budget, trigger, serial, target readiness, in that order, **because the order is by what the user
  can DO about it**. Rung 2 and the `budget` trigger skip a row whose `pastBudget` waiver is in force
  (`budgetWaived`: one start long, until the reset it was granted against). **Rung 2 also lifts for a `window`/`before` row inside the lead window of the reset its cap
  guards** (`budgetPassOf`/`budgetHold`): the SAME window the tripped ceiling is about, between its
  own `nextAt` and that reset — never for `after`, never a session pass past the weekly cap, never
  without `facts.budgetOver` (absent = hold); carried as `Intent.budgetPass`. Also owns **`intentKind` + the classifiers**. `cleanIntentRow` caps counts and
  labels, **NEVER the words**. **`IntentRequeue` is one
  record per time a SETTLED row was put back** (`REQUEUE_KEEP`, newest last): it carries the `result`
  the row had, is capped by COUNT never by the words inside it, and an entry that cannot say when or
  WHO is dropped rather than defaulted. `by` is `assess` / `hand` / `run`. **The LIST is the capped words; `Intent.requeueCount` is the uncapped NUMBER**,
  cleaned strictly, and absent means NOBODY COUNTED. **A row rung 3 has RELEASED is never re-judged
  by rung 3** (`clearedOccurrence`, persisted; only `HELD_MAX_MS` still expires one).
  Three OPT-IN rungs sit between serial and target readiness, most specific first: 4.5 `holdForHost`
  (hold until nothing on the host is starting or running; absent = the host being busy elsewhere is
  none of this row's business), 4.55 `localModel` (one ACTIVE local coding session at a time;
  automatic starts only) and 4.6 `noSlot` (`auto` rows whose target spawns a session wait for an
  automatic-session slot; a person's own tap never does). `cleanTarget` normalises every
  `{kind:"repo"}` to `fresh: true` (the shared per-repo conversation is RETIRED). The `after`
  trigger chains one row behind another's finish; its four OPTIONAL facts (`settled`,
  `knownIntents` — a dead predecessor FAILS the row, `chainWaits` — a cycle fails with a sentence,
  `neverSettles` — *after the nightly sweep* FAILS naming the rule) mean, when absent, *nobody said*,
  which waits. A chained prompt is `work`, never `schedule`. **RECURRENCE, not trigger kind, decides which list a row lives
  in**: `isTimedWorkRow` (a ONE-OFF `at` aimed at one place) is a backlog row with `BacklogItem.at`;
  only a standing rule or a one-off SWEEP is `isScheduleRow`. **Derived, never stored**;
  `timedWorkKey` is the "same clock" equality. Rung 5's `repo` case asks `fresh` BEFORE `facts.repoSession`.
  [Failures behind these](../../../docs/notes/host.md#moved-out-of-skill-shared-2026-10-17).
- `closed.ts` — **what a *Recently closed* row may say**: `cleanClosedRow` (unknown `closedBy`/`kind`
  dropped never rounded), the item's outcome only once SETTLED, and `sessionOriginOfIntent`.
- `dictate.ts` — **the audio format both ends agree on**: 16 kHz mono PCM, the header the PHONE writes
  (`pcm16ToWav`) so the host needs no transcoder, caps in SECONDS, and `dictateRefusal` so one clip is
  refused in one wording. `wavFacts` measures the body by the bytes that ARRIVED.
- `dictateterms.ts` — **the person's dictation vocabulary** (synced `waterplane.dictate.terms`, one
  term per line, `TERM: misheard, misheard`), parsed by ONE function on both ends and sent with each
  clip. Two levers: whisper's `--prompt` and corrections after the fact. Re-casing touches only
  identifier-shaped terms (≥3 chars, digit or inner capital); a prompt handed back on silence is
  refused as no speech (`isPromptEcho`). The browser engine gets corrections only.
- `installlog.ts` — **what an install log may claim.** Keyed, idempotent merging (a phone re-states its
  whole history on every connect), `at` ABSENT where the shell could not stamp it, devices DERIVED from
  the entries, a repeat FILLS IN and never blanks, and `installReportFrom` refusing every non-terminal
  outcome.
- `buildscan.ts` — **which build commands a repo may be TOLD it has.** Every candidate is read out
  of a file somebody already wrote there; a suggestion is TYPING, not saving. A publishing command is
  flagged, **never filtered**; an already-configured one stays in the list, marked.
- `buildparams.ts` — **what a build button ASKS before it runs.** Verbatim substitution at `{{id}}` in
  `cmd` AND `dir`, the `WATERPLANE_PARAM_<ID>` copy as well, a value is ONE LINE, an **undeclared
  placeholder is LEFT AS WRITTEN**, and a parameter with no value and no default **REFUSES the run by
  name** rather than picking the first option for an unattended fire.
- `artifacts.ts` — **what a build LEAVES BEHIND, and what it is called.** The per-repo policy
  (`collect`/`prune`/`keep`, **on by default** — an unparsable field falls back to the DEFAULT, never
  to off), the name (`<repo>-<variant>-<version|sha|stamp>`; **a name that already says which build
  it is, is KEPT**), `familyKey` ("which artifact IS this", here so the prune and the download queue
  cannot answer differently), the fold (size **and** a fingerprint; none ⇒ never folded) and
  `pruneVictims` (only families this run produced, only past the newest `keep`, never the run's own
  output). Disk is `host/artifacts.ts`.
- `tokens.ts` — what a pile of token counts MEANS. `sampleTotals` is the ONE reader of `SampleKinds`,
  the positional tuple every per-request split rides as; its order is `TOKEN_KINDS`' order and a
  second hand-written index is a chart with the right numbers in the wrong colours. Cache reads
  dominate, so the four kinds are never merged and the total always ships beside its split.
  `fmtCount` keeps three significant figures; `fmtShare` says `<1%` rather than `0%`.
- `sessioncost.ts` — a BARREL over `sessioncost/` (`cost*`; `cacheLikelyCold` is in `costtypes`) —
  **what one more turn in THIS session costs, against a fresh one.** The denominator is the session's
  own FIRST reading, never a constant; a truncated log yields NO baseline rather than a guess.
  `breakEvenTurns` is derived from `pricing.ts`'s cache multipliers **at the 1-hour write tier**
  (a blended ratio is the wrong input). *A quick question is still cheaper here* is false
  **on an expired cache** (re-READING becomes re-WRITING): `cacheLikelyCold` is the guard, `true` only
  past the TTL PLUS HALF AN HOUR. Two traps fake WARM when measuring from logs: a
  compaction inside the gap and `write > read` as the test.
  **Never mid-turn, no countdown, no dollar figure**, and the clock is the PHONE's at render.
  `seriesCostFields` is the ONE derivation. **`usageTok`/`agentTok` are a DIFFERENT fact from
  `spentTok`** (what the session has USED, subagents included); `usageText` always says *so far*,
  and **absent beats derived**. **`isColdRebuild`/`ColdStarts`/`coldStartText` are
  what the GAPS cost** (`REBUILD_READ` 0.8 is the real test); the sentence leads with the PREMIUM
  over re-reading, says *so far* nowhere and *wasted* never.
  **`compaction*` is what compacting DID** — shed, SAVED and the REBUILD, priced to err AGAINST
  compacting looking worthwhile; the saving is money NEVER SPENT, and every sentence says so.
  `saved 0` is refused (*nothing back yet*); an `unmeasured` boundary is NEVER called "the CLI's own". **`costChip`/`costText`** are those
  in MONEY: `costChip` answers **null, never `$0`**; `costText` never states a figure without
  saying it is a list-price COUNTERFACTUAL and naming what no rate covered.
  [Measurements](../../../docs/notes/host.md#moved-out-of-skill-shared-2026-10-17).
- `costwindow.ts` + `burn.ts` — **one week, read one way on both ends** (`wire/costwindow.ts` is the
  DTO). `weekCut` is the ONE bucketing function (the figure on an hour and the list it opens are one
  predicate). **`ptsCalibration` REFUSES, with a sentence per reason, rather than guess**. `burn.ts` owns `usageSegments` (chart and push cut a rollover alike) and `burnPushText`, which
  always ends "Nothing was paused." Reasoning: host.md `costwindow.ts`.
- `ctxwindow.ts` — how big a model's window is; the number every context graph calls 100%.
  **Not a table keyed on the id** — the log records the BASE id even for a 1M conversation.
  `resolveContextWindow` orders: TUI gauge, then the MEASUREMENT snapped up `WINDOW_LADDER`, then the
  id, then null; `windowFrom` travels with the number.
- `budget.ts` — the usage BUDGET. **FAILS OPEN** on an unreadable or stale reading, and clears past
  a known reset on the CLOCK alone. `budgetCeilings` is the per-window truth `budgetVerdict` is the
  first line of; `budget*Text` are the only wordings of a budget hold. `leftoverCeiling` (`leftoverMax`, default 20) is NOT an account pause:
  it holds only rows `budgetLeftoverOf` names — a weekly pass or weekly waiver that outlived its
  reset unstarted ([host.md](../../../docs/notes/host.md#what-a-lift-leaves-behind-after-the-reset--leftoverof-and-the-leftover-ceiling)).
- `period.ts` + `spendwarn.ts` — budget PERIODS and the readout over them. A subscription has two
  ROLLING windows (`session`, `weekly`, unit `pct`); an API-key or cloud account is governed per usd
  CALENDAR period, and **`periodBounds` is the one reading of a period's start and reset
  edge** (two copies of an edge are two answers to "has the month reset"). `period.ts` is pure, no
  clock, null when it cannot answer; zone maths via local `Intl` — importing `schedule.ts`/`budget.ts`
  closes a cycle. `spendwarn.ts` is a READOUT (orange/red marks past a chosen threshold) — it holds
  nothing.
- `sessionbudget.ts` — **a cap on ONE session** ([host.md](../../../docs/notes/host.md#sessionbudgetts--a-sessions-own-budget); tokens, dollars or ≈% of a window; spend = the session's own `ContextSpark` total). **Unknown never trips**: a stale/missing reading, uncalibrated window or unpriced model is `unknown` with a `why`; `sessionBudgetHeld` — the ONE predicate for the phone queue and the intent ladder — is true only for `over`. Separate from the account's `budget.ts`.
- `assess.ts` — a BARREL over `assess/` (`sass*`): **what an assessment is ALLOWED to conclude.** Every
  cap is on a COUNT, a citation or a label, **never on the words**: prose past `MAX_PROMPT_CHARS` is
  DROPPED with a note. Names (`headline`, `category`) ride even on `unclear` rows
  and are written only under `AssessChoices.writeNames`.
- `naming.ts` — **a title and a kind for a row, and who wrote them.** `label` is the PERSON's
  field, `headline` is the machine's, and `itemHeadline` is the ONE display rule: a typed label
  always beats a derived headline. Every value travels with a `NameAuthor` (`hand`/`assess`/`name`) and is dropped on read
  without one — `hand` makes "never overwrite typed words" checkable.
  `category` is one of four exact words, **absent means nobody said**; `"bugfix"` is dropped, never
  rounded to `chore` (no synonym table). A headline that is merely its own item's
  first words is DROPPED by a ONE-directional test (`text.startsWith(headline)`), not `typedName`'s
  two-way rule; a refused title is SAID (`headlineRefusedText`).
  **`branchLabel`/`trimDefaultBranch`: which branch a row needs to SAY.** `main`
  and `master` on a PRIMARY worktree come off — two names, no pattern; a worktree keeps its branch.
  `trimDefaultBranch` works at DRAW time: no persisted title is ever rewritten. `GitView`/`BranchPicker` never call these.
- `itempaths.ts` — `imagePaths`/`transportPaths`: the image and `.claude/outbox|inbox` paths a work item's words name.
- `intent/slot.ts` — **which waiting timed rows fire TOGETHER**: `slotsOf`/`slotMates` (the ONE bucketing function — count and cut), `findSlot` (matched with `RESET_MATCH_MS` tolerance, never as a string), `latestClock` (near-tie of different rules ⇒ null). Assessment `conflict` is words with no mutation; `split` is refused if it loses a `transportPaths` path. [host.md](../../../docs/notes/host.md#the-slot-check--sharedintentslotts-and-the-assessments-conflictsplit).
- `schedule.ts` — a BARREL over `schedule/` (`sched*`; `nextFireAt` is `schedfire`, `hoursOpenFrom`
  `schedzone`): wall-clock rules, `isSpentOnce` — a spent `once` is not a schedule somebody switched
  off. **`hours` places nothing and `nextFireAt` never reads it**: quiet hours are a policy over every
  anchor, and the ladder counts the GRACE from `hoursOpenFrom` — the window's opening. `guardWindow`
  tests `minPctLeft` against the OTHER usage window, which is the only thing that lifts the
  *after-edge has nothing to test* rule.
- `pricing.ts` — **list prices, per model, asked for a DAY** — an unknown model prices to `null`
  never to a guess, `PRICES_AS_OF` rides to the UI. Cache read is 0.1× of input EXCEPT where the
  list publishes its own (`Rate.cacheRead`); the 1-hour write tier is READ. **A cached table rots**:
  an `intro` rate "until <date>" must expire. Fast mode is knowingly absent.
- `ptysize.ts` — **a grid too small for a composer is not a viewport**: the client withholds a fit
  measured on a collapsed container, the host CLAMPS one.
- `working.ts` — the CLI's own working line off raw PTY bytes — **one matcher for both ends**: the
  phone's reader and the host's `Stop`-hook check read the same line; two copies would be two opinions.
- `transcriptfold.ts` + `followup.ts` + `passive.ts` + `peer.ts` — `transcriptfold`: the caps and
  two pure folds EVERY conversation reader shares, a plugin's store reader included; it **stays in
  shared** (extension readers reach core only via @waterplane/shared), the host re-exports it; **never fork its caps**; `followup`: what a flag-for-follow-up may say (a
  reading list that changes nothing, R-sessions-041..045); `passive`: a passive token's scope, allowed
  only to the app-update path, the HOST being the boundary (R-connection-011..014); `peer`: the peer job DTOs
  and the pure rules both ends judge by (address, repo key, report prompt) — **an additive field
  never bumps `PEER_API_VERSION`** (same rule as `PROTOCOL_VERSION`).
- `promptid.ts` (question fingerprint) · `settings.ts` (synced-key allow-list) · `hints.ts` ·
  `hosturl.ts` · `netfuse.ts` · `screenlog.ts` (`scrollOffCount` anchors on the TOP of the new grid) ·
  `urls.ts` (rejoins a wrapped URL on the WRAP GEOMETRY, never on "the next row looks URL-ish") ·
  `gallery.ts` (`coversQuery` is strict containment, never a broadness score) · `attach.ts`
  (`unknown` is never collapsed into `missing`) ·
  `launch.ts` · `fanoutruns.ts` (call it ONCE per list, never
  per row) · `collage.ts` (`pickCols` optimizes the ASPECT that comes out) · `clihealth.ts` (a
  barrel).
- `wire/localrt.ts` + `localrt.ts` — **what the local runner holds** and the pure "will a second
  model fit" SENTENCE; **`reachable:false` is not an empty model list**. `wire/sysstat.ts` — **the
  DESKTOP's own numbers**. **Every section optional and absent means no reader — never a zero**; `cpu`
  needs two readings; the slow readers carry their OWN timestamp; never add up `rssSumBytes` rows.
- `wire/telemetry.ts`'s **`TokenWindow*`** — **one PAST rate-limit window per row**: INSTANTS are
  derived from `anchor`/`lenMs` on both ends; only windows that RAN something are sent, and
  `oldestHour` tells "ran nothing" from "no record". `wire/backendtokens.ts` — **a backend's OWN
  ledger, `BackendTokensDoc`, never summed with `TokenTotals`**: its kinds are the backend's (never
  folded into claude's four), `unit` where the bill is not tokens; `available:false` is a 200 with a
  reason. An older extension document keeps its type in its own `shared/`; core serves it verbatim.
- `sweep.ts` — **clearing out a transport directory**: the age ladder NESTS, one predicate feeds the
  chip's number and the cut it opens, and **the PLAN is the contract** — the caller sends back the
  paths it showed, never an age to re-cut. Plans and words only; it deletes nothing.
- `pad.ts` — **the pad's per-note merge**: one JSON array of notes AND tombstones, discriminated by
  fields so an older bundle drops the tombs and keeps a working pad; `serializePad` is CANONICAL, the
  tie-break is lexical never *prefer mine*, an EDIT after a delete keeps the note and drops the
  tombstone, and a merge **never** sheds for size — the caps bind on a local add, which REFUSES in
  words. **THERE IS NO CLOCK IN `mergePad`**: the tombstone TTL is cut against the newest stamp in
  the UNION of the two docs, never `Date.now()`; the cap is applied AFTER the resurrection rule.
- `repohealth.ts` + `repohealthread.ts` — the zero-token repo-health series: DTOs and one sentence
  per state with nothing to draw, then every parser of a run's stdout. **A parser there rebuilds its result from the fields it NAMES**,
  so a field nobody named is dropped in silence. Adding a field ⇒ name it in the parser AND type it;
  the test asserts every key path the real engine emits survives the parse. Reasoning:
  [host.md](../../../docs/notes/host.md#repohealthts-and-repohealthreadts-in-shared--one-subject-two-failure-modes).
- `healthindex.ts` + `contextweight.ts` — the health SCORE: absolute 0–100 vs fixed `HEALTH_GOOD`
  values, headline `min(geomean of five entry scores, worst + 30)` with `cappedBy` and `alerts`. The one layer that takes a side. **Context's good line is
  `HEALTH_CONTEXT_GOOD_SHARE` × the repo's warn line** (`contextweight.ts`
  `DEFAULT_CONTEXT_LIMITS.maxChars`, or `WATERPLANE_CONTEXT_WARN_CHARS`) — not a hardcoded number.
  **Lockstep:** `HEALTH_INDEX_DEFAULT_WARN_CHARS` restates `DEFAULT_CONTEXT_LIMITS.maxChars` (an import
  cycle) and a test pins them equal — change both together. **Wire fields added after the score (`mean`, `cappedBy`, `alert`,
  `alertText`) are optional: absent = that host did not say.** `healthIndexCommits` is the same formula PER ROW, thinned (every week's last row kept, then min/max per run), and calls no move; `commits` absent = an older host (`healthCommitsAvailability`). **The whole route answer is `healthIndexResponseOf`** (`healthindexresponse.ts`, with `parseHealthRows`): the host's `respond()` and the extension's `healthindexdoc.ts` both call it — never re-derive it beside one. Why absolute and why capped: [host.md](../../../docs/notes/host.md#the-health-score-kept-current-by-healthwatchts).
- `hosts.ts` — the multi-host DTO and pure rules (`planHostMigration` idempotent, `planHostSwitch`:
  every copy lands before the bare key it came from is removed).
- `lanroute.ts` — `decideLanRoute`: the three ANDed gates (saved SSID, a fresh `/api/health`
  probe, `/api/lan/verify`'s HMAC) that decide LAN vs tailnet, pure so `web/lanRoute.ts` and
  `host/lanid.ts` read the same contract. `NetState` is also the Android `ShellNet` shape.
- `pairing.ts` — the QR pairing code: format, TTL, single-spend, and the deep-link
  (`waterplane://pair?u=&c=`) and landing-URL (`<base>/pair/<code>`) parsers, both through
  `normalizeHostBase` so a scanned link can never carry a `javascript:`/`data:` base.
- `devices.ts` — the paired-device row (`DeviceRow`) without the token hash: the one place the host's
  ledger and the phone's list agree what a row is.
  Reasoning for all four: [host.md](../../../docs/notes/host.md#modules-claudemd-links-here-for-and-this-file-never-covered).
