---
name: host-work
description: waterplane host — durable work that outlives a session (packages/host/src): `intents/` (`manager.ts`, `adapters.ts`, the tick and the rung ladder), `backlog.ts` and the per-item sessions it opens, `fanout.ts`, `archive.ts`, `convfork.ts`. Load BEFORE changing how deferred work is stored, fired, requeued, chained, held or capped, before touching schedules, launches or the automatic-session slots, and before reading, deleting or forking an archived conversation. At-most-once by intent id, forever.
---

# waterplane host — durable work that outlives a session

Work that survives the process and the session that ran it: intents on disk, the tick that decides what fires, the backlog they are shown as, and the conversations they leave behind. Router: `host`. Reasoning: [host.md](docs/notes/host.md).

- `backlog.ts` (a facade: `BacklogManager` over `backlog/backlogcore.ts` the shared state type, `backlog/backlogknobs.ts` the env knobs, `backlog/backlogwording.ts` the delivery sentences, `backlog/backlogtitles.ts` the title mark, `backlog/backlogstore.ts` config + boot + the switches, `backlog/backlogedits.ts` the row verbs, `backlog/backlogsessions.ts` the per-item sessions, cap, linger/reap and `deliver`, `backlog/backlogfollowup.ts` the flag-when-done sweep) — a VIEW of `intents/`, plus the prompt executor and the sessions work runs in.
  **EVERY FIRED ITEM GETS ITS OWN CONVERSATION** (`openItemSession`, titled `backlog · <repo> ·
  <label>`, `{kind:"repo", fresh:true}`) — the one shared `backlog · <repo>` session per repo is
  RETIRED, for a number this repo already had: `sessioncost.ts` puts break-even at ~3 turns for a
  window at 5×, a shared backlog of unrelated items reaches 5× within a handful of them, and
  `CLAUDE.md`'s measurement is 124 conversations out of 8,968 being 76% of a fortnight's tokens. **No
  `/clear`** — a fresh process IS the clear, and it lands the item as its own reopenable conversation
  in `archive.ts`. The mark is the **PREFIX** (`isBacklogTitle`), never an exact title, and still
  recognition rather than a map (a restart orphans a map, not a title). A person who wants the shared
  context SAYS so: `{kind:"session"}`, or `resume` (`--continue`). `serial` is set on every
  repo-target item — nothing else stops five due rows putting five agents in one worktree — and
  **only QUEUED work holds it** (`intentSerialHolders`: rows `starting`/`running`, sessions opened
  for queued work — origin or title mark — mid-turn, on a limit or with a question open); a hand
  session never does, and the held row carries the holder's id (`holderSessionId`).
  `ensureRepoSession`/`resolveRepoSession` survive only for the sheet's "open a session here" button (its bare `backlog · <repo>` title never closes — `closesWhenDone`)
  and a hand fire on a pre-`fresh` row; **automatic work adopts nothing.** `autoSessionCount()` is the
  cap's input, counted off the SESSIONS never a map — **and only the WORKING ones** (`slotBusy`,
  R-automation-042: a row `starting`/`running` in it, a background shell `working`/`serverLike`, a
  background agent, or `autoFireBlocker` non-null — a turn, a box, a limit wall — overruled only by
  `REAP_CEILING_MS` of PTY silence). An idle session left open holds NO slot, so **nothing is ever
  closed to make room** (`reapAutoSession` is gone; `closedBy: "auto-slot"` survives only on old
  closed rows). Sessions END one automatic way, **`sessions.remove()` and NEVER `kill()`** (kill has
  no closed-row on the other side of it): `lingerSweep` (`WATERPLANE_BACKLOG_LINGER_MS`, 10 min — so
  "open the session" is there when somebody presses it; `remove(…, "auto-done")`) — **only for a
  session whose item said close-when-done** (`closesWhenDone` → shared
  `closeWhenDoneOf`: the opener row's `Intent.closeWhenDone`, found by `openItemSession`'s mark or
  the earliest row with that `sessionId`, else the synced global `CLOSE_WHEN_DONE_KEY`
  `waterplane.backlog.closeWhenDone`, **OFF by default**). Off ⇒ NOTHING closes it, and that stops no queued
  work; a `noSlot` row waits only while `max` sessions are WORKING (`autoSlotsWaitText`, "… and 1 is
  working; a slot frees when one goes idle"), and `backlog.list.autoSlots` carries every open id with
  `busy` as FACTS (`busy` absent = an older host = busy; the phone offers only the busy ones).
  The per-item value is carried by `upsert()`, both adapters, `workItemInherits`
  and the agent route; it is edited through `edit()` (any state, `null` =
  inherit), never `update()`, so flipping it never re-queues. **Never attached, never a
  row `starting`/`running` in it, and never one the CLI says is BUSY —
  `sessions.autoFireBlocker(id, idleFor) === null` is the free test** (hook-, box- and
  silence-aware in one implementation; the old PTY-silence reading reaped live turns, and a turn
  silent for 60 s is a permission box or an `AskUserQuestion`, i.e. a session waiting on a PERSON).
  There is deliberately no "ever attached" exemption. **The one thing that overrules the CLI's word
  is `REAP_CEILING_MS` (6× linger) of PTY silence** — a lost `Stop` leaves `turnActive` set for the
  life of the process, and a slot held until restart is worse than a closed conversation. **A
  BACKGROUND shell that is still `working` or `serverLike` (`info.shellList`, `@waterplane/shared`'s
  `shellBucket`) refuses `reapable()` outright, logged, before `autoFireBlocker` is even asked** —
  the CLI's own turn flag says a session is free the moment its main loop goes idle, which says
  nothing about a `run_in_background` Bash or a Monitor still running underneath, and closing one on
  a verdict is exactly what CLAUDE.md's decision (a person's tap, never automatic) forbids. **This
  refusal is NOT overruled by `REAP_CEILING_MS`** — a `foreground` shell (the running turn's own
  command, not a background one) is not this check's business at all.
  **A background AGENT (`info.agents`, non-empty) refuses it the same way** — an orchestrator that
  ends its turn to wait on a subagent is hooked and idle, and closing it killed the subagent. **And a
  hooked session lingers from `idleSince`** (the turn's end): `autoFireBlocker` never reads `idleFor`
  on a hooked session, so without it the 10-min linger was the sweep's 1-min interval.
  **Dead session ⇒ `queued` if `diedAtLimit`, else `failed` — never `done`; EXCEPT a row in a session
  of its own, which FOLLOWS the resurrection and is never requeued** (a requeue runs the item twice)
  — **and that exemption keys on `Intent.followed`, persisted, NOT on the target**: the re-aim
  rewrites the target, and a WEEKLY limit reopens after 5 s and re-hits the wall by construction, so
  every weekly wall is a two-wall sequence and the second one requeued
  — and it follows **EXACTLY the session that replaced it** (`SessionManager.revivedSessionFor`
  records dead id → new id in `doResurrect`), never "the newest session in that cwd": the gap to the
  reset is HOURS, and a session a PERSON opened there was handed the row and completed it on their
  own Stop. **A create off the WIRE never wears the `backlog · ` mark** (`withoutBacklogMark`, applied
  in `routes/session.ts`): the mark is the only thing the cap, the reap and the linger sweep read, and
  *Recently closed* hands the title straight back to a session a person is now driving.
  **Only a FIRST-step `retry` may re-run an item** (`retryableStep`): `retry` means "provably nothing
  was typed" about that STEP, and a chain's step 2 arrives with step 1 already run — a requeue types
  it into a second session. **And `ExecutorResult.step` must travel**, because `fire()`'s Stop
  shortcut is only valid for step 0: a Stop seen while step k was being delivered proves step 1 ran
  and nothing more, and an ungated shortcut settled a three-turn item `done` with two turns never
  typed. `backlogstore.test.mjs`.
  `backlogsessions.test.mjs`, `scripts/e2e-backlog-slots.mjs`, `scripts/e2e-resurrect-item.mjs`.
  **Flag for follow up when done** (`Intent.flagWhenDone`, absent = off, no global; threaded exactly like `closeWhenDone`, merged rows flag if ANY member did): `backlog/backlogfollowup.ts` `followUpSweep` flags the session a row OPENED (`openerRow`, shared with `closesWhenDone`) with `{by:"launch", item}` ONCE per row, only when the row is `done`+ok and `slotBusy` is false — a failed or limit-stopped row never. Applied row ids persist (`followup-launched.json`, capped) so a cleared flag does not return and a restart does not re-flag. `BacklogManager.lingerSweep` runs it FIRST, so nothing closes a session ahead of its flag; fan-out children carry the flag from the run, and the same sweep flags them. `followupsweep.test.mjs`.
- `agentintents.ts` — **later work an AGENT posts**: `POST|GET|DELETE /api/agent/intents[/<id>]`,
  loopback-only, never a browser (`Origin`/`Sec-Fetch-Site`), never proxied (`tailscale serve`
  forwards to 127.0.0.1 — the forwarding headers refuse it). **`postClientDraft` is the ONE client
  path into `IntentManager.post`** — the socket's `intent.post` calls it too: contain the cwd,
  authors forced `hand`, `pastBudget`/`budgetPass` stripped, and `origin: "agent"` written ONLY by
  this route (stripped off the socket). At-most-once by the caller's `key`: the row id IS
  `agent-<key>`, so a retry returns the same row, forever. One-offs only — a recurring rule is
  refused in words. The answer's `fires` is `whenWords` (`shared/schedule.ts`, the send sheet's own).
  DELETE cancels only a row an agent posted. **`POST /api/agent/backlog`** goes through
  `addClientBacklogItem`, the socket `backlog.add`'s own body, and marks the row `manual`: rung 1
  holds it for ever, only the person's `fire` (`runNow`) starts it.
  `agentintents.test.mjs`, `scripts/e2e-agentintent.mjs`.
