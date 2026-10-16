# The shared package's shape: `intent.ts` as a barrel over `intent/`

_Target document for splitting `packages/shared/src/intent.ts` (the `refactoring` skill, step 1).
Index: [README.md](README.md). Method: [refactoring.md](refactoring.md)._

`intent.ts` was the repo's longest file — 2,860 lines holding five different things: the durable
row's TYPES, the FACTS the ladder reads, the LADDER itself (`intentVerdict`), the SENTENCES every
rung writes, the row CLEANER every read off disk goes through, and the CLASSIFIERS (`intentKind`,
`isScheduleRow`, the origin strings). Every change to deferred work — a rung, a field, a wording —
conflicted in it. The split is structure only: no rung moves, no sentence changes, no name is
added to or removed from what `@waterplane/shared` exports.

## Layers and what may import what

`src/intent.ts` stays, as a **barrel**: the module's header (why the Intent exists, the rule that
no clock deletes one) and explicit `export { … } from "./intent/<slice>.js"` lists. Everything that
imports the intent model — `index.ts`, `closed.ts`, `fanoutruns.ts`, `assess.ts`, `wire/intent.ts`,
`wire/messages.ts`, host, web, extensions, `test/intent.test.mjs` — keeps importing `./intent.js`
(or `@waterplane/shared`), unchanged. **The barrel is the one door**: nothing outside `intent/`
names a slice, so a later cut can move a name between slices without touching an importer.

The slices import each other directly, as a DAG, and **never the barrel** (it re-exports them, so
that is a cycle — and a value cycle in ESM is a `TypeError` at load in `shared/dist`, which e2e
runs as plain node). Order, leaves first:

| slice | holds | imports (intent/) |
| --- | --- | --- |
| `types.ts` | the vocabulary (`Lifecycle`, `BlockReason`), payloads, `IntentTarget`, `IntentTrigger`, `IntentResult`, `IntentRequeue` + `REQUEUE_KEEP`, and the two budget records a row carries (`BudgetPass`, `BudgetWaiver`) | — |
| `row.ts` | `Intent` itself and the module's limits (`ON_TIME_MS`, `HELD_MAX_MS`, `INTENT_MAX_*`) | types |
| `facts.ts` | what the ladder READS (`IntentFacts`, `IntentSettlement`, `busyIntentGroups`) and what it ANSWERS (`IntentVerdict`) | types |
| `words.ts` | **the sentences**: `intentReasonText`, `INTENT_BLOCK_ORDER`, `closeWhenDoneOf`, `autoSlotsWaitText`, and the ladder's own wordings + `wait` + `chainLoops` (exported to the slices, NOT through the barrel) | types, facts |
| `budgetpass.ts` | rung 2's lifts: the before-reset pass (`budgetPassAt`/`budgetPassOf`, `RESET_MATCH_MS`, `budgetHold`) and the person's waiver (`budgetWaived`, `budgetWaiverUntil`, `cleanBudgetWaiver`) | types, row, facts |
| `kind.ts` | what KIND of thing a row is: origins, `isScheduleRow`/`isTimedWorkRow`/…, `timedWorkKey`, `clockKey`, `intentKind` | row |
| `target.ts` | rung 5 (`targetVerdict`, the session blocker) and the predicates both ends ask about a target (`needsSlot`, `reopensConversation`, `liveConvSession`) | row, facts, words |
| `verdict.ts` | **`intentVerdict`, the ONE ladder**, rungs 1–4.6 in their order | row, facts, words, budgetpass, kind, target |
| `clean.ts` | `cleanIntentRow` and its per-field cleaners — the one way a row comes off disk or the wire | types, row, words, budgetpass |
| `slot.ts` | **which waiting timed rows fire TOGETHER** (`slotsOf`/`slotOf`/`slotMates`, `findSlot` by key with tolerance, `latestClock` for a merge across clocks) — the slot check's one bucketing function, over `SlotRow` built from an `Intent` or a `BacklogItem` | row, budgetpass, kind |

The ladder's ORDER is the specification (`intentVerdict`'s own comment); it stays in one function
in one file. Its helpers move to their slice but are called from the same lines in the same order.

