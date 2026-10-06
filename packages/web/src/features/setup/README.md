# setup

`Repo readings`: ONE sheet, two regions, and **the seam is the COMPARATOR, never time** — region 1
is the setup checklist (a fact against a line somebody chose: pass/warn/fail, counted in the
repo's badge, sometimes a `fix`), region 2 the zero-token repo-health series (against its own
past: no side to be on, counted in nothing). The sheet is the flat `SetupSheet.tsx` +
`RepoHealthRegion.tsx`; the rules are the `web-work` skill's.

**Owns** (`store.ts`; one writer, `actions.ts`): where the sheet is AIMED — `setupRepo` (the repo
a badge or menu opened it on), `setupAim` (`region`, and `focus: "findings"` when a badge's COUNT
opened it: a count on a control is a filter), `healthRepo` (the `repohealth` alias's repo). Each
is the tap, never a setting; the sheet's close clears it.

**Sheets**: `setup` and `repohealth` (the ALIAS a stored route or a viewer's `returnTo` may still
name; null without a repo). Neither persisted.

**Settings row**: `AutoCompactSettings.tsx` (Sessions → *auto-compact window*) — the window the
checklist's `auto-compact` write offers, stored on the DESKTOP (`/api/host/setupprefs`), not synced:
the sweep reads it with no phone attached. Advisory rows (`context-weight`, `auto-compact`) are a
thing to *consider*, never counted, and *ignore in this repo* folds them (host-side, per repo).

**Verbs**: `remedy` — the finding (or the reading's question) as a Send-sheet seed with the repo
chosen; nothing is sent by the tap. Shared by BOTH doors, because inline in one the other lost it.
`openRepoFile` — the tree opened on a file, returning to region 2.

**Reads from core**: `world.repos`, `nav.openSend/open/close/overlay`, `say.track`,
`files.browseTo(repoId, file, back)` (the tree, returning here), `world.refreshRepos()` (closing
the checklist re-reads the badges).

**Exports for App**: `openSetup(repoId, aim)` (the badges and menus), `openRepoHealth(repo)`.