- `workbacklog.ts` + `workbuild.ts` + `workassess.ts` + `workschedule.ts` + `workintent.ts` — the WebSocket work-message handlers under `routes/work/`: every handler that carries an ackId is `durable` or joins the in-flight map, and a backlog add refuses a lost ack with `AckLedger.preLossRefusal`. A new work message goes in the slice of its subject.
- `fanout.ts` — one prompt → N repos, fresh session each, dirs validated against `discoverTargets()`
  (unknown paths silently dropped). A run is N intents sharing a `groupId`, so `FanoutRun` is
  REBUILT from rows and survives the daemon. `followUp()` never spawns. A scheduled sweep gets a
  fresh run id per occurrence.
- `intents/` + `adapters.ts` + `manager.ts` + `contract.ts` + `clock.ts` + `disk.ts` + `write.ts` + `requeue.ts` + `ladder.ts` + `fire.ts` + `watch.ts` — **the durable Intent store**: one file, one tick, one lifecycle, for every piece of
  deferred work. REPLACES `schedule.ts` and `launch.ts`; `adapters.ts` speaks the old vocabularies
  and **is the only path into the store** (the shipped client still sends `launch.*`/`schedule.*`).
  Rules: **`op.ack ok` means on DISK**; **`starting` is written BEFORE the executor**;
  **at-most-once by intent id, forever**; **nothing is armed with a timer** (a tick re-asks
  `intentVerdict`, so restart/sleep/DST cannot mis-fire it); **eviction is compaction, never deletion
  of un-run work** (what leaves is appended to `intents-archive.jsonl`). Restart reconciliation asks
  the CLI's log about a `starting` row — **never a blanket requeue** — and about a `running` one:
  `landed` + the session came back ⇒ RE-ADOPTED `running`, its Stop or the silence sweep settles it —
  **never `done` off the log alone** (the log proves delivery, not an ending); `landed` + session gone
  ⇒ `failed` saying the session was lost (at the limit ⇒ it follows), never `done`. `sweepRunning`
  also waits out `awaitingInput` (an unparsable dialog) and a copy-mode pane (idle `null`), treats a
  session hooked by a `Notification` alone (`turnHookSeen` false) as unhooked, and FAILS a hooked row
  silent past `REAP_CEILING_MS` (a lost Stop — never `done`). `waive()` sets `pastBudget: {until}` (latest tripped reset; refused with none, or archived); the tick drops an expired one; kept through `starting`, cleared once `execute()` returns except `retry` (reconcile's `absent` keeps it); carried by `upsert` and to the F14 child; a MIXED merge is refused; `intent.post` strips it. **A bulk verb never reaches `runNow`**; `runNow` is one row's tap. `runNow` does not spend an
  occurrence and REVIVES a spent one-off; a terminal one-off is not ARMED (`nextAt` null); a one-off (`!ruleRecurs`: `once`, or `weekly`/`window` with `oneShot`)
  arms from the GRACE FLOOR, a recurring rule from now. `manager.ts` (the facade) and its
  slices own the store (`disk.ts`), the tick's pass (`ladder.ts`), reconciliation (`watch.ts`) and every
  transition (`fire.ts`, `write.ts`, `requeue.ts`); executors are injected from `server/intentDeps.ts`. **A `sessionId` is
  per-boot for a PTY and is NOT under tmux**, so `reconcile()` runs after `sessions.rediscover()`.
  Migrates `launches.json` / `schedules.json` on first boot, renaming each `*.migrated`.
  **`IntentDeps.budgetOver()` (every tripped ceiling) rides beside `budgetBlocked`**, and
  `workItemInherits` stamps `budgetPass` from `lastOccurrence`, so a recurring before-reset rule's
  child is not re-held by the cap its parent was exempt from.
  **The cap on automatic sessions is a RUNG, not a side door** (`noSlot`): `IntentDeps.autoSlotsFree()`
  + `autoSlotsDetail()` (the numbers, like `budgetDetail`), and `base.autoSlotsFree` is **decremented per fire within a pass** (the `hostBusy`/`busyCwds`
  trick — a fresh repo target passes rung 5 unconditionally, so five rows in five repos would each
  read the cap as untouched). **A freed slot is never handed out mid-pass** — the next tick's fresh
  `autoSlotsFree()` gives it to the first row in order, never to the rows behind it. **The whole ladder is re-asked after
  ONE microtask yield (`await Promise.resolve()`) before each `go` claim** — a kick runs the pass synchronously only that far, so a synchronous batch of writes lands before any claim (~30 host tests pin that batching); busy facts are re-read and the ladder re-asked, MONOTONICALLY. `openFor` /
  `opened` / one-repo-per-pass are GONE. **`localslot.ts` is rung 4.55 `localModel`** (R-intent-local-001): automatic local-model rows wait while `IntentFacts.local.free <= 0` (a local TURN working, or a local row `starting`/`running`; synced cap, default 1) and `localHold(row)` — synchronous, claims nothing — holds until Ollama has the model loaded, never a fallback model; a person's start is told, never refused ([host.md](docs/notes/host.md#the-local-model-gate--rung-455-localmodel)). `<state dir>/intents.json` is **schema 2** (`{schema, intents}`)
  with a `*.bak` beside it — both shapes read; the number records that every repo target has been
  re-read as `fresh`. `noteSession(id, sid)` is how an executor that OPENS a session names it on the
  row before the delivery finishes proving itself (and takes the completion baseline there).
  **A CHAIN (`after`) reads FOUR facts and the manager supplies all four or none**
  (`chainFacts()`, one walk per pass): `settled` (live rows + archive tail), `knownIntents` (what
  turns a dead predecessor into a FAILURE instead of a row that waits for ever), `chainWaits` (the
  edge list a cycle is visible in — from inside one row it is not) and `neverSettles` (`isRecurring`
  rows: a standing rule never terminates, so a chain behind one waits for ever — it FAILS naming the
  rule). **Every one is optional and absent means "nobody said" ⇒ WAIT**, so supplying three of them
  makes every chain look patient and none of them is. The archive read is a **BYTE TAIL, `ARCHIVE_TAIL_BYTES` 256 KB**, cached on the
  file's size+mtime (append-only ⇒ unchanged = nothing compacted); **past the bound a predecessor
  reads as GONE and the row FAILS with a sentence — the intended trade**, against an ever-growing
  read on the loop that pumps every PTY. A row `remove()`d while still QUEUED is archived but NOT
  known: it never finished. **`hours` moved `armFrom`'s grace floor** (`graceFloor()`): the grace
  counts from the window OPENING, so a 03:00 anchor behind a 07:00 window was never OFFERED rather
  than merely late — widened by a day only when the floor is shut and `hoursOpenFrom` says the
  opening is still within the grace, and the widening only makes a candidate VISIBLE
  (`intentVerdict` does the arithmetic). **Never a second local clock** — `inHours`/`hoursOpenFrom`
  are the one implementation, and a second would disagree across DST. `hours`/`guardWindow` need NO
  line in `adapters.ts`: the RULE is carried whole both ways, which is what stops the clause added
  most recently being the one that vanishes. A scheduled CHAIN does need a line:
  `ScheduleAction.backlog.steps` is the ONLY slot on the wire for turns 2..n, read as
  `action.steps ?? [action.text]` and written back by `intentToSchedule` so renaming a rule cannot
  shorten it (a SWEEP still runs `steps[0]` alone). **F14: `workItemInherits()` — a RECURRING
  schedule's `backlog` action gates the CHILD, not the making of the row** (instantaneous, never
  busy): the whole chain, `holdForHost` and `resume` travel; `serial` is already on every repo-target
  item. **RECURRENCE decides the list, and a ONE-OFF RUNS ITSELF** (`isTimedWorkRow`): `execute()`
  routes to `workItem` only when `isScheduleRow`, so a one-off aimed at one place falls to
  `freshSession`'s awaited backlog branch — its own session, no child row, no second account of one
  piece of work (a parent that missed its grace made no child at all: 7 real rows, `failed`, in no
  backlog). `intentToSchedule` answers `null` for one — the wire is UNCHANGED, `scheduleToIntent` and
  `schedule.save` still take a one-off — and it rides `backlog.list` with `BacklogItem.at`/
  `holdForHost` instead. **And `upsert()` CARRIES every host field `ScheduleEntry` cannot
  say** — the naming pair × 2, `order`/`handOrdered`/`archived`, the requeue history — when the draft
  is silent: it rebuilds from the DRAFT, so re-timing a backlog row in the send sheet DELETED the
  title somebody typed into it and the next naming pass then wrote over it (`revivedShape`'s rule,
  one path over). `fire()` only returns a hand-run row to `queued` when it HAS a next run, and
  `update()`'s one carve-out revives a **failed** timed row patched with a **trigger** (*drop the
  clock*), never a `done` one and never on words alone. **A FAILED row can be PUT BACK**
  (`requeueFailed` — failed ONLY, every other state refused in a SENTENCE; `result` is KEPT, `origin`
  is never rewritten (provenance is `requeues[].by`, whose value is the CALL SITE's: `run` for the
  two verbs that fire in the same breath, `hand` for a tap that waits, `assess` for a proposal), a
  spent one-off's clock is DROPPED and the entry SAYS so, the count is the UNCAPPED `requeueCount`
  and never `requeues.length` (capped at 5, so a row said "5th time" for ever), and **NO `requeued`
  event** — that channel is the usage limit's "Backlog paused"). **And the LADDER is asked first**
  (`wouldNotRun`, over `revivedShape`'s copy): a `fail` verdict, `sessionGone` and an `archived` row
  are REFUSED in words quoting the detail — put back, they stop again next tick or wait for ever,
  while Apply has said "they run again when their turn comes"; the ordinary waits (budget, slot,
  `serial`, hours, a live chain) are NOT refused, because they are what that sentence means. A
  mismatched `failedAt` is refused too — `failed` is a state, not an event. `runNow` on a failed row
  puts it back first, **`{kick: false}`** (a kicked pass settled the row failed and it fired anyway),
  and **`fire()` returns on an `inflight`/`starting`/`running` row**; `done`/`canceled` stay refused.
  `packages/host/test/intentsched.test.mjs`, `scripts/e2e-schedule.mjs`,
  `scripts/e2e-timedwork.mjs`.
- `archive.ts` — every conversation the CLI ever wrote for a repo, read off disk. Closing a session
  was never a delete. Remembers nothing; the filename IS the conversation id. **`deleteArchived` is
  the ONLY way to lose a conversation in this app** — bare-id regex, per-row confirm on the phone.
- `convfork.ts` — a conversation cut at a TURN, written under a new id. Cut after the WHOLE turn;
  rewrite **`sessionId` and only that** (`session_id` is PROVENANCE). `pruneStranded()` **prunes no
  message record, ever.** Source read-only, tmp+rename, fresh uuid.
