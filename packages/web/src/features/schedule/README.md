# schedule

Schedules: the rules this desktop fires on a wall clock (a recurring rule, a one-off sweep), and
the read-only directory of backlog rows that wear a clock. The sheet itself is the flat
`ScheduleSheet.tsx` (+ `clockDirectory.tsx`, `clockCuts.ts`), whose rules are in the
`web-work` skill: **recurrence decides the list**, `clockCuts()` is ONE call producing every
list and every number on the subject, and **a count on a control is a filter**.

The sheet is titled **Automation** (overlay id, routes and keys stay `schedule`). Its block above the cards, **"Runs
on its own, no clock"**, is `AutomationFoot.tsx` over the pure `automationLines.ts` (node-tested):
backlog auto and the rows it starts next (`backlogFilter/nextFire.ts`, the backlog's own `▶ next`
predicate), the repo's auto-download rule (through `automationSlot.ts`, which `features/pull` fills at
boot), the week-end burn (`GET /api/weekburn`, fresh reads only) and peer jobs waiting here. One
sentence and one door per line; per repo when the repo chip's cut carries `repoDir`; a source not
read draws no line. No health-watch line: the phone has no fact saying it runs.

**Owns** (`store.ts`, one writer each — `actions.ts`):

- `schedules` — the host's `schedule.list`, **seeded from the device cache
  (`loadSchedulesSnap().v`), never `[]`** — an empty list offline is a false claim
  (`scripts/e2e-offlinelists.mjs` pins that line), with `schedulesAt` the age of the copy.
- `scheduleFocus` (the launcher chip's horizon bucket) and `scheduleFocusIds` (a cut by ids,
  from a backlog row's *from the schedule “x”* or a repo row's clock chip). Both are the TAP, not a
  setting: `onLeave` clears them.

**Sheet**: `schedule` (not persisted). **Message**: `schedule.list`.

**Reads from core**: `world.intents/sessions/visibleRepos/active`, `useQueueEntries()` (the queued
`schedule.save` ops drawn as pending rows), `queue.queueOp` (`schedule.run` is DURABLE on the
`fanout` lane — the one tap that sends it, `bulkverbs.test.mjs`), `queue.verbs.scheduleQueueRows/
dropScheduleQueue` (a delete takes the queue rows that name it), `conn.liveSend` (enable, skip,
remove: live-only), `nav.openSend/openBacklogCut/openActivity/attach/close` (the spent foot opens Activity cut to
those row keys), `send.renderRetime/seedFromSchedule`. The delete receipt is `clockCuts.ts`'s
`scheduleRemovedToast`, the one wording Activity's delete says too.

**Exports for App**: `useClocks(intents, outbox, nowTick)` — the launcher chip's ONE `clockCuts`
call over the same pool as the sheet; `useSchedules()` (the backlog's schedule chips, via core);
`openSchedules(bucket)` (the chip's tap, cut to what it counted) and `openScheduleCut(ids, label)`.
