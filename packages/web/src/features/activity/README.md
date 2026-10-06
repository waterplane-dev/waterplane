# activity

Every posted piece of work, **one row for its whole life** — the send queue (words still on this
phone), the desktop's durable intents (launches, work items, schedules, sweeps, builds, captures)
and this phone's downloads. The sheet is the flat `ActivitySheet.tsx`; rows are `activityRows.ts`
(pure, node-tested). Rules in the `web-work` skill: **a row never vanishes on a state change,
it changes verdict**; it reads `Intent` DIRECTLY and infers no lifecycle; `disabledReason`, never
a greyed button.

**Owns** (`store.ts`; one writer, `actions.ts`):

- `filed` / `confirmedDone` — this phone's own marks (`activityDismiss.ts`, `activityDone.ts`),
  seeded at load because this screen is opened with the tunnel down.
- `focus` — which rows the sheet opens on (a count on a control is a filter: the queue bar's
  Manage, a repo's waiting chip, the schedule sheet's spent foot). Cleared by the sheet's close.
- `pullList` — `pull.ts`'s transfers, mirrored by `boot`.

**Sheet**: `activity` (persisted). **Boot**: the `pull.ts` subscription.

**What a row does** (`actions.ts`, `act`/`retarget`/`bulk`): `intent.run` is the ONE `run it now`
for every host-held kind (`bulkverbs.test.mjs` pins it to this arm), DURABLE via `queue.queueOp` on
the lane its kind already had (`logic.ts` `runLane`); `intent.cancel`, except `build.cancel`/
`capture.cancel` (a live process) and `schedule.remove` (a delete); a filing tells the host
(`intent.dismiss`, live only); the bulk verbs confirm with a count AND a sample (`say.confirm`,
never `window.confirm`) and end in one sentence.

**Reads from core**: `useQueueEntries()`, `queue.blocked/goneLanes/laneLabel/queueBacklog/verbs`,
`queue.repoIdOf/drop` (a re-fired row leaves the queue with no cascade), `conn.liveSend/send`,
`world.repoForCwd/backlog` (the backlog rows' check verdicts), `send.seedFromIntent/targetFor`,
`nav.followFire`. A schedule's delete says `clockCuts.ts`'s `scheduleRemovedToast`, the Schedules
card's own words.

**Exports for App**: `openActivity(cut?)` — the ONE door, taking no cut, `null`, row `keys` or
the queue `entries` a strip counted; App binds `nav.openActivity` to it directly —
`openActivityOn(entries, label)` (a thin wrapper, for the queue strip), `useActivityFiled()` / `useActivityConfirmedDone()` (the launcher's waiting chips and the
stuck counts exclude what this phone has already dealt with).