## Caps and ratchets

- `tools/sharedshape.test.mjs`: `intent.ts` line RATCHET (lowered in the commit that moves code
  out; end state is the barrel), every `intent/*.ts` ≤ **600** lines (ESLint warns at 900), no
  name defined twice across the barrel and the slices, the barrel defines nothing once slices
  exist, no slice imports the barrel, and only the barrel imports a slice.
- `packages/shared/test/intentsurface.test.mjs`: the exported SURFACE — every name and whether it
  is a value or a type — read through the TypeScript checker, pinned. Types matter here: a type no
  consumer names would drop out of the contract and still compile everywhere. The pin was written
  against the unsplit file before the first move.
- `packages/shared/test/intent.test.mjs` (the ladder from literals) passes **untouched**.

## Inventory (against `intent.ts` at 4bb3069; re-derive with `grep -n` before cutting)

| lines | region | becomes |
| --- | --- | --- |
| 1–43 | module header | barrel |
| 45–59 | imports | split per slice |
| 61–460 | vocabulary, payloads, target, trigger, result, requeue | `types.ts` |
| 461–856 | `Intent`, limits | `row.ts` |
| 857–1091 | facts, settlement, `busyIntentGroups` | `facts.ts` |
| 1093–1124 | `IntentVerdict` | `facts.ts` (the section header stays with `verdict.ts`) |
| 1126–1502 | `intentVerdict` | `verdict.ts` |
| 1503–1680 | `needsSlot` … `sessionOf` | `target.ts` |
| 1682–1805 | before-reset pass, waiver (the two interfaces to `types.ts`) | `budgetpass.ts` |
| 1807–2148 | `wait`, the sentences | `words.ts` |
| 2149–2612 | normalising one row | `clean.ts` |
| 2613–2860 | kinds and origins | `kind.ts` |

## As landed

One mechanical commit after the guardrails: the regions above copied byte-for-byte into their
slices (checked by script: every non-import line of the old file appears in exactly one slice, in
the old order within each region), with only import lines and `export` keywords on the
ladder-internal helpers added (`wait`, the ladder's sentences in `words.ts`, `budgetHold`,
`targetVerdict`) plus one path fix (`export { INTENT_MAX_STEPS } from "../schedule.js"` in
`row.ts`). `intent.ts` 2,860 → 89 lines (the header verbatim, a paragraph on where the code now
lives, the re-export lists). Slices: `types` 422, `row` 415, `facts` 280, `words` 357,
`budgetpass` 127, `kind` 262, `target` 192, `verdict` 399, `clean` 486 — the largest under the
600 cap with room, so a slice that grows past it is a sign, not a squeeze.

Comments inside the slices were moved verbatim, so a few still say "below" or "this file" about
something now in a sibling slice; they were left as written rather than edited in a move commit.

## The wire modules: `wire/session.ts` and `wire/messages.ts` as barrels

Same shape, second and third application. `session.ts` (1,726 lines) held every DTO that
describes a session; `messages.ts` (1,363) held the two unions. Both are now barrels (the one door:
importers still say `./session.js` / `./messages.js`, nothing outside names a slice), over
`wire/session/` and `wire/messages/`. Move-only: the type text is copied byte-for-byte, only imports
differ (each slice imports what it uses; slices import each other directly, never the barrel).

| barrel | slice | holds |
| --- | --- | --- |
| `session.ts` | `session/promptbox` | `PromptOption`, `StandingRule`, `DetectedPrompt` |
| | `session/launch` | `SendView`, `Effort`, `PermissionMode`, `LaunchOpts`, `ExternalSession`, limit/login/agent/ask/shell records |
| | `session/info` | `SessionInfo` |
| | `session/archive` | `NewImage`, recent/archived/closed rows, origin, history, search |
| | `session/delivery` | `OpenDelivery` |
| | `session/context`, `session/contextspark` | the context-window history: samples, agent runs, events, compaction ledger; then the spark, window source, series doc |
| `messages.ts` | `messages/clientsession` | `ClientSessionMsg`: session, input, recent/closed |
| | `messages/clientbacklog` | `ClientBacklogMsg` |
| | `messages/clienthost` | `ClientHostMsg`: update, usage, plugins, decisions, sent, settings, auth, limits, budgets, health |
| | `messages/clientwork` | `ClientWorkMsg`: builds, artifacts, capture, assess, fan-out, pull, schedule, intent |
| | `messages/hostcore` | `HostCoreMsg` + `PeerKind`, `AuthState` |
| | `messages/hosttools` | `HostToolsMsg`: settings through `error` |

