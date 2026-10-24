# Host architecture: the three big files, and what they become

How `packages/host/src/sessions.ts` (5,598 lines), `intents/manager.ts` (3,456) and `main.ts`
(2,426) are cut up without changing behaviour — the layers, what may import what, the folder layout,
the one interface a slice reaches shared state through, the ratchets and pins that hold it, and
the inventory each cut is made from. The method is [refactoring.md](refactoring.md); the finished
web split this mirrors is [web-architecture.md](web-architecture.md); the per-module reasoning for
everything that already exists is in [host.md](host.md) (grep it — it is 150k chars).

**Line numbers in this note are the file as it was on 2026-09-25 (HEAD `47eb316`). They rot with
the first commit. Every cut re-derives its range with `grep -n` against the file as it is then,
never from this note.** What does not rot is the region → destination map and the order.

## Why

Three files hold 11.5k of the host's 50k lines, and every change in the daemon conflicts in one of
them: a limit fix, a box-detector fix and a resume-queue fix are three edits to `sessions.ts`; a
new rung, a new verb and a reconcile fix are three edits to `manager.ts`; and every listener, every
snapshot and every executor is a hunk in `main.ts`. Several sessions edit this tree at once. The
web client had the same problem at 17k lines and the fix was folders a change can stay inside,
with the boundary as lint. The host gets the same shape, with one difference the files force:
these are not components with hooks but **a class with private maps, a class with private ledgers,
and a script whose order IS its behaviour**. So the pattern here is a facade over slices, not a
manifest and a registry.

**The public API of `SessionManager`, `IntentManager` and the entry point does not change.** Nine
host modules import `./sessions.js`, ten tests import `dist/sessions.js` / `dist/intents/manager.js`
/ `dist/intents/adapters.js`, `routes/types.ts`'s `HostCtx` names both classes, and 96 e2e sites
spawn `node packages/host/dist/main.js`. Those paths and names are a contract; every move below
keeps them.

## Result (2026-09-25)

The split landed as 26 commits between `47eb316` and `4700a7b` (interleaved with other work): S1–S11, I1–I7, M1–M6, plus the guardrails
before them. "Layout", "The inventory" and "Readiness" below are the PLAN as it was written before the
first cut, kept because the reasoning is still the reasoning; where the code went another way,
the "… as landed" sections say so, and "Layout" names the deviations. **This section is
the map of what exists.** Line counts measured on the tree after the review hardening that
followed the split.

**The three facades** (re-measured 2026-09-28, after three days of other work landed on the
split): `sessions.ts` **700** lines (711 at the split; floor 1,100), `intents/manager.ts` **314**
(floor 450), `main.ts` **684** (686 at the split; floor 700, planned as 650 — see below; it went
under when the `.env` loop moved to `env.ts`, the fix for a pre-existing bug). `hostshape`'s
`MAX_LINES` holds each at its count. The slice tables below carry the same day's counts; the
layering held through that work (`hostshape`, `hostpins` and `local/host-boundary` green), and the
new host modules since (`plugins/`, `pair.ts`, `envfiles.ts`, …) are flat modules outside it.

