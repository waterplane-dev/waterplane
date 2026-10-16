# fanout

Fan-out: one prompt run in several repos at once, a fresh session in each, plus follow-ups to the
sessions a sweep opened and "later" (the same sweep handed to the Send sheet's *When*). The sheet
is `FanoutSheet.tsx` (unchanged; its presets are its own `waterplane.fanout.presets`, read at mount).
Opened from the launcher header's split button and from Activity.

**Owns**

- No store: a sweep's runs are rebuilt from `core().world.intents` (`fanoutRuns` from
  `@waterplane/shared`, memoised in `FanoutEntrySheet.tsx`) — rows sharing a `groupId`. The host's
  `fanout.run`/`fanout.list` pushes are deliberately ignored for that reason.
- `actions.ts` — `runFanout` (carries the sheet's launch row — `LaunchPicker`, the same backend/wheel/effort controls as the per-launch ask: a sweep is ONE launch decision over N repos, so it never goes through the ask itself) and `followUpFanout` (both DURABLE ops through `queue.queueOp`: one
  `fanout` lane so two sweeps queued offline go out in order, and a `fu:<runId>` lane per run so a
  follow-up lands after what it follows), `scheduleFanout` (`nav.openSend`, nothing queued),
  `openFanoutSession`.
- `logic.ts` — the lanes and the two receipts, tested in `logic.test.mjs`.
- `FanoutCostHint.tsx` (words in `logic.ts`'s `fanoutCostWords`) — one sentence above Run: what the last similar finished sweep cost
  (`pickSimilarRun` → `GET /api/costwindow` over its span → `foldLaunches` → `fanoutHintText`). A reading,
  never a gate: absent when offline, on an older host, or when that run's sessions are not in the logs.
  It leaves out "≈ N% of week" because `features/tokens` owns the rate and a feature may not import one.
- Sheet: `fanout`, not persisted. Its kickoff strip (pinned above Run) is `fanoutKickoff.ts`, beside `FanoutSheet.tsx`.

**Reads from core**: `world.intents/visibleRepos/sessions/launch`, `launch.wire` (a sweep spawns N
sessions, so a stale synced `backend` would be N bad spawns — the same gate as every
`session.create`), `term.geom` (the spawn is sized to this terminal), `queue.queueOp`,
`nav.openSend/attach/close`, `conn.status`, `say.toast`.

**Rules that apply**: one send path — both ops go through the queue with an ackId, never a bare
socket write; nothing is sent by "later".
