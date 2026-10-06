# build

Build buttons: a repo's sessionless build commands (`.waterplane/builds.json` on the desktop), the runs
they start and the output they stream. Reached from a repo row's `⋯ → build`, the launcher repo
header's hammer and the `build` toolbar item; the sheet itself is the flat `BuildSheet.tsx`, whose
rules are in the `web-work` skill (three answers to an empty field, a tap that FILLS and never
saves, a parameterised build that opens its form and never runs on a tap).

**Owns** (`store.ts`, one writer each — `actions.ts`, called by the handlers in `index.ts` and the
sheet `BuildButtonsSheet.tsx`; the words and the name lookup are `logic.ts`):

- `builds` — `sdk/repoRun.ts`'s `repoRunStore`: the per-repo command list **seeded from the device
  cache** (`loadBuildsSnap`/`saveBuildsSnap` in `localState.ts`; an empty list is a CLAIM, and this
  is the sheet you open when the link is bad) with the age it was last confirmed, the runs (upserted
  by id, capped at 60) and each run's output (300 kB tail, pruned with its run).
- `buildRepo` — the repo the sheet is open on, which a reconnect re-asks `build.list` for.
- `buildCands` (`build.candidates`), `buildOpts` (`build.options`), `artifactPolicies`
  (`artifacts.config`) — never cached to disk, for the reasons on each.

**Sheet**: `build` (not persisted). **Messages**: `welcome` (re-sync), `artifacts.config`,
`build.list`, `build.options`, `build.candidates`, `build.run` (toast on done/failed), `build.output`.
**Command**: `build` (the toolbar item).

**Reads from core**: `conn.send`/`conn.liveSend`, `queue.queueOp` (a `build.run` is DURABLE, one
lane per repo — never a second send path), `nav.overlay/open/close/startSessionWithPrompt`,
`files.downloadArtifact` (the one download path), `world.activeRepo`, `say.toast`.

**Rules that apply**: `build.output` is a chatty push — it re-renders only while
`core().nav.overlay === "build"`; the buffer still moves so opening the sheet shows everything.
`build.save`/`build.cancel`/`artifacts.save` are live-only and say so when there is no link.
`build.scan`/`build.options` are plain sends because the form is the receipt.

**Exports for App**: `openBuildFor(repo)`, `useBuildNames()` (Send sheet's `buildName`, subscribed so
a list that lands later repaints), `buildNameOf(cwd, id)` (the `shell` intent, read at tap time), and the receipt words `buildLane`/`buildQueueTitle`/`buildQueuedToast`.
