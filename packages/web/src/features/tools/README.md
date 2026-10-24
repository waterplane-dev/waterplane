# tools

The thin host-tool sheets: each wires an existing top-level sheet component to the core, and
nothing else. `speedtest` (`SpeedTestSheet.tsx`), `secret` (`SecretSheet.tsx`), `features` (the
feature-usage list, `UsageSheet.tsx`), `storage` (`StorageSheet.tsx`), `nethealth`
(`NetHealthSheet.tsx`), `localrt` (`LocalRtSheet.tsx`), `repocolor` (`RepoColorSheet.tsx`) and
`archive` (`ArchiveSheet.tsx`). The sheets' own rules are in their skills (`web-chrome` for
the archive and repo colours, `web-config` for the local runner, `web-files` for
storage).

**Owns**

- `store.ts` — `netFocus` and `localRtFocus`: which reading on the connection strip / the
  local-runtime strip was tapped, so the sheet opens at that section. Not in the route (a focus is
  about the tap, not the screen). Written by `actions.ts`, cleared by each sheet's `onLeave`.
  **`onLeave` fires on ANY leave** — ×, Back, AND another sheet opened on top — so a focus does
  not survive a side trip: nethealth → *open storage* → Back lands on nethealth at the top, not
  re-flashing the tapped section. Deliberate (a focus answers the tap that opened the sheet, and a
  covered sheet is no longer answering it), and a change from the pre-feature App, where
  `netFocus` was never cleared and `localRtFocus` only on ×.
- `actions.ts` — `bootStripDoors` (the manifest's `boot`): the two always-on strips are mounted
  above `App` and ask for their sheet by window event (`app:open-nethealth`,
  `app:open-localrt`, each carrying its `focus`).
- `logic.ts` — the **feature-usage catalog** (`OVERLAY_IDS`, `ACTION_IDS`, `knownFeatureIds`),
  moved here from `App.tsx` with the sheet that reads it: every id `track()` can emit, so the usage
  sheet can list features with ZERO uses. Keep it in sync when adding a `track()` call anywhere.
  Plus, for the archive: `archiveStartRepo`; `liveConversationIds`/`liveSessionFor` (either
  `claudeSessionId` or a plugin session's `backendSessionId`); `archiveBackends` (claude first, then
  every non-shell backend whose `caps.conversations` is true — one entry draws no switch) and
  `archiveBackendHint` (the one sentence a non-claude list says about itself).
- `ToolSheets.tsx` — the eight wirings.
- Sheets: `storage`, `repocolor`, `archive` persisted (as `PERSISTED_OVERLAYS` says); the rest not.
- Track ids: `overlay:nethealth`, `overlay:localrt`, `overlay:storage`, `overlay:sweep`,
  `action:queue.manage` (unchanged).

**Reads from core**: `world.repos/visibleRepos/activeRepo/sessions/backends/launch`,
`launch.wire/openCwd` (the archive's resume and fork launch claude EXPLICITLY — every row is a
Claude Code log), `nav.open/close/attach/openActivity`, `files.openSweep` (storage's per-repo
outbox figure is a filter), `useQueueEntries()` (the undelivered count), `say.toast/track`.

**Rules that apply**: a count is a filter (the undelivered count opens Activity cut to exactly
those rows, "n of N"); a live conversation in the archive offers a jump, never a second
`--resume`.

**Tests**: `logic.test.mjs`.