`messages.ts` keeps `PROTOCOL_VERSION` (unchanged, 2), `ClientMessage` and `HostMessage` (each a union
of the slice unions, so `type HostMessage` is still declared there — the demo contract test reads
it), `encode`/`decode`, and the prose on `SendStamp`. A message is added to the slice whose subject it
is; the barrel never changes for it.

Pins: `packages/shared/test/wiresurface.test.mjs` reads both modules' full export surface and every
`t` literal (and the member count) of both unions off the type checker — written before the move.
`tools/sharedshape.test.mjs` holds each barrel to a line ratchet, each slice to 500 lines, no name
defined twice, and the one-door import rule. Before/after: `session.ts` 1,726 → 19 (largest slice
358), `messages.ts` 1,363 → 53 (largest slice 337).

## The logic modules: `sessioncost`, `schedule`, `queue`, `clihealth` as barrels

Fourth to seventh application, same shape and rules (the one door; slices import siblings, never the
barrel; move-only, the code text copied byte-for-byte). Each original keeps its header prose and
explicit `export { … } from` / `export type { … } from` lists and defines nothing. Slice basenames
carry a module prefix so they stay unique across packages (`clihealth.ts` also exists in host; web
has `core/queue/` and `scheduleWords.ts`). A slice-private helper another slice now needs gained an
`export` (`coldFrom`, `anchorWindow`, `zoneDate`); the barrels do not re-export them.

| barrel | slice | holds |
| --- | --- | --- |
| `sessioncost.ts` (1,220 → 122) | `costtypes` | level vocabulary, multipliers, cache TTL, input/reading records |
| | `costwords` | formatters, chips, the turn/week/dollar sentences, `costText` |
| | `costreading` | `breakEvenTurns`, advice, `sessionCost`, series readings, `CacheAge` |
| | `costofseries` | `sessionCostOf` (the reading off a spark) |
| | `costcompact` | what compacting saved and cost |
| | `costcold` | cold rebuilds |
| `schedule.ts` (1,199 → 102) | `schedrule` | `ScheduleRule`, anchors, window conditions |
| | `schedaction` | `ScheduleAction`/`Result`/`Entry`, `INTENT_MAX_STEPS` |
| | `schedzone` | zones, hours windows |
| | `schedfire` | `nextFireAt`, spent-once, standing |
| | `schedtext` | `describeRule` and its helpers |
| | `schedclean` | `cleanRule`, `cleanAction` |
| | `schedhorizon` | the horizon buckets and words |
| | `schedwhen` | `inWords`, `whenWords` |
| `queue.ts` (1,103 → 104) | `queueentry` | `SendQueueEntry` and its vocabulary |
| | `queueretry` | the retry contract |
| | `queueuploads` | referenced uploads, answer placement |
| | `queuelane` | lane state, walls |
| | `queueplan` | `selectSendable` and its plan types |
| | `queuebind` | pending-session binding, release |
| | `queueserial` | serial groups, `sendEligible` |
| | `queuewords` | why nothing is sending |
| | `queueretarget` | lane order, retargeting |
| `clihealth.ts` (940 → 123) | `healththresholds` | thresholds in one place |
| | `healthcatalog` | the signal catalog |
| | `healthrecord` | the record, sample capture, observe, re-arm, verdict sentence |
| | `healthrollup` | rollup, `cleanHealth` |

Pins: `packages/shared/test/logicsurface.test.mjs` reads all four export surfaces off the type
checker (written before the move); `tools/sharedshape.test.mjs` holds each barrel to a ratchet and
each slice to 500 lines. The existing `queue`, `schedule`, `sessioncost`, `clihealth` tests pass
untouched. Largest slice: `healthrecord` 442.
