# repoSync

Pull, push or sync every repo at once — the git view's three buttons (`GitView.tsx`) over the whole
repo list. Opened from the launcher header's sync button (beside rescan).

**Owns**

- `store.ts` — `run`: the run in progress or the last one, one `RowState` per repo id. Module
  state, written only by `actions.ts`, so closing the sheet never stops a run and reopening it
  shows where it got to.
- `actions.ts` — `startRun(verb, repos)` and `stopRun()`. The SAME host calls the git view makes
  (`gitPull`, `gitPush` + `gitPushState`, `gitStatus`); nothing new on the host. Pulls run three at
  a time (seconds, no hook). Pushes run ONE at a time — each runs the repo's pre-push checks on
  this desktop, and several at once fight for it. Sync = pull, then push what a FRESH status still
  has ahead. Stop lets the running step finish and marks the waiting ones stopped.
- `logic.ts` — which repos a verb touches (`syncable`: an origin and an upstream; push: only those
  ahead), the receipt and the sheet's sentences; tested in `logic.test.mjs`.
- `RepoSyncSheet.tsx` — the buttons and one row per repo; a row opens that repo's git view.

**Rules**

- Nothing runs without a tap: the sheet opening never pulls or pushes.
- `Push N` counts exactly the rows marked `↑` — a count on a control is what it acts on.
- Repos left out (no origin, no upstream) are counted in a sentence, never silently dropped.