**`main.ts`'s floor is 700, not 650.** What remains is exactly what the plan keeps in the entry
point: imports (`env.ts` first), the constructions in boot order with the singleton registrations
beside them, every `.start()` and its `DOCTOR` gate, the `ctx` assignments, the linger sweep, the
`builds.on`/`capture.on` broadcasts, `handleClientMessage` and `main()` (bind selection, the
public-bind refusal, `createServer`, `attachWs`'s `new WebSocketServer`). None of it is a
function a factory could own without taking the boot order with it, so the ratchet stops here
rather than chasing the sketch's guess.

### `sessions/` — `host-core`

| file | holds | lines |
| --- | --- | --- |
| `core.ts` | TYPES ONLY: `Session`, `LiveMeta`, `ClosedRow`/`RecentRow`, `SessionCore` | 523 |
| `knobs.ts` | every module constant and `WATERPLANE_*` read, the summary prompts, the tmux names | 316 |
| `tmux.ts` | the substrate: spawn inside tmux, re-attach, `tmux.conf`, `live/` records, orphan sweep, `sweepSessionStores` | 316 |
| `convid.ts` | which conversation a session is in (claude + opencode), the running model, `backendField` | 295 |
| `health.ts` | `healthScope`, `noteFor` (the ONE direct `noteHealth`), log/context health | 115 |
| `ctxseries.ts` | `CtxSlice`: the context gauge, spark, per-model window, context series, tool details | 378 |
| `roster.ts` | `RosterSlice`: recent + closed rows, stars, pins, prompt labels, watched ids, per-session plugin state (was: oracle state), `rename` | 331 |
| `wall.ts` | `WallSlice`: auto-continue config, `checkLimit`, the continue ladder | 494 |
| `resume.ts` | `ResumeSlice`: the resume queue, resurrection, `revivedSessionFor` | 548 |
| `turn.ts` | the turn flag, the hook lifecycle, asking + agents, the submits ring, the turn queries | 694 |
| `boxes.ts` | the choice box: when to look, reading, publishing, sign-in link, the two answer walks | 618 |
| `drive.ts` | the public verbs: `input`/`write`, `waitReady`/`autoFireBlocker`, `resize`, `kill`/`detach`/`remove`, the screen readers | 480 |
| `record.ts` | prompt history, transcript, search, `nameTab`/`nameNow` (`host-spenders`), the history/tab-name files, `lastTurnOf` | 528 |

### `intents/` — `host-work`

| file | holds | lines |
| --- | --- | --- |
| `manager.ts` | the facade: fields and ledgers, the core literal, `list`/`get`/`pending`, the tick, delegations | 314 |
| `adapters.ts` | the old `launch.*`/`schedule.*` vocabularies — the only path into the store (unchanged) | 774 |
| `contract.ts` | `ExecutorResult`/`IntentExecutors`/`IntentDeps`, the knobs (`TICK_MS` …), pure helpers (`isRecurring` …), `IntentCore` | 544 |
| `clock.ts` | `armNew`/`newBasis`/`armFrom`/`graceFloor`, `skipNext`, `setArmed` | 185 |
| `disk.ts` | `DiskSlice`: load, legacy migration, `chainFacts`, archive tail, compact, persist, flush | 422 |
| `write.ts` | `WriteSlice`: `post`, `upsert`, `waive`, `update`, `retarget`, `edit`, `name` | 550 |
| `requeue.ts` | the row verbs: `markDone`, `requeue`, `requeueFailed` (+ `wouldNotRun`), `cancel`, `dismiss`, `remove`, `runNow`, `noteSession`, `fileLanded` | 507 |
| `ladder.ts` | `LadderSlice`: `pass` (the rung ladder) and `block` | 341 |
| `fire.ts` | `FireSlice`: `fire`, `execute`, `settle`, `replace`, `unspend`, `recordMissed` | 511 |
| `watch.ts` | `WatchSlice` (owns `reconciled`): Stop/exit completion, `sweepRunning`, `reconcile` | 459 |

### `server/` — the `host` router's frame

| file | holds | lines |
| --- | --- | --- |
| `ctx.ts` | TYPES ONLY: `ServerCtx extends HostCtx`, the draft type `main.ts` fills | 114 |
| `ctxseal.ts` | `assertCtxComplete(ctx)`: just before listening, throws naming any `ServerCtx` key `main.ts` never assigned; `serverCtxKeys()` must list every key (type-checked exhaustive) | 45 |
| `clients.ts` | `createClients(deps)`: sockets, `send`/`broadcast`, auth re-evaluation, watched set, notification feed, `notify()` | 146 |
| `intentDeps.ts` | `makeIntentDeps(ctx)`: the `IntentDeps` literal, executors included, the sweep-dirs cache | 349 |
| `intentEvents.ts` | `createSnapshots(ctx)` (the store's snapshots, `padNotesFor`) and `wireIntentEvents(ctx)` (the four `intents.on`) | 239 |
| `scan.ts` | `createScan(ctx)`: outbox/image/auto-pull baselines and scanners, `announceBuild`, the `autopull.on("item")` | 201 |
| `deliveries.ts` | `createDeliveries(ctx)`: `startPrompt`, `deliverChain`, `deliverInput`, the re-send callback, `wireDeliverySettled`, `deliverySnapshot` | 273 |
| `wsops.ts` | `createWsOps(ctx)`: in-flight maps, `sendOpAck`, `durableOp`, `containRepoDir`, the `/ws` connection handler | 218 |
| `liveness.ts` | pure policy, no socket: `pingTick` (ping or terminate after two unanswered) and `ptyFrameAction` (send / skip / one full resync past the PTY backlog) — why in protocol-and-security.md | 62 |
| `sessionEvents.ts` | `wireSessionEvents(ctx)`: all fifteen `sessions.on`, the limit-event log (`proposeReply` left core with the Gemini oracle, `41585a9` — now a plugin) | 283 |
| `http.ts` | `createHttp(ctx)`: `MIME`, auth endpoints, `serveStatic`, the per-bind request handler, `listenWithRetry` | 267 |
| `shutdown.ts` | `installShutdown(ctx)`: the SIGTERM/SIGINT flush (order pinned) and the two process-error handlers | 74 |
| `firstapp.ts` | `createFirstApp(ctx)`: the first-app job (`onboard.ts`) over this host's builds, store and sessions; resumed after `intents.start()`, never under `DOCTOR` | 37 |

## The layers, and what may import what

```
packages/host/src/
  main.ts            the entry point: env, constructions in boot order, main()   ─┐ server
  server/            the pieces main.ts is made of, as factories over ServerCtx    ─┘
  routes/            the client-message table (unchanged)
  api.ts             HTTP routes (C1: now the frame; the tables are routes/api*.ts)
  <flat modules>     backlog.ts, deliver.ts, fanout.ts, review.ts, … (unchanged)
  sessions.ts        the SessionManager FACADE: fields, constructor, create/register, delegations
  sessions/          its slices, each over SessionCore
  intents/manager.ts the IntentManager FACADE                    intents/adapters.ts (unchanged)
  intents/           its slices, each over IntentCore
  backends/, capture/  leaves (unchanged)
```

Import direction, top to bottom; a cycle is forbidden at every level:

| file in | may import | may not |
| --- | --- | --- |
| `main.ts` | anything | — |
| `server/**` | `server/ctx`, `server/<sibling>`; `routes` (the index); every flat module; `sessions`, `intents/manager`, `intents/adapters`; `backends`, `capture/` | a file INSIDE `sessions/` or `intents/` other than the two facades and `adapters` |
| `routes/**` | flat modules; `sessions`; `intents/manager`, `intents/adapters`; `backends` | `server/**`, `main`; inner files of `sessions/` / `intents/` |
| a flat `src/*.ts` (not `main.ts`) | flat modules; `sessions` (the facade); `intents/manager`, `intents/adapters`; `backends`, `capture/` | `server/**`, `main`, `routes/**`; inner files of `sessions/` / `intents/` |
| `sessions.ts` (facade) | every `sessions/<slice>`; flat modules; `backends` | `server/**`, `routes/**`, `main`, `intents/**` |
| `sessions/<slice>` | `sessions/core`, `sessions/knobs`; flat modules; `backends`; packages | `sessions` (the facade — a cycle), any OTHER `sessions/<slice>`, `server/**`, `routes/**`, `main`, `intents/**` |
| `intents/manager.ts` (facade) | every `intents/<slice>`; packages | any host module outside `intents/` (it is a leaf today: `deps` are injected, and stays one) |
| `intents/adapters.ts` | `intents/manager` (today's `ORIGIN_*` import); packages | anything else in `intents/`; any other host module |
| `intents/<slice>` | `intents/contract`; packages | `intents/manager`, `intents/adapters`, any other `intents/<slice>`, any host module outside `intents/` |
| `backends/**`, `capture/**` | flat modules (as today: `backends/claude.ts` → `echo.ts`); packages | `sessions*`, `intents/**`, `routes/**`, `server/**`, `main` |

Two facts make this a real boundary rather than a folder convention. **A slice never imports
another slice**: what it needs of another slice it asks of `core` (below), so the graph inside
`sessions/` is a star with `core.ts` at the centre and cannot have a cycle by construction. **A
slice never imports its facade** — `sessions/wall.ts` importing `../sessions.js` for the
`SessionManager` type is the cycle TypeScript will happily compile and Node will happily half-load.
`import type` of the facade is refused too, deliberately: the type a slice needs is `SessionCore`,
and reaching for the class is the drift.

### `local/host-boundary` — the rule

Lives in `tools/eslint/rules.js` beside `feature-boundary`, decided on the **import path alone**
(`srcTarget` resolution, the same helper), applied by `eslint.config.js` to
`packages/host/src/**/*.ts`, pinned both ways by `tools/hostboundary.test.mjs` (the shape of
`featureboundary.test.mjs`: each allowed edge asserted allowed, each refused one refused, once
through `Linter` so the filename → `src/`-relative wiring is covered). Exact semantics of
`hostBoundary(fromRel, to, typeOnly)`, where `fromRel` is relative to `packages/host/src/` and `to`
is the bare resolved specifier (`sessions`, `sessions/wall`, `intents/manager`, `server/ctx`, …):

- Package imports (`node:*`, `@waterplane/shared`, `ws`, `node-pty`) are never restricted — the rule is
  about coupling inside this package.
- `from` = `main.ts`: **allow everything**.
- `from` starts with `server/`: refuse `sessions/<x>` and `intents/<x>` for any `x` except
  `intents/manager` and `intents/adapters` (*"reach sessions through its facade `sessions`"* /
  *"reach the intent store through `intents/manager`"*); refuse `main` (*"the entry point is never
  a library"*). Allow the rest.
- `from` starts with `routes/`: as `server/`, plus refuse `server/**` and `main` (*"a route is
  called by the server and never reaches back into it"*).
- `from` is a flat module (no `/`, not `main.ts`): as `routes/`, plus refuse `routes/**` (*"a
  flat module is called BY a route"*).
- `from` = `sessions.ts`: allow `sessions/<x>` for any `x`; refuse `server/**`, `routes/**`,
  `main`, `intents/**`.
- `from` starts with `sessions/`: allow `sessions/core` and `sessions/knobs`; refuse `sessions`
  and every other `sessions/<x>` (*"a slice reaches another slice through `core`, never by import"*,
  and for the facade: *"a slice never imports its facade — that is the cycle"*); refuse `server/**`,
  `routes/**`, `main`, `intents/**`. Allow flat modules and `backends`.
- `from` = `intents/manager.ts`: allow `intents/<x>`; refuse every path outside `intents/`
  (*"the intent store is a leaf; what it needs is injected as `IntentDeps`"*).
- `from` = `intents/adapters.ts`: allow `intents/manager`; refuse everything else inside the
  package.
- `from` starts with `intents/` (a slice): allow `intents/contract`; refuse everything else inside
  the package.
- `from` starts with `backends/` or `capture/`: refuse `sessions`, `sessions/**`, `intents/**`,
  `routes/**`, `server/**`, `main`. Allow flat modules.
- `typeOnly` (an `import type`, or every specifier `type`) relaxes exactly ONE refusal: a flat
  module, a route or a server file may `import type` from an inner `sessions/` or `intents/` file
  (e.g. `deliver.ts` taking `import type { Session } from "./sessions/core.js"`), because a type is
  erased at build. It never relaxes a slice → facade, slice → slice, or anything → `main`/`server/`
  edge: those are the cycles and the direction inversions, and a type edge is still an edge in a
  reader's head.

Every refusal message names the edge and the fix, as `feature-boundary`'s do.

Two facts about the helper, so the rule is written against what it sees. `srcTarget` is anchored
on `packages/web/src/` today (`WEB_SRC`); the host rule needs its own `HOST_SRC` anchor, and the
`.js` NodeNext specifiers are already stripped by `bareSpec`. And `bareSpec` folds `x/index` into
`x`: `../backends/index.js` resolves to `backends` and `./capture/index.js` to `capture` — the same
bare name as the flat `capture.ts`. So "`backends`" in the tables means the index, and a slice that
imports `capture/index` is seen importing a flat module (allowed), which is the intent. The fold
applies to the TARGET only: the importing file is classified by its path with the extension
stripped and NOT index-folded, or `routes/index.ts` reads as a flat module named `routes` and
is refused its own `./types.js` (the first wiring of the rule did exactly that), and a
`sessions/index.ts` would pass as the facade.

**Day one is clean.** Every intra-package edge that exists today was checked against the table
(2026-09-25): eight flat modules `import type { SessionManager }` from the facade and only
`main.ts` takes a value import of it; eight modules import types from `intents/manager`;
`intents/manager.ts` imports only `node:*` and `@waterplane/shared`; `intents/adapters.ts` imports
`./manager.js` and `@waterplane/shared`; `backends/claude.ts → ../echo.js` and
`capture/window.ts → ../host.js` are flat-module edges; `routes/session.ts` and `routes/work.ts`
import `../intents/adapters.js`; no flat module imports `routes/`, and nothing imports `main`. The
rule refuses none of these, so wiring it is not a change to any file but `eslint.config.js`.

## Layout — the plan, as written before the cuts

**Where the code went another way** (each argued in its "as landed" section): `ServerCtx`'s
member list is the one M1 derived by script, not the sketch below; the `new OpenDeliveries`
construction (M2) and `attachWs`'s `new WebSocketServer` (M2) stay in `main.ts`; `textOf` is local
to `wireIntentEvents` (M4); `healthTail` went to `boxes.ts` (S3, landed in S4), `isPassiveInput` and `modePrefix`
to `drive.ts` (S10), `revivedSessionFor` to `resume.ts` (S7). Read "Result" above for what exists.

### `sessions.ts` stays the facade; `sessions/` holds the slices

The class, its constructor, `create()`/`fork()`/`register()` (the PTY wiring — the thing there must
be exactly one of), `rediscover()`, the lookups (`get`/`list`/`managedPids`/`keepsClaudeLog`/
`revivedSessionFor`/`runningSessionFor`) and a one-line delegation for every other public method
stay in `packages/host/src/sessions.ts`. It keeps exporting exactly what it exports today:
`SessionManager`, `USE_TMUX`, `tmuxEnvPrefix`, `sweepSessionStores` (the last three become
re-exports from `sessions/tmux.ts`). Moving the facade to `sessions/index.ts` would touch nine
importers and four tests for no boundary gained — the web note's reasoning — and a `sessions.ts`
beside a `sessions/` folder is fine under NodeNext, where every import names its file.

```
sessions/
  core.ts       TYPES ONLY: Session, LiveMeta, RecentRow/ClosedRow, and SessionCore
  knobs.ts      the module constants (every WATERPLANE_* env read the file makes at import), no functions
  tmux.ts       USE_TMUX, TMUX_SERVER, tmuxEnvPrefix, spawnBackend/paneCwd/reattach, tmux.conf,
                live records, orphan sweep, sweepSessionStores, hasLiveTmux
  convid.ts     claude + opencode conversation-id discovery, refreshModel, lastAssistantModel
  boxes.ts      the box checks (checkPrompt, checkOpencodeBox, enrichPrompt, applyPrompt,
                applyLogin, setAwaiting, choosePromptBox, submitPromptBox, scheduleChecks, healthTail)
  turn.ts       setTurn/markIdle/checkIdle, the hook sink (onHookEvent, routeHook), sourceTurn, turn watch,
                stop verify), asking + agents, the submits ring, the turn queries
  idlewatch.ts  noteOutput/checkIdleWatch/clearIdle: when PTY output ends idle. A redraw over an idle
                prompt (cursor blink, resize, status-line tick) is not work, so on claude's TUI idle
                clears only when the working line is on the grid; setTurn(true) clears it for every
                turn start; a backend with no working-line reader keeps any-output-clears (2026-10-22)
  health.ts     healthScope, noteFor, noteLogHealth, noteContextHealth
  wall.ts       the usage-limit wall: limit config, checkLimit, markLimitBlocked, clearLimitBlock,
                the attempt ladder, doLimitContinue
  resume.ts     the resume queue and resurrection (revivedBy/revivedAt, doResurrect)
  ctxseries.ts  checkContext/refreshSpark/contextWindow, getContextSeries, ocFor/logFor,
                getToolDetails, flushContextWindows
  roster.ts     recent + closed rows, stars, pins, prompt labels, per-session plugin state, rename
  drive.ts      input/write/resize/panHistory/waitReady/autoFireBlocker/setRemoteControl,
                kill/detach/reattachById/remove, the screen readers
  record.ts     history, getTranscript, search, nameNow/nameTab, finalizeCapture,
                the history/tab-name files, lastTurnOf
```

Names are chosen to be **unique basenames across `packages/`**: `tools/skillmap.mjs` and
`claudemd.test.mjs` route and ghost-check modules by basename, so `sessions/limit.ts` would be
indistinguishable from the heuristics' `limit.ts` in the router's map, and `sessions/context.ts`
from `context.ts`. Hence `wall.ts`, `ctxseries.ts`, `boxes.ts` (not `prompt.ts`), `roster.ts`. The
shape test enforces uniqueness (below).

### `intents/manager.ts` stays the facade; the slices are its siblings

`intents/` already exists with `manager.ts` and `adapters.ts`, tests import
`dist/intents/manager.js`, and eight modules import types from it. The class, fields, constructor,
`list/get/pending`, `start/stop/kick/tick` and the delegations stay in `manager.ts`, which keeps
exporting `IntentManager`, `ORIGIN_SCHEDULE_WORK`, `ORIGIN_SCHEDULE_SWEEP` and the three interfaces
(the interfaces become `export type { … } from "./contract.js"`).

```
intents/
  manager.ts    the facade (unchanged path)          adapters.ts  (unchanged)
  contract.ts   ExecutorResult, IntentExecutors, IntentDeps (moved whole), the knobs, the pure
                helpers (isTerminal, isRecurring, spanWords, revivedShape), and IntentCore
  clock.ts      armNew/newBasis/armFrom/graceFloor, skipNext, setArmed
  disk.ts       load, foldLegacyWorkParents, migrateLegacy/migrateFileAt/migrateFile, present,
                chainFacts, readArchiveTail, compact, archive, persist, flush
  write.ts      post, snapshotConv, upsert, waive, update, retarget, edit, name
  requeue.ts    markDone, revive, requeue, requeueFailed, wouldNotRun, cancel, dismiss, remove,
                runNow, noteSession, fileLanded
  ladder.ts     pass (the rung ladder), block
  fire.ts       fire, execute, resolveSessionFor, unspend, stampCleared, recordMissed, settle, replace
  watch.ts      onTurnEnded, onSessionExit, sweepRunning, giveUp, complete, endWithDeadSession,
                sessionAwaitingInput, reconcile, reconcileOne
```

### `main.ts` stays the entry point; `server/` holds its pieces

`main.ts` is a SCRIPT: ~55 top-level statements with side effects whose order is the boot
(inventory §3). It exports nothing and must keep exporting nothing. What moves out is every
function and every listener block; what stays is every `new X(…)`, every `.start()`, every
`set<Singleton>(…)`, in today's order, plus `main()` itself. Each `server/` module exports a
**factory** that takes the `ServerCtx` and returns what it built, or a `wire…(ctx)` that registers
listeners — never module-level state, never a listener registered at import.

```
server/
  ctx.ts            ServerCtx extends HostCtx: the ~20 names main.ts's functions close over that
                    HostCtx does not carry (push, setupWatch, contextLimits, cliHealthStore,
                    tokenStats, uiStats, usageLog, reviewStore, assessExecutor, wsToken,
                    outSeen, opsInFlight, deliverChain, isAttachedToSomeone, considerPull,
                    announceBuild, padNotesFor, PORT, DOCTOR). Types only. (`knownRepoDirs` is
                    NOT on it: its only reader is the deps literal, see M3.)
  clients.ts        attached/clients/wsKind/wsToken, authStateFor, enforceAuth, broadcastAuthState,
                    recomputeWatched, attachedIds, isAttachedToSomeone, send, broadcast,
                    notifications + notify
  deliveries.ts     startPrompt, deliverChain, deliverInput, the OpenDeliveries construction and
                    its resend callback + "settled" listener, deliverySnapshot
  wsops.ts          opsInFlight/inputsInFlight, sendOpAck, durableOp, containRepoDir, attachWs
                    (the WebSocketServer and its connection handler)
  intentDeps.ts     makeIntentDeps(ctx): IntentDeps — the 290-line literal, executors included
  intentEvents.ts   intents.on(settled/requeued/skipped/missed), textOf, the snapshots
                    (schedule/launch/intent/assess/backlog), padNotesFor
  sessionEvents.ts  every sessions.on(…) block, proposeReply, the limit-event log
                    (logLimitEvent, fmtClock, fmtDur; LIMIT_LOG is `join(ctx.ROOT, …)` computed
                    inside wireSessionEvents — main exports nothing, so ROOT is not importable)
  scan.ts           imgSeen/outSeen/pullSeen, scanImages/scanOutboxDocs/scanPullCandidates,
                    pullNewFiles, pullCatchUp, fmtSize, announceBuild, considerPull
  http.ts           MIME, readSmallJson, handleAuthHttp, serveStatic, the createServer request
                    handler, listenWithRetry
  shutdown.ts       the SIGTERM/SIGINT flush, unhandledRejection, uncaughtException
```

`main.ts` after the split reads as the boot order it already is: constants; `const ctx = {} as
ServerCtx`; one line per construction assigning into `ctx` in today's order; `wireSessionEvents(ctx)`
etc. at the positions the listener blocks hold today; `main()`. Under ~650 lines (it landed at 700 — see "Result"). Two listener
blocks stay in `main.ts` on purpose: `builds.on("output")` (789) and `capture.on("output")` (800)
are ten-line broadcasts beside the constructions they belong to, inside the range that stays;
they are pinned (below) so they cannot be copied into a `server/` file as well.

## How a slice reaches shared state

### `SessionCore` — the one interface (`sessions/core.ts`)

`SessionManager` is a class with private maps, private ledgers and forty private methods that call
each other across every concern (inventory §1.4). The split cannot make those calls into imports
without cycles, and cannot make them public without widening the class's API. So:

- **`Session`** (the record, lines 453–755 today) moves to `sessions/core.ts` whole, with its
  comments, and is what every slice receives per call: `checkLimit(s: Session)`.
- **`SessionCore`** is an interface, also in `core.ts`, that the facade **implements as a private
  object literal** built in its constructor — not `this`, so the class's public surface is
  untouched:

  ```ts
  export interface SessionCore {
    readonly root: string; readonly port: number;
    readonly sessions: Map<string, Session>;          // THE map, shared by reference
    emit(event: string, ...args: unknown[]): void;    // the facade's EventEmitter
    // hub methods — the private methods the dependency sketch shows called from 2+ regions,
    // one entry per method, typed exactly as the private method is today:
    noteFor(s: Session | null | undefined, id: CliSignalId, outcome: HealthOutcome, opts?): void;
    setTurn(s: Session, active: boolean, opts?: { fromScreen?: boolean }): void;
    markIdle(s: Session, emitPing: boolean): void;
    checkLimit(s: Session): void; releaseResume(id: string, why: …): void;
    publishQueue(): void; scheduleLimitAttempt(s: Session, at?: number): void;
    // … (the full list is what the dependency sketch derives; it is written once, in core.ts)
    // and the PUBLIC methods slices call on the facade today, by the same names:
    create(cwd, opts): SessionInfo; input(id, data): boolean; write(id, data): boolean;
    screenText(id, lines?): Promise<string>; screenCells(id, lines?): Promise<RenderRow[]>;
    recordPrompt(id, text, kind): void;
    // `register` is PRIVATE (1152) and stays in the facade; it is a hub member because
    // tmux.ts's `reattach` (1442) calls it — the one slice that wires a PTY it did not spawn.
    register(id, proc, info, launch, cols, rows, backend?, createsRecord?): SessionInfo;
  }
  ```

  The hub list is derived from the code, not sketched, and **S1 writes every member the
  inventory's cross-reads need, so no builder discovers one**. The two clusters the cut order
  keeps adjacent are exactly the ones whose members are easy to miss, measured today:
  - the **limit-config region (2949–3008) and the ladder (3384–3765), assigned to `wall`,** read
    resume's private state directly: `resumingIds` ×4, `resumeWaiting` ×2, `resumeHoldUntil` ×2,
    `resumeProven`, `resumeFirst`, and call `releaseResume` ×7, `publishQueue` ×2, `pumpResume` ×2.
    Those become hub members (`isResuming(id)`, `resumeQueue()`, `resumeHoldUntil()`,
    `resumeProven()`, `resumeFirstAt(id)`, `releaseResume`, `publishQueue`, `pumpResume`) — a slice
    reads another slice's state through a named accessor on `core`, never `core.resume.x`.
  - the **resume region (3010–3248, 3767–3937)** calls wall's `clearLimitTimer`,
    `doLimitContinue`, `limitRetry`, `scheduleLimitAttempt`, `writeLimitCfg`: five more hub members.
  - `resumeMode` is written by `writeLimitCfg` (2994) into the limit-config file beside
    `autoContinueOn`, so it is **wall's field**, not resume's (the field list below is corrected);
    resume reads it through `core.resumeMode()`.
  - `onExit` in the facade calls `finalizeCapture` (record), `clearStopVerify` (turn),
    `clearLimitTimer` (wall), `stopClaudeIdWatch` (convid), `deleteLive` (tmux), `pushClosed`
    (roster), `maybeScheduleResurrect` (resume); `register` calls `loadSummary` (record),
    `applyPromptLabels`/`refreshOracle`/`rememberRecent` (roster), `watchClaudeId`/`watchBackendId`
    (convid). Every one of those is a hub member from S1, pointing at the facade until its slice
    lands.

- **A slice that owns state is a class** taking `core` in its constructor (`WallSlice` owns
  `autoContinueOn`, `limitCfgPath`, `resumeMode`; `ResumeSlice` owns `resumingIds`, `resumeProven`,
  `resumeWaiting`, `resumeForced`, `resumeGuards`, `resumeGapTimer`, `resumeFirst`,
  `resumeHoldUntil`, `lastQueueSig`, `revivedBy`, `revivedAt`, `revivedPath` and the static
  `REVIVED_MAX`; `RosterSlice` owns `recent`, `recentlyClosed`, `stars`, `pins`, `watched`, their
  paths and the four statics `RECENT_PER_CWD`, `RECENT_LIMIT`, `CLOSED_LIMIT`, `LABEL_CAP`;
  `CtxSlice` owns `ctxWindows`). **A stateless slice is plain exported functions** taking `core`
  first (`health.ts`, `boxes.ts`, `convid.ts` — with the statics `OC_SPAWN_SLACK_MS`/
  `OC_PROMPT_SLACK_MS` as module constants — `drive.ts`, `record.ts`, `tmux.ts`). No static is
  referenced outside the class today, so none needs a re-export.
- **The core is always called `core`** — the constructor parameter, the field (`this.core`) and
  the first argument of a stateless slice's functions. Not a style point: the pins below count
  `(?:this|core)\.emit\(`, `(?:this|core)\.persist\(` and so on, and a slice that names it `hub`
  or `c` is a slice the pins cannot see. `hostshape` asserts no `sessions/*.ts` or `intents/*.ts`
  (bar the facades) contains `\.(emit|persist|settle|block|archive)\(` preceded by anything but
  `this` or `core`.
- **Every hub member of the core object is an arrow that delegates at CALL time**:
  `checkLimit: (s) => this.wall.checkLimit(s)`. So construction order among slices is free, and
  during the split a hub member points at wherever the method currently lives (`this.checkLimit`
  in the facade until the wall package lands, `this.wall.checkLimit` after) — the same commit
  that moves a method retargets its arrow.
- **`SessionCore` grows only in `core.ts`**, one member per method a second slice needs, in review.
  Never a `wallHooks()` beside it, never a slice reading `core.sessions` to find another slice's
  state: a slice's non-hub method is not on the core and is therefore unreachable from another
  slice. That is the narrowness, and it is what stops the folder becoming the class again.
- The facade keeps `private sessions = new Map()` and hands the SAME Map to the core object. The
  Map is shared by reference; `this.sessions` in the facade and `core.sessions` in a slice are one
  object, so `register()`'s `set` and `remove()`'s `delete` stay where they are.
- `oracleDefaults` (the one public FIELD, injected by `main.ts`) stayed on the facade and the roster
  slice read it through `core.oracleDefaults()` — until the oracle became a plugin
  ([plugins.md](plugins.md)); the field, the hub member and `refreshOracle` are gone.

A slice's file has one shape: imports, the slice's own constants (or none — the knobs live in
`knobs.ts`), the class or the functions, nothing at module level that runs. `PRIVATE_MODE_RE`
(line 758) is a `/g` regex whose `lastIndex` the `onData` handler resets (1213): it stays in the
facade beside its one user.

### `IntentCore` — the same, in `intents/contract.ts`

`IntentManager` owns `rows`, `inflight`, `stopBase`, `stopSeen`, `watchMode`, `readopted`,
`archiveTail`, `lastKnownDirs`, `timer`, `ticking`, `reconciled`, `loadedSchema`, `path`,
`archivePath`, and `deps`. Ten methods touch the four completion maps (inventory §2.4). So:

- `IntentCore` = `{ readonly deps: IntentDeps; rows()/setRows() (`this.rows` is REASSIGNED at
  five sites across four slices — `upsert` 875 (write), `remove` 1592 (requeue), `replace` 2767
  (fire), `load` 3180 and `compact` 3428 (disk) — so a field shared by reference would go stale
  after the first of them; every read is `core.rows()`, every replacement `core.setRows(next)`,
  and the facade's `private rows` stays the one array behind both); the ledgers as fields
  (`inflight`, `stopBase`, `stopSeen`, `watchMode`, `readopted`) shared by reference — none is
  ever reassigned; `lastKnownDirs` as get/set (assigned in `pass`, 1798); `archiveTail` is
  reassigned at 3379 and 3405 but only inside `disk.ts`, which owns it; emit; kick; persist;
  archive; get; pending; settle; block; armFrom; armNew; newBasis; revive; wouldNotRun; present;
  chainFacts; unspend; complete; giveUp; endWithDeadSession; sweepRunning; fire; execute;
  resolveSessionFor; recordMissed; stampCleared; snapshotConv; replace }` — the list the
  dependency sketch derives.
- **`IntentDeps` is not narrowed per slice in this split.** Each slice reads the members it needs
  off `core.deps` (the sketch says which); narrowing to per-slice sub-interfaces is a later,
  separate change, because it would alter the `IntentDeps` shape `main.ts` builds and every test
  constructs.
- **`core.deps` is the SAME object the constructor received, and `deps.executors.<x>` is read at
  call time.** `ladderpass.test.mjs` (was `pickhold.test.mjs`; 337, 372) does `store.deps.executors.freshSession = …` AFTER
  construction; `pastbudget.test.mjs` spreads `store.deps` to build a second store. A slice that
  wrote `const { freshSession } = core.deps.executors` in its constructor would hold the stub the
  test replaced.
- **TypeScript `private` is not a runtime boundary, and the tests are `.mjs`.** `ladderpass.test.mjs`
  calls `store.pass()` (420, 445), `requeue.test.mjs` calls `store.fire(row, {})` (703, 710) and
  writes `store.inflight.set(…)` (708), `backlogedit.test.mjs` calls `store.settle(…)` (140). All
  three methods are `private` today and move (`pass` → ladder, `fire`/`settle` → fire). The
  facade therefore keeps a delegation for **`pass`, `fire` and `settle`** as well as for the
  public methods — still `private`, each with a one-line comment naming the test that reaches it —
  and `inflight` stays a facade field (shared by reference with the core, so the test's write is
  what `fire` reads). The same check for `SessionManager` found only public methods reached
  (`noteHookFallback`, `onHookEvent`, `diedAtLimit`, `listRecent`, `listClosed`, `getTranscript`,
  `recordPrompt`, `kill`, `create`, `get`, `list`, `on`/`off`): nothing private, and no test reads
  a private field or patches a prototype. Re-run the grep before each facade's first cut:
  `grep -ohE "store\.[a-zA-Z_]+" packages/host/test/*.mjs | sort -u` against the class's
  `private` members.
- `persist()` stays the ONE write to `intents.json` and moves to `disk.ts`; every slice calls
  `core.persist()`. The pin below counts those calls per file, so a slice that grows its own
  `writeFileSync` fails.

### `ServerCtx` — `main.ts`'s names as one record (`server/ctx.ts`)

`HostCtx` (`routes/types.ts`) already IS this record for the routes: the `ctx` literal at line
2070 maps main's module-level names 1:1. `ServerCtx extends HostCtx` adds the twenty names main's
other functions close over (listed in the layout). `main.ts` builds ONE object incrementally, in
boot order, and hands it to every factory; the same object is the `HostCtx` `dispatch()` receives.

**The one rule for a `server/` factory: read `ctx.<x>` at CALL time, never destructure at
construction.** The `IntentManager` deps literal (444–717) references `backlog` (782), `fanout` (784), `builds` (788), `capture` (799), `assessExecutor` (812), `usage` (1348),
`budget` (1374) — all defined AFTER it — and is safe only because the closures are late-bound and
nothing invokes them during construction (`load()` and `foldLegacyWorkParents()` read only
`deps.root`; `migrateLegacy` never calls `onChange`; `start()`'s synchronous `kick()` returns at
`!this.reconciled`). A factory that wrote `const { backlog } = ctx` at the top would capture
`undefined` for ever and type-check. `makeIntentDeps(ctx)` therefore returns closures over `ctx`
and the review checklist for the server package has this line.

**M1 builds the whole `ctx` from main's still-local names** — `ctx.startPrompt = startPrompt`,
`ctx.deliverChain = deliverChain`, … for every `ServerCtx` member, at the position each name is
defined today — so that M3's `makeIntentDeps(ctx)` can call `ctx.startPrompt(…)` two commits
before M2 moves `startPrompt` out. Later packages only retarget the assignment's right-hand side;
the set of names on `ctx` does not change after M1. (Today's `HostCtx` literal at 2070 is built
once, after every definition; the incremental object is equivalent because nothing reads `ctx`
before `main()`, and the late-binding rule is what keeps it so.)

## Caps and ratchets: `tools/hostshape.test.mjs`

Runs in `npm run test:unit` — its glob is already `"tools/*.test.mjs"`, so the file only has to
exist. Text only, no build, no import (as `webshape.test.mjs`). It holds:

- **Three ratchets**, starting at today's counts and lowered in every commit that moves code out:

  ```js
  const MAX_LINES = {
    "sessions.ts":         5598,
    "intents/manager.ts":  3456,
    "main.ts":             2426,
  };
  ```

  A commit that moves a package out sets each number to the new count (the `lines()` helper of
  `webshape`, trailing newline discounted). Raising one is a decision about the file every change
  conflicts in, never a way to pass. End-state targets, so the ratchets have a floor to aim at:
  `sessions.ts` ≤ 1,100, `intents/manager.ts` ≤ 450, `main.ts` ≤ 700 (planned as 650; "Result" says why
  it stops at 700).
- **`MAX_SLICE_LINES = 900`** for every `.ts` under `sessions/`, `intents/` (excluding
  `manager.ts` and `adapters.ts`, which have their own numbers) and `server/` — the same number
  `eslint`'s `max-lines` warns at and `webshape` fails feature files at. A slice at 900 is the
  class moved one folder down.
- **The two type files hold only types**: `sessions/core.ts` and `server/ctx.ts` contain no
  `function `, `class `, `=> {`, `new ` or `setInterval`/`setTimeout` token outside comments
  (`intents/contract.ts` is allowed its four pure helpers and is checked for no `class ` and no
  timer instead).
- **`main.ts` exports nothing**: no line matches `^export`. The entry point is never a library.
- **The facades keep their exports**: `sessions.ts` has `export class SessionManager`, and
  `tmuxEnvPrefix`, `sweepSessionStores` each appear in an `export` (declaration or
  `export { … } from`; `USE_TMUX` was on this list until tmux became the only substrate and it was
  deleted); `intents/manager.ts` has `export class IntentManager`, exports
  `ORIGIN_SCHEDULE_WORK`/`ORIGIN_SCHEDULE_SWEEP`, and `ExecutorResult`/`IntentExecutors`/
  `IntentDeps` each appear in an `export` (`interface` or `export type { … } from`). This is the
  `dist/` contract the tests and eight importers rest on, read off the source.
- **A move is a move**: no method NAME is defined both in a facade and in one of its slices. For
  `sessions.ts` the check is: a method HEADER in the facade is a line matching
  `^\s{2}(?:private |protected |static |readonly |async |get |set )*(\w+)\(.*\{\s*$` — a header
  that ends the line with `{`, so a one-line delegation (`{ return this.x.f(...); }` /
  `{ this.x.f(...); }`, which ends in `}`) is not one. Every such name must not also be a
  definition in any `sessions/*.ts`: `^(?:export )?(?:async )?function (\w+)\(` or the same
  header regex inside a class. Two things the first draft of this regex got wrong: it missed
  `static`/`get`/`readonly` modifiers (seven statics move), and without the trailing `\{` a
  2-space-indented STATEMENT in a plain-function slice (`  clearTimeout(s.idleTimer);`) reads
  as a definition named `clearTimeout`. Generic names (`get`, `list`, `has`, `remove`) are
  facade lookups with real bodies, so a slice class may not define a method of those names either
  — name it `rowFor`/`liveIds`, which is what it is. Left behind, both exist and the arrow on the
  core picks one in an order nobody chose. Same for `intents/manager.ts` against `intents/*.ts`
  (not `adapters.ts`) — remembering `pass`/`fire`/`settle` stay as one-line delegations, which the
  header regex correctly ignores — and for `main.ts` against `server/*.ts` (top-level `function`
  names).
- **Nothing runs at import time in `server/`**: every non-blank column-0 line of a `server/*.ts`
  matches `^(?:import |export |type |interface |const [A-Z_]+ = |\}|/\*|\s*\*|//)` — imports,
  exports, types, an UPPER_CASE constant table (`MIME`), comment lines and closers. That refuses
  a column-0 `sessions.on(`, a bare `setInterval(`, a `let knownDirsCache = …` (main 856 — module
  state that becomes a closure inside its factory), and the `for (const sig of …) process.on(sig,
  …)` loop at main 2380 — which a `^\w+\.on\(` check would have passed, since the `.on(` is
  indented under the `for`. Registration happens inside an exported `wire…`/`create…`/`make…`/
  `install…` function.
- **No slice imports a slice, no slice imports its facade**: the lint rule is the enforcement;
  the shape test asserts `eslint.config.js` applies `local/host-boundary` to
  `packages/host/src/**/*.{ts}` and that `tools/hostboundary.test.mjs` exists, so the rule cannot
  be silently unwired.
- **Unique basenames**: every `.ts` basename under `sessions/`, `intents/`, `server/` is unique
  across `packages/**` (excluding `node_modules`/`dist`) — the skill-map reason above.
- **Every slice is named by a sub-skill bullet HEAD** (`host-core` for `sessions/*`,
  `host-work` for `intents/*`, the `host` router's frame list for `server/*`): the same
  regex `skillmap.mjs`'s `headModules` uses, so a slice nobody routed to fails here rather than in
  the router drift test three commits later. Naming it in a sub-skill's head changes the router's
  printed map, and `claudemd.test.mjs` compares that map against `ownership()` — so the commit
  that lands a slice also regenerates `host/SKILL.md`'s map line (the test's failure message
  prints the one-liner), or `test:unit` fails on the router, not on the slice.

- **Added after the split's review** (2026-09-25), each a way the finished shape could be undone
  without any other test noticing:
  - **A `server/` factory never binds a `ctx` member at construction** — a 2-space-indent `const`/
    `let` whose right-hand side starts with `ctx` (a destructure or `ctx.x`) is refused, except
    `ctx.ROOT`/`BOOT_ID`/`PORT`/`DOCTOR`, which `main.ts` sets before any factory runs.
    `clients.ts` is exempt: it takes explicit deps, not `ctx`. `main.ts` fills `ctx` incrementally
    and the draft is a cast, so a binding at construction can hold `undefined` for ever and compile.
  - **A by-reference member of a facade's core literal names a `readonly` field** — every
    `name: this.field,` inside `this.core = {` in `sessions.ts` and `intents/manager.ts`. The slices
    keep that object; a reassignment in the facade would strand them, and `readonly` makes it a
    type error.
  - **No module assigns `process.env` at import** (a column-0 `process.env.X =` anywhere under
    `src/`) — the reason the knobs' place in the facades' import lists is not behaviour.

## Pins: `tools/hostpins.test.mjs`

A separate file from the shape test, as `queue.test.mjs` is separate from `webshape`: the shape
test says where things may live, this one says **how many of each dangerous thing exist and in
which file**, so a copy-then-delete move that leaves a copy behind, or drops one, fails with the
file named. Same text discipline as `queue.test.mjs`: `code()` strips comments, `noImports()`
strips import/re-export lines, every count is `deepEqual` against a per-file map. Every map below
is TODAY's, computed by the regexes shown against `packages/host/src/**/*.ts`; a move edits the
map in the same commit, and the diff of the map IS the review of the move.

Definitions are excluded by an explicit per-name regex (`function <name>(`, `private <name>(`);
nothing cleverer, so a builder can reproduce a count with `grep -c`. Interface members are NOT
excluded by regex: `HostCtx`'s `durableOp(ws, ackId, exec: () => OpVerdict | …): void` and
`startPrompt(…)`/`deliverInput(…)` carry nested parentheses, so a `^\s*<name>\([^)]*\):` exclusion
misses them and the count is off by one or two. `routes/types.ts` holds no calls at all, so the
pins **skip that file by name** instead. Every count below was recomputed on 2026-09-25 with the
regex shown and matched; the two rows the first draft had wrong or missing are marked †, and the
exclusion method of two more (chain, durable ops) is corrected in place.

| pin | regex (after `code()`+`noImports()`) | today |
| --- | --- | --- |
| **deliveries** — every call of the two delivery entry points | `\b(?:deliverPrompt\|deliverToNewSession)\(` minus `function …(` | `backlog.ts: 1, deliver.ts: 2, fanout.ts: 3, main.ts: 4` |
| **chain / first prompt / compose** | `\b(?:startPrompt\|deliverChain\|deliverInput)\(` minus definitions; `routes/types.ts` skipped | `main.ts: 4` (startPrompt 577, 613; deliverChain 581, 618), `routes/session.ts: 2` (startPrompt 189, deliverInput 279) |
| **PTY spawns** | `\bpty\.spawn\(` | `sessions.ts: 3` (1377 direct, 1383 tmux new-session, 1418 tmux attach), `builds.ts: 1`, `usage.ts: 1` |
| **tmux `new-session`** | `"new-session"` | `sessions.ts: 1` (1381) |
| **ack-ledger writes** | `\backs\.remember\(` | `main.ts: 1` (1997, inside `durableOp`), `routes/session.ts: 5`, `routes/work/workbacklog.ts: 3` (was `routes/work.ts: 2`; the work.ts split moved them) |
| **durable ops** | `\bdurableOp\(` minus `function durableOp(`; `routes/types.ts` skipped | `routes/index.ts: 1`, `routes/work/workbacklog.ts: 1`, `routes/work/workschedule.ts: 1` |
| **health observations, gated** | `\bnoteFor\(` minus `private noteFor(` | `sessions.ts: 12` (2279, 2355, 2362, 2363, 2545, 2796, 3356, 3566, 4186, 4187, 4188, 4973) |
| **health observations, direct** | `\bnoteHealth\(` minus `function noteHealth(` | `deliver.ts: 1, sessions.ts: 1` (2849 — the ONE inside `noteFor`; a second direct call anywhere is a bypass of `healthScope`) |
| **log / context health** | `\bnoteLogHealth\(`, `\bnoteContextHealth\(` minus `private …(` | `sessions.ts: 2` (4936, 4947), `sessions.ts: 1` (3270) |
| **hook registration** | `\bhookSettingsArg\(` minus its `function` | `backends/claude.ts: 1` (116) |
| **hook ingress** | `\bonHookEvent\(` minus the method definition | `api.ts: 1` (549) |
| **intervals** | `\bsetInterval\(` | `sessions.ts: 1` (1012), `intents/manager.ts: 1` (1716), `main.ts: 1` (832), `localrt.ts: 1`, `opendeliveries.ts: 1`, `setupwatch.ts: 1`, `update.ts: 2`, `usage.ts: 2` |
| **timeouts in the three files** | `\bsetTimeout\(` scoped to the three files + `sessions/**`, `intents/**`, `server/**` (so a moved timer is still counted) | `sessions.ts: 18`, `main.ts: 3`, `intents/manager.ts: 0` (the rest of the tree is not pinned) |
| **summary spends** | `\brunSummaryTask\(`, `\brunSummary\(`, `\bnameTab\(` minus definitions | `sessions.ts: 3` (5332, 5374, 5596), `sessions.ts: 2` (5273, 5322), `sessions.ts: 1` (5282) |
| **intent state writes, assignment** | `\.state\s*=\s*(?!=)` | `intents/manager.ts: 22` (and, not pinned but counted: `screenlog.ts: 1` — a different `state`; the pin is scoped to `intents/**`) |
| **intent state writes, literal** | `\bstate:\s*"queued"` (every row-literal write is `"queued"`; `settle`'s signature is not matched) | `intents/manager.ts: 6` (535, 736, 994, 1070, 3203, 3213) |
| **settle / block calls** | `\b(?:this\|core)\.settle\(`, `\b(?:this\|core)\.block\(` | `intents/manager.ts: 9`, `intents/manager.ts: 3` |
| **intents persist / archive** | `\b(?:this\|core)\.persist\(\)`, `\b(?:this\|core)\.archive\(` scoped to `intents/**` | `intents/manager.ts: 36`, `intents/manager.ts: 2` |
| **intents emits** | `\b(?:this\|core)\.emit\(\s*"` scoped to `intents/**` | `intents/manager.ts: 9` (settled ×6, requeued ×1, skipped ×1, missed ×1) |
| **sessions emits** | `\bthis\.emit\(\s*"` → after the split `\b(?:this\|core)\.emit\(\s*"`, scoped to `sessions.ts` + `sessions/**` | `sessions.ts: 71` (updated ×51, limit ×8, history ×2, and one each of data, exit, created, updateBanner, awaiting, prompt, idle, turnEnded, limitQueue, closed) |
| **main's subscriptions** | `\bsessions\.on\(\s*"`, `\bintents\.on\(\s*"`, `\bprocess\.on\(` scoped to `main.ts` + `server/**` | `main.ts: 15` (842, 843, 1147, 1150, 1156, 1157, 1158, 1160, 1271, 1289, 1411, 1421, 1569, 1573, 1628), `main.ts: 4`, `main.ts: 3` |
| **main's other subscriptions** † | `\b(?:autopull\|builds\|capture\|openDeliveries)\.on\(\s*"` scoped to `main.ts` + `server/**` — the first draft pinned only sessions/intents/process and would have let these four be copied | `main.ts: 4` (autopull 402 → `scan.ts`; builds 789 and capture 800 STAY; openDeliveries 1099 → `deliveries.ts`) |
| **notifications** † | `(?<![.\w])notify\(` minus `function notify(` scoped to `main.ts` + `server/**` — not `notify\(\s*"`, which missed the push bridge `(kind, p) => notify(kind, p)` at 334 | `main.ts: 30` (29 with a literal kind + the bridge) |
| **singleton registrations** | `\b(?:setCliHealth\|setOpenDeliveries\|setSentLog\|setContextLimitsStore\|installSessionModels)\(` minus definitions | `main.ts: 5` |
| **env file loads** | `\bloadEnvFile\(` → since 2026-09-28 `\bloadEnvFiles?\(` minus its definition (`envfiles.ts`, a later file wins) | `main.ts: 1` → `env.ts: 1` |

Three of these deserve a sentence. **`noteHealth` direct = 1 in `sessions.ts`** is the whole of
`host-core`'s "one private `noteFor` gates every `noteHealth` on `healthScope`" rule made
countable: after the split that 1 lives in `sessions/health.ts` and nowhere else under
`sessions/`. **`sessions emits` counts `"updated"` 51 times** — not because 51 is right but because
a move that turns two of them into one (or one into two) is a behaviour change the phone sees as a
missing or duplicated `session.updated` frame. **`acks.remember` in `main.ts: 1`** is the
`durableOp` write; when `durableOp` moves to `server/wsops.ts` the map says `server/wsops.ts: 1`
and `main.ts` drops to 0, in the same commit.

**A pin some other test already holds, which a move breaks without failing:**
`packages/host/test/backlogstore.test.mjs` reads `../dist/backlog.js` and `../dist/main.js` AS
TEXT and asserts (a) neither decides retryability with `retry: last === "retry"` and (b) every
`chainDeliveryError(` has a `step` within 260 chars before it. When `deliverChain` and the
`freshSession` executor leave `main.ts`, that test keeps passing on a `main.js` that no longer
contains the code — a pin that has silently stopped pinning. The commit that moves them adds
`../dist/server/deliveries.js` and `../dist/server/intentDeps.js` to that test's file list (and may
drop `main.js`).

**Order pins**, added after the review: a count cannot see two listeners swap. `hostpins` also
`deepEqual`s the ORDER of `sessions.on(…)` in `server/sessionEvents.ts` (fifteen, three of them
`"exit"`), of `intents.on(…)` in `server/intentEvents.ts`, and of the SIGTERM flush in
`server/shutdown.ts` (the ack ledger first). A reorder edits the list and says so in the commit.

## The inventory — the plan, as written before the cuts

Regions → destination → package. Packages are sized for one builder (~300–700 lines of NEW file
each) and named `S1…`, `I1…`, `M1…`. Within a file, `*` marks a doc comment that today sits above
the wrong method and must travel with the method it describes (inventory §1 lists six in
`sessions.ts`, two in `manager.ts`, one in `main.ts`).

### `sessions.ts` (5,598 lines → facade ≤ 1,100)

| lines | region | → | package |
| --- | --- | --- | --- |
| 1–43 | imports | facade keeps what it still uses; each slice imports its own | every |
| 45–155, 157–186, 188–227, 229–302, 450–451, 767–793 | module constants (the `WATERPLANE_*` reads: `SUMMARY_MODEL` 76, `IDLE_PING_MS` 155, `STOP_VERIFY_MS` 181, `HEALTH_SPAWN_GRACE_MS` 207, the `LIMIT_*` block 233–302, `AGENT_POLL_MS` 277, `CLAUDE_ID_POLL_*` 450, `ORPHAN_*` 786–793) | `sessions/knobs.ts` — constants only; `isPassiveInput` (110) → `drive.ts`, `healthTail` (221) → `health.ts` | **S1** |
| 368–389, 391–407, 453–755 | `LiveMeta`, `ClosedRow`/`RecentRow`, `Session` | `sessions/core.ts` + the new `SessionCore` | **S1** |
| 311–366, 1331–1457, 1675–1714, 1716–1757, 795–840, 4582–4587 | `USE_TMUX`, `defaultTmuxServer`, `TMUX_SERVER` (module-level call at 338 — stays an import-time computation, now in `tmux.ts`; it reads env and hashes a path, no subprocess), `tmuxName`, `tmuxEnvPrefix`; `spawnBackend`/`paneCwd`/`reattach` (1401; calls the private `register` at 1442 → hub member); `tmuxConfPath`/`ensureTmuxConf`; `livePath`…`deleteLive`; `aliveSessionIds`/`armOrphanSweep`; `sweepSessionStores`; `hasLiveTmux` | `sessions/tmux.ts` (facade re-exports the three exports) | **S2** |
| 303–310 | the hook-lifecycle comment (sits above `USE_TMUX`, describes `onHookEvent`) | travels with `onHookEvent` → `sessions/turn.ts` | **S5** |
| 409–448, 1459–1640, 2503–2521 | `backendField`, `lastAssistantModel`; claude + opencode id detection (`OC_SPAWN_SLACK_MS`/`OC_PROMPT_SLACK_MS` statics go with it); `refreshModel`* | `sessions/convid.ts` | **S3** |
| 2799–2850, 3350–3366, 4968–4995 | `healthScope`, `noteFor`, `noteContextHealth`, `noteLogHealth` | `sessions/health.ts` | **S3** |
| 1759–1788, 1790–2154, 2248–2285, 2287–2367, 4155–4196 | `scheduleChecks`/`armPromptCheck`; `checkPrompt`, `checkOpencodeBox`, `choosePromptBox`, `enrichPrompt`; `setAwaiting`; `applyLogin`, `applyPrompt`; `submitPromptBox` | `sessions/boxes.ts` | **S4** |
| 2156–2246, 2369–2501, 2523–2797, 2852–2947, 4398–4437 | `checkAsking`/`checkAgents`/`setAsking`; `checkIdle`, `setTurn`*, `markIdle`; `onHookEvent`*, turn watch, stop verify, `routeHook`, `isHooked`/`sawTurnHook`/`inCopyMode`, `noteHookFallback`; `stopCount`…`geometry`, the submits ring*; `ackAsking`, `setSuggestion` | `sessions/turn.ts` | **S5** |
| 2949–3008, 3384–3765 | limit config (`newLimitState`…`setSessionLimitOverride`, `limitAuto`, `refreshLimit`, `writeLimitCfg`); `limitLog`, `checkLimit`*, `markLimitBlocked`, `clearLimitBlock`, `limitRetry`, `noteGaveUp`, `scheduleLimitAttempt`, `onLimitDue`, `doLimitContinue`, `clearLimitTimer` | `sessions/wall.ts` (class: owns `autoContinueOn`, `limitCfgPath` and `resumeMode` — the three things `writeLimitCfg` persists; the limit-config region also calls `pumpResume`, `publishQueue`, `releaseResume` and reads five resume fields — every one a hub member, listed under `SessionCore`) | **S6** |
| 3010–3248, 3767–3937 | the resume queue (`pumpResume` 3163, `publishQueue`, `releaseResume`); `diedAtLimit`, `noteRevived`, `clearResurrectTimer`, `maybeScheduleResurrect`, `doResurrect` | `sessions/resume.ts` (class: the `resume*` fields except `resumeMode`, `revivedBy`/`revivedAt`/`revivedPath`, `REVIVED_MAX`; calls wall's `clearLimitTimer`, `doLimitContinue`, `limitRetry`, `scheduleLimitAttempt`, `writeLimitCfg` through `core`) | **S7** |
| 3250–3349, 3368–3382, 4813, 4997–5208 | `checkContext`*, `refreshSpark`, `contextWindow`, `noteAndResolveWindow`; `flushContextWindows`; `ocFor`*, `ocContextSeries`, `logFor`, `getToolDetails`, `getContextSeries` | `sessions/ctxseries.ts` (class: owns `ctxWindows`) | **S8** |
| 3939–4033, 4326–4396, 4439–4535 | recent/closed rows (+ the statics `RECENT_PER_CWD`, `RECENT_LIMIT`, `CLOSED_LIMIT`), stars/pins/labels (+ `LABEL_CAP` 4355), oracle state, `rename` | `sessions/roster.ts` (class: `recent`, `recentlyClosed`, `stars`, `pins`, `watched`, their paths; the constructor's six file reads at 967–990 and the `hasLiveTmux` sweep at 979 move into the slice constructors in the same relative order) | **S9** |
| 4035–4153, 4198–4324, 4537–4581, 4595–4630, 4632–4757 | `input`, `panHistory`, `leaveCopyMode`, `write`, `markSubmitted`, `clearReplySuggestion`, `waitReady`, `readyForAutoFire`, `autoFireBlocker`, `resize`, `setRemoteControl`; `kill`, `detach`, `reattachById`, `remove`; `scrollback`…`idleMs` | `sessions/drive.ts` | **S10** |
| 4759–4819 (minus 4813), 4821–4966, 5210–5249, 5251–5408, 5410–5472, 5552–5597 | `recordPrompt`, `getHistory`; `getTranscript`; `search`; `summarize`, `nameNow`, `nameTab`, `finalizeCapture`; the six path/IO helpers; `lastTurnOf`, `runSummary` (+ the summary prompts 76–105) | `sessions/record.ts` | **S11** |
| 842–1329, 1642–1673, 5474–5549, 757–765 | class doc, fields, constructor, `create`/`fork`/`register` (with `onData` 1200–1266 and `onExit` 1267–1323 — the PTY wiring, the thing there is ONE of), `rediscover`, the lookups; `PRIVATE_MODE_RE`/`modePrefix` | **stays in `sessions.ts`**, plus one delegation per public method | facade |

**Cut order.** S1 first and alone (it moves types and constants, changes no behaviour, and every
other package imports it). Then S2…S11 are built as NEW files in parallel — each builder writes
its slice against `SessionCore` as S1 defined it, adding a hub member to `core.ts` only when its
slice calls a method another slice owns (say which, in the PR). Integration is serial, one package
per commit, in this order: **S2 tmux → S3 convid+health → S8 ctxseries → S9 roster → S6 wall → S7
resume → S5 turn → S4 boxes → S10 drive → S11 record.** Leaves and small state-owners first; the
two strongly-connected clusters (wall+resume, turn+boxes) adjacent so their cross-calls go through
`core` arrows that already point at slices; `drive` and `record` last because they are the public
verbs most e2e scripts exercise, so the fullest suite runs on the fewest remaining moves.

Ratchet after each: S1 ≈ 4,900 · S2 ≈ 4,550 · S3 ≈ 4,200 · S8 ≈ 3,800 · S9 ≈ 3,550 · S6 ≈ 3,100
· S7 ≈ 2,700 · S5 ≈ 2,050 · S4 ≈ 1,350 · S10 ≈ 900 (+ delegations) · S11 ≈ 1,000 with
delegations. Each commit's number is the measured count, not these estimates.

**Ordering hazards in `sessions.ts`:**

- The constructor (965–1060) reads six files in a fixed order, calls `hasLiveTmux` per
  `alive` closed row (a `tmux has-session` subprocess each, under `USE_TMUX`), and arms the ONE
  `setInterval` (1012, `.unref()`, handle not stored) LAST. After the split the constructor
  constructs the slices (each reading its own files in the same relative order: `ctxWindows` first,
  then recent, closed, stars, pins, revived, limit config), then builds the core object, then arms
  the interval. The interval body calls `refreshSpark` and `checkLimit` and reads `resumingIds` —
  after the split `this.ctx.refreshSpark`, `this.wall.checkLimit`, `this.resume.has(id)`; the
  gates and their order inside the sweep (`running` → spark → `sawData` → quiet-or-blocked-and-not-
  resuming → `checkLimit`) are behaviour (`e2e-limitqueue.mjs` fails on the resuming clause).
- `register()`'s setup order (1153–1198): Session literal → `loadSummary` → `sessions.set` →
  `applyPromptLabels` → `refreshOracle` → `rememberRecent` → `watchClaudeId`/`watchBackendId` →
  `proc.onData` → `proc.onExit` → emit `created`. Keep it; the slices are called from it in that
  order.
- `onExit` (1267–1323) calls, in order: `finalizeCapture`, `clearStopVerify`, `clearLimitTimer`,
  `stopClaudeIdWatch`, the two id detections, `deleteLive`, `pushClosed`, emit `updated`, emit
  `exit`, `maybeScheduleResurrect`. `main.ts` has THREE `exit` listeners (843 intents, 1156
  broadcast, 1289 scan cleanup) in that registration order; the emit's position relative to
  `maybeScheduleResurrect` decides whether the intents store sees `diedAtLimit` before the
  resurrect timer exists. Do not reorder.
- Every per-session timer (`idleTimer`, `promptTimer`, `agentTimer`, `stopVerifyTimer`,
  `limitTimer`, `resurrectTimer`, `claudeIdTimer`, `ocIdTimer`) lives on the `Session` record, so it
  moves with `core.ts` and the slice that arms it clears it through the same field — no slice
  holds a timer for a session in a private map. Only `resumeGuards`/`resumeGapTimer` are
  manager-level and they belong to `ResumeSlice`.
- `this` handed out: nothing hands a bound method to another module (inventory §1.5); every
  timer callback is an arrow. After the split an arrow inside a slice closes over the slice's
  `this` and `core`, which is the same object graph.
- `screenText`/`screenCells`/`input`/`write`/`create`/`recordPrompt` are PUBLIC and called
  internally by five regions: they are on `SessionCore` by their public names, delegating to the
  slice that holds them — never a second `screenTextInner`.
- The class doc (842–853) does not list `created`, `awaiting`, `closed`; fix the comment in S1
  (a comment, not behaviour).

### `intents/manager.ts` (3,456 lines → facade ≤ 450)

| lines | region | → | package |
| --- | --- | --- | --- |
| 1–63, 64–109 | the header doc (the store's rules); the imports (`node:*` and one `@waterplane/shared` list — the facade keeps what it still uses, `contract.ts` takes the rest) | stays in `manager.ts` | facade |
| 110–181, 183–196, 198–484, 486–560 | knobs (`TICK_MS` reads env at import — stays an import-time read, now in `contract.ts`), the `ORIGIN_*` re-export (stays in the facade), `ExecutorResult`/`IntentExecutors`/`IntentDeps`, `isTerminal`/`isRecurring`/`spanWords`/`revivedShape` | `intents/contract.ts` + the new `IntentCore` | **I1** |
| 2772–2942 | `armNew`, `newBasis`, `armFrom`*, `graceFloor`, `skipNext`, `setArmed` | `intents/clock.ts` | **I2** |
| 640–692, 3149–3299, 3301–3456 | `foldLegacyWorkParents`; `load`, `migrateLegacy`, `migrateFileAt`, `migrateFile`, `present`; `chainFacts`, `readArchiveTail`, `compact`, `archive`, `persist`, `flush` | `intents/disk.ts` (class: `path`, `archivePath`, `loadedSchema`, `archiveTail`) | **I2** |
| 710–880, 882–1224 | `post`, `snapshotConv`, `upsert`; `waive`, `update`, `retarget`, `edit`, `name` | `intents/write.ts` | **I3** |
| 1226–1556, 1558–1710 | `markDone`, `revive`, `requeue`, `requeueFailed`, `wouldNotRun`; `emitChanged`, `cancel`, `dismiss`, `remove`, `runNow`, `noteSession`, `fileLanded` | `intents/requeue.ts` | **I4** |
| 1741–2031, 2617–2685 | `pass` (with its `groupBusy`/`nonGo` closures), the "State transitions" section comment (2619), `block` | `intents/ladder.ts` (the facade keeps a one-line `private pass()` delegation — `ladderpass.test.mjs` calls it) | **I5** |
| 2269–2616, 2686–2770 | `fire`, `execute`, `resolveSessionFor`; `unspend`, `stampCleared`, `recordMissed`*, `settle`, `replace` | `intents/fire.ts` (the facade keeps one-line `private fire()` and `private settle()` delegations — `requeue.test.mjs` and `backlogedit.test.mjs` call them) | **I6** |
| 2033–2267, 2944–3147 | `onTurnEnded`, `onSessionExit`, `sweepRunning`, `giveUp`, `sessionAwaitingInput`, `complete`, `endWithDeadSession`; `reconcile`, `reconcileOne` | `intents/watch.ts` | **I7** |
| 562–638, 694–708, 1712–1739 | class, fields, constructor, `list`/`get`/`pending`, `start`/`stop`/`kick`/`tick` | **stays in `manager.ts`** + delegations | facade |

**Cut order.** I1 alone, then I2…I7 as new files in parallel, integration serial: **I2 clock+disk
→ I3 write → I4 requeue → I5 ladder → I6 fire → I7 watch.** `disk` first because `persist` is the
one write and every later package retargets `this.persist()` → `core.persist()` in the pin map;
`ladder`/`fire`/`watch` last because they are what `intentsched`, `requeue`, `pastbudget`,
`ladderpass` (was `pickhold`), `queuehere` and `naming` tests drive, and the whole `test:host`
suite plus `e2e-schedule`/`e2e-timedwork`/`e2e-backlog-slots`/`e2e-resurrect-item` run on each.

Ratchet after each: I1 ≈ 2,950 · I2 ≈ 2,450 · I3 ≈ 1,950 · I4 ≈ 1,450 · I5 ≈ 1,120 · I6 ≈ 620 ·
I7 ≈ 400.

**Ordering hazards in `manager.ts`:**

- The constructor is four lines: paths, `load()`, `foldLegacyWorkParents()`. Both may `persist()`
  (and `persist` may `compact` → `archive` → `appendFileSync`) at construction on a legacy or
  schema-<3 file. No timer, no listener, no `kick`. Keep it exactly so: `DiskSlice` is constructed
  first and its two boot calls are the constructor's only calls.
- `pass()` mutates rows directly (1767, 1777, 1914–1915) beside the transition methods; those
  lines are not `.state =` writes and the pin does not see them — the review does.
- `reconcileOne` never persists (`reconcile` does, once, if dirty); `revive` never persists or
  kicks (its callers do); `markDone` clears `stopBase`/`watchMode`/`readopted` but NOT `stopSeen`.
  Each of these is a behaviour a tidy-minded builder would "fix" — do not.
- `compact()` REPLACES `this.rows`; every slice reads rows through `core.rows()` and never caches
  the array across an `await`.
- `emit("settled" | "requeued" | "skipped" | "missed", row, result)` — `main.ts` subscribes to all
  four (888–1002); the (row, result) shape and the emit's position relative to `persist()` in each
  method (`persist` then `onChange` then `emit`) is behaviour.

### `main.ts` (2,426 lines → ≤ 650 planned, 700 landed)

| lines | region | → | package |
| --- | --- | --- | --- |
| (new) | `ServerCtx extends HostCtx` | `server/ctx.ts` | **M1** |
| 164–224, 296–298, 300–319 | client bookkeeping, `send`, `broadcast`, `notifications`/`notify` | `server/clients.ts` — `createClients({ auth, notifyPrefs, push, sessions })` returning the sets, maps and functions; `main.ts` assigns them into `ctx` | **M1** |
| 225–294, 866–886, 1075–1134, 1882–1958 | `startPrompt`, `deliverChain`, the `OpenDeliveries` construction + resend callback + `settled` listener + `deliverySnapshot`, `deliverInput` | `server/deliveries.ts` — `createDeliveries(ctx)` (reads `ctx.backlog`, `ctx.sessions`, `ctx.notify`, `ctx.netstats` at call time). Extend `backlogstore.test.mjs`'s file list in the SAME commit. | **M2** |
| 1807–1880 (minus the `new AckLedger`/`new NetStats` lines, which stay), 1960–2040, 2198–2265 | `OpVerdict`/`InputVerdict` (drop the local duplicates in favour of `routes/types.ts`'s exports — types only), `opsInFlight`/`inputsInFlight`, `sendOpAck`, `durableOp`, `containRepoDir`, `attachWs` | `server/wsops.ts` — `createWsOps(ctx)` | **M2** |
| 426–717, 844–865 | the `IntentManager` deps literal, executors included; `knownDirsCache` + `knownRepoDirs()` (the deps literal's `knownDirs` at 509 is its only reader — the first draft left these 22 lines out of the inventory) | `server/intentDeps.ts` — `makeIntentDeps(ctx): IntentDeps`; the cache becomes a `let` INSIDE the factory (module-level state is refused by `hostshape`); `main.ts` keeps `const intents = new IntentManager(makeIntentDeps(ctx))` at its current position | **M3** |
| 888–1002, 1012–1073, 2042–2060 | `intents.on(…)` ×4, `textOf`, the six snapshots, `padNotesFor`* | `server/intentEvents.ts` — `createSnapshots(ctx)` + `wireIntentEvents(ctx)` | **M4** |
| 358–424, 1164–1268 | `announceBuild`, `considerPull`, the three `*Seen` maps, the scanners, `pullNewFiles`, `pullCatchUp`, `fmtSize` | `server/scan.ts` — `createScan(ctx)` | **M4** |
| 839–843, 1147–1163, 1271–1298, 1409–1540, 1542–1717 | every `sessions.on(…)`, `proposeReply`, the limit-event log | `server/sessionEvents.ts` — `wireSessionEvents(ctx)`, called from `main.ts` at the position of TODAY'S FIRST `sessions.on` (842), registering in today's order | **M5** |
| 1719–1805, 2267–2312, 2327–2362 | `MIME`, `readSmallJson`, `handleAuthHttp`, `serveStatic`, the request handler, `listenWithRetry` | `server/http.ts` — `createHttp(ctx)` returning `{ handler, listenWithRetry }` | **M6** |
| 2364–2421 | signal + process handlers | `server/shutdown.ts` — `installShutdown(ctx)` | **M6** |
| 1–162, 321–356, 719–837, 1004–1010, 1136–1146, 1300–1407, 1813, 1821, 2062–2096, 2098–2325, 2423–2426 | imports, env, every construction, every `.start()`, every singleton registration, the linger sweep, the two run-output broadcasts (`builds.on` 789, `capture.on` 800), `ctx`, `handleClientMessage`, `main()` | **stays in `main.ts`** | entry |

**Cut order.** M1 alone — `ctx.ts`, `clients.ts`, AND the `ctx` object in `main.ts` populated
with every `ServerCtx` member from the still-local names (above). Then M2…M6 as new files in
parallel; integration serial **M1 → M3 → M4 → M2 → M5 → M6**: the deps literal before the events
that read the same snapshots (M3 reaches `startPrompt`/`deliverChain` as `ctx.startPrompt`/
`ctx.deliverChain`, which M1 assigned and M2 later retargets); deliveries before the session events
that call `pullNewFiles`/`proposeReply`; HTTP last because it is `main()`'s own body and the last
thing the e2e harness would notice.

**Ordering hazards in `main.ts`** (inventory §3 has the full 56-step boot list):

- **Listener order is behaviour.** `sessions.on("exit")` has three listeners registered at 843,
  1156 and 1289 and they fire in that order. `wireSessionEvents(ctx)` must register ALL of main's
  session listeners in today's order, and the `turnEnded`/`exit` → intents pair (842–843) stays
  FIRST — it is registered before the store's own `intents.on` blocks and before the broadcast
  listeners, and `listenWithRetry`'s callback (`sessions.rediscover()` → `intents.reconcile()`) relies on every listener existing before `rediscover` emits.
- **Late binding, not TDZ.** The deps literal, `startPrompt` (reads `backlog`), the `assessExecutor.notes` (reads `settings`), the `usage` callback (reads
  `budget`) and `announceBuild` (reads `fmtSize`, a `const` at 1268) all reference names defined
  later and are correct only because nothing invokes them before `main()`. A factory reads
  `ctx.<x>` at call time; the review checklist for M2–M5 says so and `hostshape` refuses a column-0
  `.on(` in `server/`.
- **`DOCTOR` gating.** `intents.start()` (1010), `openDeliveries.start()` (1130) and
  `syncUsagePolling()` (1402) are `if (!DOCTOR)`; the `tokenStats` 20 s timeout (356), the linger
  `setInterval` (832) and `primeBackendModels` (2117) are NOT. Keep each exactly as it is; a
  factory that takes `DOCTOR` and gates "for consistency" changes `--doctor`'s behaviour.
- **Singletons** (`installSessionModels` 144, `setContextLimitsStore` 162, `setCliHealth` 336,
  `setOpenDeliveries` 1098, `setSentLog` 1315) are registered immediately after their construction;
  they stay in `main.ts` beside the `new`, and the pin holds the count at 5.
- `process.loadEnvFile` ×3 (109–115) runs before `PORT` is read; it stays the first statement
  after the imports.
- The orphaned comment at 968–975 documents `"missed"` but sits above `on("skipped")` — travels
  with `on("missed")`.

## Readiness — the plan, as written before the cuts

- **`intents/manager.ts`: ready now, independent of `sessions.ts`.** It is a leaf (no host
  imports; `deps` injected), its tests construct `IntentManager` directly and import from
  `dist/intents/manager.js` and `dist/intents/adapters.js` — paths that do not move — and the only
  outside coupling is `main.ts`'s deps literal, which this split does not touch. It can run in
  parallel with the sessions split by a separate integrator (disjoint files; the shared tree only
  bites on the SAME file). Prerequisites: `hostshape` + `hostpins` landed with the intents rows;
  `local/host-boundary` wired; `intents/contract.ts` (I1) landed and reviewed. Two things the
  review added to "ready": the facade keeps `pass`/`fire`/`settle` delegations because the tests
  call them past `private`, and `core.deps` is the constructor's object, not a copy.
- **`main.ts`: ready independently of `sessions.ts`, sequenced last.** Its dependencies are the
  two facades' public APIs, which are unchanged. But it is the file every e2e run boots through
  (96 spawn sites), so every one of its six commits costs the full `run-e2e.mjs`, not a filter;
  `HostCtx` (`routes/types.ts`) gains a sibling type; and `backlogstore.test.mjs`'s text pin must be
  re-pointed in M2. Do it once the sessions and intents ratchets have reached their floors and the
  e2e suite has run green on those, so a failure in the main split is a failure in the main split.
  Prerequisite over and above the tests: `server/ctx.ts` (M1) reviewed for the late-binding rule.

## The never-fork list holds

`deliver.ts` and `render.ts` are not touched by this split: neither is one of the three files,
and nothing in the inventory copies a line of either. `sessions.ts` imports `renderCapture`/
`renderCells` (14) and `samePromptText` (16); after the split `record.ts` and `drive.ts` import the
same names from the same files. If a later cut ever wants `deliver.ts` inside a folder, it MOVES
whole (`git mv`, one commit, the `deliveries` pin's `deliver.ts: 2` row renamed with it) or not at
all. The same holds for `download.ts` and `PromptComposer.tsx` on the web side. A slice that finds
itself wanting "a small deliverPrompt for this one case" has found the reason the rule exists.

*Later (2026-10-04):* `deliver.ts` was cut into `deliver/` after all — as a MOVE behind the same
facade, one `runDelivery`, nothing outside the folder importing a slice. See "The deliver slices"
below; the rule above (no second implementation) is exactly what that section keeps.

## Doing one package, step by step

1. Re-derive the region's lines: `grep -n "^  \(private \|async \)*<method>(" packages/host/src/sessions.ts`
   for each method in the package's row. The note's numbers are stale by then.
2. Write the NEW file only: the methods verbatim, `this.<field>` → the slice's own field or
   `core.<hub>`, `this.<privateMethodOfAnotherSlice>` → `core.<hub>` (adding the member to
   `core.ts` if it is new, and saying so). Comments travel with their method, including the
   stranded ones the inventory names. Build: `npm run build -w @waterplane/host` must pass with the new
   file unused.
3. Integrate: delete the moved methods from the facade, add one-line delegations for the public
   ones, retarget the core arrows, lower the ratchet, move the pin counts. One package, one
   commit, one agent holding the facade.
4. Gate in a clean worktree: `scripts/verify-rev.sh <rev> <e2e filters>` — for a sessions package
   at least `limitqueue`, `resurrect`, `scrollcomposer`, `screenrec`, `hook`; for an intents package
   `schedule`, `timedwork`, `backlog-slots`, `resurrect-item`; for a server package the full suite.
   Then `npm run restart` and `/api/health` → `ptys.masters` equals `sessions`.
5. Name the slice in its sub-skill's bullet head (`host-core` / `host-work` / the
   router's frame) in the same commit, or `hostshape` fails; the reasoning for the slice, if any is
   new, goes in `host.md` under the slice's name.

## S1 as landed (decisions a later package builds on)

- **The hub list was derived by script, not by reading.** Every `this.<member>` in every method,
  with each method and field assigned to its slice by the inventory above; a member is on
  `SessionCore` when a method of one slice (or the facade's `register`/`onExit`/constructor) reaches
  it and another slice owns it. `sessions/core.ts` groups the members by OWNING slice, so an
  integrator retargets exactly one group. Beyond the names this note sketched, the code needed:
  `closedRow(id)` (ctxseries's `ocFor`/`logFor` and the facade's `keepsClaudeLog` find a closed
  row), `dropClosed(id)` (drive's `reattachById` REASSIGNS `recentlyClosed`), `isWatched(id)` (turn's
  `markIdle`), `assignResumeMode(mode)` (resume's `setResumeMode` writes wall's field),
  `setResumeProven` (wall's `markLimitBlocked` writes it) and `dropResumeFirst(id)` (wall's
  `clearLimitBlock` deletes from it). `markIdle` is NOT a member: only `turn` calls it.
- **Knobs are imported after the facade's own flat imports, before the modules only slices
  import** (`sessions/tmux.ts` and the rest, which import knobs themselves, so knobs is still
  evaluated first among them). Safe because nothing in the host assigns `process.env` at import —
  `hostshape` checks that — so where the env reads run in the import order cannot change a value.
  The one import-time WRITE is `env.ts`'s `.env` load, which is `main.ts`'s first import, so every
  knob read runs after it. The summary prompts (76–105 in the old file) went to
  `knobs.ts` with the other constants; `record.ts` imports them from there. `isPassiveInput` and
  `healthTail` stayed in the facade with their regex/row constant as the inventory says.
- **A hub arrow is a forwarder, and the pins say so.** `  noteFor: (…) => this.noteFor(…),` is one
  key plus one call; `hostpins`' `hubDefs()` takes one out per key and skips `sessions/core.ts` by
  name (its interface members look like calls), so the three health pins still count real call
  sites and their totals do not move when the method does.
- The facade holds `void this.core;` so `noUnusedLocals` accepts a field only S2 onwards reads;
  S2 deletes that line.
- Ratchet: `sessions.ts` 5,598 → 5,077 (the hub literal is ~70 of the lines the move freed).

## S2 as landed

- **The tmux constants are knobs, not `tmux.ts`'s.** `USE_TMUX`, `defaultTmuxServer`, `TMUX_SERVER`,
  `TMUX_PREFIX`, `tmuxName` went to `sessions/knobs.ts`, because the facade's `rediscover` and
  drive's `kill`/`detach`/`remove`/pan code name the server too, and a slice may import knobs but
  never another slice. Still evaluated once at import; the facade imports `tmux.ts` AFTER knobs.
  The facade re-exports `tmuxEnvPrefix`/`sweepSessionStores` from `tmux.ts` (and re-exported
  `USE_TMUX` from knobs until the direct-PTY substrate was removed, taking the constant with it).
- **`backendField` and `lastTurnOf` are hub members** (facade group): `reattach` builds a
  `SessionInfo` with both. They point at the facade's module functions until S3/S11 move them.
- `tmux.ts` is stateless functions taking `core`; the facade keeps one-line private delegations
  (`spawnBackend`, `reattach`, `persistLive`, `loadLive`, `deleteLive`, `armOrphanSweep`,
  `hasLiveTmux`) for its code not yet moved. Pins moved: the three `pty.spawn`, `"new-session"` and
  one `setTimeout` → `sessions/tmux.ts`. Ratchet 5,077 → 4,764.

## S3 as landed

- **`healthTail` went to `boxes.ts` (S4), not `health.ts`**: its only callers are `setAwaiting` and
  `submitPromptBox`, and a slice cannot import another. The facade keeps its copy until S4 lands.
- **`backendField` moved to `convid.ts`**; the hub member S2 added now points at it, and the facade's
  `create` imports it from there.
- `noteFor`, `noteContextHealth` and `noteLogHealth` take no `core` (they read only the session), so
  the facade calls the slice's functions DIRECTLY rather than through a one-line delegation — a
  forwarder would be one more `noteFor(` call site the pins count. `healthScope` (public) keeps a
  one-line delegation; convid's methods (which take `core`) keep private ones, S2's shape.
- Pins moved: `noteHealth` direct → `sessions/health.ts` 1; `noteFor` 2 → `sessions/health.ts`;
  four `setTimeout` and three `"updated"` emits → `sessions/convid.ts`. Ratchet 4,764 → 4,447.

## S8 as landed

- **The hub is built FIRST in the constructor now**, straight after `super()`, before any file is
  read. `CtxSlice` is the first stateful slice and takes `core` in its constructor, and it must be
  constructed first among the file reads (`ctxWindows` before recent/closed/stars/pins/revived/limit
  config) — which is before the literal's old position. Building the literal calls nothing (every
  member is a call-time arrow; `root`/`port`/`sessions` are already set), so moving it is neutral.
  Every later stateful slice (roster, wall, resume) is constructed in the same place, after the hub.
- `CtxSlice(core, root)` owns `ctxWindows`. The facade's field is `ctx`; the minute sweep calls
  `this.ctx.refreshSpark`. One-line delegations: public `flushContextWindows`, `getToolDetails`,
  `getContextSeries`; private `checkContext` (for `checkIdle`), `ocFor`/`logFor` (for
  `getTranscript`) until turn/record land. The stranded `checkLimit` doc above `checkContext` stays
  in the facade for S6; the stranded `logFor` doc now sits above `logFor`.
- Pins moved: `noteContextHealth` 1 and two `"updated"` emits → `sessions/ctxseries.ts`.
  Ratchet 4,447 → 4,115. No hub member added.

## S9 as landed

- `RosterSlice(core)` owns `recent`, `recentlyClosed`, `stars`, `pins`, `watched`, their paths
  and the four statics (`RECENT_PER_CWD`, `RECENT_LIMIT`, `CLOSED_LIMIT`, `LABEL_CAP`), and reads
  its four files in its constructor. **Built right after `CtxSlice`**, so the boot read order stays
  `ctxWindows` → recent → closed (with the `hasLiveTmux` downgrade, which is why the hub exists
  before it) → stars → pins → revived → limit config.
- The roster hub arrows point at the slice; the facade keeps one-line delegations for the public
  verbs and calls `this.roster.*` where it used the fields. No hub member added. Pins moved: nine
  emits (`updated` ×8, `closed`) → `sessions/roster.ts`. Ratchet 4,115 → 3,832.

## S6 as landed

- `WallSlice(core)` owns `autoContinueOn`, `limitCfgPath` and `resumeMode`: the auto-continue
  config, `limitLog`, `checkLimit`, `markLimitBlocked`/`clearLimitBlock`, `limitRetry`,
  `noteGaveUp` and the continue ladder, moved verbatim. Calls into the resume queue go through the
  core accessors that already existed (`isResuming`, `resumeQueue`, `resumeHoldUntil`,
  `setResumeProven`, `dropResumeFirst`, `releaseResume`, `publishQueue`, `pumpResume`,
  `requestResume`), health through `core.noteFor`. The stranded "Idle-time scan" doc travelled to
  `checkLimit`.
- **Constructed after the `revived.json` read**, so `limit.json` stays the last file the
  constructor reads. Until S7 the resume methods still in the facade read `this.wall.resumeMode`.
  No hub member added. Pins moved: 18 emits (`updated` ×12, `limit` ×6), three `setTimeout` and
  one `noteFor` → `sessions/wall.ts`. Ratchet 3,832 → 3,388.

## S7 as landed

- **`revivedSessionFor` went to `resume.ts`**, not the facade's lookups (above): it reads only
  `revivedBy`, which the slice owns, so the facade keeps a one-line delegation and no accessor was
  added to the hub. The stranded `runningSessionFor` doc now sits above `runningSessionFor`.
- `ResumeSlice(core)` reads `revived.json` in its constructor, built after `RosterSlice` and before
  `WallSlice` (whose `limit.json` stays last). The minute sweep and `setTurn` ask
  `this.resume.isResuming(id)`; the hub's resume group points at the slice's accessors (`queue`,
  `holdUntil`, `proven`/`setProven`, `firstAt`/`dropFirst`). One-line delegations: public
  `resumeState`, `getResumeMode`, `setResumeMode`, `setResumeFirst`, `resumeNow`, `diedAtLimit`,
  `revivedSessionFor`; private `releaseResume`, `clearResurrectTimer`, `maybeScheduleResurrect` for
  facade code not yet moved. Six wall delegations lost their last facade caller and went.
- Pins moved: three `setTimeout` and six emits (`updated` ×3, `limit` ×2, `limitQueue`) →
  `sessions/resume.ts`. Ratchet 3,388 → 2,888. No hub member added.

## S5 as landed

- **`turn.ts` is plain functions taking `core`**: it owns no manager-level state (every timer and
  flag it touches is on `Session`). `clearStopVerify(s)` and the module-private
  `noteSubmittedPrompt(s, …)` take no `core` because they never read it. The facade imports it as a
  namespace (`import * as turn`), since its public names (`inCopyMode`, `geometry`, `stopCount`)
  are too generic for a named import. The hook-lifecycle comment that sat above `USE_TMUX` now sits
  above `onHookEvent`; the stranded `markIdle` and `claimSubmittedPrompt` docs sit above their own
  functions. `lastTurnOf` was already a hub member (S2).
- One-line delegations: public `onHookEvent`, `isHooked`, `sawTurnHook`, `inCopyMode`,
  `noteHookFallback`, `stopCount`, `turnFromHook`, `turnFromScreen`, `geometry`,
  `lastSubmittedPrompt`, `claimSubmittedPrompt`, `ackAsking`, `setSuggestion`; private `setAsking`,
  `checkIdle`, `setTurn`, `armTurnWatch`, `clearStopVerify` for facade code not yet moved. The
  private `refreshModel` and `checkContext` delegations lost their last facade caller and went.
- The hook-ingress pin now excludes a one-line facade delegation (header and its
  `{ turn.onHookEvent(this.core,` forwarder) as well as `function onHookEvent(`; `api.ts: 1` stays
  the only count. Pins moved: two `noteFor`, two `setTimeout` and eleven emits (`updated` ×9,
  `idle`, `turnEnded`) → `sessions/turn.ts`. Ratchet 2,888 → 2,252. No hub member added.

## S4 as landed

- **`boxes.ts` is plain functions taking `core`**, imported as a namespace (`import * as boxes`)
  like `turn`. Exported: `scheduleChecks`, `armPromptCheck`, `applyPrompt` (the three hub arrows)
  and the public `choosePromptBox`/`submitPromptBox`; `checkPrompt`, `checkOpencodeBox`,
  `setAwaiting`, `applyLogin`, `enrichPrompt` and `healthTail` are module-private.
  `enrichPrompt(s, p)` takes no `core` because it never read it. The slice calls `core.noteFor`
  (a slice may not import `health.ts`); the facade's free `noteFor` calls it replaced were the same
  function.
- One-line delegations: public `choosePromptBox`, `submitPromptBox`; private `scheduleChecks`
  (`onData`) and `armPromptCheck` (`input`/`write`, until drive lands). The private `checkIdle`,
  `armTurnWatch`, `limitAuto` and `markLimitBlocked` delegations lost their last facade caller and
  went. Pins moved: seven `noteFor`, four `setTimeout`, six emits (`updated` ×4, `awaiting`,
  `prompt`) → `sessions/boxes.ts`. Ratchet 2,252 → 1,656. No hub member added.

## S10 as landed

- **`drive.ts` is plain functions taking `core`**, imported as a namespace (`import * as drive`).
  Exported: every public verb of the row (`input`, `write`, `waitReady`, `readyForAutoFire`,
  `autoFireBlocker`, `resize`, `setRemoteControl`, `kill`, `detach`, `reattachById`, `remove`,
  `scrollback`, `screenText`, `screenLines`, `screenCells`, `attachReplay`, `idleMs`), each a
  one-line delegation on the facade; the `input`/`write`/`screenText`/`screenCells` hub arrows
  point at it. `panHistory`, `leaveCopyMode`, `markSubmitted`, `clearReplySuggestion` are
  module-private; `panHistory(s, …)` and `leaveCopyMode(s)` take no `core` because they never read
  it. The tmux constants come from `knobs.ts` (S2), so no hub member was added.
- **`modePrefix` + `ALT_MODES` moved with `scrollback`**, their only user, against the inventory's
  "stays in the facade": pure, and the alternative was a hub member for a pure function.
  `PRIVATE_MODE_RE` stays beside `onData`. `isPassiveInput`/`PASSIVE_INPUT_RE` moved with `input`.
- The private `hasLiveTmux`, `armPromptCheck`, `setAsking`, `setTurn`, `releaseResume` and
  `clearResurrectTimer` delegations lost their last facade caller and went. Pins moved: one
  `setTimeout` (`waitReady`) and two emits (`updated` ×2) → `sessions/drive.ts`. Ratchet
  1,656 → 1,212.

## S11 as landed

- **`record.ts` is plain functions taking `core`**, imported as a namespace (`import * as record`).
  The six public verbs (`recordPrompt`, `getHistory`, `getTranscript`, `search`, `summarize`,
  `nameNow`) are one-line delegations; `register`/`onExit` call `record.loadHistory`,
  `record.loadSummary` and `record.finalizeCapture` directly, and the record group of hub arrows
  points at the slice. `nameTab`, `saveSummary`, `saveHistory` and `runSummary` are module-private.
- **`lastTurnOf` moved to the record group of `SessionCore`** (S2 had parked it beside
  `backendField` as a facade function); `tmux.ts`'s `reattach` and `turn.ts`'s `markIdle` reach it
  through `core`. The private `ocFor`/`logFor` delegations lost their last facade caller and went.
- Pins moved to `sessions/record.ts`: the three summary-spend pins (`runSummaryTask` 3,
  `runSummary` 2, `nameTab` 1 — the argv is `sidecar.ts`'s, untouched), `noteLogHealth` 2, and six
  emits (`updated` ×4, `history` ×2). Ratchet 1,212 → 713: what is left is the constructor and hub,
  `create`/`fork`/`register` with `onData`/`onExit`, `rediscover`, the lookups and the delegations —
  the facade the layout section says stays.

## I1 as landed

- **`IntentCore` was derived by script** (S1's method), and it is narrower than the sketch above:
  `revive`, `wouldNotRun`, `execute`, `giveUp`, `endWithDeadSession`, `snapshotConv` and `block`
  are only ever called from their own slice, so they are not members. `reconciled` is read and
  written only by `reconcile`, so it is watch's own field, and `watch.ts` is a class.
  `load`/`foldLegacyWorkParents` are the constructor's two boot calls on the disk slice, not members.
- `revivedShape` carries a `state: "queued"`, so that pin reads `contract.ts: 1, manager.ts: 5`.
  The core literal forwards `settle`/`persist`/`archive`. Those three pins subtract the arrow's KEY
  line (`/^\s+settle: \(/gm`), never `hubDefs`, whose `private settle(` half was never counted by a
  `(this|core)\.` regex. Ratchet 3,456 → 3,069.

## I2 as landed

- `clock.ts` is stateless functions (`core` first; `newBasis` and `graceFloor` take none). `disk.ts`
  is `DiskSlice(core)`, owning `path`, `archivePath`, `loadedSchema` and `archiveTail`. The facade
  builds the hub, then `this.disk = new DiskSlice(this.core)`, then `disk.load()`, then
  `disk.foldLegacyWorkParents()` — the constructor's only calls, as before.
- **The facade's remaining calls go through `this.core.persist()` / `this.core.archive(` /
  `this.core.armFrom(` …, never `this.disk.persist()`**: `this.core.persist()` is still a
  `(this|core)\.persist\(\)` site, so the pin keeps counting the facade's writes, and a later slice
  retargets them by deleting `this.`. The hub arrows now read `this.disk.persist()`, which the
  regex does not match, so the persist/archive pins DROP their key-line `def:` (keeping it would
  subtract a site that no longer counts). Settle's stays until I6.
- Facade delegations are one line: `skipNext`, `setArmed`, `migrateLegacy` (its parameter typed
  `Parameters<DiskSlice["migrateLegacy"]>[0]`, since a multi-line `convert: {` reads as a method
  header to hostshape), `migrateFileAt`, `flush`. Ratchet 3,069 → 2,521.

## I3 as landed

- `write.ts` is `WriteSlice(core)`, stateless. It is constructed right after `DiskSlice` and
  before `disk.load()`; its constructor reads nothing, so the boot order is unchanged.
- **`snapshotConv` stays private to the slice.** The `IntentCore` sketch listed it, but only the
  write verbs call it, so no hub member was added. The slice needed no member the contract lacked.
- Seven one-line facade delegations: `post`, `upsert`, `waive`, `update`, `retarget`, `edit` (its
  patch typed `Parameters<WriteSlice["edit"]>[1]`) and `name`. Ratchet 2,521 → 2,010.

## I4 as landed

- `requeue.ts` is plain functions over `IntentCore` (no class: the verbs own no state), imported by
  the facade as a namespace (`import * as putback`, since `remove`/`cancel` are too generic for a
  named import). The bodies moved verbatim with `this.<member>` retargeted to `core.<member>` —
  rows through `core.rows()`/`setRows`, `lastKnownDirs` through its accessor. `revive` and
  `wouldNotRun` stay module-private, as they were private.
- The facade keeps one-line public delegations. No hub member added. Pins moved: `.state =` 1,
  settle 2, persist 5, archive 1 → `intents/requeue.ts`. Ratchet 2,010 → 1,538.

## I5 as landed

- `ladder.ts` is `LadderSlice(core)`, stateless, constructed after `WriteSlice`. `core.pass` points
  at it; the facade's `tick` still awaits its own one-line `private pass()`, which
  `ladderpass.test.mjs` calls.
- **`block` stays private to the slice**: `pass` is its only caller, so it is no hub member, and
  its three `this.block(` calls are the pin's three. `pass`'s direct row writes (the `window`
  arming, the expired-waiver drop, the limit re-aim) and the re-asked ladder after the pre-claim yield
  moved unchanged; rows are read through `core.rows()` at each use, never cached over the await.
  No member was added to `IntentCore`. Ratchet 1,538 → 1,224.

## I6 as landed

- `fire.ts` is `FireSlice(core)`, stateless, constructed after `LadderSlice`; the facade field is
  `fireSlice` (the facade still has a `fire` method). `inflight` and the completion ledgers stay
  facade fields, shared by reference through `core`. `execute` stays private to the slice (only
  `fire` calls it) — no hub member; none was added.
- Three one-line private delegations: `fire` (`requeue.test.mjs`; the core's `fire` arrow forwards
  THROUGH it, which is also what keeps `noUnusedLocals` quiet), `settle` (`backlogedit.test.mjs`
  and the completion code still in the facade) and `unspend` (`reconcileOne`, until I7).
- The stranded `recordMissed` doc (above `unspend`'s) travelled into `fire.ts` in place, so
  `ladder.ts` took only the section comment and `block` of the note's 2617–2685 range.
- **The settle pin's forwarder exclusion is now `settle: (…) => this.settle(`**, not any
  `settle: (` key: the arrow now reads `this.fireSlice.settle(`, which the pin's regex does not
  match, so the old exclusion subtracted a call nobody counted. The one-line delegation does not
  match either. Totals stay the real call sites: manager 3 (completion code), fire 3.
  Ratchet 1,224 → 749.

## I7 as landed

- `watch.ts` is `WatchSlice(core)`, constructed after `FireSlice`, and the one intents slice with
  state: it OWNS `reconciled` (a public field — the facade's `tick` reads `this.watch.reconciled`).
  `core.complete` and `core.sweepRunning` point at it; `giveUp`, `endWithDeadSession`,
  `sessionAwaitingInput` and `reconcileOne` stay private to the slice (nothing else calls them), so
  no member was added to `IntentCore`. The "Restart reconciliation" section comment travelled
  between the two groups.
- Public one-line delegations: `onTurnEnded`, `onSessionExit`, `reconcile` (`main.ts` calls it
  after `sessions.rediscover()`). The private `unspend` delegation is gone (`reconcileOne` now
  reads `core.unspend`). The core's `settle` arrow now forwards THROUGH the facade's private
  `settle` (as `fire`'s does), which keeps `noUnusedLocals` quiet now that no facade body calls it
  and is exactly the forwarder the settle pin's exclusion names, so the facade counts 0.
- Pins moved to `intents/watch.ts`: `.state =` 9, settle 3, persist 6, emits 3. Ratchet 749 → 315
  — under the 450 floor. What remains in the facade: the header doc, the class with its fields
  and the ledgers, the constructor with the core literal, `list`/`get`/`pending`,
  `start`/`stop`/`kick`/`tick`, and one-line delegations.

## M1 as landed

- **`ServerCtx`'s extra members were derived by script, not read off the layout list.** A
  TypeScript-checker pass over each M2–M6 range collected every free identifier bound at main's
  top level and defined outside that range, minus `HostCtx`. That gives 23 members: `PORT`, `DOCTOR`,
  `push`, `setupWatch`, `cliHealthStore`, `tokenStats`, `uiStats`, `usageLog`,
  `assessExecutor`, `wsToken`, `isAttachedToSomeone`, `startPrompt` (narrowed: `opts.rescue`,
  `DeliveryResult`), `deliverChain`, `outSeen`, `announceBuild`, `scanImages`, `scanOutboxDocs`,
  `scanPullCandidates`, `pullNewFiles`, `fmtSize`, `padNotesFor`, `handleClientMessage`. The layout
  list's `contextLimits`, `reviewStore`, `opsInFlight` and `considerPull` are NOT on it (no second
  file reads them), and it had missed `handleClientMessage` (wsops' message handler) and the five
  scan functions sessionEvents calls.
- `startPrompt`/`deliverChain` are PROPERTY signatures in `ctx.ts`, so the chain pin (which skips
  only `routes/types.ts` by name) does not count them as calls.
- **main builds `const ctx = {} as ServerCtxDraft` right after `BOOT_ID`** and assigns each member
  on the line after its definition (after the `set…` singleton line where there is one; `fmtSize`
  after its `const`, TDZ). `ServerCtxDraft` is `ServerCtx` minus `readonly`. The old `HostCtx`
  literal is gone. A cast is not checked for completeness, so `hostshape` now asserts every
  `HostCtx` + `ServerCtx` member is assigned in main exactly once (`ctx.x =` or `Object.assign(ctx, {…})`).
- `createClients({ auth, notifyPrefs, push, sessions })` destructures its four deps at creation.
  This is the one accepted exception to the call-time rule: all four are constructed before the call
  and never reassigned, and it keeps the bodies verbatim. main destructures the result back into
  its own names, so every `send(`/`broadcast(`/`notify(` call in main is unchanged.
- **Later packages:** when M4 moves `padNotesFor`, main's `makeAssessExecutor({ notes: padNotesFor })`
  must become `notes: (cwd) => ctx.padNotesFor(cwd)`. It is built before the snapshots are.
- `hostshape`'s "a move is a move" check could never fire for `server/` because every definition
  there is nested inside a factory. It now compares nested `function x(` and `const x = (…) =>` in
  `server/*.ts` against main's top-level functions and arrows. The notify pin regex also counts
  `ctx.notify(` now. Counts are unchanged: `main.ts: 30`, `server/clients.ts: 0` (`push.notify(` is
  dot-preceded, and `function notify(` is the excluded definition).
- Ratchet: `main.ts` 2,426 → 2,385.

## M3 as landed

- `server/intentDeps.ts` exports `makeIntentDeps(ctx: ServerCtx): IntentDeps`: the IntentManager
  doc comment and deps literal (executors included) verbatim, every main name read as `ctx.<x>`
  inside the closures. `knownDirsCache` + `knownRepoDirs` are closure state in the factory; main calls
  it once, so there is still one cache per process. main keeps
  `const intents: IntentManager = new IntentManager(makeIntentDeps(ctx))` and `ctx.intents = intents`
  at the old position. No `ServerCtx` member was added.
- The one non-textual edit: `reapAutoSession(isAttachedToSomeone)` became
  `reapAutoSession(ctx.isAttachedToSomeone)`, still read inside the arrow at call time.
- Chain pin: `main.ts: 4` → `server/intentDeps.ts: 4`. `backlogstore.test.mjs`'s two text pins
  (no `retry: last === "retry"`, a `step` beside every `chainDeliveryError(`) read
  `dist/server/intentDeps.js` instead of `dist/main.js`, which no longer holds the executor.
- Ratchet: `main.ts` 2,385 → 2,066.

## M4 as landed

- `server/intentEvents.ts` exports `createSnapshots(ctx)` (schedule/launch/intent/assess/backlog
  snapshots and `padNotesFor` — five snapshots; `deliverySnapshot` is M2's) and
  `wireIntentEvents(ctx)` (the four `intents.on` blocks in today's order, with `textOf` local to
  it: the listeners are its only readers, so it is on no record). `server/scan.ts` exports
  `createScan(ctx)`: `announceBuild`, `considerPull`, the three `*Seen` maps, the scanners,
  `pullNewFiles`, `pullCatchUp`, `fmtSize`, and it REGISTERS `autopull.on("item")`.
- Positions: `createSnapshots(ctx)` right after `ctx` is created (it reads nothing until a
  snapshot is called, and the construction callbacks that hold `backlogSnapshot`/`assessSnapshot`
  come after it); `createScan(ctx)` right after `new AutoPullManager(ROOT)` / `ctx.autopull`, the
  listener's old place; `wireIntentEvents(ctx)` where the first `intents.on` stood, after
  `deliverChain` and before `migrateLegacy`/`start`. `makeAssessExecutor`'s `notes` became
  `(cwd) => ctx.padNotesFor(cwd)`. `ctx.announceBuild` is now assigned after the autopull
  construction instead of before it — nothing reads it between the two. No `ServerCtx` member
  was added; `considerPull` stays off the record (scan.ts is its only reader).
- The `AutoPullManager` doc comment stays with the construction in `main.ts`.
- Pins: `intents.on` `main.ts: 4` → `server/intentEvents.ts: 4`; other subscriptions
  `main.ts: 4` → `main.ts: 3` + `server/scan.ts: 1`; `notify(` `main.ts: 30` → `main.ts: 19` +
  `server/intentEvents.ts: 8` + `server/scan.ts: 3`.
- Ratchet: `main.ts` 2,066 → 1,699.

## M2 as landed

- `server/deliveries.ts` exports `createDeliveries(ctx)`: `startPrompt`, `deliverChain`,
  `deliverInput`, `deliverySnapshot`, the re-send callback as `resendOpenDelivery` (a named
  `Redeliverer`) and the `"settled"` listener inside `wireDeliverySettled()`. `server/wsops.ts`
  exports `createWsOps(ctx)`: `opsInFlight` and `inputsInFlight` as closure state, `sendOpAck`,
  `durableOp`, `containRepoDir` (both verbatim) and `wireWsConnections(wss, net)`. The local
  `OpVerdict`/`InputVerdict` duplicates are gone in favour of `routes/types.ts`'s.
- Positions: `createDeliveries(ctx)` where `startPrompt` stood, and all four of its `ctx`
  members are assigned there (`deliverChain`'s assignment moves up from after `wireIntentEvents`;
  nothing calls it before `main()`). At the old `new OpenDeliveries` block the order is
  construction → `setOpenDeliveries` → `ctx.openDeliveries = …` → `wireDeliverySettled()` →
  `if (!DOCTOR) openDeliveries.start()`; the wire reads `ctx.openDeliveries`, so the assignment
  must come before it. `createWsOps(ctx)` right after `new AckLedger`/`new NetStats`.
- `new WebSocketServer(…)` STAYS in `main()`'s `attachWs` with its permessage-deflate comment
  (constructions stay in main); only the `connection` handler moved. It closed over `main()`'s
  locals `ip`, `tsBin`, `tsDns`, `httpsUrl`, `boundLan`, which are now an explicit `WelcomeNet`
  argument. The `OpenDeliveries` doc comment stays with its construction. No `ServerCtx` member
  was added.
- Pins: deliveries `main.ts: 4` → `server/deliveries.ts: 4`; `acks.remember` `main.ts: 1` →
  `server/wsops.ts: 1`; other subscriptions `main.ts: 3` → `main.ts: 2` +
  `server/deliveries.ts: 1`; `notify(` `main.ts: 19` → `main.ts: 15` + `server/deliveries.ts: 4`.
  `backlogstore.test.mjs` is unchanged: nothing M2 moved builds a chain error or decides
  retryability (that is `server/intentDeps.ts`, already on its list).
- Ratchet: `main.ts` 1,699 → 1,288.

## M5 as landed

- `server/sessionEvents.ts` exports `wireSessionEvents(ctx)`, returning `{ proposeReply }`. It
  registers all fifteen `sessions.on(…)` in today's order — `turnEnded`/`exit` → intents first,
  then updateBanner, data, exit (broadcast), closed, updated, history, created, exit (scan
  baselines), awaiting, prompt, limitQueue, limit, idle — so the three `exit` listeners still fire
  intents → broadcast → baseline cleanup. `LIMIT_LOG`, `logLimitEvent`, `fmtClock`, `fmtDur` are
  closure locals; `LIMIT_LOG` is `join(ctx.ROOT, …)` evaluated at the wire call.
- Position: one call where the first `sessions.on` stood (before `wireIntentEvents`), followed by
  `ctx.proposeReply = sessionEvents.proposeReply` (moved up from after `proposeReply`'s
  definition; nothing calls it before `main()`). One call is order-preserving, not only
  convenient: nothing else in the host subscribes to `sessions`, and everything main runs between
  the old registration sites is synchronous, has no `await`, and emits nothing on `sessions`
  (`intents.start()`'s first `tick` returns at `!reconciled`, `openDeliveries.start()` and
  `usage.startPolling()` only arm timers, `sessions.oracleDefaults =` is an assignment). Listeners
  that read names assigned later (`updates`, `oracle`, `oracleLog`, `usage`) read them as `ctx.<x>`
  at call time. No `ServerCtx` member was added.
- Pins: `sessions.on` `main.ts: 15` → `server/sessionEvents.ts: 15`; `notify(` `main.ts: 15` →
  `main.ts: 2` + `server/sessionEvents.ts: 13`.
- Ratchet: `main.ts` 1,288 → 923.

## M6 as landed

- `server/http.ts` exports `createHttp(ctx)`, returning `{ handler, listenWithRetry }`: `MIME`,
  `readSmallJson`, `handleAuthHttp`, `serveStatic` as closure locals, the request handler the
  `createServer` arrow in `main()`'s bind loop used to be, and `listenWithRetry`. The origin/Host
  gate, the always-reachable `/api/auth/`, the 401 for an untokened gated peer and the `handleApi`
  deps are text-identical apart from `ctx.` (the shorthand members are spelled `push: ctx.push`).
  The public-bind refusal (`isSafeBind`, `WATERPLANE_ALLOW_PUBLIC`) and `createServer` itself stay in
  `main()`: the loop is now `createServer(http.handler)` → `attachWs` → `http.listenWithRetry`.
  One handler serves every bind instead of one arrow per bind — it holds no per-server state.
- `MIME` is `const MIME = {…} as Record<string, string>`: `hostshape`'s column-0 rule allows
  `const NAME = ` and refused the annotated form.
- `server/shutdown.ts` exports `installShutdown(ctx)`: the `for (sig)` SIGTERM/SIGINT flush in
  today's order (acks, cliHealthStore, sentLogStore, installLog, netstats,
  `sessions.flushContextWindows`, tokenStats, usageLog, settings, openDeliveries, intents, then
  `exit(0)`), `unhandledRejection`, `uncaughtException`. Called at module scope where the handlers
  stood — after `main()`'s definition, before `main().catch` — so they register before boot runs.
- `const http = createHttp(ctx)` sits at module scope where `MIME` stood; creation runs nothing.
  No `ServerCtx` member was added.
- Pins: `process.on` `main.ts: 3` → `server/shutdown.ts: 3`; `setTimeout` `main.ts: 3` →
  `main.ts: 2` + `server/http.ts: 1`.
- Ratchet: `main.ts` 923 → 700, which is the floor (planned as 650; see "Result"). What remains is what the plan keeps:
  imports, env, every construction with its `ctx.` assignment, `.start()`s, singleton
  registrations, the linger sweep, the `builds.on`/`capture.on` broadcasts, `handleClientMessage`,
  and `main()` (doctor path, bind selection and refusal, `attachWs`'s `new WebSocketServer`, the
  bind loop, preflight).

## `api.ts` — the HTTP routes as tables (C1)

`api.ts` was one 1,755-line `handleApi` of `if (path === … && method === …)` blocks. It becomes
the HTTP twin of `routes/index.ts`: **the frame only** — the CORS reflection (`corsHeaders`,
never `*`), the preflight answer, and dispatch over one ordered table. The origin/Host gate,
`OPAQUE_READ_ROUTES` and the token gate stay where they are (`origin.ts`, `server/http.ts`), in
front of `handleApi`; nothing in a table can be reached without passing them, and no table
widens them.

**The registration** (`routes/apitable.ts`): `route(method, pattern, handler)`. `method` is one
verb or `"*"` (any — what `/api/health` and the web-bundle routes always answered). A pattern is
`/`-separated segments: a literal, `:name` (exactly one segment, raw, may be empty — never
decoded by the matcher), and a trailing `*` (zero or more further segments, as `rest`). A
handler answers, or returns `false` to say "not mine" and let the next entry try — the old
fall-through, kept explicit. `mount(name, fn)` is a delegating handler that owns its own
dispatch (`peers/routes.ts`, `peers/agentpeer.ts`, `agentintents.ts`, `onboardroutes.ts`):
it is asked in table order and answers `true` when it handled the request. First match wins;
the end of the table is the 404 `{ error: "not found" }` it always was.

**The repo scope.** `* /api/repos/:id/*` resolves the target FIRST (unknown ⇒ 404
`unknown repo`, for every method and sub-path, as before) and then dispatches a second table
whose patterns are relative to the repo (`inbox/*`, `git/status/*`). The trailing `*` on most of
them is not looseness: the old checks read `parts[2]` and ignored anything after it, and a pin
holds that.

**Files** (all in `routes/`, prefixed `api` because `routes/session.ts` and the flat `files.ts`
and `git.ts` already own the plain names; each ≤ 500 lines, `hostshape`):

| file | holds |
| --- | --- |
| `apiroutes.ts` | the one table, assembled in order (`API_ROUTES`), and `listRoutes()` for the pin |
| `apitable.ts` | `ApiCtx`, `ApiReq`/`RepoReq`, `route`, `mount`, the matcher, `dispatchApi`, `listApiRoutes` |
| `apiio.ts` | `json`, `readBody`/`readJson`, the multipart parser, `MIME`, `serveRange`, `serveFileStream`, `serveTreeFile`, the upload ceiling |
| `apisystem.ts` | health, theme, web bundle, both hook sinks, a plugin's own routes (`* /api/plugin/:id/*`, `api.route`, plugin API 1.2), the four mounts, speed test, ui-usage, netstats, push |
| `apisession.ts` | transcript (+tools), scrollback, shell, context, slash, external |
| `apistats.ts` | tokenstats (+ per backend), localusage, tokenwindows, usagelog |
| `apihost.ts` | repos listing, storage, search, `/api/host/*`, scaffolding, secrets |
| `apirepofiles.ts` | the repo scope and its file routes: archive, inbox, envfiles, artifacts, sweep, artifact, tree |
| `apirepowork.ts` | capture/run, compliance, repohealth, the repo's git routes |

**The import rule changes by one edge.** A flat module may not import `routes/**` ("a flat
module is called BY a route"), and `api.ts` is flat. It is also, now, a router: it gets
`routes/`'s rights (may import `routes/**` and flat modules, never `server/**` or `main`), and
`routes/**` may not import `api` (a table never imports its router — that is the cycle). Every
other flat module keeps the refusal; `hostboundary.test.mjs` pins both.

**Pins, written before the first move** (`packages/host/test/apiroutes.test.mjs`): the list of
every METHOD + pattern the host answers, plus the mounts in order — checked against the old
`if`-chain's literals in the pin commit and against `listApiRoutes()` after; the list itself does
not change. Every route is reachable (its own sample path first-matches it). The fall-through
edges answer the same (`apifallthrough.test.mjs`: unknown repo, a wrong method, a trailing
slash, an extra segment, a traversal in an inbox name). And `api.ts`'s export surface, off the
type checker.

## Review findings (folded in)

An adversarial pass on 2026-09-25 against HEAD `47eb316`, checking the plan against the code
rather than its own claims. Everything below is already edited into the sections above; this list
says what changed and why, so the diff of the plan is reviewable as the plan asks the diff of a
pin map to be.

**What held.** Every count in the pin table reproduced with the regex shown (a script over
`code()`+`noImports()` of `packages/host/src/**/*.ts`; the sessions emit breakdown is exactly 51
`updated` / 8 `limit` / 2 `history` / one each of the other ten; intents 6/1/1/1). No bound
method is handed out of either class; every timer callback is an arrow. `sessions.ts` and
`intents/manager.ts` are `extends EventEmitter` classes with TS `private`, no `#` fields, no
getters, no `instanceof` checks anywhere, and nothing serialises a manager. No test patches a
prototype or reads a private field via `as any`. No test or e2e script imports a deep path that
moves — the deepest are `dist/routes/*.js`, `dist/backends/*.js`, `dist/intents/{manager,adapters}.js`.
`main.ts` exports nothing today. The proposed `host-boundary` rule refuses no import that exists
today. `LiveMeta`/`RecentRow`/`ClosedRow`/`Session` (368–407, 453–755) contain no runtime token
after comment-stripping, so a types-only `core.ts` is feasible as specified. The cut orders are
safe: no early package needs a slice that lands later, because every cross-call is a hub arrow
that points at the facade until its slice lands. Every slice file is under the 900 cap by the
inventory's own ranges (largest: `turn.ts` ≈ 630, `boxes.ts` ≈ 551, `write.ts` ≈ 512).

**What changed, by severity.**

- *Would have broken tests (high).* `pass`, `fire` and `settle` are `private` and three `.mjs`
  tests call them directly; `inflight` is written by a test. The facade keeps those three
  delegations and the field. `core.deps` must be the constructor's object because a test replaces
  `deps.executors.freshSession` after construction.
- *Would have broken a build or a boot (high).* `register` was listed as public; it is private
  and `tmux.ts`'s `reattach` needs it as a hub member. Main's 844–865 (`knownDirsCache`,
  `knownRepoDirs`) were in no row — assigned to M3, as closure state. `LIMIT_LOG` was going to a
  `server/` module as a module constant over `ROOT`, which main does not export. M3 calling
  `startPrompt` before M2 moves it only works if M1 already put every name on `ctx` — now stated.
- *Would have let a copy survive (medium).* Four listener blocks in `main.ts` (`autopull.on`,
  `builds.on`, `capture.on`, `openDeliveries.on`) were not pinned, and two of them sit in a range
  marked "stays" while the prose said every listener moves; they stay, and are pinned. `notify(`
  pinned with a literal kind missed the push bridge at 334. The `HostCtx`-member exclusion for
  `durableOp`/`startPrompt`/`deliverInput` cannot be a regex (nested parens); `routes/types.ts` is
  skipped by name. The "a move is a move" regex missed `static`/`get` modifiers and would read an
  indented statement in a plain-function slice as a definition; it now requires a header line
  ending in `{`. "No column-0 `.on(`" would have passed the `for (sig) process.on(sig, …)` loop;
  `server/` now refuses any column-0 statement. A slice that names the core anything but `core`
  escapes every `(?:this|core)\.` pin; the name is now a rule with a check.
- *Would have been discovered by a builder instead of written by S1 (medium).* The wall and resume
  regions read each other's private fields and methods at ~20 sites; the hub members are now
  listed. `resumeMode` is persisted by `writeLimitCfg` and belongs to wall, not resume.
  `this.rows` is reassigned at five sites across four slices, not only in `compact`.
- *Inventory accuracy (low).* `hasLiveTmux` is 4582–4587, not "4583"; the hook-lifecycle comment
  at 303–310 and manager's imports at 64–109 and section comment at 2617–2619 were in no row;
  roster owns four statics, not three; the router's map line must be regenerated in the commit
  that names a slice, or `claudemd.test.mjs` fails on the router.

**Left for the orchestrator.** (1) `builds.on`/`capture.on` staying in `main.ts` is the smaller
change; moving them into a `server/runs.ts` would be consistent with "every listener moves" at the
cost of one more module and pin row. (2) The wall↔resume coupling is ~20 hub members for two
files of ~440 and ~410 lines; a single `sessions/limit.ts`-shaped slice of ~850 would need none of
them but sits just under the 900 cap with no room — the plan keeps two slices. (3) The pins are
regex over text; a `deliverPrompt` reached through an alias (`const d = deliverPrompt; d(…)`) is
invisible to them and to `feature-boundary`'s equivalents on the web side. None exists today.

## Ledger readers as landed: `ctxlog/` and `transcript/`

`ctxlog.ts` (1,302 lines) and `transcript.ts` (990) read the CLI's own conversation log. Both are cut
by subject into a folder of the same name, and the original path stays a barrel (explicit re-exports,
so the export surface is exactly what it was: pinned off the type checker by
`packages/host/test/ledgerpins.test.mjs`). MOVE ONLY: no line of logic changed, no importer changed.
Every slice is held to 500 lines and the barrels to 60 / 40 by `tools/hostshape.test.mjs`.

- `ctxlog/ctxcursor.ts` — `ContextLog`, `SeriesCursor`, `readRange` (whole-file forward reads in
  `MAX_READ` chunks, `consumed` past the last NEWLINE), the blank/project helpers for the cold-start and
  compaction tallies, the caps and `blank()`.
- `ctxlog/ctxupdate.ts` — `updateContextLog`, the one incremental pass that makes the series, the spend,
  the split, the per-record cost, the cold rebuilds and the compactions behind the same guards.
- `ctxlog/ctxproject.ts` — `modelOrder`, `projectContextLog`, `readContextLog` and `sparkOf` (the row
  miniature). The only slice that reads both the cursor and the agents.
- `ctxlog/ctxagents.ts` — `agentUsage` and everything about the subagents' logs: the roster, `agentCumOf`,
  `liveAgentOf`, `agentEnvelope`, `thinMax`, `withAgentRuns`.
- `transcript/transcriptlog.ts` — where the log is (`transcriptPath`, `logMtime`, `lastTurnAt`), `readLog`,
  and the record predicates (`promptOf`, `queuedPromptOf`, `localCommandOf`, `localOutputOf`, `opensTurn`).
- `transcript/transcriptparse.ts` — `parseTranscript` (lite/full), `toolDetails`, tool labels.
- `transcript/transcriptscreen.ts` — TUI chrome trimming and repaint folding on a PTY capture.
- `transcript/transcriptturns.ts` — turns the log does not hold (`screenCommandTurns`, `queuedTurns`,
  `absorbedOpeners`, box answers), `mergeLocalTurns`, `transcriptFromHistory`.

Import edges inside a folder run one way: `transcriptparse` → `transcriptturns` → `transcriptlog`;
`ctxproject` → `ctxupdate`, `ctxagents` → `ctxcursor`. The ledger rules ("degrade to absent, never to a
wrong number", whole-log reads, per-record pricing) are unchanged and live in the `host-ledgers` skill.
Proof of no behaviour change: the golden in `ledgerpins.golden.json` (recorded before the move), and a
scratch digest of every reader over 87 real conversation logs, before and after, identical.

## The capture and backlog slices

`capture.ts` (1,143 lines) and `backlog.ts` (1,133) were cut by subject, 2026-10-04, behind their
original paths: the old file stays as the facade (the class and `export … from` re-exports), so no
importer changed. Caps: 500 lines per slice (`tools/hostshape.test.mjs`, `TIGHT_DIRS`), facade
ratchets in `MAX_LINES`. The export surface and the public members of both classes are pinned off the
type checker in `tools/hostsplitpins.test.mjs`; behaviour is held by the untouched
`capture.test.mjs` and `backlog*.test.mjs` plus `e2e-capture`, `e2e-backlog*`. Basenames carry a
`capture`/`backlog` prefix because `types.ts`, `web.ts` and the web package's `backlog/` already own
the plain ones.

**`capture/` (leaf — flat modules only, never `intents/`):** `capturekit.ts` (the knobs, `ENABLED`,
the `BACKENDS` table, `sleep`), `captureverdict.ts` (the pure ladder: `verificationLevel`,
`verdictLine`, `shouldEmit`, `diffRecord`), `captureconfig.ts` (`cleanTarget`, overlay
classification, `probeCaptureBackends` and its TTL cache), `capturehelpers.ts` (anchors, the
per-worktree lease, the sidecar reader, `intentToCaptureRun`, `weakest`), `capturesettle.ts`
(`settleFrames` — the clock starts when the FIRST frame completes), `capturepass.ts` (one run's
passes, the frame writer and the watch loop). `CaptureManager` keeps the stores of a run (`output`,
`canceled`, `live`) and the verbs; `capturepass.ts` receives the `canceled` set by reference. A leaf
cannot import `ExecutorResult`, so `capturepass.ts` declares the sub-shape it returns
(`CapturePassResult`) and the manager's `execute` returning it as an `ExecutorResult` is the type
checker's pin. The containment checks (`contained()` on a target's `dir`, `cleanTarget`'s refusal of
an absolute or `..` dir) moved verbatim.

**`backlog/`:** `BacklogManager` keeps the constructor, the reads (`rows`, `list`, `waiting`), the
one-line verbs and a `core: BacklogCore` — one object holding the root, `sessions`, `intents`,
`reviews` and the manager's mutable state (`auto`,
`repoSessions`, `openedBy`, `closeDefault`). Each slice is functions over `c: BacklogCore`, written
against it the way `sessions/` is against `SessionCore`: `backlogcore.ts` (the type, types only),
`backlogknobs.ts` (`BACKLOG_SESSIONS_MAX`, `BACKLOG_LINGER_MS`, `REAP_*`, read at import),
`backlogwording.ts` (`deliveryError`, `retryableStep`, `chainDeliveryError` — `retry` is only ever a
first-step claim), `backlogtitles.ts` (the `backlog · ` PREFIX mark and `withoutBacklogMark`),
`backlogstore.ts` (`init`, the legacy-file migration, `saveConfig` — tmp+rename — `setAuto`,
`backlogRows`), `backlogedits.ts` (`add`, `fire`, `update`, `swap`, `reorder`) and
`backlogsessions.ts` (`openItemSession`, `lingerSweep`, `reapAutoSession`, `reapable` with its
background-shell/agent refusal and `REAP_CEILING_MS` overrule, the repo-session helpers, `deliver`).
`BacklogManager`'s public members and the module's exports are unchanged (pinned).

## The rest of the host: X

Three more files cut under the same rules (barrel stays, move-only commits, export surfaces pinned
in `tools/hostrestpins.test.mjs`, 500-line cap in `hostshape`).

**`routes/work/`:** `routes/work.ts` is the barrel — it spreads five tables back into `workRoutes`
in the order the one table had (the router's `HANDLED` order is pinned). `workbacklog.ts` (fan-out
and the backlog, including the in-flight add join and the `preLossRefusal` path), `workbuild.ts`
(builds, artifacts policy, capture), `workassess.ts` (assess and pull), `workschedule.ts` (launch
and schedule adapters) and `workintent.ts` (the intent verbs). Every ack-ledger write and
`durableOp` stays on the same handler it was on; `hostpins` names the new files.

**`sidecar/`:** `sidecar.ts` keeps the header doc (the seam's rules) and re-exports the same names it always
had. `sidecarroute.ts` (the task and engine types, `SIDECAR_ENV`, `NEEDS_TOOLS`, `parseSidecarSpec`,
`sidecarPlan`, `sayOnce`), `sidecarclaude.ts` (`runHeadlessClaude` and its streaming variant, the flags,
`envelopeUsage`, `runToolTask`), `sidecartrust.ts` (`workspaceTrust`, `trustRefusal` — the folder-trust
refusal), `sidecaropenai.ts` (the local engine: timeout, token budget, `chatCompletion`),
`sidecartasks.ts` (summary) and `sidecarname.ts` (naming and the commit message). Flags,
prompts and timeouts moved byte-identically; `sayOnce` is the one name newly exported, to cross slices.

**`octranscript.mts` (opencode extension):** the facade keeps the header doc and re-exports the same
names; the slices sit beside it (an extension imports only `@waterplane/shared`): `octrbase.mts` (row
types, caps, `ocToolLabel` and the small coercions), `octrfold.mts` (`foldOcTranscript`,
`ocToolDetails`), `octrcontext.mts` (`foldOcContext`), `octrdb.mts` (the database half: session rows,
`readOcTranscript`, `readOcContextSeries`, the poll stamp) and `octrident.mts` (session identity:
`pickOcSession`, `ocIdVerdict`, candidates and the probe). Pinned by `hostrestpins` (surface) and
`hostshape` (ratchet).

## The deliver slices — one implementation, cut into a folder

`deliver.ts` (1,442 lines) is the one implementation of "type into a live session and confirm"
(CLAUDE.md: never fork it). Cut 2026-10-04 by MOVING its pieces into `deliver/`, never by copying:
still one `runDelivery`, one entry point, and `deliver.ts` stays the facade — `deliverPrompt`,
`deliverToNewSession`, the audit row and the open-question registration — and **the only module
anything outside `deliver/` imports for delivery**. `local/host-boundary` refuses an import of a
`deliver/*` file from anywhere else (main included), and a slice importing its facade; slices may
import each other, because there is no core object here — they are the halves of one function.

- `deliverknobs.ts` — every timing constant (`ECHO_WAIT_MS`, `PROMPT_HOOK_WAIT_MS`,
  `SOURCE_LANDED_MS`, `CHANNEL_CONNECT_WAIT_MS`, `LOCAL_*`, `UNANNOUNCED_*`, `LOG_PROOF_MS`) and the
  `sleep` the old function declared locally. Values unchanged, byte for byte.
- `delivertypes.ts` — types only: `DeliveryResult`, `DeliverOpts` (re-exported by the facade) and
  `DeliveryRun`, the record the run hands its submit tail.
- `deliverscreen.ts` — reading the composer: `composerAnchorsOf`, `foreignInComposer` and
  `makeScreenReader`, the closures that were `runDelivery`'s locals (`screen`, `probe`, `placeEcho`,
  `onScreen`, `rivals`/`proven`, `pastedNearBottom`, `snapshot`, `waitForEcho`). All capture only
  consts, so the run DESTRUCTURES them and every call site reads exactly as before.
- `deliverproof.ts` — the evidence that is not a rendering: `makeLogProof` (`ranAnyway`, the log)
  and `makeSubmitProof` (the hook/side-channel proof). Its three pieces of mutable state
  (`submitProven`, `sourceLanded`, `deliverySrc`) stay closure `let`s; readers outside reach them
  through GETTERS (`proof.submitProven`), read at the same moment as before — never destructured,
  which would freeze them — and the post-hold re-read is `refreshSource()`.
- `deliverrun.ts` — `runDelivery` from its health gate to the echo verdict: channel hold,
  readiness, trust, the before-typing checks, the write, the echo wait and every rescue.
- `deliverreturn.ts` — the TAIL of `runDelivery`, from `recordPrompt` on: the settle, the no-turn
  presses, the unhooked press-and-look and the hooked submit ladder. Moved whole as the function's
  last statement (`return submitAndConfirm(run)`), so no branch had to be rewritten to fall through.

What a move is allowed to change here, said once: the names above become imports; the mutable
proof state is read as `proof.x`; the tail is one call deeper (its promise adopted by
`runDelivery`'s — microtasks, no timer, no keystroke). Every constant, poll, press, Esc, ctrl-U,
health observation and their ORDER is the same text. Pins: the export surface off the type checker
(`tools/hostsplitpins.test.mjs`, `DELIVER_SURFACE`), the `deliver/` folder in `hostshape`'s
`SLICE_DIRS` at the 500 cap with a `deliver.ts` ratchet, `hostpins`' delivery and `noteHealth`
maps (paths only), and the untouched `deliverecho`/`deliversubmit`/`settle` host tests plus every
e2e that delivers text.
