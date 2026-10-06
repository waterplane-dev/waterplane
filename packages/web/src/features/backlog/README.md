# backlog

A repo's waiting work — **the list, never a place words are "sent to"** — and its grooming, the
assessment (*what is left*). One feature, because each opens the other: the backlog's `assess`
opens the assessment, and an applied assessment's *open the backlog — N waiting* cuts the backlog.
The sheets themselves are the flat `Backlog.tsx` (+ `backlogFilter.ts`) and `AssessSheet.tsx`
(+ `assessRows.ts`, `assessPicks.ts`), whose rules are in the `web-work` skill. `Backlog.tsx` is a
thin composer over `src/backlog/` (state hooks, regions, the grouped `BacklogProps`) and
`backlogFilter.ts` a barrel over `src/backlogFilter/` — see `docs/notes/backlog-architecture.md`.
`BacklogSheet` binds the facts flat and the callbacks in three groups: `verbs` (one row),
`cutVerbs` (the repo or the cut on screen) and `nav` (doors out).

**Owns** (`store.ts`; one writer, `actions.ts`):

- `backlog` — the host's `backlog.list` as one value. `items/auto/smartPick/passes/snapAt` are
  seeded from `waterplane.snap.backlog` so the sheet renders offline; `waiting`/`naming`/`autoSlots` are
  facts about this second and are never snapshotted (`autoSlots` feeds a slot-held row's *close one
  to make room*, intersected with live sessions in `autoSessions.ts`). `smartPick: null` ≠ `[]` (an old host has no switch).
- `backlogScope` / `backlogFocus` — which repo the sheet opens on, and the ids cut it was opened
  on (a count is a filter; `onLeave` drops the cut).
- `assessRuns` (per repo, `assess.state`, never persisted), `assessRepo`, `assessScope`, and
  `assessBusy` — **ref-authoritative** (a store's `get()` is synchronous): ackId → the pad notes
  an apply owes, cleared on the RECEIPT (`onAssessAck`), only `ticked ∩ msg.filed`, never on the tap.

**Sheets**: `backlog` (persisted), `assess` (not; null without a repo). **Messages**: `welcome`
(asks `assess.state`), `backlog.list`, `assess.state` — a chatty push, kept at `prev` unless the
assess sheet is on top (`core().nav.overlay`), never swallowing a transition, a new run or a null.

**Reads from core**: `conn.liveSend/liveSendAll/liveAsk` (every backlog mutation is LIVE-only with
`BL_OFFLINE`), `queue.queueOp` (the two DURABLE verbs: `intent.requeue` on the row's own lane,
`backlog.name`), `queue.mintAckId` (the live assess ops' ack ids), `send.renderRetime/
seedFromIntent`, `world.cwdVisible/schedules/pending/budget/intents`, `nav.open/close/overlay/
openScheduleCut/followFire/openPadAt/openSend/attach/openBacklogCut`, `nav.closeSession` (the ONE session close, for *close one to make room*), `nav.openActivity` (an
assessment row's work item opens Activity UNCUT — a bare `nav.open("activity")` kept whatever cut
it was last left on), `files.editBacklogImage/openFileFrom`. The sheet's row filter is memoised on
`world.cwdVisible` itself, so it relies on that member being STABLE across App renders.
`bulkverbs.test.mjs` pins `onFire: (id) => { if (liveSend({ t: "backlog.fire", id }` here.

**Exports for App**: `useBacklog()` (compose strip, badges, fire-nav), `openBacklogFor(repo)`,
`openBacklogIn(cwd)`, `openBacklogCut(cwd, ids, label)` (App binds `nav.openBacklogCut` to it),
`openAssessFor(repo, ids)`, and `onAssessAck(ackId, ok, filed, removePadNotes)` for App's `op.ack`.
