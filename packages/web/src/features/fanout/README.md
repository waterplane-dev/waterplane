# fanout

Fan-out: one prompt run in several repos at once, a fresh session in each, plus follow-ups to the
sessions a sweep opened and "later" (the same sweep handed to the Send sheet's *When*). The sheet
is `FanoutSheet.tsx` (unchanged; its presets are its own `waterplane.fanout.presets`, read at mount).
Opened from the launcher header's split button and from Activity.

**Owns**

- No store: a sweep's runs are rebuilt from `core().world.intents` (`fanoutRuns` from
  `@waterplane/shared`, memoised in `FanoutEntrySheet.tsx`) — rows sharing a `groupId`. The host's
  `fanout.run`/`fanout.list` pushes are deliberately ignored for that reason.
- `actions.ts` — `runFanout` and `followUpFanout` (both DURABLE ops through `queue.queueOp`: one
  `fanout` lane so two sweeps queued offline go out in order, and a `fu:<runId>` lane per run so a
  follow-up lands after what it follows), `scheduleFanout` (`nav.openSend`, nothing queued),
  `openFanoutSession`.
- `logic.ts` — the lanes and the two receipts, tested in `logic.test.mjs`.
- Sheet: `fanout`, not persisted.

**Reads from core**: `world.intents/visibleRepos/sessions/launch`, `launch.wire` (a sweep spawns N
sessions, so a stale synced `backend` would be N bad spawns — the same gate as every
`session.create`), `term.geom` (the spawn is sized to this terminal), `queue.queueOp`,
`nav.openSend/attach/close`, `conn.status`, `say.toast`.

**Rules that apply**: one send path — both ops go through the queue with an ackId, never a bare
socket write; nothing is sent by "later".
